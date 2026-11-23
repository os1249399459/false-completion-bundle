/** Repetition detection: allowlist, feedback, cached result, span attribute. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_READONLY_TOOLS, REPEAT_FEEDBACK, RepetitionGuard, fingerprintOf } from '../src/adapters/repetitionGuard.js'
import { OtelLedgerAdapter } from '../src/adapters/ledgerAdapter.js'
import type { BeforeToolCallContext, AfterToolCallContext, JsonValue } from '../src/adapters/adapters.js'

function before(toolName: string, args: JsonValue, turn = 1): BeforeToolCallContext {
  return { callId: 'c', rootCallId: 'r', toolName, arguments: args, turn, isSubDispatch: false, signal: new AbortController().signal }
}

function after(toolName: string, args: JsonValue, value: JsonValue, turn = 1): AfterToolCallContext {
  return {
    callId: 'c', rootCallId: 'r', toolName, turn,
    redactedArgs: { toolName, args, redactedFields: [] },
    outcome: { isError: false, exitCode: 'OK', value, content: [] },
    snapshot: { source: 'unknown', diffs: [] },
    signal: new AbortController().signal,
  }
}

const FIRST = { ok: true, path: '/a.txt' } as JsonValue

describe('RepetitionGuard', () => {
  it('fingerprint reuses deterministic ledger hashing', () => {
    expect(fingerprintOf('read_file', { path: '/a', n: 1 })).toBe(fingerprintOf('read_file', { n: 1, path: '/a' }))
    expect(fingerprintOf('read_file', { path: '/a' })).not.toBe(fingerprintOf('read_file', { path: '/b' }))
  })

  it('read-only repeat is caught; first repeat injects feedback', async () => {
    const guard = new RepetitionGuard()
    const args = { path: '/first-repeat' }
    expect(await guard.beforeToolCall(before('read_file', args))).toEqual({ kind: 'allow' })
    await guard.afterToolCall(after('read_file', args, FIRST))
    const d = await guard.beforeToolCall(before('read_file', args))
    expect(d.kind).toBe('feedback')
    if (d.kind === 'feedback') expect(d.feedback).toEqual(REPEAT_FEEDBACK)
  })

  it('second repeat returns cached result via decision', async () => {
    const guard = new RepetitionGuard()
    await guard.beforeToolCall(before('get_file_info', { path: '/a' }))
    await guard.afterToolCall(after('get_file_info', { path: '/a' }, FIRST))
    await guard.beforeToolCall(before('get_file_info', { path: '/a' }))
    const d = await guard.beforeToolCall(before('get_file_info', { path: '/a' }))
    expect(d.kind).toBe('cached')
    if (d.kind === 'cached') {
      expect(d.result).toEqual(FIRST)
      expect(d.feedback).toEqual(REPEAT_FEEDBACK)
    }
  })

  it('write operations are never blocked, even with identical args', async () => {
    const guard = new RepetitionGuard()
    const args = { path: '/a', content: 'x' }
    for (let i = 0; i < 4; i++) {
      expect((await guard.beforeToolCall(before('write_file', args))).kind).toBe('allow')
      expect((await guard.afterToolCall(after('write_file', args, { ok: true }))).kind).toBe('accept')
    }
    expect(DEFAULT_READONLY_TOOLS).not.toContain('write_file')
  })

  it('recordRepetition fires with cached result info', async () => {
    const seen: Array<{ count: number; cached?: JsonValue }> = []
    const guard = new RepetitionGuard({ recordRepetition: (info) => seen.push({ count: info.count, cached: info.cachedResult }) })
    await guard.beforeToolCall(before('grep', { q: 'x' }))
    await guard.afterToolCall(after('grep', { q: 'x' }, FIRST))
    await guard.beforeToolCall(before('grep', { q: 'x' }))
    await guard.beforeToolCall(before('grep', { q: 'x' }))
    expect(seen.length).toBe(2)
    expect(seen[0]!.count).toBe(2)
    expect(seen[0]!.cached).toEqual(FIRST)
  })

  it('fail open when fingerprinting throws', async () => {
    const guard = new RepetitionGuard()
    const bad = { ...before('read_file', {}), arguments: { get toJSON() { throw new Error('boom') } } } as unknown as BeforeToolCallContext
    expect((await guard.beforeToolCall(bad)).kind).toBe('allow')
  })

  it('span records repeated:true when ledger receives the flag', async () => {
    const attributes: Array<Record<string, unknown>> = []
    const ledger = new OtelLedgerAdapter({
      exporter: {
        emitEvidenceSpan: async (input: { attributes: Record<string, unknown> }) => {
          attributes.push({ ...input.attributes })
          return { traceId: 't', spanId: 's' }
        },
      },
    })
    await ledger.emitEvidence({
      toolName: 'read_file',
      repeated: true,
      redactedArgs: { toolName: 'read_file', args: { path: '/a' }, redactedFields: [] },
      outcome: { isError: false, exitCode: 'OK', value: FIRST, content: [] },
      snapshot: { source: 'unknown', diffs: [] },
    })
    expect(attributes[0]!['evidence.repeated']).toBe(true)
  })
})
