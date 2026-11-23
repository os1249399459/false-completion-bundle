/**
 * Real DSH plugin entry: binds the completion gate to `agent/turn-stopping`.
 *
 * Confirmed DSH API (0.2.1-rc.5, cordis inspect Event catalog):
 * - 'agent/turn-stopping' is serial, awaited before the turn boundary commits.
 *   Payload: { agent, turn, signal }. Feedback is delivered by agent.steer().
 * - Per-agent listeners register on agent.ctx inside 'agent/created'.
 */
import { CompletionGate, DEFAULT_MAX_RETRIES } from '../src/gate/completionGate.js';
import { DocumentedSuspendAdapter } from '../src/gate/suspendAdapter.js';
import { OtelLedgerAdapter } from '../src/adapters/ledgerAdapter.js';
import { printProbe, probeVerifiers } from '../src/telemetry/verifierProbe.js';
import { abortDecision } from '../src/gate/abortReason.js';
import { emitAbortLine } from '../src/gate/abortLog.js';
import { buildGateStatus, formatGateStatus } from '../src/gate/gateStatus.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MessageId } from '@deepseek-ai/dsh-llm/brand';
export const name = 'false-completion-gate';
// `tools` is required to register the read-only status tool. Declaring it is
// what lets `ctx.tools` resolve; omitting it throws "cannot get property".
export const inject = ['tools'];
/**
 * Emit exactly one greppable abort line per aborted turn, and return the
 * structure needed by agent.cancel. Pure formatter is in abortReason.ts.
 */
function abortWith(reason, cancel) {
    emitAbortLine(reason);
    const decision = abortDecision(reason);
    cancel({ kind: 'hook', reason: decision.reason });
}
function feedbackMessage(feedback, turn) {
    const text = feedback
        .map((part) => (typeof part === 'string' ? part : JSON.stringify(part, null, 2)))
        .join('\n\n');
    const content = [{ type: 'text', text: `COMPLETION GATE (${`turn ${turn}`})\n\n${text}` }];
    return {
        id: MessageId(`gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        role: 'user',
        content,
        source: { kind: 'user' },
    };
}
export function apply(ctx) {
    // Startup diagnostic only. Never throws; strict profile guards handle refusal.
    printProbe(probeVerifiers({
        cwd: process.cwd(),
        playwrightEnabled: process.env['DSH_FALSE_COMPLETION_PLAYWRIGHT'] === '1',
        verifierBackend: process.env['VERIFIER_BACKEND'],
        githubToken: process.env['GITHUB_TOKEN'],
    }));
    // Read-only status tool: exposes effective config + today's abort log tail.
    // It never evaluates claims or triggers retries.
    ctx.effect(() => {
        const dispose = ctx.tools.register(defineTool({
            name: 'get_gate_status',
            description: 'Read-only: report the completion gate effective config (retry budget, divergence limits, active verifiers, OTel endpoint, profile) and the path plus last 5 entries of the abort log. Use this first when a turn aborts or a span is missing. It never evaluates claims or changes state.',
            parameters: {},
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        markdown: { type: 'string', required: true },
                    },
                },
                render(_args, value) {
                    return [{ type: 'text', text: value.markdown }];
                },
            },
            async execute() {
                return { markdown: formatGateStatus(buildGateStatus()) };
            },
        }));
        return () => dispose();
    }, 'false-completion status tool');
    // Gate config from the environment with zero-edit defaults:
    // Smoke-run options come from the environment (no inject: keeps the plugin
    // loadable in any profile without declaring host services).
    const raw = process.env['FALSE_COMPLETION_LEDGER'] ?? '{}';
    let ledger = {};
    try {
        ledger = JSON.parse(raw);
    }
    catch {
        ledger = {};
    }
    const maxRetries = Number(process.env['FALSE_COMPLETION_MAX_RETRIES'] ?? DEFAULT_MAX_RETRIES);
    let bound;
    let ledgerAdapter;
    ctx.effect(() => {
        // Real OTel evidence ledger: emits spans to OTEL_EXPORTER_OTLP_ENDPOINT.
        // Attribution: prefer the real profile name from the DSH loader context,
        // then DSH_PROFILE, so spans are self-describing.
        const profileContext = ctx.get?.('profileContext');
        const profileId = profileContext?.name ?? process.env['DSH_PROFILE'] ?? 'unknown';
        console.error(`[false-completion-gate] OTLP endpoint = ${process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '(unset)'} profile=${profileId}`);
        ledgerAdapter = new OtelLedgerAdapter({ sessionId: 'dsh-host', profileId });
        bound = new CompletionGate({
            ledger: ledgerAdapter,
            maxRetries,
            suspendAdapter: new DocumentedSuspendAdapter({
                onSuspend: (record) => {
                    console.error(`[false-completion-gate] SUSPENDED ${record.ticket}: ${record.reason}`);
                },
            }),
            sessionId: 'dsh-host',
        });
        return () => {
            bound = undefined;
        };
    }, 'false-completion-gate lifecycle');
    ctx.on('agent/created', (payload) => {
        console.error('[false-completion-gate] agent/created received; binding turn-stopping');
        const { agent } = payload;
        agent.ctx.effect(() => {
            const dispose = agent.ctx.on('agent/turn-stopping', async ({ turn }) => {
                console.error(`[false-completion-gate] turn-stopping fired turn=${turn}`);
                const gate = bound;
                if (!gate)
                    return;
                // Real gates read the model's final message; the smoke profile binds a
                // fixture claim through the gate's one-shot output.
                const output = readPendingOutput(agent);
                console.error(`[false-completion-gate] parsed claim output status=${output ? (claimsOf(output)[0]?.status ?? 'none') : 'undefined'}`);
                if (output === undefined)
                    return;
                // Emit real evidence spans for each claim through the OTel ledger.
                if (ledgerAdapter) {
                    for (const claim of claimsOf(output)) {
                        try {
                            await ledgerAdapter.emitEvidence({
                                toolName: 'assistant.claim',
                                // Real DSH session id (overrides the static adapter value).
                                sessionId: String(agent.session.id ?? ''),
                                redactedArgs: { toolName: 'assistant.claim', args: claim, redactedFields: [] },
                                outcome: {
                                    isError: claim.status === 'done' && (claim.evidence_ids?.length ?? 0) === 0,
                                    exitCode: claim.status === 'done' && (claim.evidence_ids?.length ?? 0) === 0 ? 'NO_EVIDENCE' : 'OK',
                                    content: [],
                                },
                                snapshot: { source: 'unknown', diffs: [] },
                            });
                        }
                        catch (error) {
                            abortWith({
                                kind: 'hook',
                                category: 'exporter_failed',
                                detail: `Evidence export failed: ${String(error)}`,
                            }, (cause) => agent.cancel(cause));
                            return;
                        }
                    }
                }
                const decision = await gate.evaluate(output, { sessionId: 'dsh-host', turn, concludesTurn: false, signal: new AbortController().signal });
                // Verifier-driven override: if the model emitted a "done" claim but a
                // deterministic MCP verifier tool failed in this turn (e.g. Filesystem
                // MCP ENOENT for a fabricated path), the gate must abort even if the
                // static claim guard found ledger evidence. Adapter wiring only — the
                // gate/claimGuard logic is untouched.
                const failedVerifier = lastFailedVerifierResult(agent, turn);
                const hasDone = claimsOf(output).some((claim) => claim.status === 'done');
                if (failedVerifier && hasDone) {
                    abortWith({
                        kind: 'hook',
                        category: 'verifier_failed',
                        verifier: { type: 'filesystem-mcp', detail: failedVerifier },
                        claim_text: claimsOf(output)[0]?.text,
                        detail: `Verifier failure overrides done claim: ${failedVerifier}`,
                    }, (cause) => agent.cancel(cause));
                    return;
                }
                if (decision.kind === 'feedback') {
                    agent.steer(feedbackMessage(decision.feedback, turn));
                }
                else if (decision.kind === 'abort') {
                    if (decision.abortDetail) {
                        emitAbortLine(decision.abortDetail);
                    }
                    agent.cancel({ kind: 'hook', reason: decision.reason });
                }
            });
            return () => dispose();
        }, 'false-completion-gate per-agent');
    });
}
/** Find a deterministic verifier failure in the current turn's session events or assistant text. */
function lastFailedVerifierResult(agent, _turn) {
    try {
        const events = agent.session.snapshotEvents();
        let reason;
        const failurePattern = /ENOENT|no such file|not found|access denied|fabricated|does not exist/i;
        // 1. Structured tool/result events (when visible at turn-stopping).
        for (const event of events) {
            if (event.type !== 'tool/result')
                continue;
            const text = JSON.stringify(event.message?.content ?? []);
            console.error(`[false-completion-gate] tool/result isError=${event.message?.isError} err=${event.error?.code ?? '-'} text=${text.slice(0, 160)}`);
            const match = failurePattern.exec(text);
            const failed = event.message?.isError === true || Boolean(event.error) || Boolean(match);
            if (!failed)
                continue;
            reason = event.error?.reason ?? event.error?.code ?? match?.[0] ?? extractText(event.message?.content) ?? 'verifier tool failed';
        }
        // 2. Assistant text quoting a deterministic tool failure (MCP results can
        //    reach the model without a durable tool/result event at this boundary).
        if (!reason) {
            const assistantText = events
                .filter((event) => event.type === 'assistant/message')
                .map((event) => extractText(event.message?.content) ?? '')
                .join('\n');
            const match = failurePattern.exec(assistantText);
            if (match)
                reason = `verifier reported ${match[0]}`;
        }
        return reason;
    }
    catch {
        return undefined;
    }
}
function extractText(content) {
    if (!content)
        return undefined;
    for (const block of content) {
        if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
            return block.text.slice(0, 300);
        }
    }
    return undefined;
}
/** Narrow an unknown claim document to an array of claim records. */
function claimsOf(output) {
    const claims = output?.claims;
    return Array.isArray(claims) ? claims : [];
}
/** Extract the last assistant message's JSON claim document, if any. */
function readPendingOutput(agent) {
    try {
        const events = agent.session.snapshotEvents();
        let lastText;
        for (const event of events) {
            if (event.type !== 'assistant/message')
                continue;
            const text = firstTextBlock(event);
            if (text)
                lastText = text;
        }
        if (!lastText)
            return undefined;
        const start = lastText.indexOf('{');
        const end = lastText.lastIndexOf('}');
        if (start === -1 || end <= start)
            return undefined;
        try {
            return JSON.parse(lastText.slice(start, end + 1));
        }
        catch {
            return undefined;
        }
    }
    catch {
        return undefined;
    }
}
/** First text block of a durable assistant/message event, at any nesting. */
function firstTextBlock(value) {
    if (typeof value === 'string')
        return value.includes('"claims"') ? value : undefined;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstTextBlock(item);
            if (found)
                return found;
        }
        return undefined;
    }
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) {
            const found = firstTextBlock(child);
            if (found)
                return found;
        }
    }
    return undefined;
}
