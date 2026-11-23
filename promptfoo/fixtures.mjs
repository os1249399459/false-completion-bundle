/**
 * Promptfoo custom provider for false-completion regression cases.
 *
 * Default-export class as required by Promptfoo's file:// provider loader.
 * Calls exported CompletionGate / DocumentedSuspendAdapter symbols only;
 * no P1-P3 implementation is modified or reimplemented.
 */
import { CompletionGate } from '../.promptfoo-build/src/gate/completionGate.js'
import { DocumentedSuspendAdapter } from '../.promptfoo-build/src/gate/suspendAdapter.js'
import { VerifierDispatcher } from '../.promptfoo-build/src/verifier/verifierDispatcher.js'
import { PythonMcpVerifier } from '../.promptfoo-build/src/verifier/pythonMcpVerifier.js'

function makeLedger(map) {
  const entries = new Map(
    Object.entries(map || {}).map(([ref, ok]) => [ref, { ref, ok }]),
  )
  return { getEntry: (ref) => entries.get(ref) }
}

export default class FalseCompletionGateProvider {
  constructor(options = {}) {
    this.label = options.id || 'false-completion-gate'
  }

  id() {
    return this.label
  }

  async callApi(_prompt, context) {
    const vars = context?.vars || {}
    let claim
    try {
      claim = typeof vars.claim === 'string' ? JSON.parse(vars.claim) : vars.claim
    } catch (error) {
      return { output: JSON.stringify({ kind: 'abort', reason: `invalid fixture JSON: ${error.message}` }) }
    }

    // Optional verifier path: a case may describe a mocked Python MCP server
    // response; only a real deterministic pass yields an ok ledger entry.
    let ledgerMap = vars.ledger || {}
    let verdictKind = null
    if (vars.verifierMock) {
      const mock = typeof vars.verifierMock === 'string'
        ? JSON.parse(vars.verifierMock)
        : vars.verifierMock
      const client = {
        callTool: async () => mock,
      }
      const dispatcher = new VerifierDispatcher({
        adapters: { python: new PythonMcpVerifier(client) },
      })
      const firstClaim = claim && claim.claims && claim.claims[0]
      const verdict = await dispatcher.dispatch({
        claimId: 'promptfoo',
        subject: { verification: { type: 'python', claimText: (firstClaim && firstClaim.text) || '' } },
        evidenceRefs: (firstClaim && firstClaim.evidence_ids) || [],
      })
      verdictKind = verdict.kind
      const ref = (firstClaim && firstClaim.evidence_ids && firstClaim.evidence_ids[0])
      if (ref && typeof ledgerMap === 'object') {
        ledgerMap = { ...ledgerMap, [ref]: verdict.kind === 'pass' }
      }
    }

    const gate = new CompletionGate({
      ledger: makeLedger(ledgerMap),
      maxRetries: vars.maxRetries === undefined ? 1 : Number(vars.maxRetries),
      suspendAdapter: new DocumentedSuspendAdapter(),
      sessionId: 'promptfoo',
    })
    const ctx = {
      sessionId: 'promptfoo',
      turn: Number(vars.turn || 1),
      concludesTurn: false,
      signal: new AbortController().signal,
    }

    let decision
    let lastCodes = []
    try {
      const first = await gate.evaluate(claim, ctx)
      lastCodes = first.kind === 'feedback'
        ? ((first.feedback[1] && first.feedback[1].issues) || []).map((issue) => issue.code)
        : []
      decision = first
      // Simulate retry exhaustion: a second invalid claim after feedback.
      if (decision.kind === 'feedback') {
        decision = await gate.evaluate(claim, ctx)
      }
    } catch (error) {
      decision = { kind: 'abort', reason: `gate threw: ${error.message}` }
    }

    return {
      output: JSON.stringify({
        kind: decision.kind,
        reason: decision.reason,
        codes: lastCodes,
        verdictKind,
      }),
    }
  }
}
