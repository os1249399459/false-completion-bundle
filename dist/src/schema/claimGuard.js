/**
 * Claim guard — Zod shape validation plus evidence-backed policy checks.
 *
 * Rules:
 *  1. status "done" with empty evidence_ids → reject (custom Zod issue).
 *  2. evidence_ids that do not resolve to a ledger entry → reject.
 *  3. evidence_ids whose ledger entry has ok=false → reject.
 *
 * All failures are returned as structured ClaimIssues; no untyped throws.
 */
import { ClaimsDocumentSchema } from './claim.schema.js';
/** Extra check added to the Zod schema for rule 1 (status/evidence coherence). */
const claimPolicy = ClaimsDocumentSchema.superRefine((document, ctx) => {
    document.claims.forEach((claim, index) => {
        if (claim.status === 'done' && claim.evidence_ids.length === 0) {
            ctx.addIssue({
                code: 'custom',
                path: ['claims', index, 'evidence_ids'],
                message: 'A claim with status "done" must cite at least one evidence_id',
            });
        }
    });
});
function toIssues(error) {
    return error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
    }));
}
export class ClaimGuard {
    options;
    constructor(options) {
        this.options = options;
    }
    /** Validate a parsed ClaimsDocument against ledger state. */
    validate(document) {
        const shapeResult = claimPolicy.safeParse(document);
        if (!shapeResult.success) {
            return { ok: false, issues: toIssues(shapeResult.error) };
        }
        const issues = [];
        shapeResult.data.claims.forEach((claim, index) => {
            claim.evidence_ids.forEach((ref, evidenceIndex) => {
                const entry = this.options.ledger.getEntry(ref);
                if (entry === undefined) {
                    issues.push({
                        code: 'evidence_unresolved',
                        path: ['claims', index, 'evidence_ids', evidenceIndex],
                        message: `Evidence id "${ref}" does not resolve to a ledger entry`,
                    });
                    return;
                }
                if (!entry.ok) {
                    issues.push({
                        code: 'evidence_failed',
                        path: ['claims', index, 'evidence_ids', evidenceIndex],
                        message: `Evidence id "${ref}" refers to a failed tool call (ok=false) and cannot support a claim`,
                    });
                }
            });
        });
        if (issues.length > 0)
            return { ok: false, issues };
        return { ok: true, data: shapeResult.data };
    }
    /** Convenience: validate an unknown input in one call (shape + policy + ledger). */
    validateInput(input) {
        const parsed = ClaimsDocumentSchema.safeParse(input);
        if (!parsed.success)
            return { ok: false, issues: toIssues(parsed.error) };
        return this.validate(parsed.data);
    }
}
