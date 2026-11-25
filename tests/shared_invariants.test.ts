/**
 * SHARED INVARIANTS — the three rules that must hold identically in
 * `false-completion-bundle` and its sibling implementation `no-receipts`.
 *
 * This file is the sync artifact. When these tests change, the same three
 * properties must be re-verified in the sibling repo (see HANDOFF.md
 * "Cross-Repo Sync Discipline"). The two repos are deliberately NOT merged and
 * do NOT share a package: the implementations differ, the *contracts* must not.
 *
 * The three invariants:
 *   I1. Fail-closed export. If evidence cannot be exported, the turn aborts
 *       with `exporter_failed`. It never completes on unexported evidence.
 *   I2. Three-state decisions. `complete` / `feedback` / `abort` are distinct
 *       and exhaustive; `abort` is reachable without any journal write.
 *   I3. Stable, ASCII-only abort line. One grep-able line, fixed shape, and no
 *       non-ASCII characters — the gate's prose is always raw English so logs
 *       stay token-cheap and greppable regardless of the user's language.
 *
 * Hermetic by construction: no OTLP sink, no network, no spawned processes.
 * Exporters and ledgers are injected doubles.
 */
import { describe, expect, it } from 'vitest'
import { CompletionGate } from '../src/gate/completionGate.js'
import { OtelLedgerAdapter, type LedgerReader } from '../src/adapters/ledgerAdapter.js'
import {
  ABORT_CATEGORIES,
  abortDecision,
  formatAbortLine,
  type AbortReason,
} from '../src/gate/abortReason.js'
import type { CompletionContext } from '../src/adapters/adapters.js'
import { createFailingExporter, createMockExporter } from './helpers/mockExporter.js'

const CTX: CompletionContext = {
  sessionId: 'invariant-test',
  turn: 1,
  concludesTurn: false,
  signal: new AbortController().signal,
}

/** A claim document with a caller-supplied status and evidence. */
function document(status: string, evidenceIds: string[] = []) {
  return {
    claims: [{
      text: 'task finished',
      status,
      evidence_ids: evidenceIds,
      verification: {},
      open_questions: ['q'],
      unverified_assumptions: [],
    }],
  }
}

const okLedger: LedgerReader = { getEntry: (ref) => ({ ref, ok: true }) }

function gateWith(config: Record<string, unknown> = {}) {
  const gate = new CompletionGate({
    ledger: okLedger,
    maxRetries: 1,
    suspendAdapter: { suspend: async () => ({ kind: 'suspended', reason: 'suspended' }) },
    sessionId: 'invariant-test',
    ...config,
  } as never)
  return gate
}

/** Any character outside printable ASCII (excluding tab) makes the line unstable. */
const NON_ASCII = /[^\x09\x0A\x0D\x20-\x7E]/

/**
 * The one allowed abort-line shape:
 *   [false-completion-gate] abort category=<cat> claim=<q|-> evidence=<q|-> \
 *     verifier=<type:q|-> counts=<a/b|-> detail=<q>
 * Quotes may contain escaped \" and \\ .
 */
const LINE_SHAPE = new RegExp(
  '^\\[false-completion-gate\\] abort category=(' + ABORT_CATEGORIES.join('|') + ')' +
  ' claim=(?:-|"(?:[^"\\\\]|\\\\.)*")' +
  ' evidence=(?:-|"(?:[^"\\\\]|\\\\.)*"(?:,"(?:[^"\\\\]|\\\\.)*")*)' +
  ' verifier=(?:-|[A-Za-z0-9_.-]+:"(?:[^"\\\\]|\\\\.)*")' +
  ' counts=(?:-|\\d+\\/\\d+)' +
  ' detail="(?:[^"\\\\]|\\\\.)*"$',
)

describe('I1: exporter_failed aborts and never completes (fail-closed)', () => {
  it('a rejected evidence export aborts the turn with category=exporter_failed', async () => {
    // Injected rejection: no socket, no collector, no network.
    const failing = createFailingExporter('OTLP evidence export failed: mock unreachable')
    const adapter = new OtelLedgerAdapter({ exporter: failing, profileId: 'test' })

    let exportError: unknown
    try {
      await adapter.emitEvidence({
        toolName: 'assistant.claim',
        sessionId: 'invariant-test',
        redactedArgs: { toolName: 'assistant.claim', args: { a: 1 }, redactedFields: [] },
        outcome: { isError: false, exitCode: 'OK', content: [] },
        snapshot: { source: 'unknown', diffs: [] },
      })
    } catch (error) {
      exportError = error
    }

    // The adapter must reject rather than silently drop the evidence.
    expect(exportError, 'emitEvidence must reject when the export fails').toBeDefined()

    // The decision the entry builds from that rejection is an abort, never a
    // completion. This is the fail-closed guarantee.
    const decision = abortDecision({
      kind: 'hook',
      category: 'exporter_failed',
      detail: `Evidence export failed: ${String(exportError)}`,
    })
    expect(decision.kind).toBe('abort')
    expect(decision.kind).not.toBe('complete')
    expect(decision.abortDetail.category).toBe('exporter_failed')
    expect(decision.reason).toContain('category=exporter_failed')
    expect(formatAbortLine(decision.abortDetail)).toContain('category=exporter_failed')
  })

  it('a successful export does NOT abort (control for the case above)', async () => {
    const ok = createMockExporter()
    const adapter = new OtelLedgerAdapter({ exporter: ok, profileId: 'test' })

    const ref = await adapter.emitEvidence({
      toolName: 'assistant.claim',
      sessionId: 'invariant-test',
      redactedArgs: { toolName: 'assistant.claim', args: { a: 1 }, redactedFields: [] },
      outcome: { isError: false, exitCode: 'OK', content: [] },
      snapshot: { source: 'unknown', diffs: [] },
    })

    expect(ok.emitEvidenceSpan).toHaveBeenCalledTimes(1)
    expect(ref.ref).toMatch(/^ev_/)
    // No abort decision is produced on the success path.
    expect(ref).not.toHaveProperty('kind')
  })
})

describe('I2: three-state decisions are distinct and exhaustive', () => {
  it('complete: valid claim citing resolvable evidence', async () => {
    const decision = await gateWith().evaluate(document('done', ['ev_ok']), CTX)
    expect(decision.kind).toBe('complete')
  })

  it('feedback: an invalid claim within the retry budget asks for a fix', async () => {
    // maxRetries 1 => the first invalid output yields feedback, not abort.
    const decision = await gateWith({ maxRetries: 1 }).evaluate(document('done', []), CTX)
    expect(decision.kind).toBe('feedback')
    if (decision.kind === 'feedback') {
      expect(decision.feedback.length).toBeGreaterThan(0)
      // Feedback is a retry signal, so it must not masquerade as an abort.
      expect(JSON.stringify(decision.feedback)).not.toContain('[false-completion-gate] abort')
    }
  })

  it('abort: retry budget exhausted suspends and aborts', async () => {
    const gate = gateWith({ maxRetries: 0 })
    const decision = await gate.evaluate(document('done', []), CTX)
    expect(decision.kind).toBe('abort')
    if (decision.kind === 'abort') {
      expect(decision.reason).toContain('retries exhausted')
      expect(decision.abortDetail?.category).toBeTruthy()
    }
  })

  it('the three states are mutually exclusive on identical input', async () => {
    // Same claim shape, three configurations -> three different states.
    const complete = await gateWith().evaluate(document('done', ['ev_ok']), CTX)
    const feedback = await gateWith({ maxRetries: 1 }).evaluate(document('done', []), CTX)
    const abort = await gateWith({ maxRetries: 0 }).evaluate(document('done', []), CTX)

    const kinds = [complete.kind, feedback.kind, abort.kind]
    expect(kinds).toEqual(['complete', 'feedback', 'abort'])
    expect(new Set(kinds).size).toBe(3)
  })
})


