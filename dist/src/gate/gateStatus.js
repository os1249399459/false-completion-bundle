/**
 * Read-only gate status tool support.
 *
 * Strictly read-only: reads env/config and (optionally) today's abort log.
 * It never evaluates claims, triggers retries, or emits evidence.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_MAX_RETRIES } from './completionGate.js';
const DEFAULT_LIMITS = { steps: 20, toolCalls: 30, noProgress: 3 };
/** Resolve the abort log path exactly like src/gate/abortLog.ts does. */
export function resolveAbortLogPath(env = process.env) {
    const configured = env['DSH_ABORT_LOG'];
    return configured && configured.length > 0 ? configured : undefined;
}
function activeVerifiers(env) {
    const active = ['filesystem'];
    if (env['DSH_FALSE_COMPLETION_PLAYWRIGHT'] === '1')
        active.push('playwright');
    if (env['GITHUB_TOKEN'])
        active.push('github');
    const backend = env['VERIFIER_BACKEND'] ?? '';
    if (['ragas', 'trulens', 'deepeval'].includes(backend))
        active.push('python');
    return active;
}
function readTail(path, count) {
    try {
        const text = readFileSync(path, 'utf8');
        const lines = text.split('\n').filter((line) => line.trim().length > 0);
        return { entries: lines.slice(-count) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Missing or unreadable log is normal and must never fail the tool.
        return { entries: [], error: message };
    }
}
/** Build the status snapshot without side effects. */
export function buildGateStatus(input = {}) {
    const env = input.env ?? process.env;
    const path = resolveAbortLogPath(env);
    const tail = path ? readTail(path, 5) : { entries: [] };
    return {
        effective: {
            maxRetries: Number(env['FALSE_COMPLETION_MAX_RETRIES'] ?? DEFAULT_MAX_RETRIES),
            maxStepsPerTurn: Number(env['FALSE_COMPLETION_MAX_STEPS'] ?? DEFAULT_LIMITS.steps),
            maxToolCallsPerTurn: Number(env['FALSE_COMPLETION_MAX_TOOL_CALLS'] ?? DEFAULT_LIMITS.toolCalls),
            maxConsecutiveNoProgressSteps: Number(env['FALSE_COMPLETION_MAX_NO_PROGRESS'] ?? DEFAULT_LIMITS.noProgress),
            activeVerifiers: activeVerifiers(env),
            profile: env['DSH_PROFILE'] ?? 'unknown',
            otelEndpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318 (default)',
        },
        abortLog: {
            path: path ?? '(unset — stderr only)',
            source: path ? 'env' : 'none',
            exists: tail.error === undefined,
            entries: tail.entries,
            ...(tail.error ? { error: tail.error } : {}),
        },
    };
}
/** Compact, chat-friendly rendering of the status snapshot. */
export function formatGateStatus(status) {
    const e = status.effective;
    const counts = [
        `maxRetries=${e.maxRetries}`,
        `steps=${e.maxStepsPerTurn}`,
        `toolCalls=${e.maxToolCallsPerTurn}`,
        `noProgress=${e.maxConsecutiveNoProgressSteps}`,
    ].join(' ');
    const lines = [
        '## Completion gate status',
        '',
        '**Effective config**',
        `- ${counts}`,
        `- active verifiers: ${e.activeVerifiers.join(', ')}`,
        `- profile: ${e.profile}`,
        `- otel endpoint: ${e.otelEndpoint}`,
        '',
        '**Abort log**',
        `- path: ${status.abortLog.path} (${status.abortLog.source})`,
    ];
    if (!status.abortLog.exists) {
        lines.push('- status: not created yet (no aborts recorded, or path unset)');
        if (status.abortLog.error)
            lines.push(`- note: ${status.abortLog.error}`);
    }
    else if (status.abortLog.entries.length === 0) {
        lines.push('- last entries: (file exists but is empty)');
    }
    else {
        lines.push(`- last ${status.abortLog.entries.length} entries:`);
        lines.push('```');
        lines.push(...status.abortLog.entries);
        lines.push('```');
    }
    return lines.join('\n');
}
