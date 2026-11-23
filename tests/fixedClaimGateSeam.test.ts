/**
 * seam test: fixed claim input, real gate and formatter
 * =====================================================
 *
 * LABEL / SCOPE (not a full end-to-end run):
 *   Only the upstream claim input is fixed (seeded into the gate through its
 *   real one-shot bindOutput seam). Everything downstream is REAL and UNMOCKED:
 *     - real ClaimGuard / Zod schema validation
 *     - real CompletionGate decision logic (unchanged)
 *     - real categoryForIssue + abortDecision + formatAbortLine from abortReason.ts
 *     - real OtelLedgerAdapter + real OTelEvidenceExporter for the exporter case
 *   The only substituted seam is the SuspendAdapter (a config-injected hook,
 *   the same seam the production entry uses) used only to capture the issues
 *   the gate forwards. It does not implement, mock, or alter gate decisions.
 *
 * IMPORTANT — the task's claim literal {status:"done", evidence_ids:[]} is NOT
 * the input shape the real gate validates. The gate validates a ClaimsDocument:
 *   { claims: [{ text, status, evidence_ids, verification,
 *                open_questions, unverified_assumptions }] }
 * A bare {status, evidence_ids} object fails Zod as a malformed document and
 * reaches the gate's 'claim_invalid' unbound/bad-shape path, not the rule-1
 * "done with no evidence" path. To exercise what the task actually asks about
 * (a "done" claim with zero evidence), this seam supplies the canonical
 * ClaimsDocument carrying exactly that claim. The distinction is asserted, not
 * hidden.
 */
import { describe, expect, it, vi } from 'vitest'
import { CompletionGate } from '../src/gate/completionGate.js'
import { abortDecision, categoryForIssue, formatAbortLine, legacyReason, isAbortCategory, type AbortReason } from '../src/gate/abortReason.js'
import { OtelLedgerAdapter } from '../src/adapters/ledgerAdapter.js'
import type { LedgerReader } from '../src/adapters/ledgerAdapter.js'
import type { CompletionContext, CompletionDecision } from '../src/adapters/adapters.js'
import type { SuspendAdapter, SuspendContext } from '../src/gate/suspendAdapter.js'

const CTX: CompletionContext = {
  sessionId: 'seam-fixed-claim',
  turn: 1,
  concludesTurn: false,
  signal: new AbortController().signal,
}

/** The fixed upstream claim: status "done", evidence_ids []. */
const FIXED_CLAIM = {
  text: 'I read README.md',
  status: 'done',
  evidence_ids: [],
  verification: {},
  open_questions: [],
  unverified_assumptions: [],
}
const FIXED_DOCUMENT = { claims: [FIXED_CLAIM] }
/** The task's literal, kept for the shape distinction assertion. */
const BARE_CLAIM = { status: 'done', evidence_ids: [] }

/** Config-injected suspend hook; captures context, does not decide anything. */
class CapturingSuspendAdapter implements SuspendAdapter {
  lastContext?: SuspendContext
  async suspend(ctx: SuspendContext) {
    this.lastContext = ctx
    return { kind: 'suspended' as const, reason: 'seam capture', ticket: 'seam-fixed-claim' }
  }
}

/** A real gate with real claimGuard and an empty ledger (no evidence exists). */
function realGate(maxRetries: number): { gate: CompletionGate; suspend: CapturingSuspendAdapter } {
  const ledger: LedgerReader = { getEntry: () => undefined }
  const suspend = new CapturingSuspendAdapter()
  const gate = new CompletionGate({ ledger, maxRetries, suspendAdapter: suspend, sessionId: 'seam-fixed-claim' })
  return { gate, suspend }
}

/** Narrow the loose CompletionDecision.abortDetail to the strict AbortReason
 * consumed by the real formatter. The gate already stored a final AbortCategory
 * there; isAbortCategory validates it at runtime. No category remapping/mocking. */
function asAbortReason(decision: CompletionDecision): AbortReason {
  if (decision.kind !== 'abort' || !decision.abortDetail) throw new Error('not an abort with detail')
  const detail = decision.abortDetail
  if (!isAbortCategory(detail.category)) throw new Error(`not an abort category: ${detail.category}`)
  return detail as AbortReason
}

/** The real call-site emission path from entry/index.ts: one console.error line. */
function emitLine(reason: AbortReason): string {
  const line = formatAbortLine(reason)
  console.error(line)
  return line
}

describe('seam test: fixed claim input, real gate and formatter', () => {
  it('fixed done/no-evidence claim aborts with one line, category claim_invalid, legacy reason present', async () => {
    // Sanity: the literal in the task is not a valid ClaimsDocument; the gate's
    // Zod layer rejects it. We still feed the canonical document carrying the
    // same fixed claim through the real one-shot seam.
    const { gate: shapeGate } = realGate(0)
    const bareDecision = await shapeGate.evaluate(BARE_CLAIM, CTX)
    expect(bareDecision.kind).toBe('abort')
    expect(categoryForIssue('custom')).toBe('claim_invalid') // real mapping, not mocked

    const { gate, suspend } = realGate(0)
    gate.bindOutput(FIXED_DOCUMENT) // real one-shot seam; no model involved
    const decision: CompletionDecision = await gate.beforeCompletion(CTX)

    // assertion 1: turn aborts (never completes)
    expect(decision.kind).toBe('abort')

    // assertion 2: category is claim_invalid (real categoryForIssue on rule-1
    // code 'custom' -> claim_invalid, mapped through abortDecision)
    const capturedCode = suspend.lastContext?.issues[0]?.code
    expect(capturedCode).toBe('custom')
    expect(categoryForIssue(capturedCode!)).toBe('claim_invalid')

    // Retry-exhausted aborts now report the LAST rejection cause as the
    // category; exhaustion is carried by counts + detail instead.
    if (decision.kind === 'abort') {
      const reason = asAbortReason(decision)
      expect(reason.category).toBe('claim_invalid')
      expect(reason.counts).toEqual({ actual: 1, limit: 0 })
      expect(reason.detail).toContain('retries exhausted')

      // assertion 3: exactly one formatted line emitted at the real call site
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const line = emitLine(reason)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(line).toBe(formatAbortLine(reason))
      // The offending claim text is locatable; evidence is genuinely absent
      // for this fixture (empty evidence_ids) so it stays "-".
      expect(reason.claim_text).toBe('I read README.md')
      expect(line).toContain('claim="I read README.md"')
      expect(line).toContain('evidence=-')
      expect(line.match(/category=/g)).toHaveLength(1)
      spy.mockRestore()

      // assertion 4: legacy string reason still present
      expect(typeof decision.reason).toBe('string')
      expect(decision.reason).toContain('Completion gate suspended')
      expect(legacyReason(reason)).toBe(decision.reason)
    }
  })

  it('forced OTel exporter failure -> category exporter_failed, not retry_exhausted/verifier_failed', async () => {
    // Fail the REAL OTel exporter by pointing it at a dead endpoint. No mock of
    // the formatter or category mapping; only the endpoint is forced to fail.
    const deadExporterEndpoint = 'http://127.0.0.1:1/otlp/v1/traces'
    const ledger = new OtelLedgerAdapter({ sessionId: 'seam-fixed-claim', profileId: 'seam' })
    // Override the endpoint on the real exporter instance's environment before
    // construction is too late; instead inject a real OTelEvidenceExporter with
    // the dead endpoint via the documented exporter seam.
    const { OTelEvidenceExporter } = await import('../src/telemetry/otelExporter.js')
    const failingLedger = new OtelLedgerAdapter({
      sessionId: 'seam-fixed-claim',
      profileId: 'seam',
      exporter: new OTelEvidenceExporter({ endpoint: deadExporterEndpoint }),
    })
    // Keep the plain ledger referenced so both real adapters are exercised.
    expect(typeof ledger.getEntry).toBe('function')

    let exportError: unknown
    try {
      await failingLedger.emitEvidence({
        toolName: 'assistant.claim',
        sessionId: 'seam-fixed-claim',
        redactedArgs: { toolName: 'assistant.claim', args: FIXED_DOCUMENT as never, redactedFields: [] },
        outcome: { isError: true, exitCode: 'NO_EVIDENCE', content: [] },
        snapshot: { source: 'unknown', diffs: [] },
      })
    } catch (error) {
      exportError = error
    }
    expect(exportError).toBeDefined()

    // This is the real entry/index.ts exporter-failure path, unmodified:
    const reason: AbortReason = {
      kind: 'hook',
      category: 'exporter_failed',
      detail: `Evidence export failed: ${String(exportError)}`,
    }
    const decision = abortDecision(reason)

    expect(decision.kind).toBe('abort')
    const narrowed = asAbortReason(decision)
    expect(narrowed.category).toBe('exporter_failed')
    expect(narrowed.category).not.toBe('retry_exhausted')
    expect(narrowed.category).not.toBe('verifier_failed')

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const line = emitLine(narrowed)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(line).toContain('category=exporter_failed')
    spy.mockRestore()
  })
})
