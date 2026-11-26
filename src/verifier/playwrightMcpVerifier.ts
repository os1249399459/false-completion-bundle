/**
 * Playwright MCP verifier — asserts element/text/state through an existing
 * Playwright MCP server. No custom browser automation. The MCP client is
 * injected; its server config lives in the profile patch.
 */
import { createHash } from 'node:crypto'
import type { JsonValue, VerificationClaim, Verdict, VerifierAdapter } from '../adapters/adapters.js'

/** Minimal structural view of an existing Playwright MCP client. */
export interface PlaywrightMcpClient {
  assert(args: {
    selector?: string
    text?: string
    state?: string
    url?: string
  }): Promise<{ ok: boolean; observed?: string; error?: string }>
}

interface PlaywrightSpec {
  selector?: string
  text?: string
  state?: string
  url?: string
}

function readSpec(claim: VerificationClaim): PlaywrightSpec | undefined {
  const subject = claim.subject
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return undefined
  const verification = (subject as Record<string, JsonValue>).verification
  if (verification === null || typeof verification !== 'object' || Array.isArray(verification)) return undefined
  const raw = verification as Record<string, JsonValue>
  const spec: PlaywrightSpec = {}
  if (typeof raw.selector === 'string') spec.selector = raw.selector
  if (typeof raw.text === 'string') spec.text = raw.text
  if (typeof raw.state === 'string') spec.state = raw.state
  if (typeof raw.url === 'string') spec.url = raw.url
  return spec.selector || spec.text || spec.state || spec.url ? spec : undefined
}

export class PlaywrightMcpVerifier implements VerifierAdapter {
  constructor(private readonly client: PlaywrightMcpClient) {}

  async verify(claim: VerificationClaim): Promise<Verdict> {
    const spec = readSpec(claim)
    if (!spec) {
      return { kind: 'unknown', reason: 'Playwright verification requires selector/text/state/url' }
    }

    let result: { ok: boolean; observed?: string; error?: string }
    try {
      result = await this.client.assert(spec)
    } catch (error) {
      return { kind: 'fail', detail: this.detail(spec, false, `MCP error: ${String(error)}`, undefined) }
    }

    return {
      kind: result.ok ? 'pass' : 'fail',
      detail: this.detail(spec, result.ok, result.error, result.observed),
    }
  }

  private detail(spec: PlaywrightSpec, ok: boolean, error: string | undefined, observed: string | undefined): JsonValue {
    const fingerprint = createHash('sha256').update(JSON.stringify({ spec, ok, observed: observed ?? null })).digest('hex')
    return {
      evidenceRef: `pw:${fingerprint.slice(0, 32)}`,
      spec: { ...spec } as Record<string, JsonValue>,
      ok,
      error: error ?? null,
      observed: observed ?? null,
    }
  }
}
