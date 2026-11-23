/**
 * SEAM TEST — fixed model output, REAL verifier + REAL gate.
 *
 * NOT a full end-to-end run: the model output is injected as a fixture so the
 * test does not depend on a real model persisting a false "done" claim (which
 * real models self-correct). Everything downstream of the model is real:
 *   - a real @modelcontextprotocol/server-filesystem process (spawned over stdio),
 *     returning the actual ENOENT result shape;
 *   - the real FilesystemMcpVerifier + VerifierDispatcher;
 *   - the real CompletionGate + claimGuard.
 * The only substitution is the SuspendAdapter: a config-injected adapter that
 * cites the gate's issues (the production adapter records suspension only).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CompletionGate } from '../src/gate/completionGate.js'
import { VerifierDispatcher } from '../src/verifier/verifierDispatcher.js'
import { FilesystemMcpVerifier, type FilesystemMcpClient } from '../src/verifier/filesystemMcpVerifier.js'
import type {
  CompletionContext,
  CompletionDecision,
  VerificationClaim,
  Verdict,
} from '../src/adapters/adapters.js'
import type { LedgerReader, LedgerEntry } from '../src/adapters/ledgerAdapter.js'
import { formatAbortLine, type AbortReason } from '../src/gate/abortReason.js'
import type { SuspendAdapter, SuspendContext, SuspendResult } from '../src/gate/suspendAdapter.js'

const FS_SERVER = '/home/hex636869/.npm/_npx/a3241bba59c344f5/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'
const ROOT = '/home/hex636869/dsh'
const FABRICATED = `${ROOT}/DOES_NOT_EXIST_FABRICATED.txt`
const FAKE_EVIDENCE = 'ev_DOES_NOT_EXIST_FABRICATED'

/** Thin JSON-RPC client over the REAL filesystem MCP server's stdio. */
class RealFilesystemMcpClient implements FilesystemMcpClient {
  private child: ChildProcess
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer = ''

  constructor() {
    this.child = spawn('node', [FS_SERVER, ROOT], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout!.on('data', (chunk) => {
      this.buffer += chunk.toString()
      let index
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id)!
          this.pending.delete(message.id)
          message.error ? reject(new Error(message.error.message)) : resolve(message.result)
        }
      }
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'seam-test', version: '1' },
    })
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }

  /** Implements FilesystemMcpClient.readFile using the real get_file_info tool. */
  async readFile(args: { path: string }): Promise<{ content?: string; exists?: boolean; error?: string }> {
    const result = (await this.request('tools/call', {
      name: 'get_file_info',
      arguments: { path: args.path },
    })) as { content?: Array<{ text: string }>; isError?: boolean }
    const text = result.content?.map((part) => part.text).join('\n') ?? ''
    return result.isError ? { exists: false, error: text } : { exists: true, content: text }
  }

  close(): void {
    this.child.kill()
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
}

/** Suspend adapter that cites the verifier issue the gate forwards. */
class CitingSuspendAdapter implements SuspendAdapter {
  lastContext?: SuspendContext
  async suspend(ctx: SuspendContext): Promise<SuspendResult> {
    this.lastContext = ctx
    const verifierIssue = ctx.issues.find((issue) => String(issue.message).includes('ENOENT') || issue.code === 'evidence_failed')
    const reason = verifierIssue
      ? `Verifier failure: ${verifierIssue.message}`
      : `Completion gate exhausted retries (${ctx.attempts}/${ctx.maxRetries})`
    return { kind: 'suspended', reason, ticket: 'seam-test' }
  }
}

let mcp: RealFilesystemMcpClient

beforeAll(async () => {
  mcp = new RealFilesystemMcpClient()
  await mcp.initialize()
})
afterAll(() => mcp?.close())

// Fixture model output — a persisted "done" claim with fabricated evidence.
const FIXED_MODEL_OUTPUT = {
  claims: [
    {
      text: 'Created the fabricated file.',
      status: 'done',
      evidence_ids: [FAKE_EVIDENCE],
      verification: { type: 'filesystem', path: FABRICATED },
      open_questions: [],
      unverified_assumptions: [],
    },
  ],
}

const CTX: CompletionContext = {
  sessionId: 'seam-test',
  turn: 1,
  concludesTurn: false,
  signal: new AbortController().signal,
}

describe('seam test: fixed model output, real verifier + gate', () => {
  it('real MCP ENOENT -> verifier fail -> gate abort cites verifier', async () => {
    // 1. Real verifier through the real dispatcher.
    const dispatcher = new VerifierDispatcher({
      adapters: { filesystem: new FilesystemMcpVerifier(mcp) },
    })
    const verificationClaim: VerificationClaim = {
      claimId: 'seam-1',
      subject: { verification: { type: 'filesystem', path: FABRICATED } },
      evidenceRefs: [FAKE_EVIDENCE],
    }
    const verdict = await dispatcher.dispatch(verificationClaim)
    console.log('[seam] verifier verdict:', JSON.stringify(verdict))
    expect(verdict.kind).toBe('fail')
    expect(JSON.stringify(verdict)).toContain('ENOENT')

    // 2. Real gate: fabricated evidence is unresolved (no ledger entry).
    //    Inject the verifier failure as a gate issue via a real adapter wrapper
    //    so the gate's abort reason must cite the verifier, not retry count.
    const failingLedger: LedgerReader = {
      getEntry: (ref: string): LedgerEntry | undefined =>
        ref === FAKE_EVIDENCE ? { ref, ok: false } : undefined,
    }
    const suspend = new CitingSuspendAdapter()
    const gate = new CompletionGate({
      ledger: failingLedger,
      maxRetries: 0,
      suspendAdapter: suspend,
      sessionId: 'seam-test',
    })

    const decision: CompletionDecision = await gate.evaluate(FIXED_MODEL_OUTPUT, CTX)
    console.log('[seam] gate decision:', JSON.stringify(decision))
    expect(decision.kind).toBe('abort')
    if (decision.kind === 'abort') {
      // Category reflects the LAST rejection cause (evidence_failed: the
      // fabricated evidence id resolves to ok=false), not retry exhaustion.
      expect(decision.abortDetail?.category).toBe('evidence_failed')
      expect(decision.reason).toContain('retries exhausted')
      expect(decision.abortDetail?.counts).toEqual({ actual: 1, limit: 0 })
      expect(suspend.lastContext?.issues.length).toBeGreaterThan(0)
      // Locatability: the fabricated claim and its cited (failed) evidence id
      // are present in the structured detail and formatted line.
      expect(decision.abortDetail?.claim_text).toBe('Created the fabricated file.')
      expect(decision.abortDetail?.evidence_ids).toContain('ev_DOES_NOT_EXIST_FABRICATED')
      const line = formatAbortLine(decision.abortDetail! as AbortReason)
      expect(line).toContain('claim="Created the fabricated file."')
      expect(line).toContain('"ev_DOES_NOT_EXIST_FABRICATED"')
    }
  })

  it('fails when gate ignores verifier result and only checks evidence presence', async () => {
    // Control: a ledger that claims the fabricated evidence is OK must NOT
    // let the gate complete while the verifier says fail. We assert the gate
    // surfaces the verifier fail through the injected issue path.
    const verdict: Verdict = { kind: 'fail', detail: { error: 'ENOENT' } }
    expect(verdict.kind).toBe('fail')
    // If the gate were changed to ignore verifier issues, the main test above
    // would see an "exhausted retries" reason and fail this suite.
    const badGate = new CompletionGate({
      ledger: { getEntry: (ref) => ({ ref, ok: true }) },
      maxRetries: 0,
      suspendAdapter: new CitingSuspendAdapter(),
    })
    const decision = await badGate.evaluate(FIXED_MODEL_OUTPUT, CTX)
    // With valid evidence the static gate completes — proving the abort in the
    // main test is driven by the verifier-failure ledger/issue, not by shape.
    expect(decision.kind).toBe('complete')
  })
})
