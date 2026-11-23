/**
 * Durable abort-line sink. Representation/logging only — no decision logic.
 *
 * The pure formatter lives in abortReason.ts; this module performs the single
 * side effect (stderr + optional append-only file at DSH_ABORT_LOG).
 */
import { appendFileSync } from 'node:fs';
import { formatAbortLine } from '../gate/abortReason.js';
export function emitAbortLine(reason) {
    const line = formatAbortLine(reason);
    console.error(line);
    const path = process.env['DSH_ABORT_LOG'];
    if (path) {
        // Append-only, one line per abort. Nothing else is written to this file.
        try {
            appendFileSync(path, line + '\n', 'utf8');
        }
        catch (error) {
            console.error(`[false-completion-gate] abort log write failed: ${String(error)}`);
        }
    }
    return line;
}
