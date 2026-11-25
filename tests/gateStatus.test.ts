/** get_gate_status: read-only config + abort-log tail, never mutating. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildGateStatus, formatGateStatus, resolveAbortLogPath } from '../src/gate/gateStatus.js'
import { DEFAULT_MAX_RETRIES } from '../src/gate/completionGate.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gate-status-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('gate status: config', () => {
  it('reports the canonical retry default when unset', () => {
    const status = buildGateStatus({ env: {} })
    expect(status.effective.maxRetries).toBe(DEFAULT_MAX_RETRIES)
  })

  it('reflects env overrides without changing defaults', () => {
    const status = buildGateStatus({
      env: { FALSE_COMPLETION_MAX_RETRIES: '4', FALSE_COMPLETION_MAX_STEPS: '9', DSH_PROFILE: 'web' },
    })
    expect(status.effective.maxRetries).toBe(4)
    expect(status.effective.maxStepsPerTurn).toBe(9)
    expect(status.effective.profile).toBe('web')
  })

  it('derives active verifiers from env gating flags', () => {
    expect(buildGateStatus({ env: {} }).effective.activeVerifiers).toEqual(['filesystem'])
    expect(buildGateStatus({ env: { DSH_FALSE_COMPLETION_PLAYWRIGHT: '1' } }).effective.activeVerifiers).toContain('playwright')
    expect(buildGateStatus({ env: { VERIFIER_BACKEND: 'ragas' } }).effective.activeVerifiers).toContain('python')
    expect(buildGateStatus({ env: { VERIFIER_BACKEND: 'none' } }).effective.activeVerifiers).not.toContain('python')
  })
})

describe('gate status: abort log', () => {
  it('resolves path only from DSH_ABORT_LOG', () => {
    expect(resolveAbortLogPath({})).toBeUndefined()
    expect(resolveAbortLogPath({ DSH_ABORT_LOG: '/tmp/x.log' })).toBe('/tmp/x.log')
  })

  it('reports unset log without failing', () => {
    const status = buildGateStatus({ env: {} })
    expect(status.abortLog.source).toBe('none')
    expect(status.abortLog.path).toContain('unset')
    expect(status.abortLog.entries).toEqual([])
    expect(() => formatGateStatus(status)).not.toThrow()
  })

  it('returns the last 5 entries from an existing log', () => {
    const log = join(dir, 'aborts.log')
    const lines = Array.from({ length: 8 }, (_, i) => `line-${i + 1}`)
    writeFileSync(log, lines.join('\n') + '\n')
    const status = buildGateStatus({ env: { DSH_ABORT_LOG: log } })
    expect(status.abortLog.exists).toBe(true)
    expect(status.abortLog.entries).toEqual(['line-4', 'line-5', 'line-6', 'line-7', 'line-8'])
  })

  it('fails gracefully on a missing log file', () => {
    const status = buildGateStatus({ env: { DSH_ABORT_LOG: join(dir, 'nope.log') } })
    expect(status.abortLog.exists).toBe(false)
    expect(status.abortLog.entries).toEqual([])
    expect(status.abortLog.error).toBeTruthy()
    expect(() => formatGateStatus(status)).not.toThrow()
  })

  it('handles an empty file without throwing', () => {
    const log = join(dir, 'empty.log')
    writeFileSync(log, '')
    const status = buildGateStatus({ env: { DSH_ABORT_LOG: log } })
    expect(status.abortLog.entries).toEqual([])
    expect(formatGateStatus(status)).toContain('empty')
  })
})

describe('gate status: rendering is read-only', () => {
  it('markdown includes config, path and entries', () => {
    const log = join(dir, 'a.log')
    writeFileSync(log, '[false-completion-gate] abort category=claim_invalid claim="x" evidence=- verifier=- counts=1/1 detail="d"\n')
    const md = formatGateStatus(buildGateStatus({ env: { DSH_ABORT_LOG: log, DSH_PROFILE: 'web' } }))
    expect(md).toContain('## Completion gate status')
    expect(md).toContain('maxRetries=')
    expect(md).toContain('active verifiers: filesystem')
    expect(md).toContain('profile: web')
    expect(md).toContain(log)
    expect(md).toContain('category=claim_invalid')
  })

  it('does not create or modify the log file', () => {
    const log = join(dir, 'keep.log')
    writeFileSync(log, 'original\n')
    buildGateStatus({ env: { DSH_ABORT_LOG: log } })
    expect(readFileSyncMode(log)).toBe('original\n')
  })
})

import { readFileSync } from 'node:fs'
function readFileSyncMode(path: string): string {
  return readFileSync(path, 'utf8')
}
