export const ABORT_CATEGORIES = [
    'claim_invalid',
    'evidence_missing',
    'evidence_failed',
    'verifier_failed',
    'retry_exhausted',
    'repeated_tool_call',
    'step_budget_exceeded',
    'tool_call_budget_exceeded',
    'no_progress_exceeded',
    'exporter_failed',
];
export function isAbortCategory(value) {
    return ABORT_CATEGORIES.includes(value);
}
/** Map a claim-issue code to its single abort category. */
export function categoryForIssue(code) {
    if (code === 'custom')
        return 'claim_invalid';
    if (code === 'evidence_unresolved')
        return 'evidence_missing';
    if (code === 'evidence_failed')
        return 'evidence_failed';
    if (code === 'verifier_failed')
        return 'verifier_failed';
    if (code === 'repeated_tool_call')
        return 'repeated_tool_call';
    if (code.startsWith('step_budget'))
        return 'step_budget_exceeded';
    if (code.startsWith('tool_call_budget'))
        return 'tool_call_budget_exceeded';
    if (code.startsWith('no_progress'))
        return 'no_progress_exceeded';
    return 'claim_invalid';
}
/** Build the legacy string from a structured reason (keeps greppable detail). */
export function legacyReason(reason) {
    // Preserve old reason text verbatim as the base; append structured hints so
    // existing string assertions and greps keep working.
    const counts = reason.counts ? ` (${reason.counts.actual}/${reason.counts.limit})` : '';
    return `${reason.detail}${counts} [category=${reason.category}]`;
}
/** Build a CompletionDecision-shaped abort with both representations. */
export function abortDecision(reason) {
    return { kind: 'abort', reason: legacyReason(reason), abortDetail: reason };
}
/**
 * Pure formatter: one stable, greppable line per aborted turn.
 * Absent fields render as "-" so the shape never varies. Quotes, backslashes
 * and newlines are escaped so the line stays single-line and grep-stable.
 */
function quote(value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}
export function formatAbortLine(reason) {
    const claim = reason.claim_text ? `claim=${quote(reason.claim_text)}` : 'claim=-';
    const evidence = reason.evidence_ids?.length ? `evidence=${reason.evidence_ids.map(quote).join(',')}` : 'evidence=-';
    const verifier = reason.verifier
        ? `verifier=${reason.verifier.type}:${quote(reason.verifier.detail)}`
        : 'verifier=-';
    const counts = reason.counts ? `counts=${reason.counts.actual}/${reason.counts.limit}` : 'counts=-';
    const detail = `detail=${quote(reason.detail)}`;
    return `[false-completion-gate] abort category=${reason.category} ${claim} ${evidence} ${verifier} ${counts} ${detail}`;
}
/** Convert an abort detail to a JSON-safe value (for trace attributes/events). */
export function abortDetailToJson(reason) {
    return {
        kind: reason.kind,
        category: reason.category,
        ...(reason.claim_text ? { claim_text: reason.claim_text } : {}),
        ...(reason.evidence_ids ? { evidence_ids: [...reason.evidence_ids] } : {}),
        ...(reason.verifier ? { verifier: reason.verifier } : {}),
        ...(reason.counts ? { counts: reason.counts } : {}),
        detail: reason.detail,
    };
}
