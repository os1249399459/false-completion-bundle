import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { VerifierDispatcher } from '../src/verifier/verifierDispatcher.js'
import { CliVerifier } from '../src/verifier/cliVerifier.js'
import { FilesystemMcpVerifier } from '../src/verifier/filesystemMcpVerifier.js'
import { PlaywrightMcpVerifier } from '../src/verifier/playwrightMcpVerifier.js'
import type { VerificationClaim, JsonValue, Verdict, VerifierAdapter } from '../src/adapters/adapters.js'

function claim(type: string, fields: Record<string, JsonValue> = {}): VerificationClaim {
  return {
    claimId: 'claim-1',
    subject: { verification: { type, ...fields } },
    evidenceRefs: [],
  }
}

function dispatcher(adapters: Record<string, VerifierAdapter>) {
  return new VerifierDispatcher({ adapters })
}

describe('VerifierDispatcher', () => {
  it('returns fail when a test command fails (exit code driven)', async () => {
    const adapter: VerifierAdapter = {
      verify: async () => ({
        kind: 'fail',
        detail: {
          evidenceRef: 'cli:mock',
          reason: 'failing test command returns fail',
        },
      }),
    }
    const result = await dispatcher({ cli: adapter }).dispatch(claim('cli', { command: 'vitest' }))
    expect(result.kind).toBe('fail')
    expect(result.type).toBe('cli')
    expect(result.evidenceRef).toBe('cli:mock')
  })

  it('returns fail for a missing file via mocked Filesystem MCP', async () => {
    const client = { readFile: vi.fn().mockResolvedValue({ exists: false, error: 'ENOENT' }) }
    const result = await dispatcher({ filesystem: new FilesystemMcpVerifier(client) }).dispatch(
      claim('filesystem', { path: '/missing/file.txt' }),
    )
    expect(result.kind).toBe('fail')
    expect(client.readFile).toHaveBeenCalledWith({ path: '/missing/file.txt' })
  })

  it('returns pass for a matching content hash via mocked Filesystem MCP', async () => {
    const content = 'verified content'
    const sha256 = createHash('sha256').update(content).digest('hex')
    const client = { readFile: vi.fn().mockResolvedValue({ exists: true, content }) }
    const result = await dispatcher({ filesystem: new FilesystemMcpVerifier(client) }).dispatch(
      claim('filesystem', { path: 'src/index.ts', sha256 }),
    )
    expect(result.kind).toBe('pass')
  })

  it('returns fail for a failed Playwright assertion via mocked MCP', async () => {
    const client = {
      assert: vi.fn().mockResolvedValue({ ok: false, observed: 'Element not found', error: 'timeout' }),
    }
    const result = await dispatcher({ playwright: new PlaywrightMcpVerifier(client) }).dispatch(
      claim('playwright', { selector: '#submit', text: 'Submit' }),
    )
    expect(result.kind).toBe('fail')
    expect(client.assert).toHaveBeenCalled()
  })

  it('returns pass for a successful Playwright assertion via mocked MCP', async () => {
    const client = { assert: vi.fn().mockResolvedValue({ ok: true, observed: 'Submit' }) }
    const result = await dispatcher({ playwright: new PlaywrightMcpVerifier(client) }).dispatch(
      claim('playwright', { text: 'Submit' }),
    )
    expect(result.kind).toBe('pass')
  })

  it('returns unknown for an unregistered verification type, never pass', async () => {
    const adapter: VerifierAdapter = { verify: async (): Promise<Verdict> => ({ kind: 'pass' }) }
    const result = await dispatcher({ cli: adapter }).dispatch(claim('llm-judge'))
    expect(result.kind).toBe('unknown')
    if (result.kind === 'unknown') expect(result.reason).toContain('Unsupported')
    expect(result.evidenceRef).toBeUndefined()
  })

  it('CLI verifier rejects a non-allowlisted command as unknown', async () => {
    const verifier = new CliVerifier({ allowedCommands: ['vitest'] })
    const result = await verifier.verify(claim('cli', { command: 'rm' }))
    expect(result.kind).toBe('unknown')
  })

  it('CLI verifier is exit-code driven and hashes captured output', async () => {
    const verifier = new CliVerifier({ allowedCommands: ['node'] })
    const result = await verifier.verify(
      claim('cli', { command: 'node', args: ['-e', "process.stdout.write('ok')"] }),
    )
    expect(result.kind).toBe('pass')
    if (result.kind === 'pass' && result.detail && typeof result.detail === 'object' && !Array.isArray(result.detail)) {
      const detail = result.detail as Record<string, JsonValue>
      expect(typeof detail.outputHash).toBe('string')
      expect(String(detail.evidenceRef)).toMatch(/^cli:/)
    }
  })
})
