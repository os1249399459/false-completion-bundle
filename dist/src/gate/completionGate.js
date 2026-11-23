import { ClaimGuard } from '../schema/claimGuard.js';
import { abortDecision, categoryForIssue } from './abortReason.js';
/**
 * Canonical retry budget. Single source of truth for the gate default, the
 * entry's env fallback, and the documentation. Kept at 1 to match the (2/1)
 * retry-exhaustion semantics used throughout prior verification.
 */
export const DEFAULT_MAX_RETRIES = 1;
/** Compute a progress snapshot from a claim document and tool-call tally. */
export function progressSnapshot(document, verifierOutcomes = []) {
    const claims = document?.claims ?? [];
    return {
        claimStatuses: claims.map((claim) => claim.status),
        evidenceIds: [...new Set(claims.flatMap((claim) => claim.evidence_ids))].sort(),
        verifierOutcomes: [...verifierOutcomes],
    };
}
/** True when any progress dimension changed vs the previous step. */
export function hasProgress(previous, current) {
    if (!previous)
        return true;
    return !(sameStrings(previous.claimStatuses, current.claimStatuses) &&
        sameStrings(previous.evidenceIds, current.evidenceIds) &&
        sameStrings(previous.verifierOutcomes, current.verifierOutcomes));
}
function sameStrings(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
/** Pick the claim a Zod issue points at (by path index), else the first claim. */
function offendingClaim(output, path) {
    const doc = output;
    const claims = doc?.claims;
    if (!Array.isArray(claims) || claims.length === 0)
        return undefined;
    const index = typeof path?.[1] === 'number' ? path[1] : 0;
    const claim = claims[index] ?? claims[0];
    if (!claim)
        return undefined;
    return {
        text: typeof claim.text === 'string' ? claim.text : '',
        evidence_ids: Array.isArray(claim.evidence_ids) ? claim.evidence_ids.filter((id) => typeof id === 'string') : [],
    };
}
/** Extract claimGuard's issues from the document shape. */
function parseWithGuard(guard, output) {
    const result = guard.validateInput(output);
    return result.ok ? { ok: true, document: result.data } : { ok: false, issues: result.issues };
}
/**
 * Rule 4: an "unknown" or "blocked" claim must be disclosed to the user in
 * open_questions or unverified_assumptions. Undisclosed items are a fake
 * completion signal and block the turn.
 */
function undisclosedIssues(document) {
    const issues = [];
    document.claims.forEach((claim, index) => {
        if (claim.status !== 'unknown' && claim.status !== 'blocked')
            return;
        const disclosed = claim.open_questions.length > 0 || claim.unverified_assumptions.length > 0;
        if (!disclosed) {
            issues.push({
                code: 'undisclosed_unknown',
                path: ['claims', index, 'status'],
                message: `Claim ${index} is "${claim.status}" but was not disclosed in open_questions or unverified_assumptions`,
            });
        }
    });
    return issues;
}
function issueToJson(issue) {
    return {
        code: issue.code,
        path: issue.path.map((part) => String(part)),
        message: issue.message,
    };
}
export class CompletionGate {
    /** Immutable after construction — no hot-reload mutation surface. */
    claimGuard;
    ledger;
    maxRetries;
    suspendAdapter;
    sessionId;
    maxStepsPerTurn;
    maxToolCallsPerTurn;
    maxConsecutiveNoProgressSteps;
    attempts = 0;
    boundOutput;
    /** Per-turn divergence counters (in-memory, no second store). */
    turn = -1;
    stepsThisTurn = 0;
    toolCallsThisTurn = 0;
    consecutiveNoProgress = 0;
    previousProgress;
    constructor(config) {
        this.claimGuard = new ClaimGuard({ ledger: config.ledger });
        this.ledger = config.ledger;
        this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES);
        this.suspendAdapter = config.suspendAdapter;
        this.sessionId = config.sessionId;
        // Conservative defaults: enough headroom for normal multi-step tasks while
        // bounding runaway loops; see README#divergence-defaults.
        this.maxStepsPerTurn = Math.max(1, config.maxStepsPerTurn ?? 20);
        this.maxToolCallsPerTurn = Math.max(0, config.maxToolCallsPerTurn ?? 30);
        this.maxConsecutiveNoProgressSteps = Math.max(1, config.maxConsecutiveNoProgressSteps ?? 3);
    }
    /**
     * Record one step/tool observation for divergence detection. Callers invoke
     * this once per step (and once per tool call via `noteToolCall`) so the gate
     * sees activity even when the model has not produced a final claim output.
     */
    noteStep(document, verifierOutcomes = []) {
        this.stepsThisTurn += 1;
        const snapshot = progressSnapshot(document, verifierOutcomes);
        if (hasProgress(this.previousProgress, snapshot)) {
            this.consecutiveNoProgress = 0;
        }
        else {
            this.consecutiveNoProgress += 1;
        }
        this.previousProgress = snapshot;
    }
    noteToolCall(turn) {
        if (turn !== undefined && this.turn !== turn)
            this.resetTurn(turn);
        this.toolCallsThisTurn += 1;
    }
    resetTurn(turn) {
        this.turn = turn;
        this.stepsThisTurn = 0;
        this.toolCallsThisTurn = 0;
        this.consecutiveNoProgress = 0;
        this.previousProgress = undefined;
    }
    /** Aborts through the EXISTING suspend adapter path; no second abort route. */
    async checkDivergence(output, ctx) {
        if (this.turn !== ctx.turn)
            this.resetTurn(ctx.turn);
        const parsed = parseWithGuard(this.claimGuard, output);
        // Observe this step using the same progress definition as noteStep.
        this.noteStep(parsed.ok ? parsed.document : undefined);
        const limits = [
            { limit: 'step_budget_exceeded', count: this.stepsThisTurn, max: this.maxStepsPerTurn, atLimit: false },
            { limit: 'tool_call_budget_exceeded', count: this.toolCallsThisTurn, max: this.maxToolCallsPerTurn, atLimit: false },
            // No-progress is a streak: reaching the limit already means divergence.
            { limit: 'no_progress_exceeded', count: this.consecutiveNoProgress, max: this.maxConsecutiveNoProgressSteps, atLimit: true },
        ];
        const exceeded = limits.find((entry) => entry.atLimit ? entry.count >= entry.max : entry.count > entry.max);
        if (!exceeded)
            return undefined;
        const structuredReason = `${exceeded.limit} (${exceeded.count}/${exceeded.max})`;
        const result = await this.suspendAdapter.suspend({
            ...(this.sessionId ?? ctx.sessionId ? { sessionId: this.sessionId ?? ctx.sessionId } : {}),
            turn: ctx.turn,
            attempts: this.attempts,
            maxRetries: this.maxRetries,
            issues: [{ code: exceeded.limit, path: ['gate', 'limits'], message: structuredReason }],
        });
        const reason = {
            kind: 'hook',
            category: categoryForIssue(exceeded.limit),
            counts: { actual: exceeded.count, limit: exceeded.max },
            detail: `Completion gate suspended: ${result.reason}; ${structuredReason}`,
        };
        return abortDecision(reason);
    }
    /** Number of invalid outputs seen; exposed for diagnostics only (no setter). */
    get attemptCount() {
        return this.attempts;
    }
    /**
     * Evaluate one model output. `output` is whatever the caller extracted from
     * the model message (typically parsed JSON). This method never throws on
     * malformed input: claimGuard returns structured issues.
     */
    async evaluate(output, ctx) {
        // Deterministic divergence limits, checked before any completion decision.
        const diverged = await this.checkDivergence(output, ctx);
        if (diverged)
            return diverged;
        const parsed = parseWithGuard(this.claimGuard, output);
        const issues = parsed.ok ? undisclosedIssues(parsed.document) : [...parsed.issues];
        if (issues.length === 0 && parsed.ok) {
            // Valid claims: also confirm every cited id resolves with ok=true.
            // claimGuard already enforces this; the ledger field is checked here so
            // the gate remains correct if a caller injects a different guard result.
            const unresolved = this.findLedgerIssues(parsed.document);
            if (unresolved.length > 0)
                issues.push(...unresolved);
        }
        if (issues.length === 0) {
            this.attempts = 0;
            return { kind: 'complete' };
        }
        this.attempts += 1;
        if (this.attempts > this.maxRetries) {
            const result = await this.suspendAdapter.suspend({
                ...(this.sessionId ?? ctx.sessionId ? { sessionId: this.sessionId ?? ctx.sessionId } : {}),
                turn: ctx.turn,
                attempts: this.attempts,
                maxRetries: this.maxRetries,
                issues,
            });
            const primary = issues[0];
            // Categorize by the LAST rejection cause, not by the fact that retries
            // ran out. Exhaustion stays visible in counts + detail.
            const causeCategory = primary ? categoryForIssue(primary.code) : 'claim_invalid';
            const offending = offendingClaim(output, primary?.path);
            const reason = {
                kind: 'hook',
                category: causeCategory,
                ...(offending ? { claim_text: offending.text } : {}),
                ...(offending && offending.evidence_ids.length ? { evidence_ids: offending.evidence_ids } : {}),
                counts: { actual: this.attempts, limit: this.maxRetries },
                detail: `Completion gate suspended: retries exhausted (${this.attempts}/${this.maxRetries}); ${result.reason}${primary ? ` (${primary.code}: ${primary.message})` : ''}`,
            };
            return abortDecision(reason);
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
        };
    }
    /**
     * DSH CompletionHookAdapter entry point. The P0 interface carries no output,
     * so the host integration must bind the model output via `bindOutput()` before
     * calling this. Unbound calls abort (never a fake completion) with feedback.
     */
    async beforeCompletion(ctx) {
        if (this.boundOutput === undefined) {
            return abortDecision({
                kind: 'hook',
                category: 'claim_invalid',
                detail: 'Completion gate has no model output bound; refusing to complete',
            });
        }
        const output = this.boundOutput;
        this.boundOutput = undefined;
        return this.evaluate(output, ctx);
    }
    /**
     * One-shot output binding for the DSH bridge. Not a config setter: it is
     * consumed by the next beforeCompletion call and does not change gate policy.
     */
    bindOutput(output) {
        this.boundOutput = output;
    }
    /** Ledger re-check for cited evidence; defensive, mirrors claimGuard rules 2-3. */
    findLedgerIssues(document) {
        const issues = [];
        document.claims.forEach((claim, index) => {
            claim.evidence_ids.forEach((ref, evidenceIndex) => {
                const entry = this.ledger.getEntry(ref);
                if (!entry) {
                    issues.push({
                        code: 'evidence_unresolved',
                        path: ['claims', index, 'evidence_ids', evidenceIndex],
                        message: `Evidence id "${ref}" does not resolve to a ledger entry`,
                    });
                }
                else if (!entry.ok) {
                    issues.push({
                        code: 'evidence_failed',
                        path: ['claims', index, 'evidence_ids', evidenceIndex],
                        message: `Evidence id "${ref}" refers to a failed tool call and cannot support a claim`,
                    });
                }
            });
        });
        return issues;
    }
}
