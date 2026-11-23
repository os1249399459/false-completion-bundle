import { describe, expect, it } from 'vitest'
import { ClaimGuard } from '../src/schema/claimGuard.js'
import type { LedgerReader, LedgerEntry } from '../src/adapters/ledgerAdapter.js'
import type { ClaimsDocument } from '../src/schema/claim.schema.js'

function fakeLedger(entries: Record<string, boolean>): LedgerReader {
  const map = new Map<string, LedgerEntry>(
    Object.entries(entries).map(([ref, ok]) => [ref, { ref, ok }]),
  )
  return { getEntry: (ref: string) => map.get(ref) }
}

const GOOD_REF = 'ev_good_00000000000000000000000000000000'
const FAILED_REF = 'ev_failed_0000000000000000000000000000000'

// Fixture 1: valid claim — status done, cited with a successful ledger entry.
const validClaim: ClaimsDocument = {
  claims: [
    {
      text: 'The file src/index.ts was rewritten.',
      status: 'done',
      evidence_ids: [GOOD_REF],
      verification: { method: 'ledger' },
      open_questions: [],
      unverified_assumptions: [],
    },
  ],
}

// Fixture 2: no evidence — status done with empty evidence_ids.
const noEvidenceClaim: ClaimsDocument = {
  claims: [
    {
      text: 'Everything is complete.',
      status: 'done',
      evidence_ids: [],
      verification: {},
      open_questions: [],
      unverified_assumptions: [],
    },
  ],
}

// Fixture 3: fake evidence_id — references an unknown ledger entry.
const fakeEvidenceClaim: ClaimsDocument = {
  claims: [
    {
      text: 'The deployment succeeded.',
      status: 'done',
      evidence_ids: ['ev_does_not_exist'],
      verification: {},
      open_questions: [],
      unverified_assumptions: [],
    },
  ],
}

// Fixture 4: failed tool call cited as success — entry exists but ok=false.
const failedToolClaim: ClaimsDocument = {
  claims: [
    {
      text: 'The test suite passed.',
      status: 'done',
      evidence_ids: [FAILED_REF],
      verification: {},
      open_questions: [],
      unverified_assumptions: [],
    },
  ],
}

const guard = new ClaimGuard({
  ledger: fakeLedger({ [GOOD_REF]: true, [FAILED_REF]: false }),
})

describe('ClaimGuard', () => {
  it('accepts a valid claim with a successful evidence reference', () => {
    const result = guard.validate(validClaim)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.claims[0]!.status).toBe('done')
  })

  it('rejects a done claim with no evidence ids', () => {
    const result = guard.validate(noEvidenceClaim)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.join('.') === 'claims.0.evidence_ids')).toBe(true)
      expect(result.issues.every((issue) => typeof issue.message === 'string')).toBe(true)
    }
  })

  it('rejects an evidence id that does not resolve to the ledger', () => {
    const result = guard.validate(fakeEvidenceClaim)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'evidence_unresolved')).toBe(true)
    }
  })

  it('rejects a failed tool call cited as success', () => {
    const result = guard.validate(failedToolClaim)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'evidence_failed')).toBe(true)
    }
  })

  it('returns structured issues for malformed input without throwing', () => {
    const result = guard.validateInput({ claims: [{ status: 'done' }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0)
  })
})
