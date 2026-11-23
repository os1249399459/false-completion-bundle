/**
 * Real DSH plugin entry: binds the completion gate to `agent/turn-stopping`.
 *
 * Confirmed DSH API (0.2.1-rc.5, cordis inspect Event catalog):
 * - 'agent/turn-stopping' is serial, awaited before the turn boundary commits.
 *   Payload: { agent, turn, signal }. Feedback is delivered by agent.steer().
 * - Per-agent listeners register on agent.ctx inside 'agent/created'.
 */
import { CompletionGate } from '../src/gate/completionGate.js';
import { DocumentedSuspendAdapter } from '../src/gate/suspendAdapter.js';
import { MessageId } from '@deepseek-ai/dsh-llm/brand';
export const name = 'false-completion-gate';
export const inject = [];
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
    const maxRetries = Number(process.env['FALSE_COMPLETION_MAX_RETRIES'] ?? 1);
    let bound;
    ctx.effect(() => {
        bound = new CompletionGate({
            ledger: { getEntry: (ref) => (ref in ledger ? { ref, ok: Boolean(ledger[ref]) } : undefined) },
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
        const { agent } = payload;
        agent.ctx.effect(() => {
            const dispose = agent.ctx.on('agent/turn-stopping', async ({ turn }) => {
                const gate = bound;
                if (!gate)
                    return;
                // Real gates read the model's final message; the smoke profile binds a
                // fixture claim through the gate's one-shot output.
                const output = readPendingOutput(agent);
                if (output === undefined)
                    return;
                const decision = await gate.evaluate(output, { sessionId: 'dsh-host', turn, concludesTurn: false, signal: new AbortController().signal });
                if (decision.kind === 'feedback') {
                    agent.steer(feedbackMessage(decision.feedback, turn));
                }
                else if (decision.kind === 'abort') {
                    agent.cancel({ kind: 'hook', reason: decision.reason });
                }
            });
            return () => dispose();
        }, 'false-completion-gate per-agent');
    });
}
/** Extract the last assistant message's JSON claim document, if any. */
function readPendingOutput(agent) {
    try {
        const events = agent.session.snapshotEvents();
        let lastAssistant;
        for (const event of events) {
            if (event.type === 'assistant/message')
                lastAssistant = event;
        }
        if (!lastAssistant)
            return undefined;
        const text = JSON.stringify(lastAssistant);
        const match = text.match(/\{[\s\S]*"claims"[\s\S]*\}/);
        if (!match)
            return undefined;
        try {
            return JSON.parse(match[0]);
        }
        catch {
            return undefined;
        }
    }
    catch {
        return undefined;
    }
}
