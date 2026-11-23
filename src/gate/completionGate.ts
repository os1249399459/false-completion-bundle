/**
 * Completion gate — code-level hard gate before a turn may finish.
 *
 * Static policy only (no verifier dispatch in this phase):
 *  1. Parse the model's output with claimGuard.
 *  2. Reject "done" with missing/invalid evidence_ids (claimGuard rule 1).
 *  3. Reject unresolved or ok=false evidence (claimGuard rules 2 and 3).
 *  4. Reject unlisted "unknown"/"blocked" items not disclosed to the user.
 *
 * On failure the gate returns a `feedback` decision (the caller delivers it
 * with agent.steer) and the turn continues. On retry exhaustion it calls the
 * suspend adapter and returns `abort` — never `complete`.
 *
 * MOUNT CONTRACT (non-hot-reloadable): construct one gate per session and
 * register its listener on `agent.ctx` inside a single `ctx.effect()` guarded
 * by `ctx.tools.guard()` semantics elsewhere. The gate has no setter for its
 * config or guard function at runtime; reload requires recreating the agent.
 */
import type { CompletionContext, CompletionDecision, CompletionHookAdapter, JsonValue } from '../adapters/adapters.js'
import type { LedgerReader } from '../adapters/ledgerAdapter.js'
import { ClaimGuard } from '../schema/claimGuard.js'
import type { ClaimIssue, ClaimsDocument, Claim } from '../schema/claim.schema.js'
import type { SuspendAdapter } from './suspendAdapter.js'
import { abortDecision, categoryForIssue, type AbortReason } from './abortReason.js'

/**
 * Canonical retry budget. Single source of truth for the gate default, the
 * entry's env fallback, and the documentation. Kept at 1 to match the (2/1)
 * retry-exhaustion semantics used throughout prior verification.
 */
export const DEFAULT_MAX_RETRIES = 1

/**
 * Canonical divergence-limit defaults. Single source of truth shared by the
 * gate constructor, the entry's env fallback and the read-only status tool, so
 * a reported limit can never drift from an enforced one.
 */
export const DEFAULT_MAX_STEPS_PER_TURN = 20
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 30
export const DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_STEPS = 3

export interface CompletionGateConfig {
  /** Ledger lookup used to resolve evidence_ids. */
  readonly ledger: LedgerReader
  /** Maximum invalid outputs before suspending. Default {@link DEFAULT_MAX_RETRIES}. */
  readonly maxRetries?: number
  /** Suspend adapter used on exhaustion. */
  readonly suspendAdapter: SuspendAdapter
  /** Optional session id propagated to suspension records. */
  readonly sessionId?: string
  /** Hard limit: model steps per turn. Default 20. */
  readonly maxStepsPerTurn?: number
  /** Hard limit: tool calls per turn. Default 30. */
  readonly maxToolCallsPerTurn?: number
  /** Hard limit: consecutive steps with no progress. Default 3. */
  readonly maxConsecutiveNoProgressSteps?: number
}

/** Which hard limit was exceeded; carried in structured abort reasons. */
export type DivergenceReason =
  | 'step_budget_exceeded'
  | 'tool_call_budget_exceeded'
  | 'no_progress_exceeded'

export interface DivergenceAbortDetail {
  readonly limit: DivergenceReason
  readonly count: number
  readonly max: number
}

/** Precise progress definition for divergence detection. */
export interface ProgressSnapshot {
  readonly claimStatuses: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly verifierOutcomes: readonly string[]
}

/** Compute a progress snapshot from a claim document and tool-call tally. */
export function progressSnapshot(
  document: ClaimsDocument | undefined,
  verifierOutcomes: readonly string[] = [],
): ProgressSnapshot {
  const claims = document?.claims ?? []
  return {
    claimStatuses: claims.map((claim) => claim.status),
    evidenceIds: [...new Set(claims.flatMap((claim) => claim.evidence_ids))].sort(),
    verifierOutcomes: [...verifierOutcomes],
  }
}

/** True when any progress dimension changed vs the previous step. */
export function hasProgress(previous: ProgressSnapshot | undefined, current: ProgressSnapshot): boolean {
  if (!previous) return true
  return !(
    sameStrings(previous.claimStatuses, current.claimStatuses) &&
    sameStrings(previous.evidenceIds, current.evidenceIds) &&
    sameStrings(previous.verifierOutcomes, current.verifierOutcomes)
  )
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Pick the claim a Zod issue points at (by path index), else the first claim. */
function offendingClaim(output: unknown, path?: readonly (string | number)[]): { text: string; evidence_ids: string[] } | undefined {
  const doc = output as { claims?: Array<{ text?: unknown; evidence_ids?: unknown }> } | undefined
  const claims = doc?.claims
  if (!Array.isArray(claims) || claims.length === 0) return undefined
  const index = typeof path?.[1] === 'number' ? path[1] : 0
  const claim = claims[index] ?? claims[0]
  if (!claim) return undefined
  return {
    text: typeof claim.text === 'string' ? claim.text : '',
    evidence_ids: Array.isArray(claim.evidence_ids) ? claim.evidence_ids.filter((id): id is string => typeof id === 'string') : [],
  }
}

/** Extract claimGuard's issues from the document shape. */
function parseWithGuard(guard: ClaimGuard, output: unknown): { ok: true; document: ClaimsDocument } | { ok: false; issues: readonly ClaimIssue[] } {
  const result = guard.validateInput(output)
  return result.ok ? { ok: true, document: result.data } : { ok: false, issues: result.issues }
}

/**
 * Rule 4: an "unknown" or "blocked" claim must be disclosed to the user in
 * open_questions or unverified_assumptions. Undisclosed items are a fake
 * completion signal and block the turn.
 */
function undisclosedIssues(document: ClaimsDocument): ClaimIssue[] {
  const issues: ClaimIssue[] = []
  document.claims.forEach((claim: Claim, index: number) => {
    if (claim.status !== 'unknown' && claim.status !== 'blocked') return
    const disclosed = claim.open_questions.length > 0 || claim.unverified_assumptions.length > 0
    if (!disclosed) {
      issues.push({
        code: 'undisclosed_unknown',
        path: ['claims', index, 'status'],
        message: `Claim ${index} is "${claim.status}" but was not disclosed in open_questions or unverified_assumptions`,
      })
    }
  })
  return issues
}

function issueToJson(issue: ClaimIssue): JsonValue {
  return {
    code: issue.code,
    path: issue.path.map((part) => String(part)),
    message: issue.message,
  }
}

export class CompletionGate implements CompletionHookAdapter {
  /** Immutable after construction — no hot-reload mutation surface. */
  private readonly claimGuard: ClaimGuard
  private readonly ledger: LedgerReader
  private readonly maxRetries: number
  private readonly suspendAdapter: SuspendAdapter
  private readonly sessionId?: string
  private readonly maxStepsPerTurn: number
  private readonly maxToolCallsPerTurn: number
  private readonly maxConsecutiveNoProgressSteps: number
  private attempts = 0
  private boundOutput?: unknown
  /** Per-turn divergence counters (in-memory, no second store). */
  private turn = -1
  private stepsThisTurn = 0
  private toolCallsThisTurn = 0
  private consecutiveNoProgress = 0
  private previousProgress?: ProgressSnapshot

  constructor(config: CompletionGateConfig) {
    this.claimGuard = new ClaimGuard({ ledger: config.ledger })
    this.ledger = config.ledger
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES)
    this.suspendAdapter = config.suspendAdapter
    this.sessionId = config.sessionId
    // Conservative defaults: enough headroom for normal multi-step tasks while
    // bounding runaway loops; see README#divergence-defaults.
    this.maxStepsPerTurn = Math.max(1, config.maxStepsPerTurn ?? DEFAULT_MAX_STEPS_PER_TURN)
    this.maxToolCallsPerTurn = Math.max(0, config.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN)
    this.maxConsecutiveNoProgressSteps = Math.max(1, config.maxConsecutiveNoProgressSteps ?? DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_STEPS)
  }

  /**
   * Record one step/tool observation for divergence detection. Callers invoke
   * this once per step (and once per tool call via `noteToolCall`) so the gate
   * sees activity even when the model has not produced a final claim output.
   */
  noteStep(document?: ClaimsDocument, verifierOutcomes: readonly string[] = []): void {
    this.stepsThisTurn += 1
    const snapshot = progressSnapshot(document, verifierOutcomes)
    if (hasProgress(this.previousProgress, snapshot)) {
      this.consecutiveNoProgress = 0
    } else {
      this.consecutiveNoProgress += 1
    }
    this.previousProgress = snapshot
  }

  noteToolCall(turn?: number): void {
    if (turn !== undefined && this.turn !== turn) this.resetTurn(turn)
    this.toolCallsThisTurn += 1
  }

  private resetTurn(turn: number): void {
    this.turn = turn
    this.stepsThisTurn = 0
    this.toolCallsThisTurn = 0
    this.consecutiveNoProgress = 0
    this.previousProgress = undefined
  }

  /** Aborts through the EXISTING suspend adapter path; no second abort route. */
  private async checkDivergence(output: unknown, ctx: CompletionContext): Promise<CompletionDecision | undefined> {
    if (this.turn !== ctx.turn) this.resetTurn(ctx.turn)

    const parsed = parseWithGuard(this.claimGuard, output)
    // Observe this step using the same progress definition as noteStep.
    this.noteStep(parsed.ok ? parsed.document : undefined)

    const limits: Array<{ limit: DivergenceReason; count: number; max: number; atLimit: boolean }> = [
      { limit: 'step_budget_exceeded', count: this.stepsThisTurn, max: this.maxStepsPerTurn, atLimit: false },
      { limit: 'tool_call_budget_exceeded', count: this.toolCallsThisTurn, max: this.maxToolCallsPerTurn, atLimit: false },
      // No-progress is a streak: reaching the limit already means divergence.
      { limit: 'no_progress_exceeded', count: this.consecutiveNoProgress, max: this.maxConsecutiveNoProgressSteps, atLimit: true },
    ]
    const exceeded = limits.find((entry) => entry.atLimit ? entry.count >= entry.max : entry.count > entry.max)
    if (!exceeded) return undefined

    const structuredReason = `${exceeded.limit} (${exceeded.count}/${exceeded.max})`
    const result = await this.suspendAdapter.suspend({
      ...(this.sessionId ?? ctx.sessionId ? { sessionId: this.sessionId ?? ctx.sessionId } : {}),
      turn: ctx.turn,
      attempts: this.attempts,
      maxRetries: this.maxRetries,
      issues: [{ code: exceeded.limit, path: ['gate', 'limits'], message: structuredReason }],
    })
    const reason: AbortReason = {
      kind: 'hook',
      category: categoryForIssue(exceeded.limit),
      counts: { actual: exceeded.count, limit: exceeded.max },
      detail: `Completion gate suspended: ${result.reason}; ${structuredReason}`,
    }
    return abortDecision(reason)
  }

  /** Number of invalid outputs seen; exposed for diagnostics only (no setter). */
  get attemptCount(): number {
    return this.attempts
  }

  /**
   * Evaluate one model output. `output` is whatever the caller extracted from
   * the model message (typically parsed JSON). This method never throws on
   * malformed input: claimGuard returns structured issues.
   */
  async evaluate(output: unknown, ctx: CompletionContext): Promise<CompletionDecision> {
    // Deterministic divergence limits, checked before any completion decision.
    const diverged = await this.checkDivergence(output, ctx)
    if (diverged) return diverged
    const parsed = parseWithGuard(this.claimGuard, output)
    const issues: ClaimIssue[] = parsed.ok ? undisclosedIssues(parsed.document) : [...parsed.issues]

    if (issues.length === 0 && parsed.ok) {
      // Valid claims: also confirm every cited id resolves with ok=true.
      // claimGuard already enforces this; the ledger field is checked here so
      // the gate remains correct if a caller injects a different guard result.
      const unresolved = this.findLedgerIssues(parsed.document)
      if (unresolved.length > 0) issues.push(...unresolved)
    }

    if (issues.length === 0) {
      this.attempts = 0
      return { kind: 'complete' }
    }

    this.attempts += 1
    if (this.attempts > this.maxRetries) {
      const result = await this.suspendAdapter.suspend({
        ...(this.sessionId ?? ctx.sessionId ? { sessionId: this.sessionId ?? ctx.sessionId } : {}),
        turn: ctx.turn,
        attempts: this.attempts,
        maxRetries: this.maxRetries,
        issues,
      })
      const primary = issues[0]
      // Categorize by the LAST rejection cause, not by the fact that retries
      // ran out. Exhaustion stays visible in counts + detail.
      const causeCategory = primary ? categoryForIssue(primary.code) : 'claim_invalid'
      const offending = offendingClaim(output, primary?.path)
      const reason: AbortReason = {
        kind: 'hook',
        category: causeCategory,
        ...(offending ? { claim_text: offending.text } : {}),
        ...(offending && offending.evidence_ids.length ? { evidence_ids: offending.evidence_ids } : {}),
        counts: { actual: this.attempts, limit: this.maxRetries },
        detail: `Completion gate suspended: retries exhausted (${this.attempts}/${this.maxRetries}); ${result.reason}${primary ? ` (${primary.code}: ${primary.message})` : ''}`,
      }
      return abortDecision(reason)
    }

    return {
      kind: 'feedback',
      feedback: [
        'Completion gate rejected your claims. Fix all issues below before finishing the turn.',
        {
          gate: 'completion',
          attempts: this.attempts,
          maxRetries: this.maxRetries,
          issues: issues.map(issueToJson),
        },
      ],
    }
  }

  /**
   * DSH CompletionHookAdapter entry point. The P0 interface carries no output,
   * so the host integration must bind the model output via `bindOutput()` before
   * calling this. Unbound calls abort (never a fake completion) with feedback.
   */
  async beforeCompletion(ctx: CompletionContext): Promise<CompletionDecision> {
    if (this.boundOutput === undefined) {
      return abortDecision({
        kind: 'hook',
        category: 'claim_invalid',
        detail: 'Completion gate has no model output bound; refusing to complete',
      })
    }
    const output = this.boundOutput
    this.boundOutput = undefined
    return this.evaluate(output, ctx)
  }

  /**
   * One-shot output binding for the DSH bridge. Not a config setter: it is
   * consumed by the next beforeCompletion call and does not change gate policy.
   */
  bindOutput(output: unknown): void {
    this.boundOutput = output
  }

  /** Ledger re-check for cited evidence; defensive, mirrors claimGuard rules 2-3. */
  private findLedgerIssues(document: ClaimsDocument): ClaimIssue[] {
    const issues: ClaimIssue[] = []
    document.claims.forEach((claim, index) => {
      claim.evidence_ids.forEach((ref, evidenceIndex) => {
        const entry = this.ledger.getEntry(ref)
        if (!entry) {
          issues.push({
            code: 'evidence_unresolved',
            path: ['claims', index, 'evidence_ids', evidenceIndex],
            message: `Evidence id "${ref}" does not resolve to a ledger entry`,
          })
        } else if (!entry.ok) {
          issues.push({
            code: 'evidence_failed',
            path: ['claims', index, 'evidence_ids', evidenceIndex],
            message: `Evidence id "${ref}" refers to a failed tool call and cannot support a claim`,
          })
        }
      })
    })
    return issues
  }
}
