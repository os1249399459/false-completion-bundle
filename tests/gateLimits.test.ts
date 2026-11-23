/** Hard divergence limits: budgets, progress detection, structured aborts. */
import { describe, expect, it } from 'vitest'
import { CompletionGate, hasProgress, progressSnapshot } from '../src/gate/completionGate.js'
import type { LedgerReader } from '../src/adapters/ledgerAdapter.js'
import type { CompletionContext } from '../src/adapters/adapters.js'
import type { ClaimStatus } from '../src/schema/claim.schema.js'
import type { SuspendAdapter } from '../src/gate/suspendAdapter.js'

const ledger: LedgerReader = { getEntry: (ref) => ({ ref, ok: true }) }
const CTX: CompletionContext = { sessionId: 't', turn: 1, concludesTurn: false, signal: new AbortController().signal }

function makeGate(config: Record<string, unknown> = {}) {
  const seen: string[] = []
  const suspend: SuspendAdapter = {
    suspend: async (c) => {
      seen.push(String(c.issues[0]?.message ?? ''))
      return { kind: 'suspended', reason: 'suspended by test' }
    },
  }
  const gate = new CompletionGate({ ledger, suspendAdapter: suspend, sessionId: 't', ...config } as never)
  return { gate, seen }
}

function claim(status: ClaimStatus = 'blocked', evidence: string[] = []) {
  return { claims: [{ text: 'x', status, evidence_ids: evidence, verification: {}, open_questions: ['q'], unverified_assumptions: [] }] }
}

describe('progressSnapshot / hasProgress', () => {
  it('advancing status, new evidence, or new verifier verdict is progress', () => {
    const base = progressSnapshot(claim('blocked'))
    expect(hasProgress(base, progressSnapshot(claim('done')))).toBe(true)
    expect(hasProgress(base, progressSnapshot(claim('blocked', ['ev1'])))).toBe(true)
    expect(hasProgress(base, progressSnapshot(claim('blocked'), ['pass']))).toBe(true)
  })

  it('identical claims and no verifier change are NOT progress', () => {
    const base = progressSnapshot(claim('blocked', ['ev1']))
    expect(hasProgress(base, progressSnapshot(claim('blocked', ['ev1'])))).toBe(false)
  })

  it('a repeated tool call does not count as progress', () => {
    const base = progressSnapshot(claim('blocked'), [])
    // repetition is not represented in any progress dimension -> identical
    expect(hasProgress(base, progressSnapshot(claim('blocked'), []))).toBe(false)
  })
})

describe('hard divergence limits', () => {
  it('maxStepsPerTurn aborts at 21/20 with structured reason', async () => {
    const { gate, seen } = makeGate({ maxStepsPerTurn: 20, maxToolCallsPerTurn: 1000, maxConsecutiveNoProgressSteps: 1000 })
    let decision
    for (let i = 0; i < 21; i++) decision = await gate.evaluate(claim('blocked'), CTX)
    expect(decision?.kind).toBe('abort')
    expect((decision as { reason: string } | undefined)?.reason).toContain('step_budget_exceeded (21/20)')
    expect((decision as { abortDetail?: { limit?: string; category?: string } } | undefined)?.abortDetail?.category).toBe('step_budget_exceeded')
    expect(seen[0]).toContain('step_budget_exceeded (21/20)')
  })

  it('maxToolCallsPerTurn aborts at 31/30', async () => {
    const { gate } = makeGate({ maxStepsPerTurn: 1000, maxToolCallsPerTurn: 30, maxConsecutiveNoProgressSteps: 1000 })
    await gate.evaluate(claim('blocked'), CTX) // initializes turn, step 1
    for (let i = 0; i < 31; i++) gate.noteToolCall(1)
    const d = await gate.evaluate(claim('blocked'), CTX)
    expect(d.kind).toBe('abort')
    expect((d as { reason: string }).reason).toContain('tool_call_budget_exceeded (31/30)')
  })

  it('no-progress counter aborts at 3/3 and resets on real progress', async () => {
    const { gate } = makeGate({ maxStepsPerTurn: 1000, maxToolCallsPerTurn: 1000, maxConsecutiveNoProgressSteps: 3 })
    await gate.evaluate(claim('blocked'), CTX) // initial: progress, count 0
    await gate.evaluate(claim('blocked'), CTX) // count 1
    await gate.evaluate(claim('done'), CTX)    // progress -> reset 0
    await gate.evaluate(claim('done'), CTX)    // count 1
    await gate.evaluate(claim('done'), CTX)    // count 2
    const d = await gate.evaluate(claim('done'), CTX) // count 3 -> abort
    expect(d.kind).toBe('abort')
    expect((d as { reason: string }).reason).toContain('no_progress_exceeded (3/3)')
  })

  it('limits respect explicit overrides', async () => {
    const { gate } = makeGate({ maxStepsPerTurn: 2, maxToolCallsPerTurn: 1000, maxConsecutiveNoProgressSteps: 1000 })
    await gate.evaluate(claim('blocked'), CTX) // step 1
    const d = await gate.evaluate(claim('blocked'), CTX) // step 2
    expect(d.kind).toBe('complete') // step 2 = valid claim, at limit but not over
    const d2 = await gate.evaluate(claim('blocked', ['ev1']), CTX) // step 3 -> over? progress resets no-progress but steps exceed
    expect(d2.kind).toBe('abort')
    expect((d2 as { reason: string }).reason).toContain('step_budget_exceeded (3/2)')
  })

  it('backward-compatible string reason still present', async () => {
    const { gate } = makeGate({ maxStepsPerTurn: 1, maxToolCallsPerTurn: 1000, maxConsecutiveNoProgressSteps: 1000 })
    await gate.evaluate(claim('blocked'), CTX)
    const d = await gate.evaluate(claim('blocked'), CTX)
    expect(d.kind).toBe('abort')
    expect((d as { reason: string }).reason).toContain('Completion gate suspended:')
    expect(typeof (d as { reason: string }).reason).toBe('string')
  })

  it('new turn resets divergence counters', async () => {
    const { gate } = makeGate({ maxStepsPerTurn: 2, maxToolCallsPerTurn: 1000, maxConsecutiveNoProgressSteps: 1000 })
    await gate.evaluate(claim('blocked'), CTX)
    await gate.evaluate(claim('blocked'), CTX)
    const fresh = await gate.evaluate(claim('blocked'), { ...CTX, turn: 2 })
    expect(fresh.kind).toBe('complete')
  })
})
