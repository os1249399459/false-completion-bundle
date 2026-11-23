function readSpec(claim) {
    const subject = claim.subject;
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject))
        return undefined;
    const verification = subject.verification;
    if (verification === null || typeof verification !== 'object' || Array.isArray(verification))
        return undefined;
    const raw = verification;
    const claimText = raw.claimText ?? raw.text;
    if (typeof claimText !== 'string' || claimText.length === 0)
        return undefined;
    const refs = claim.evidenceRefs.length > 0
        ? [...claim.evidenceRefs]
        : Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.filter((r) => typeof r === 'string') : [];
    return { claimText, evidenceRefs: refs };
}
export class PythonMcpVerifier {
    client;
    constructor(client) {
        this.client = client;
    }
    async verify(claim) {
        const spec = readSpec(claim);
        if (!spec)
            return { kind: 'unknown', reason: 'Python grounding verification requires claim text' };
        let result;
        try {
            result = await this.client.callTool('verify_claim', {
                claim_text: spec.claimText,
                evidence_refs: spec.evidenceRefs,
            });
        }
        catch (error) {
            return { kind: 'unknown', reason: `Python MCP call failed: ${String(error)}` };
        }
        const deterministic = (result.deterministic_signals ?? []).filter((signal) => signal.source === 'deterministic' && typeof signal.score === 'number');
        const kind = result.kind;
        const detail = {
            evidenceRef: result.evidence_ref ?? null,
            rationale: result.rationale ?? null,
            deterministicSignals: deterministic,
            judge: result.judge ?? null,
        };
        // A pass with no deterministic signal is judge-only → downgrade.
        if (kind === 'pass' && deterministic.length === 0) {
            return { kind: 'unknown', reason: 'Judge-only pass is not allowed; no deterministic signal present' };
        }
        if (kind === 'pass' || kind === 'fail')
            return { kind, detail };
        return { kind: 'unknown', reason: result.rationale ?? 'Python verifier returned unknown' };
    }
}
