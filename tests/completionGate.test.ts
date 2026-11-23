import { describe, expect, it, vi } from 'vitest'
import { CompletionGate } from '../src/gate/completionGate.js'
import { DocumentedSuspendAdapter } from '../src/gate/suspendAdapter.js'
import type { LedgerReader, LedgerEntry } from '../src/adapters/ledgerAdapter.js'
import type { CompletionContext } from '../src/adapters/adapters.js'

const GOOD = 'ev_good_00000000000000000000000000000000'
const STALE = 'ev_stale_0000000000000000000000000000000'
const FAILED = 'ev_failed_0000000000000000000000000000000'

function ledger(entries: Record<string, boolean>): LedgerReader {
  const map = new Map<string, LedgerEntry>(
    Object.entries(entries).map(([ref, ok]) => [ref, { ref, ok }]),
  )
  return { getEntry: (ref: string) => map.get(ref) }
}

const ctx: CompletionContext = {
  sessionId: 'session-1',
  turn: 3,
  concludesTurn: false,
  signal: new AbortController().signal,
}

function makeGate(entryMap: Record<string, boolean>, maxRetries = 2) {
  const suspend = new DocumentedSuspendAdapter()
  const gate = new CompletionGate({
    ledger: ledger(entryMap),
    maxRetries,
    suspendAdapter: suspend,
    sessionId: 'session-1',
  })
  return { gate, suspend }
}

function claim(status: string, evidenceIds: string[], extra: Record<string, unknown> = {}) {
  return {
    claims: [{ text: 'test claim', status, evidence_ids: evidenceIds, verification: {}, open_questions: [], unverified_assumptions: [], ...extra }],
  }
}

describe('CompletionGate', () => {
  it('rejects a done claim with no evidence and injects structured feedback', async () => {
    const { gate } = makeGate({ [GOOD]: true })
    const decision = await gate.evaluate(claim('done', []), ctx)
    expect(decision.kind).toBe('feedback')
    if (decision.kind === 'feedback') {
      const payload = decision.feedback[1] as { issues: { code: string }[] }
      expect(payload.issues.some((issue) => issue.code === 'custom')).toBe(true)
    }
  })

  it('rejects stale evidence (unresolved ledger entry)', async () => {
    const { gate } = makeGate({ [GOOD]: true })
    const decision = await gate.evaluate(claim('done', [STALE]), ctx)
    expect(decision.kind).toBe('feedback')
    if (decision.kind === 'feedback') {
      const payload = decision.feedback[1] as { issues: { code: string }[] }
      expect(payload.issues.some((issue) => issue.code === 'evidence_unresolved')).toBe(true)
    }
  })

  it('rejects a failed tool call cited as success', async () => {
    const { gate } = makeGate({ [FAILED]: false })
    const decision = await gate.evaluate(claim('done', [FAILED]), ctx)
    expect(decision.kind).toBe('feedback')
    if (decision.kind === 'feedback') {
      const payload = decision.feedback[1] as { issues: { code: string }[] }
      expect(payload.issues.some((issue) => issue.code === 'evidence_failed')).toBe(true)
    }
  })

  it('passes a valid claim with successful evidence', async () => {
    const { gate } = makeGate({ [GOOD]: true })
    const decision = await gate.evaluate(claim('done', [GOOD]), ctx)
    expect(decision).toEqual({ kind: 'complete' })
    expect(gate.attemptCount).toBe(0)
  })

  it('routes retry exhaustion to suspend, never to fake success', async () => {
    const onSuspend = vi.fn()
    const suspend = new DocumentedSuspendAdapter({ onSuspend })
    const gate = new CompletionGate({
      ledger: ledger({}),
      maxRetries: 1,
      suspendAdapter: suspend,
      sessionId: 'session-1',
    })

    const first = await gate.evaluate(claim('done', []), ctx)
    expect(first.kind).toBe('feedback')

    const second = await gate.evaluate(claim('done', []), ctx)
    expect(second.kind).toBe('abort')
    if (second.kind === 'abort') expect(second.reason).toContain('suspended')
    expect(onSuspend).toHaveBeenCalledOnce()
    expect(suspend.listSuspensions()).toHaveLength(1)
  })

  it('rejects an undisclosed blocked item', async () => {
    const { gate } = makeGate({ [GOOD]: true })
    const decision = await gate.evaluate(claim('blocked', [], { open_questions: [] }), ctx)
    expect(decision.kind).toBe('feedback')
    if (decision.kind === 'feedback') {
      const payload = decision.feedback[1] as { issues: { code: string }[] }
      expect(payload.issues.some((issue) => issue.code === 'undisclosed_unknown')).toBe(true)
    }
  })

  it('accepts a disclosed blocked item', async () => {
    const { gate } = makeGate({})
    const decision = await gate.evaluate(
      claim('blocked', [], { open_questions: ['What is the retry policy?'] }),
      ctx,
    )
    expect(decision).toEqual({ kind: 'complete' })
  })

  it('beforeCompletion uses bound output and never completes unbound', async () => {
    const { gate } = makeGate({ [GOOD]: true })
    const unbound = await gate.beforeCompletion(ctx)
    expect(unbound.kind).toBe('abort')

    gate.bindOutput(claim('done', [GOOD]))
    const bound = await gate.beforeCompletion(ctx)
    expect(bound).toEqual({ kind: 'complete' })
  })
})
