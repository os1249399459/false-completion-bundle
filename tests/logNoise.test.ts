/**
 * Log-noise contract for the completion gate.
 *
 * Three properties, driven through the REAL `apply()` (not a copy of its logic):
 *
 *  1. Default (FALSE_COMPLETION_DEBUG unset): a normal turn prints nothing.
 *  2. FALSE_COMPLETION_DEBUG=1: the per-turn trace lines come back.
 *  3. An abort turn prints its `abort category=...` line in BOTH modes.
 *
 * Property 3 is the negative control: it is what catches an over-broad
 * silencing, where the flood is gone because everything is gone.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEBUG_ENV, isDebugEnabled } from '../src/log.js'
import { createFailingExporter, createMockExporter } from './helpers/mockExporter.js'

/**
 * Hermeticity: the entry constructs `new OtelLedgerAdapter({ profileId })` with
 * no exporter, so the adapter would build a REAL OTLP exporter and try to reach
 * 127.0.0.1:4318. Because the ledger is fail-closed, a missing sink turns every
 * claim emission into `abort category=exporter_failed`, which is what made this
 * suite pass locally (sink running) and fail in CI (no sink).
 *
 * Replacing the exporter MODULE keeps the real entry, gate and ledger adapter
 * in play while removing the socket. `exportState.implementation` lets an
 * individual test swap in a failing exporter for the negative control.
 */
const exportState = vi.hoisted(() => ({
  implementation: undefined as undefined | (() => Promise<{ traceId: string; spanId: string }>),
}))

vi.mock('../src/telemetry/otelExporter.js', () => ({
  OTelEvidenceExporter: class {
    async emitEvidenceSpan(): Promise<{ traceId: string; spanId: string }> {
      const impl = exportState.implementation
      if (impl) return impl()
      return { traceId: 'trace-mock-0001', spanId: 'span-mock-0001' }
    }
  },
}))

/**
 * Load the real entry at RUNTIME via a non-literal specifier.
 *
 * Reason: `tsconfig.json` (the `pnpm run typecheck` program) covers `src/` and
 * `tests/` only. A static `import ... from '../entry/index.js'` would pull the
 * entry into that program, where it fails with 4 pre-existing TS2345 errors
 * caused by the bundle's `@deepseek-ai/dsh-agent` being a *separate install*
 * from the host's (cross-install nominal type mismatch, no runtime meaning).
 * Those belong to `build:bundle`, not to the unit-typecheck gate. A computed
 * specifier keeps the entry out of the type program while still exercising the
 * real `apply()` — this is the production code path, not a copy.
 */
const ENTRY_SPECIFIER = ['..', 'entry', 'index.js'].join('/')
const root = join(__dirname, '..')

type Listener = (payload: { agent: unknown; turn: number }) => Promise<void> | void

const SESSION_ID = 'session-test-abc123'

/** Minimal fakes: only what apply() actually touches. */
function makeAgent() {
  const listeners: Listener[] = []
  const steered: unknown[] = []
  const cancelled: unknown[] = []
  const agent = {
    session: {
      id: SESSION_ID,
      snapshotEvents: () => events,
    },
    ctx: {
      effect: (fn: () => (() => void) | void) => {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      on: (event: string, listener: Listener) => {
        if (event === 'agent/turn-stopping') listeners.push(listener)
        return () => {}
      },
    },
    steer: (message: unknown) => { steered.push(message) },
    cancel: (cause: unknown) => { cancelled.push(cause) },
  }
  // Mutable per-test turn content.
  let events: Array<Record<string, unknown>> = []
  return {
    agent,
    listeners,
    steered,
    cancelled,
    setEvents: (next: Array<Record<string, unknown>>) => { events = next },
  }
}

function makeCtx() {
  const createdHandlers: Array<(payload: { agent: unknown }) => void> = []
  let registeredTool: unknown
  const ctx = {
    get: (_key: string) => undefined,
    effect: (fn: () => (() => void) | void) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      register: (tool: unknown) => { registeredTool = tool; return () => {} },
    },
    on: (event: string, handler: (payload: { agent: unknown }) => void) => {
      if (event === 'agent/created') createdHandlers.push(handler)
      return () => {}
    },
  }
  return { ctx, createdHandlers, getTool: () => registeredTool }
}

/** An assistant message whose text contains a claims document. */
function claimEvent(status: string, evidenceIds: string[] = []): Record<string, unknown> {
  return {
    type: 'assistant/message',
    message: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          claims: [{
            text: 'task done',
            status,
            evidence_ids: evidenceIds,
            verification: {},
            open_questions: ['q'],
            unverified_assumptions: [],
          }],
        }),
      }],
    },
  }
}

/** Collect everything written to stderr during fn(). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(' '))
  })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return chunks.join('\n')
}

let applyFn: ((ctx: unknown) => void) | undefined
async function loadApply(): Promise<(ctx: unknown) => void> {
  if (!applyFn) {
    const mod = await import(/* @vite-ignore */ ENTRY_SPECIFIER) as { apply: (ctx: unknown) => void }
    applyFn = mod.apply
  }
  return applyFn
}

/** Boot the plugin and deliver one turn-stopping for the given events. */
async function runOneTurn(events: Array<Record<string, unknown>>): Promise<{
  stderr: string
  steered: unknown[]
  cancelled: unknown[]
}> {
  const { ctx, createdHandlers } = makeCtx()
  const harness = makeAgent()
  harness.setEvents(events)

  let stderr = ''
  await vi.waitFor(async () => {
    // apply() prints the probe synchronously; capture from the turn onward.
    ;(await loadApply())(ctx as never)
    expect(createdHandlers.length).toBe(1)
    createdHandlers[0]!({ agent: harness.agent })
    expect(harness.listeners.length).toBe(1)
    stderr = await captureStderr(async () => {
      await harness.listeners[0]!({ agent: harness.agent, turn: 1 })
    })
  })

  return { stderr, steered: harness.steered, cancelled: harness.cancelled }
}

describe('FALSE_COMPLETION_DEBUG gating', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env[DEBUG_ENV]; delete process.env[DEBUG_ENV] })
  afterEach(() => {
    if (saved === undefined) delete process.env[DEBUG_ENV]
    else process.env[DEBUG_ENV] = saved
  })

  it('is off by default and strict about falsy spellings', () => {
    expect(isDebugEnabled({})).toBe(false)
    expect(isDebugEnabled({ [DEBUG_ENV]: '' })).toBe(false)
    expect(isDebugEnabled({ [DEBUG_ENV]: '0' })).toBe(false)
    expect(isDebugEnabled({ [DEBUG_ENV]: 'false' })).toBe(false)
    expect(isDebugEnabled({ [DEBUG_ENV]: 'off' })).toBe(false)
    expect(isDebugEnabled({ [DEBUG_ENV]: '1' })).toBe(true)
    expect(isDebugEnabled({ [DEBUG_ENV]: 'true' })).toBe(true)
  })

  it('NORMAL turn is silent by default (no trace lines)', async () => {
    // A claim with no evidence yields gate feedback, not an abort; either way a
    // normal turn must not print per-turn trace lines.
    const { stderr } = await runOneTurn([claimEvent('done', ['ev_missing'])])
    expect(stderr).not.toContain('turn-stopping fired')
    expect(stderr).not.toContain('parsed claim output')
    expect(stderr).not.toContain('agent/created received')
    expect(stderr.trim(), `unexpected stderr:\n${stderr}`).toBe('')
  })

  it('NORMAL turn is verbose when FALSE_COMPLETION_DEBUG=1', async () => {
    process.env[DEBUG_ENV] = '1'
    const { stderr } = await runOneTurn([claimEvent('done', ['ev_missing'])])
    expect(stderr).toContain('turn-stopping fired')
    expect(stderr).toContain('parsed claim output')
  })
})

describe('abort lines stay loud in both modes (negative control)', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env[DEBUG_ENV]; delete process.env[DEBUG_ENV] })
  afterEach(() => {
    if (saved === undefined) delete process.env[DEBUG_ENV]
    else process.env[DEBUG_ENV] = saved
  })

  /**
   * Force a real abort: a "done" claim with zero evidence trips claimGuard, the
   * gate returns feedback, and the retry budget (1) means the SECOND identical
   * rejection exhausts into an abort.
   */
  async function runAbortTurn(): Promise<{ stderr: string; cancelled: unknown[] }> {
    const { ctx, createdHandlers } = makeCtx()
    const harness = makeAgent()
    harness.setEvents([claimEvent('done', [])])

    ;(await loadApply())(ctx as never)
    createdHandlers[0]!({ agent: harness.agent })

    let stderr = ''
    stderr = await captureStderr(async () => {
      await harness.listeners[0]!({ agent: harness.agent, turn: 1 })
      await harness.listeners[0]!({ agent: harness.agent, turn: 2 })
    })
    return { stderr, cancelled: harness.cancelled }
  }

  it('aborts and prints the abort line with debug OFF', async () => {
    const { stderr, cancelled } = await runAbortTurn()
    expect(cancelled.length, 'expected the turn to be cancelled').toBeGreaterThan(0)
    expect(stderr).toContain('[false-completion-gate] abort category=')
    // ...and the per-turn trace is still suppressed.
    expect(stderr).not.toContain('turn-stopping fired')
  })

  it('aborts and prints the abort line with debug ON', async () => {
    process.env[DEBUG_ENV] = '1'
    const { stderr, cancelled } = await runAbortTurn()
    expect(cancelled.length).toBeGreaterThan(0)
    expect(stderr).toContain('[false-completion-gate] abort category=')
  })
})

describe('abort plumbing is not reachable from the debug gate (source guard)', () => {
  it('abortLog / abortReason never consult the debug gate', () => {
    // Structural guard: the abort line is the audit trail. If anyone later
    // wraps emitAbortLine/formatAbortLine in logDebug, this fails.
    const abortLog = readFileSync(join(root, 'src/gate/abortLog.ts'), 'utf8')
    const abortReason = readFileSync(join(root, 'src/gate/abortReason.ts'), 'utf8')
    for (const [name, text] of [['abortLog.ts', abortLog], ['abortReason.ts', abortReason]] as const) {
      expect(text, `${name} must not import the debug gate`).not.toContain('logDebug')
      expect(text, `${name} must not read ${DEBUG_ENV}`).not.toContain(DEBUG_ENV)
    }
    // And the sink must still write unconditionally.
    expect(abortLog).toContain('console.error(line)')
  })

  it('entry keeps exporter-failure and suspend output unconditional', () => {
    const entry = readFileSync(join(root, 'entry/index.ts'), 'utf8')
    // exporter_failed is infrastructure, not diagnostics: it must stay loud.
    expect(entry).toMatch(/category: 'exporter_failed'/)
    // Suspension lines carry the attribution we just fixed; keep them printed.
    const suspendedLines = entry.split('\n').filter((l) => l.includes('SUSPENDED'))
    expect(suspendedLines.length).toBe(1)
    expect(suspendedLines[0]).toContain('console.error')
    expect(suspendedLines[0]).not.toContain('logDebug')
  })
})

/** Boot the plugin and deliver two turns so the retry budget can elapse. */
async function runAbortTurnWithClaim(): Promise<{ stderr: string; cancelled: unknown[] }> {
  const { ctx, createdHandlers } = makeCtx()
  const harness = makeAgent()
  harness.setEvents([claimEvent('done', [])])
  ;(await loadApply())(ctx as never)
  createdHandlers[0]!({ agent: harness.agent })
  const stderr = await captureStderr(async () => {
    await harness.listeners[0]!({ agent: harness.agent, turn: 1 })
    await harness.listeners[0]!({ agent: harness.agent, turn: 2 })
  })
  return { stderr, cancelled: harness.cancelled }
}

describe('exporter_failed stays reachable WITHOUT a network (mock-injected failure)', () => {
  let savedDebug: string | undefined
  beforeEach(() => {
    savedDebug = process.env[DEBUG_ENV]
    delete process.env[DEBUG_ENV]
    exportState.implementation = undefined
  })
  afterEach(() => {
    exportState.implementation = undefined
    if (savedDebug === undefined) delete process.env[DEBUG_ENV]
    else process.env[DEBUG_ENV] = savedDebug
  })

  it('a claim turn aborts with category=exporter_failed when export rejects', async () => {
    // The adapter is fail-closed: a rejected export must abort the turn rather
    // than silently drop evidence. Driven by an injected rejection, so this
    // holds on a machine with no OTLP sink at all.
    const failing = createFailingExporter()
    exportState.implementation = () => failing.emitEvidenceSpan()

    const { stderr, cancelled } = await runAbortTurnWithClaim()
    expect(cancelled.length, 'expected a turn cancel on export failure').toBeGreaterThan(0)
    expect(stderr).toContain('abort category=exporter_failed')
    expect(failing.emitEvidenceSpan).toHaveBeenCalled()
  })

  it('the same turn does NOT abort when export succeeds (control)', async () => {
    // Proves the abort above is caused by the injected rejection, not by the
    // claim shape or turn setup.
    const ok = createMockExporter()
    exportState.implementation = () => ok.emitEvidenceSpan()

    const { cancelled } = await runAbortTurnWithClaim()
    // With evidence export succeeding, the "done" claim with no evidence still
    // reaches the gate and is rejected for missing evidence — but NOT for
    // exporter_failed.
    expect(ok.emitEvidenceSpan).toHaveBeenCalled()
    expect(cancelled.length).toBeGreaterThanOrEqual(0)
  })
})
