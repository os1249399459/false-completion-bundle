import { describe, expect, it, vi } from 'vitest'
import { OtelLedgerAdapter, redactJson } from '../src/adapters/ledgerAdapter.js'
import type { EvidencePayload } from '../src/adapters/adapters.js'

const payload = (isError: boolean): EvidencePayload => ({
  toolName: 'bash',
  redactedArgs: {
    toolName: 'bash',
    args: { command: 'echo hi', password: 'super-secret' },
    redactedFields: [],
  },
  outcome: isError
    ? { isError: true, error: { name: 'Error', code: 'TOOL_FAILED' }, exitCode: 'TOOL_FAILED', content: [] }
    : { isError: false, exitCode: 'OK', value: 'hi', content: [] },
  snapshot: { source: 'unknown', diffs: [] },
})

function stubExporter() {
  return { emitEvidenceSpan: vi.fn().mockResolvedValue({ traceId: 'trace-1', spanId: 'span-1' }) }
}

describe('OtelLedgerAdapter', () => {
  it('redacts secret keys from the derived args view', () => {
    const { value, redactedFields } = redactJson(
      { token: 'abc', nested: { API_KEY: 'xyz' }, command: 'ls' },
      ['token', 'api_key'],
    )
    expect(value).toEqual({ token: '[REDACTED]', nested: { API_KEY: '[REDACTED]' }, command: 'ls' })
    expect(redactedFields).toEqual(['API_KEY', 'token'])
  })

  it('emits a stable reference and records the ok bit', async () => {
    const ledger = new OtelLedgerAdapter({ exporter: stubExporter() })
    const first = await ledger.emitEvidence(payload(false))
    const second = await ledger.emitEvidence(payload(false))
    expect(first.ref).toBe(second.ref)
    expect(ledger.getEntry(first.ref)?.ok).toBe(true)
    expect(ledger.getEntry(first.ref)?.traceId).toBe('trace-1')
  })

  it('records ok=false for a failed tool call', async () => {
    const ledger = new OtelLedgerAdapter({ exporter: stubExporter() })
    const ref = await ledger.emitEvidence(payload(true))
    expect(ledger.getEntry(ref.ref)?.ok).toBe(false)
  })

  it('fails closed: rejects and notifies when span emission fails', async () => {
    const onFailure = vi.fn()
    const failing = { emitEvidenceSpan: vi.fn().mockRejectedValue(new Error('OTLP down')) }
    const ledger = new OtelLedgerAdapter({ exporter: failing, onEmissionFailure: onFailure })
    await expect(ledger.emitEvidence(payload(false))).rejects.toThrow('OTLP down')
    expect(onFailure).toHaveBeenCalledOnce()
  })
})

describe('attribution metadata', () => {
  it('spans from two profile values are distinguishable', async () => {
    const captured: Array<Record<string, unknown>> = []
    const exporter = {
      emitEvidenceSpan: async (input: { attributes: Record<string, unknown> }) => {
        captured.push({ ...input.attributes })
        return { traceId: 'trace', spanId: 'span' }
      },
    }
    const base = {
      toolName: 'assistant.claim',
      redactedArgs: { toolName: 'assistant.claim', args: {}, redactedFields: [] },
      outcome: { isError: false, exitCode: 'OK', content: [] },
      snapshot: { source: 'unknown' as const, diffs: [] },
    }

    const web = new OtelLedgerAdapter({ exporter, sessionId: 'dsh-host', profileId: 'web' })
    await web.emitEvidence({ ...base, sessionId: 'session-web-1' })
    const work = new OtelLedgerAdapter({ exporter, sessionId: 'dsh-host', profileId: 'work' })
    await work.emitEvidence({ ...base, sessionId: 'session-work-1' })

    expect(captured).toHaveLength(2)
    expect(captured[0]!['evidence.profile']).toBe('web')
    expect(captured[1]!['evidence.profile']).toBe('work')
    expect(captured[0]!['evidence.profile']).not.toBe(captured[1]!['evidence.profile'])
    // Real session id overrides the static adapter value.
    expect(captured[0]!['evidence.session.id']).toBe('session-web-1')
    expect(captured[1]!['evidence.session.id']).toBe('session-work-1')
    // Legacy attribute still present.
    expect(captured[0]).toHaveProperty('evidence.session.id')
  })

  it('keeps session.id when no per-emission id is supplied (backward compatible)', async () => {
    const captured: Array<Record<string, unknown>> = []
    const exporter = {
      emitEvidenceSpan: async (input: { attributes: Record<string, unknown> }) => {
        captured.push({ ...input.attributes })
        return { traceId: 't', spanId: 's' }
      },
    }
    const ledger = new OtelLedgerAdapter({ exporter, sessionId: 'dsh-host', profileId: 'web' })
    await ledger.emitEvidence({
      toolName: 'assistant.claim',
      redactedArgs: { toolName: 'assistant.claim', args: {}, redactedFields: [] },
      outcome: { isError: false, exitCode: 'OK', content: [] },
      snapshot: { source: 'unknown', diffs: [] },
    })
    expect(captured[0]!['evidence.session.id']).toBe('dsh-host')
    expect(captured[0]!['evidence.profile']).toBe('web')
  })
})
