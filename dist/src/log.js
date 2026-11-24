/**
 * Debug-channel logging for the completion gate.
 *
 * Per-turn trace lines (`turn-stopping fired`, `parsed claim output
 * status=...`) are diagnostics, not evidence: on a busy host they flood the
 * terminal and bury the lines that matter. They are therefore gated behind
 * `FALSE_COMPLETION_DEBUG=1`.
 *
 * What this module must NEVER be used for:
 *  - abort lines (`emitAbortLine` / `formatAbortLine`) — those are the audit
 *    trail and stay loud unconditionally;
 *  - suspensions, exporter failures, or abort-log write failures — same reason.
 * Anything that explains why a turn was blocked is always printed.
 *
 * No logging dependency: this is `console.error` with one boolean in front.
 */
/** Env var that turns per-turn trace lines back on. Unset/empty/'0' = off. */
export const DEBUG_ENV = 'FALSE_COMPLETION_DEBUG';
/**
 * True only for an explicit truthy value. Deliberately strict: `0`, `false`,
 * `no`, `off`, and the empty string all mean OFF, so a typo cannot silently
 * re-enable the flood. Anything else non-empty enables.
 */
export function isDebugEnabled(env = process.env) {
    const raw = env[DEBUG_ENV];
    if (raw === undefined)
        return false;
    const value = raw.trim().toLowerCase();
    if (value.length === 0)
        return false;
    return !['0', 'false', 'no', 'off'].includes(value);
}
/** Print a gated diagnostic line. No-op unless {@link isDebugEnabled}. */
export function logDebug(message, env = process.env) {
    if (!isDebugEnabled(env))
        return;
    console.error(message);
}
