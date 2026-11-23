/**
 * Divergence limits must be wired end-to-end: the entry passes the three
 * limits into the gate constructor, the gate falls back to the shared
 * constants, and the read-only status tool reports the SAME numbers.
 *
 * This test exists because `FALSE_COMPLETION_MAX_TOOL_CALLS` was once read only
 * by gateStatus while the gate was constructed without it — status reported a
 * limit that was never enforced.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CompletionGate,
  DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_STEPS,
  DEFAULT_MAX_STEPS_PER_TURN,
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
} from '../src/gate/completionGate.js'
import { buildGateStatus } from '../src/gate/gateStatus.js'
import type { LedgerReader } from '../src/adapters/ledgerAdapter.js'

const root = join(__dirname, '..')
const ledger: LedgerReader = { getEntry: (ref) => ({ ref, ok: true }) }

function gateWith(config: Record<string, unknown>) {
  return new CompletionGate({
    ledger,
    suspendAdapter: { suspend: async () => ({ kind: 'suspended', reason: 's' }) },
    ...config,
  } as never)
}

async function effectiveToolCallBudget(gate: CompletionGate, limit: number): Promise<number> {
  // Each evaluate() with a valid-looking claim advances one step; the tool-call
  // counter is driven by noteToolCall.
  for (let calls = 1; calls <= limit * 2 + 5; calls++) {
    gate.noteToolCall(1)
    const decision = await gate.evaluate(
      { claims: [{ text: 'x', status: 'blocked', evidence_ids: [], verification: {}, open_questions: ['q'], unverified_assumptions: [] }] },
      { turn: 1, concludesTurn: false, signal: new AbortController().signal },
    )
    if (decision.kind === 'abort') return calls
  }
  return -1
}

describe('divergence limits: enforced and reported from one source', () => {
  it('status tool defaults equal the gate constructor constants', () => {
    const status = buildGateStatus({ env: {} })
    expect(status.effective.maxStepsPerTurn).toBe(DEFAULT_MAX_STEPS_PER_TURN)
    expect(status.effective.maxToolCallsPerTurn).toBe(DEFAULT_MAX_TOOL_CALLS_PER_TURN)
    expect(status.effective.maxConsecutiveNoProgressSteps).toBe(DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_STEPS)
  })

  it('an explicit 10 tool-call budget is actually enforced by the gate', async () => {
    const gate = gateWith({
      maxStepsPerTurn: 1000,
      maxToolCallsPerTurn: 10,
      maxConsecutiveNoProgressSteps: 1000,
    })
    // toolCallsThisTurn exceeds the limit on call 11.
    expect(await effectiveToolCallBudget(gate, 10)).toBe(11)
  })

  it('status reports 10 when the env var is set (same variable the entry reads)', () => {
    const status = buildGateStatus({ env: { FALSE_COMPLETION_MAX_TOOL_CALLS: '10' } })
    expect(status.effective.maxToolCallsPerTurn).toBe(10)
  })

  it('entry/index.ts passes all three limits to the gate constructor', () => {
    const source = readFileSync(join(root, 'entry/index.ts'), 'utf8')
    for (const key of ['maxStepsPerTurn', 'maxToolCallsPerTurn', 'maxConsecutiveNoProgressSteps']) {
      expect(source, `entry must read+pass ${key}`).toMatch(new RegExp(key))
    }
    // Reading the env var without forwarding it is the exact regression this guards.
    expect(source).toContain('FALSE_COMPLETION_MAX_TOOL_CALLS')
    expect(source).toMatch(/maxToolCallsPerTurn,\s*\n\s*maxConsecutiveNoProgressSteps,/)
  })

  it('entry no longer hardcodes a static session id', () => {
    const source = readFileSync(join(root, 'entry/index.ts'), 'utf8')
    // Comments may mention the old value; only code occurrences matter.
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain("sessionId: 'dsh-host'")
  })
})

describe('packaging: no stale compiled entry ships', () => {
  it('entry/ contains no committed .js next to the TypeScript source', () => {
    const entries = readdirSync(join(root, 'entry'))
    // A stray entry/index.js is a compiled copy of an older index.ts; the
    // profile loads dist/entry/index.js (built), so shipping the stale one only
    // risks it being picked up later with the old behaviour.
    expect(entries.filter((f) => f.endsWith('.js'))).toEqual([])
  })

  it('package.json ships the entry source, not a whole entry/** tree', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(pkg.files).toContain('entry/index.ts')
    expect(pkg.files).not.toContain('entry/**')
  })
})
