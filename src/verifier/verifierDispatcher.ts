/**
 * Deterministic verifier dispatch. Routes a claim to exactly one adapter by
 * claim.verification.type. Unknown types return `unknown`, never `pass`.
 *
 * No LLM judge. No custom runner, browser, or MCP server: each adapter calls
 * an existing tool through an injected client interface.
 */
import type { JsonValue, VerificationClaim, Verdict, VerifierAdapter } from '../adapters/adapters.js'

export interface VerifierResultBase {
  /** Stable claim id echoed back for correlation. */
  readonly claimId: string
  /** Verification type that produced the verdict. */
  readonly type: string
  /** Evidence reference (hash/id) supporting the verdict, when available. */
  readonly evidenceRef?: string
}

export type VerifierResult =
  | (VerifierResultBase & { readonly kind: 'pass'; readonly detail?: JsonValue })
  | (VerifierResultBase & { readonly kind: 'fail'; readonly detail?: JsonValue })
  | (VerifierResultBase & { readonly kind: 'unknown'; readonly reason: string })

export interface VerificationPayload {
  readonly type: string
  readonly [key: string]: JsonValue | undefined
}

/** Read verification.type from the claim's redacted subject. */
export function verificationType(claim: VerificationClaim): string {
  const subject = claim.subject
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return 'unknown'
  const type = (subject as Record<string, JsonValue>).verification
  if (type === null || typeof type !== 'object' || Array.isArray(type)) return 'unknown'
  const value = (type as Record<string, JsonValue>).type
  return typeof value === 'string' && value.length > 0 ? value : 'unknown'
}

export interface DispatcherOptions {
  readonly adapters: Readonly<Record<string, VerifierAdapter>>
  /** Optional pattern allowlist for verification types; defaults to adapter keys. */
  readonly allowedTypes?: readonly string[]
}

export class VerifierDispatcher {
  constructor(private readonly options: DispatcherOptions) {}

  async dispatch(claim: VerificationClaim, signal?: AbortSignal): Promise<VerifierResult> {
    const type = verificationType(claim)
    const allowed = this.options.allowedTypes ?? Object.keys(this.options.adapters)
    const adapter = allowed.includes(type) ? this.options.adapters[type] : undefined

    if (!adapter) {
      return {
        claimId: claim.claimId,
        type,
        kind: 'unknown',
        reason: `Unsupported verification type "${type}"`,
      }
    }

    const verdict = await adapter.verify(claim, signal)
    return {
      claimId: claim.claimId,
      type,
      ...verdict,
      ...(verdict.kind !== 'unknown' ? { evidenceRef: this.evidenceRefOf(verdict) } : {}),
    }
  }

  private evidenceRefOf(verdict: Verdict): string | undefined {
    if (verdict.kind === 'unknown') return undefined
    const detail = verdict.detail
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return undefined
    const ref = (detail as Record<string, JsonValue>).evidenceRef
    return typeof ref === 'string' ? ref : undefined
  }
}
