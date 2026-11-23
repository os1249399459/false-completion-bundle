/**
 * CLI verifier — runs an existing command (vitest, pytest, tsc, eslint, ...)
 * and derives pass/fail strictly from its exit code. Output is hashed and
 * recorded in the ledger-backed evidence reference. No custom test runner.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
function readSpec(claim) {
    const subject = claim.subject;
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject))
        return undefined;
    const verification = subject.verification;
    if (verification === null || typeof verification !== 'object' || Array.isArray(verification))
        return undefined;
    const raw = verification;
    const command = raw.command;
    if (typeof command !== 'string' || command.length === 0)
        return undefined;
    const args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [];
    return { command, args };
}
export class CliVerifier {
    options;
    constructor(options) {
        this.options = options;
    }
    async verify(claim, signal) {
        const spec = readSpec(claim);
        if (!spec || !this.options.allowedCommands.includes(spec.command)) {
            return { kind: 'unknown', reason: `CLI command "${spec?.command ?? 'missing'}" is not allowlisted` };
        }
        const startedAt = new Date().toISOString();
        try {
            const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
                cwd: this.options.cwd,
                timeout: this.options.timeoutMs ?? 120_000,
                signal,
                maxBuffer: 8 * 1024 * 1024,
            });
            return {
                kind: 'pass',
                detail: this.detail(spec, 0, stdout, stderr, startedAt),
            };
        }
        catch (error) {
            const failure = error;
            const exitCode = typeof failure.code === 'number' ? failure.code : -1;
            return {
                kind: exitCode === 0 ? 'pass' : 'fail',
                detail: this.detail(spec, exitCode, failure.stdout ?? '', failure.stderr ?? failure.message ?? '', startedAt),
            };
        }
    }
    detail(spec, exitCode, stdout, stderr, startedAt) {
        const outputHash = createHash('sha256').update(`${stdout}\n${stderr}`, 'utf8').digest('hex');
        return {
            evidenceRef: `cli:${outputHash.slice(0, 32)}`,
            command: spec.command,
            args: spec.args,
            exitCode,
            outputHash,
            startedAt,
        };
    }
}
