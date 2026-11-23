/**
 * End-to-end smoke path: completionGate -> claimGuard -> verifierDispatcher
 * -> pythonMcpVerifier -> mocked FastMCP server. No live LLM or Langfuse.
 */
import { describe, expect, it, vi } from 'vitest'
import { CompletionGate } from '../src/gate/completionGate.js'
import { DocumentedSuspendAdapter } from '../src/gate/suspendAdapter.js'
import { VerifierDispatcher } from '../src/verifier/verifierDispatcher.js'
import { PythonMcpVerifier, type PythonGroundingMcpClient } from '../src/verifier/pythonMcpVerifier.js'
import type { LedgerReader, LedgerEntry } from '../src/adapters/ledgerAdapter.js'
import type { CompletionContext, VerificationClaim } from '../src/adapters/adapters.js'

const VALID_REF = 'ev_valid_0000000000000000000000000000000'

function ledger(entries: Record<string, boolean>): LedgerReader {
  const map = new Map<string, LedgerEntry>(
    Object.entries(entries).map(([ref, ok]) => [ref, { ref, ok }]),
  )
  return { getEntry: (ref) => map.get(ref) }
}

const ctx: CompletionContext = {
  sessionId: 'e2e',
  turn: 1,
  concludesTurn: false,
  signal: new AbortController().signal,
}

function claimDoc(evidenceRefs: string[]) {
  return {
    claims: [{
      text: 'The deployment succeeded.',
      status: 'done',
      evidence_ids: evidenceRefs,
      verification: { type: 'python', claimText: 'The deployment succeeded.' },
      open_questions: [],
      unverified_assumptions: [],
    }],
  }
}

function pythonClaim(refs: string[]): VerificationClaim {
  return {
    claimId: 'e2e-claim',
    subject: { verification: { type: 'python', claimText: 'The deployment succeeded.' } },
    evidenceRefs: refs,
  }
}

// Downgrade verdicts to a ledger ok bit, then feed the gate a claim whose
// evidence reflects the verifier outcome (verified pass -> ok=true ledger).
async function runPath(verifierResponse: Record<string, unknown>) {
  const callTool = vi.fn().mockResolvedValue(verifierResponse)
  const client = { callTool } as unknown as PythonGroundingMcpClient
  const dispatcher = new VerifierDispatcher({ adapters: { python: new PythonMcpVerifier(client) } })
  const verdict = await dispatcher.dispatch(pythonClaim([VALID_REF]))
  const ledgerOk = verdict.kind === 'pass'
  const gate = new CompletionGate({
    ledger: ledger({ [VALID_REF]: ledgerOk }),
    maxRetries: 1,
    suspendAdapter: new DocumentedSuspendAdapter(),
    sessionId: 'e2e',
  })
  const decision = await gate.evaluate(claimDoc([VALID_REF]), ctx)
  return { verdict, decision, callTool }
}

describe('end-to-end gate -> claimGuard -> dispatcher -> python MCP', () => {
  it('Case A: Python verifier fail -> gate rejects completion', async () => {
    const { verdict, decision } = await runPath({
      kind: 'fail',
      rationale: 'deterministic signal below threshold',
      evidence_ref: 'py:fail',
      deterministic_signals: [{ source: 'deterministic', score: 0.1 }],
    })
    expect(verdict.kind).toBe('fail')
    expect(decision.kind).toBe('feedback')
    if (decision.kind === 'feedback') {
      const payload = decision.feedback[1] as { issues: { code: string }[] }
      expect(payload.issues.some((issue) => issue.code === 'evidence_failed')).toBe(true)
    }
  })

  it('Case B: deterministic pass -> gate may allow completion', async () => {
    const { verdict, decision, callTool } = await runPath({
      kind: 'pass',
      rationale: 'deterministic support',
      evidence_ref: 'py:pass',
      deterministic_signals: [{ source: 'deterministic', score: 1 }],
    })
    expect(verdict.kind).toBe('pass')
    expect(callTool).toHaveBeenCalledWith('verify_claim', {
      claim_text: 'The deployment succeeded.',
      evidence_refs: [VALID_REF],
    })
    expect(decision).toEqual({ kind: 'complete' })
  })

  it('Case C: judge-only pass -> downgraded to unknown -> gate does not pass', async () => {
    const { verdict, decision } = await runPath({
      kind: 'pass',
      rationale: 'judge says yes',
      evidence_ref: 'py:judge',
      deterministic_signals: [],
      judge: { name: 'ragas', score: 0.99 },
    })
    expect(verdict.kind).toBe('unknown')
    expect(decision.kind).toBe('feedback')
    if (decision.kind === 'feedback') {
      const payload = decision.feedback[1] as { issues: { code: string }[] }
      expect(payload.issues.some((issue) => issue.code === 'evidence_failed')).toBe(true)
    }
  })
})
