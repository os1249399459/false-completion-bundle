/**
 * Filesystem MCP verifier — checks file existence and content hash using an
 * existing Filesystem MCP server. No custom filesystem MCP implementation.
 * The MCP client is injected; its server config lives in the profile patch (profiles/minimal.yml).
 */
import { createHash } from 'node:crypto'
import type { JsonValue, VerificationClaim, Verdict, VerifierAdapter } from '../adapters/adapters.js'

/** Minimal structural view of an existing Filesystem MCP client. */
export interface FilesystemMcpClient {
  readFile(args: { path: string }): Promise<{ content?: string; exists?: boolean; error?: string }>
}

interface FilesystemSpec {
  path: string
  expectedSha256?: string
  mustExist: boolean
}

function readSpec(claim: VerificationClaim): FilesystemSpec | undefined {
  const subject = claim.subject
  if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return undefined
  const verification = (subject as Record<string, JsonValue>).verification
  if (verification === null || typeof verification !== 'object' || Array.isArray(verification)) return undefined
  const raw = verification as Record<string, JsonValue>
  if (typeof raw.path !== 'string' || raw.path.length === 0) return undefined
  const expected = raw.sha256
  return {
    path: raw.path,
    ...(typeof expected === 'string' && expected.length > 0 ? { expectedSha256: expected } : {}),
    mustExist: raw.mustExist !== false,
  }
}

export class FilesystemMcpVerifier implements VerifierAdapter {
  constructor(private readonly client: FilesystemMcpClient) {}

  async verify(claim: VerificationClaim): Promise<Verdict> {
    const spec = readSpec(claim)
    if (!spec) return { kind: 'unknown', reason: 'Filesystem verification requires a path' }

    let result: { content?: string; exists?: boolean; error?: string }
    try {
      result = await this.client.readFile({ path: spec.path })
    } catch (error) {
      return { kind: 'fail', detail: this.detail(spec, undefined, `MCP error: ${String(error)}`, false) }
    }

    if (result.error || result.exists === false || (spec.mustExist && result.content === undefined)) {
      return { kind: 'fail', detail: this.detail(spec, undefined, result.error ?? 'file missing', false) }
    }

    const actualHash = createHash('sha256').update(result.content ?? '', 'utf8').digest('hex')
    const matches = spec.expectedSha256 ? actualHash === spec.expectedSha256 : true
    return {
      kind: matches ? 'pass' : 'fail',
      detail: this.detail(spec, actualHash, undefined, matches),
    }
  }

  private detail(spec: FilesystemSpec, sha256: string | undefined, error: string | undefined, ok: boolean): JsonValue {
    const evidenceRef = `fs:${sha256?.slice(0, 32) ?? createHash('sha256').update(`${spec.path}:${error ?? ''}`).digest('hex').slice(0, 32)}`
    return { evidenceRef, path: spec.path, sha256: sha256 ?? null, ok, error: error ?? null }
  }
}
