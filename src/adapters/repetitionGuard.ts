/**
 * Repetition detection at the tool boundary.
 *
 * Thin adapter over the EXISTING ToolBoundaryAdapter seam: no new storage, no
 * new ledger, no gate/verifier changes. Per-turn fingerprints live in memory on
 * this instance only; evidence is recorded on the existing OTLP span via the
 * injected `recordRepetition` callback (the ledger adapter in production).
 *
 * Allowlist semantics: only explicitly allowed read-only / idempotent tools are
 * considered. Write / side-effecting tools are NEVER blocked, even with
 * identical args. Fail-open: any fingerprinting error returns `allow`.
 */
import { digestJson } from '../adapters/ledgerAdapter.js'
import type { ToolBoundaryAdapter, BeforeToolCallContext, BeforeToolCallDecision, AfterToolCallContext, AfterToolCallDecision, JsonValue } from '../adapters/adapters.js'

/** Read-only / idempotent tools eligible for repetition detection. */
export const DEFAULT_READONLY_TOOLS: readonly string[] = [
  'get_file_info',
  'read_file',
  'read_text_file',
  'read_multiple_files',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
  'list_allowed_directories',
  'grep',
  'stat',
  'view',
  'read',
]

export interface RepetitionOptions {
  /** Tool names eligible for detection. Defaults to read-only tools only. */
  readonly allowlist?: readonly string[]
  /** Called when a repeated call is observed; records `repeated: true` on the span. */
  readonly recordRepetition?: (info: RepetitionInfo) => void
}

export interface RepetitionInfo {
  readonly turn: number
  readonly toolName: string
  readonly fingerprint: string
  readonly count: number
  readonly cachedResult?: JsonValue
}

interface Entry {
  count: number
  result?: JsonValue
}

export const REPEAT_FEEDBACK: readonly JsonValue[] = ['this operation already ran in this turn with identical args and the same result; do not repeat it.']

/** Fingerprint = tool name + digest of normalized (JSON) args. Reuses ledger hashing. */
export function fingerprintOf(toolName: string, args: JsonValue): string {
  return `${toolName}:${digestJson(args)}`
}

export class RepetitionGuard implements ToolBoundaryAdapter {
  private readonly allowlist: ReadonlySet<string>
  private readonly recordRepetition?: (info: RepetitionInfo) => void
  /** turn -> fingerprint -> entry. In-memory, per adapter instance (per turn). */
  private readonly turns = new Map<number, Map<string, Entry>>()

  constructor(options: RepetitionOptions = {}) {
    this.allowlist = new Set(options.allowlist ?? DEFAULT_READONLY_TOOLS)
    this.recordRepetition = options.recordRepetition
  }

  async beforeToolCall(ctx: BeforeToolCallContext): Promise<BeforeToolCallDecision> {
    if (!this.allowlist.has(ctx.toolName)) return { kind: 'allow' }
    try {
      const fingerprint = fingerprintOf(ctx.toolName, ctx.arguments as JsonValue)
      const state = this.stateFor(ctx.turn ?? 0)
      const found = state.get(fingerprint)
      if (!found) {
        state.set(fingerprint, { count: 1 })
        return { kind: 'allow' }
      }

      found.count += 1
      const info: RepetitionInfo = {
        turn: ctx.turn ?? 0,
        toolName: ctx.toolName,
        fingerprint,
        count: found.count,
        ...(found.result !== undefined ? { cachedResult: found.result } : {}),
      }
      this.recordRepetition?.(info)

      // First repeat (third call: 1 initial + feedback + this) rejects and
      // returns the cached result. Count 2 is the first repeat (feedback only).
      if (found.count > 2) {
        return { kind: 'cached', result: found.result ?? null, feedback: REPEAT_FEEDBACK }
      }
      // First repeat: inject feedback but still allow the call.
      return { kind: 'feedback', feedback: REPEAT_FEEDBACK }
    } catch {
      // Fail open: fingerprinting must never crash a tool call.
      return { kind: 'allow' }
    }
  }

  async afterToolCall(ctx: AfterToolCallContext): Promise<AfterToolCallDecision> {
    if (!this.allowlist.has(ctx.toolName)) return { kind: 'accept' }
    try {
      const fingerprint = fingerprintOf(ctx.toolName, ctx.redactedArgs.args)
      const state = this.stateFor(ctx.turn ?? 0)
      // Only attach a result to a fingerprint already seen by beforeToolCall;
      // never create a new count entry here (that would skip the feedback step).
      const found = state.get(fingerprint)
      if (found && found.result === undefined) {
        found.result = ctx.outcome.value ?? (ctx.outcome.content as JsonValue | undefined) ?? null
      }
      return { kind: 'accept' }
    } catch {
      return { kind: 'accept' }
    }
  }

  /** Counts for tests and the metrics counter; no persistent store. */
  counts(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const [turn, state] of this.turns) {
      for (const [fp, entry] of state) {
        if (entry.count > 1) out[`${turn}:${fp}`] = entry.count
      }
    }
    return out
  }

  private stateFor(turn: number): Map<string, Entry> {
    let state = this.turns.get(turn)
    if (!state) {
      state = new Map()
      this.turns.set(turn, state)
    }
    return state
  }
}
