/**
 * Playwright MCP verifier — asserts element/text/state through an existing
 * Playwright MCP server. No custom browser automation. The MCP client is
 * injected; its server config lives in cordis.patch.yml.
 */
import { createHash } from 'node:crypto';
function readSpec(claim) {
    const subject = claim.subject;
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject))
        return undefined;
    const verification = subject.verification;
    if (verification === null || typeof verification !== 'object' || Array.isArray(verification))
        return undefined;
    const raw = verification;
    const spec = {};
    if (typeof raw.selector === 'string')
        spec.selector = raw.selector;
    if (typeof raw.text === 'string')
        spec.text = raw.text;
    if (typeof raw.state === 'string')
        spec.state = raw.state;
    if (typeof raw.url === 'string')
        spec.url = raw.url;
    return spec.selector || spec.text || spec.state || spec.url ? spec : undefined;
}
export class PlaywrightMcpVerifier {
    client;
    constructor(client) {
        this.client = client;
    }
    async verify(claim) {
        const spec = readSpec(claim);
        if (!spec) {
            return { kind: 'unknown', reason: 'Playwright verification requires selector/text/state/url' };
        }
        let result;
        try {
            result = await this.client.assert(spec);
        }
        catch (error) {
            return { kind: 'fail', detail: this.detail(spec, false, `MCP error: ${String(error)}`, undefined) };
        }
        return {
            kind: result.ok ? 'pass' : 'fail',
            detail: this.detail(spec, result.ok, result.error, result.observed),
        };
    }
    detail(spec, ok, error, observed) {
        const fingerprint = createHash('sha256').update(JSON.stringify({ spec, ok, observed: observed ?? null })).digest('hex');
        return {
            evidenceRef: `pw:${fingerprint.slice(0, 32)}`,
            spec: { ...spec },
            ok,
            error: error ?? null,
            observed: observed ?? null,
        };
    }
}
