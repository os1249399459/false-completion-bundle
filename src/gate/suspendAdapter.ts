/**
 * Suspend adapter — the terminal escape hatch for the completion gate.
 *
 * When the gate exhausts its retries it MUST NOT allow completion. It calls
 * this adapter, then returns an abort decision. The adapter is deliberately a
 * seam: if the host exposes a DSH suspend/approval service it is used;
 * otherwise the documented in-memory hook records the suspension for the host
 * to inspect. Suspension is never a "soft success".
 */
import type { ClaimIssue } from '../schema/claim.schema.js'

export interface SuspendContext {
  readonly sessionId?: string
  readonly turn: number
  /** Number of invalid claim outputs seen so far. */
  readonly attempts: number
  readonly maxRetries: number
  readonly issues: readonly ClaimIssue[]
}

export type SuspendResult =
  | { readonly kind: 'suspended'; readonly reason: string; readonly ticket?: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface SuspendAdapter {
  suspend(ctx: SuspendContext): Promise<SuspendResult>
}

/**
 * Structural bridge to an existing DSH suspend/approval adapter. No
 * @deepseek-ai/* import: the host injects a compatible object. If neither
 * method is present, the documented fallback applies.
 */
export interface DshSuspendBridge {
  /** Existing DSH approval adapter, if mounted. */
  requestApproval?(reason: string): Promise<{ allowed: boolean; reason?: string }>
  /** Existing DSH turn-suspend hook, if mounted. */
  suspendTurn?(reason: string): Promise<void>
}

export interface SuspensionRecord {
  readonly ticket: string
  readonly sessionId?: string
  readonly turn: number
  readonly attempts: number
  readonly reason: string
  readonly issues: readonly ClaimIssue[]
  readonly bridgeUsed: 'approval' | 'turn' | 'none'
  readonly approvalAllowed?: boolean
  readonly at: string
}

export interface DocumentedSuspendAdapterConfig {
  /** Existing DSH bridge. Optional; absence triggers the documented fallback. */
  readonly bridge?: DshSuspendBridge
  /** Documented hook called on every suspension, including fallback suspensions. */
  readonly onSuspend?: (record: SuspensionRecord) => void
}

/**
 * Default suspend adapter.
 *
 * Resolution order:
 *  1. bridge.suspendTurn(reason) — existing DSH turn suspension.
 *  2. bridge.requestApproval(reason) — existing DSH approval adapter.
 *  3. documented fallback — record the suspension locally and notify onSuspend.
 *
 * In every case the gate receives a typed result and still aborts the turn.
 * A denied/absent approval never turns into a successful completion.
 */
export class DocumentedSuspendAdapter implements SuspendAdapter {
  private readonly bridge?: DshSuspendBridge
  private readonly onSuspend?: (record: SuspensionRecord) => void
  private readonly records: SuspensionRecord[] = []
  private sequence = 0

  constructor(config: DocumentedSuspendAdapterConfig = {}) {
    this.bridge = config.bridge
    this.onSuspend = config.onSuspend
  }

  async suspend(ctx: SuspendContext): Promise<SuspendResult> {
    const reason = `Completion gate exhausted retries (${ctx.attempts}/${ctx.maxRetries}) for session ${ctx.sessionId ?? 'anonymous'}, turn ${ctx.turn}`
    let bridgeUsed: SuspensionRecord['bridgeUsed'] = 'none'
    let approvalAllowed: boolean | undefined

    try {
      if (this.bridge?.suspendTurn) {
        await this.bridge.suspendTurn(reason)
        bridgeUsed = 'turn'
      } else if (this.bridge?.requestApproval) {
        const outcome = await this.bridge.requestApproval(reason)
        approvalAllowed = outcome.allowed
        bridgeUsed = 'approval'
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const record: SuspensionRecord = {
        ticket: this.nextTicket(),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        turn: ctx.turn,
        attempts: ctx.attempts,
        reason: `${reason}; bridge error: ${detail}`,
        issues: ctx.issues,
        bridgeUsed,
        ...(approvalAllowed === undefined ? {} : { approvalAllowed }),
        at: new Date().toISOString(),
      }
      this.records.push(record)
      this.onSuspend?.(record)
      return { kind: 'unavailable', reason: record.reason }
    }

    const record: SuspensionRecord = {
      ticket: this.nextTicket(),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      turn: ctx.turn,
      attempts: ctx.attempts,
      reason,
      issues: ctx.issues,
      bridgeUsed,
      ...(approvalAllowed === undefined ? {} : { approvalAllowed }),
      at: new Date().toISOString(),
    }
    this.records.push(record)
    this.onSuspend?.(record)

    return bridgeUsed === 'none'
      ? { kind: 'unavailable', reason }
      : { kind: 'suspended', reason, ticket: record.ticket }
  }

  /** Inspect recorded suspensions (host diagnostics / tests). */
  listSuspensions(): readonly SuspensionRecord[] {
    return [...this.records]
  }

  private nextTicket(): string {
    this.sequence += 1
    return `suspend-${this.sequence.toString().padStart(6, '0')}`
  }
}
