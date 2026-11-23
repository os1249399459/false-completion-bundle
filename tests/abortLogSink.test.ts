/** DSH_ABORT_LOG: append exactly one line per abort, stderr unchanged. */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitAbortLine } from '../src/gate/abortLog.js'
import { formatAbortLine } from '../src/gate/abortReason.js'
import type { AbortReason } from '../src/gate/abortReason.js'

const reason: AbortReason = { kind: 'hook', category: 'claim_invalid', claim_text: 'I read foo.txt', detail: 'no evidence' }

let dir: string
let previous: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-abort-log-'))
  previous = process.env.DSH_ABORT_LOG
})
afterEach(() => {
  if (previous === undefined) delete process.env.DSH_ABORT_LOG
  else process.env.DSH_ABORT_LOG = previous
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('DSH_ABORT_LOG file sink', () => {
  it('set: appends exactly one line and still emits stderr', () => {
    const target = join(dir, 'abort.log')
    process.env.DSH_ABORT_LOG = target
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const line = emitAbortLine(reason)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledWith(line)
    const contents = readFileSync(target, 'utf8')
    expect(contents).toBe(formatAbortLine(reason) + '\n')
    expect(contents.trim().split('\n')).toHaveLength(1)
  })

  it('set: repeated calls append one line each (no duplicated/stderr spam)', () => {
    const target = join(dir, 'abort2.log')
    process.env.DSH_ABORT_LOG = target
    vi.spyOn(console, 'error').mockImplementation(() => {})
    emitAbortLine(reason)
    emitAbortLine({ ...reason, category: 'exporter_failed' })
    const lines = readFileSync(target, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('category=claim_invalid')
    expect(lines[1]).toContain('category=exporter_failed')
  })

  it('unset: no file is created, stderr behavior unchanged', () => {
    delete process.env.DSH_ABORT_LOG
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const line = emitAbortLine(reason)
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledWith(line)
    expect(existsSync(join(dir, 'abort.log'))).toBe(false)
  })
})
