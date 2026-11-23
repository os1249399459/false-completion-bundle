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
export class DocumentedSuspendAdapter {
    bridge;
    onSuspend;
    records = [];
    sequence = 0;
    constructor(config = {}) {
        this.bridge = config.bridge;
        this.onSuspend = config.onSuspend;
    }
    async suspend(ctx) {
        const reason = `Completion gate exhausted retries (${ctx.attempts}/${ctx.maxRetries}) for session ${ctx.sessionId ?? 'anonymous'}, turn ${ctx.turn}`;
        let bridgeUsed = 'none';
        let approvalAllowed;
        try {
            if (this.bridge?.suspendTurn) {
                await this.bridge.suspendTurn(reason);
                bridgeUsed = 'turn';
            }
            else if (this.bridge?.requestApproval) {
                const outcome = await this.bridge.requestApproval(reason);
                approvalAllowed = outcome.allowed;
                bridgeUsed = 'approval';
            }
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const record = {
                ticket: this.nextTicket(),
                ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
                turn: ctx.turn,
                attempts: ctx.attempts,
                reason: `${reason}; bridge error: ${detail}`,
                issues: ctx.issues,
                bridgeUsed,
                ...(approvalAllowed === undefined ? {} : { approvalAllowed }),
                at: new Date().toISOString(),
            };
            this.records.push(record);
            this.onSuspend?.(record);
            return { kind: 'unavailable', reason: record.reason };
        }
        const record = {
            ticket: this.nextTicket(),
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
            turn: ctx.turn,
            attempts: ctx.attempts,
            reason,
            issues: ctx.issues,
            bridgeUsed,
            ...(approvalAllowed === undefined ? {} : { approvalAllowed }),
            at: new Date().toISOString(),
        };
        this.records.push(record);
        this.onSuspend?.(record);
        return bridgeUsed === 'none'
            ? { kind: 'unavailable', reason }
            : { kind: 'suspended', reason, ticket: record.ticket };
    }
    /** Inspect recorded suspensions (host diagnostics / tests). */
    listSuspensions() {
        return [...this.records];
    }
    nextTicket() {
        this.sequence += 1;
        return `suspend-${this.sequence.toString().padStart(6, '0')}`;
    }
}
