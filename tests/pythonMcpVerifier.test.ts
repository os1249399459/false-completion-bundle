/** TS-side MCP client tests with a mocked Python MCP server. */
import { describe, expect, it, vi } from 'vitest'
import { VerifierDispatcher } from '../src/verifier/verifierDispatcher.js'
import { PythonMcpVerifier, type PythonGroundingMcpClient } from '../src/verifier/pythonMcpVerifier.js'
import type { VerificationClaim } from '../src/adapters/adapters.js'

function claim(text: string, refs: string[] = []): VerificationClaim {
  return {
    claimId: 'claim-1',
    subject: { verification: { type: 'python', text }, claimText: text },
    evidenceRefs: refs,
  }
}

function mockClient(response: Record<string, unknown>) {
  const callTool = vi.fn().mockResolvedValue(response)
  return { client: { callTool } as unknown as PythonGroundingMcpClient, callTool }
}

function dispatcher(client: PythonGroundingMcpClient) {
  return new VerifierDispatcher({ adapters: { python: new PythonMcpVerifier(client) } })
}

describe('PythonMcpVerifier', () => {
  it('routes a factual claim to the Python verifier with evidence refs', async () => {
    const { client, callTool } = mockClient({
      kind: 'pass',
      rationale: 'deterministic support',
      evidence_ref: 'py:abc',
      deterministic_signals: [{ source: 'deterministic', score: 1 }],
    })
    const result = await dispatcher(client).dispatch(claim('the deployment succeeded', ['ev1']))
    expect(result.kind).toBe('pass')
    expect(callTool).toHaveBeenCalledWith('verify_claim', {
      claim_text: 'the deployment succeeded',
      evidence_refs: ['ev1'],
    })
    expect(result.evidenceRef).toBe('py:abc')
  })

  it('downgrades a judge-only pass to unknown', async () => {
    const { client } = mockClient({
      kind: 'pass',
      rationale: 'judge says yes',
      evidence_ref: 'py:judge',
      deterministic_signals: [],
      judge: { name: 'ragas', score: 0.99 },
    })
    const result = await dispatcher(client).dispatch(claim('unsupported flux claim', ['missing']))
    expect(result.kind).toBe('unknown')
    if (result.kind === 'unknown') expect(result.reason).toContain('Judge-only')
  })

  it('passes through a fail from the Python verifier', async () => {
    const { client } = mockClient({
      kind: 'fail',
      rationale: 'signal below threshold',
      evidence_ref: 'py:fail',
      deterministic_signals: [{ source: 'deterministic', score: 0.1 }],
    })
    const result = await dispatcher(client).dispatch(claim('tests passed', ['ev1']))
    expect(result.kind).toBe('fail')
  })

  it('returns unknown on MCP errors instead of throwing', async () => {
    const client = { callTool: vi.fn().mockRejectedValue(new Error('server down')) } as unknown as PythonGroundingMcpClient
    const result = await dispatcher(client).dispatch(claim('anything', ['ev1']))
    expect(result.kind).toBe('unknown')
  })
})
