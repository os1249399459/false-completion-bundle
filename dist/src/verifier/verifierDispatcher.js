/** Read verification.type from the claim's redacted subject. */
export function verificationType(claim) {
    const subject = claim.subject;
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject))
        return 'unknown';
    const type = subject.verification;
    if (type === null || typeof type !== 'object' || Array.isArray(type))
        return 'unknown';
    const value = type.type;
    return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}
export class VerifierDispatcher {
    options;
    constructor(options) {
        this.options = options;
    }
    async dispatch(claim, signal) {
        const type = verificationType(claim);
        const allowed = this.options.allowedTypes ?? Object.keys(this.options.adapters);
        const adapter = allowed.includes(type) ? this.options.adapters[type] : undefined;
        if (!adapter) {
            return {
                claimId: claim.claimId,
                type,
                kind: 'unknown',
                reason: `Unsupported verification type "${type}"`,
            };
        }
        const verdict = await adapter.verify(claim, signal);
        return {
            claimId: claim.claimId,
            type,
            ...verdict,
            ...(verdict.kind !== 'unknown' ? { evidenceRef: this.evidenceRefOf(verdict) } : {}),
        };
    }
    evidenceRefOf(verdict) {
        if (verdict.kind === 'unknown')
            return undefined;
        const detail = verdict.detail;
        if (detail === null || typeof detail !== 'object' || Array.isArray(detail))
            return undefined;
        const ref = detail.evidenceRef;
        return typeof ref === 'string' ? ref : undefined;
    }
}
