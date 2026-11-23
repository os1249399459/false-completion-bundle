/**
 * Claim schema — Zod only, no custom schema framework.
 *
 * Required shape:
 *   claims[] with text, status (done|partial|blocked|unknown), evidence_ids[],
 *   verification, open_questions[], unverified_assumptions[]
 */
import { z } from 'zod';
export const ClaimStatusSchema = z.enum(['done', 'partial', 'blocked', 'unknown']);
/**
 * A verification object. Kept permissive on purpose: the verifier dispatch is
 * out of scope for this phase, so we require the field to be present and be an
 * object, but do not constrain its inner keys yet.
 */
export const VerificationSchema = z.record(z.string(), z.unknown());
export const ClaimSchema = z.object({
    text: z.string().min(1, 'Claim text must not be empty'),
    status: ClaimStatusSchema,
    evidence_ids: z.array(z.string().min(1, 'Evidence id must not be empty')),
    verification: VerificationSchema,
    open_questions: z.array(z.string()),
    unverified_assumptions: z.array(z.string()),
});
export const ClaimsDocumentSchema = z.object({
    claims: z.array(ClaimSchema),
});
