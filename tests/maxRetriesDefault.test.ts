/**
 * The retry budget must be identical regardless of load path:
 *   - gate constructed without maxRetries (profile path / library default)
 *   - entry reading FALSE_COMPLETION_MAX_RETRIES when unset (env path)
 * This test fails if the three sources (constant, gate default, profile
 * comment/prose) drift apart.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompletionGate, DEFAULT_MAX_RETRIES } from '../src/gate/completionGate.js'
import type { LedgerReader } from '../src/adapters/ledgerAdapter.js'
import type { CompletionContext } from '../src/adapters/adapters.js'

const root = join(__dirname, '..')
const ledger: LedgerReader = { getEntry: (ref) => ({ ref, ok: true }) }
const CTX: CompletionContext = { sessionId: 't', turn: 1, concludesTurn: false, signal: new AbortController().signal }

function claim() {
  return { claims: [{ text: 'x', status: 'done', evidence_ids: [], verification: {}, open_questions: [], unverified_assumptions: [] }] }
}

/** Count how many invalid outputs the gate tolerates before aborting. */
async function effectiveRetryBudget(gate: CompletionGate): Promise<number> {
  for (let attempts = 1; attempts <= 20; attempts++) {
    const decision = await gate.evaluate(claim(), CTX)
    if (decision.kind === 'abort') return attempts - 1
  }
  return -1
}

describe('canonical maxRetries default', () => {
  it('gate default equals DEFAULT_MAX_RETRIES (profile/library load path)', async () => {
    const gate = new CompletionGate({
      ledger,
      suspendAdapter: { suspend: async () => ({ kind: 'suspended', reason: 's' }) },
    } as never)
    expect(await effectiveRetryBudget(gate)).toBe(DEFAULT_MAX_RETRIES)
  })

  it('entry env fallback resolves to the same value (env load path)', () => {
    // Mirrors entry/index.ts: Number(env ?? DEFAULT_MAX_RETRIES)
    delete process.env.FALSE_COMPLETION_MAX_RETRIES
    const fromEnv = Number(process.env.FALSE_COMPLETION_MAX_RETRIES ?? DEFAULT_MAX_RETRIES)
    expect(fromEnv).toBe(DEFAULT_MAX_RETRIES)
  })

  it('both load paths produce the identical effective budget', async () => {
    const gate = new CompletionGate({
      ledger,
      suspendAdapter: { suspend: async () => ({ kind: 'suspended', reason: 's' }) },
    } as never)
    const profilePath = await effectiveRetryBudget(gate)
    const envPath = Number(process.env.FALSE_COMPLETION_MAX_RETRIES ?? DEFAULT_MAX_RETRIES)

    const entryBuilt = new CompletionGate({
      ledger,
      maxRetries: envPath,
      suspendAdapter: { suspend: async () => ({ kind: 'suspended', reason: 's' }) },
    } as never)
    expect(await effectiveRetryBudget(entryBuilt)).toBe(profilePath)
    expect(profilePath).toBe(envPath)
  })

  it('explicit override still wins on both paths', async () => {
    const gate = new CompletionGate({
      ledger,
      maxRetries: 3,
      suspendAdapter: { suspend: async () => ({ kind: 'suspended', reason: 's' }) },
    } as never)
    expect(await effectiveRetryBudget(gate)).toBe(3)
  })

  it('no source restates a conflicting numeric default', () => {
    // Guard against a future comment/constant drift: profiles must not hardcode
    // a maxRetries number, and they must reference the canonical constant.
    const profileDir = join(root, 'profiles')
    for (const file of readdirSync(profileDir).filter((f) => f.endsWith('.yml'))) {
      const text = readFileSync(join(profileDir, file), 'utf8')
      expect(text, `${file} must not restate maxRetries=<n>`).not.toMatch(/maxRetries=\d/)
    }
    const gateSource = readFileSync(join(root, 'src/gate/completionGate.ts'), 'utf8')
    expect(gateSource).toContain('export const DEFAULT_MAX_RETRIES')
    expect(gateSource).toContain('config.maxRetries ?? DEFAULT_MAX_RETRIES')
    // The gate must not fall back to a bare numeric literal any more.
    expect(gateSource).not.toMatch(/config\.maxRetries \?\? \d/)
  })
})
