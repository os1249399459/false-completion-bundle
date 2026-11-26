/**
 * Filesystem MCP server: `--read-only` must actually bound what the model can
 * reach. This is a security test, not a convenience test.
 *
 * Background: the profile pinned `@modelcontextprotocol/server-filesystem@1.0.0`,
 * which registered 14 tools unconditionally — `write_file`, `edit_file`,
 * `create_directory`, `move_file` included — and read no environment variables
 * at all. Our plugin never called the write tools, but the *model* could, and so
 * could a prompt injection. The verifier only needs to read.
 *
 * `--read-only` was added upstream in 2.2.0. The profile and devDependency now
 * pin 2.4.0. Two separate guarantees are asserted here:
 *
 *   1. The advertised `tools/list` contains exactly the 10 read-only tools.
 *   2. Enforcement is at the invocation level: a direct `tools/call` for a write
 *      tool is rejected with "Tool ... not found", even though the caller never
 *      saw it in the list. Filtering the list alone would not be enough — a
 *      crafted or injected call could still name the tool.
 *
 * These tests spawn the real server binary from `node_modules`. They skip (with
 * a printed reason) only if it is not installed, and every assertion otherwise
 * runs against the real thing — a mock could not prove either guarantee.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

/** Resolve the installed server entry, or undefined when absent. */
function resolveServerEntry(): string | undefined {
  try {
    const pkg = require_.resolve('@modelcontextprotocol/server-filesystem/package.json')
    // package.json sits at <pkg>/package.json; the bin is dist/index.js.
    const entry = join(pkg, '..', 'dist', 'index.js')
    return existsSync(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

const SERVER_ENTRY = resolveServerEntry()
const AVAILABLE = SERVER_ENTRY !== undefined

/** Tools the server serves under `--read-only`, verified against 2.4.0. */
const READ_ONLY_TOOLS = [
  'directory_tree',
  'get_file_info',
  'list_allowed_directories',
  'list_directory',
  'list_directory_with_sizes',
  'read_file',
  'read_media_file',
  'read_multiple_files',
  'read_text_file',
  'search_files',
] as const

/** Write-capable tools that must never be advertised nor callable. */
const WRITE_TOOLS = [
  'append_file',
  'copy_file',
  'create_directory',
  'edit_file',
  'move_file',
  'write_file',
] as const

interface RpcResult {
  readonly tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>
  readonly [key: string]: unknown
}
interface RpcError {
  readonly code: number
  readonly message: string
}

let sandbox: string

/**
 * Boot the server, run `script` with a send/receive helper, then shut down.
 * Kept minimal on purpose: this is a JSON-RPC client, nothing more.
 */
function withServer<T>(
  args: string[],
  script: (rpc: (method: string, params: unknown) => Promise<{ result?: RpcResult; error?: RpcError }>) => Promise<T>,
  timeoutMs = 20000,
): Promise<T> {
  if (!SERVER_ENTRY) return Promise.reject(new Error('filesystem MCP server not installed'))
  return new Promise<T>((resolve, reject) => {
    const child = spawn('node', [SERVER_ENTRY, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    const pending = new Map<number, (msg: { result?: RpcResult; error?: RpcError }) => void>()
    let nextId = 1

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timeout after ${timeoutMs}ms; stderr: ${stderr.slice(0, 400)}`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line) as { id?: number; result?: RpcResult; error?: RpcError }
          if (typeof message.id === 'number' && pending.has(message.id)) {
            const settle = pending.get(message.id)!
            pending.delete(message.id)
            settle({ ...(message.result !== undefined ? { result: message.result } : {}), ...(message.error ? { error: message.error } : {}) })
          }
        } catch { /* non-JSON banner line */ }
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })

    const rpc = (method: string, params: unknown) => new Promise<{ result?: RpcResult; error?: RpcError }>((res) => {
      const id = nextId++
      pending.set(id, res)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })

    const notify = (method: string) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
    }

    void (async () => {
      try {
        await rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'readonly-invariant-test', version: '1' },
        })
        notify('notifications/initialized')
        const value = await script(rpc)
        clearTimeout(timer)
        child.kill()
        resolve(value)
      } catch (error) {
        clearTimeout(timer)
        child.kill()
        reject(error)
      }
    })()
  })
}

function toolNames(rpc: (m: string, p: unknown) => Promise<{ result?: RpcResult; error?: RpcError }>) {
  return rpc('tools/list', {}).then((response) => {
    if (!response.result?.tools) throw new Error('tools/list returned no tools')
    return response.result.tools.map((tool) => tool.name)
  })
}

beforeAll(() => {
  if (!AVAILABLE) {
    console.warn(
      '\n[filesystemReadOnly] SKIPPED: @modelcontextprotocol/server-filesystem is not installed.\n' +
      '  Run pnpm install to run this security test.',
    )
    return
  }
  sandbox = mkdtempSync(join(tmpdir(), 'fs-readonly-'))
})

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

describe.skipIf(!AVAILABLE)('filesystem server --read-only', () => {
  it('advertises EXACTLY the 10 read-only tools', async () => {
    const names = await withServer(['--read-only', sandbox], toolNames)
    // Strict set equality, not "contains": an extra tool is a regression even if
    // it happens to be harmless, because nobody reviewed it.
    expect(names.slice().sort()).toEqual([...READ_ONLY_TOOLS].sort())
    expect(names).toHaveLength(10)
  })

  it('advertises NO write-capable tool', async () => {
    const names = await withServer(['--read-only', sandbox], toolNames)
    for (const writeTool of WRITE_TOOLS) {
      expect(names, `${writeTool} must not be advertised`).not.toContain(writeTool)
    }
  })

  it('the same binary WITHOUT the flag does expose write tools (control)', async () => {
    // Proves the assertion above is caused by --read-only, not by the tool list
    // having shrunk in a newer release.
    const names = await withServer([sandbox], toolNames)
    expect(names.length).toBeGreaterThan(10)
    expect(names).toContain('write_file')
    expect(names).toContain('move_file')
  })

  it('NEGATIVE CONTROL: a direct tools/call for write_file is rejected', async () => {
    // The model never sees write_file in the list, but an injected or crafted
    // call can still name it. Invocation-level rejection is the real guarantee.
    const response = await withServer(['--read-only', sandbox], (rpc) =>
      rpc('tools/call', {
        name: 'write_file',
        arguments: { path: join(sandbox, 'SHOULD_NOT_EXIST.txt'), content: 'pwned' },
      }),
    )
    expect(response.error, 'write_file must error, not succeed').toBeDefined()
    expect(response.error!.message).toMatch(/not found/i)
    expect(response.result).toBeUndefined()
  })

  it('NEGATIVE CONTROL: move_file is rejected the same way', async () => {
    const response = await withServer(['--read-only', sandbox], (rpc) =>
      rpc('tools/call', {
        name: 'move_file',
        arguments: { source: join(sandbox, 'a'), destination: join(sandbox, 'b') },
      }),
    )
    expect(response.error).toBeDefined()
    expect(response.error!.message).toMatch(/not found/i)
  })

  it('nothing was written to the sandbox by the rejected calls', async () => {
    // The rejected calls above must have had no side effect.
    expect(readdirSync(sandbox)).toEqual([])
  })

  it('a read tool still works under --read-only (the verifier can do its job)', async () => {
    const response = await withServer(['--read-only', sandbox], (rpc) =>
      rpc('tools/call', { name: 'list_directory', arguments: { path: sandbox } }),
    )
    expect(response.error).toBeUndefined()
    expect(response.result).toBeDefined()
  })
})
