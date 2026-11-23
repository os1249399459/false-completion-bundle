const FIXES = {
    python: 'see README (Python setup section)',
    playwright: 'run `npx playwright install chromium` to enable',
    github: 'set GITHUB_TOKEN to enable',
    filesystem: 'pre-install locally or allow network access',
};
export function probeVerifiers(env = {}) {
    const results = [];
    // Filesystem: baseline verifier. An npx resolution failure is a SKIP with
    // the exact failing command; it never throws or blocks startup.
    const fsOk = env.hasFilesystemServer !== false && env.npxFilesystemOk !== false;
    results.push(fsOk
        ? { name: 'filesystem', state: 'OK' }
        : {
            name: 'filesystem',
            state: 'SKIP',
            reason: `${env.npxFailures?.filesystem ?? 'npx server-filesystem unavailable'}`,
        });
    const backend = env.verifierBackend ?? '';
    results.push(['ragas', 'trulens', 'deepeval'].includes(backend)
        ? { name: 'python', state: 'OK' }
        : { name: 'python', state: 'SKIP', reason: 'no deterministic backend configured' });
    const pwEnabled = env.playwrightEnabled === true;
    const hasBrowser = env.hasBrowser === true;
    results.push(pwEnabled && hasBrowser && env.npxPlaywrightOk !== false
        ? { name: 'playwright', state: 'OK' }
        : {
            name: 'playwright',
            state: 'SKIP',
            reason: env.npxPlaywrightOk === false
                ? `${env.npxFailures?.playwright ?? 'npx playwright unavailable'}`
                : hasBrowser || !pwEnabled ? 'not enabled' : 'browser binary not found',
        });
    results.push(env.githubToken && env.npxGithubOk !== false
        ? { name: 'github', state: 'OK' }
        : {
            name: 'github',
            state: 'SKIP',
            reason: env.npxGithubOk === false
                ? `${env.npxFailures?.github ?? 'npx github unavailable'}`
                : 'GITHUB_TOKEN not set',
        });
    const lines = ['[false-completion-bundle] verifier probe:'];
    for (const result of results) {
        const name = result.name.padEnd(11);
        lines.push(result.state === 'OK'
            ? `  ${name} OK`
            : `  ${name} SKIP (${result.reason}; ${FIXES[result.name]})`);
    }
    const active = results.filter((r) => r.state === 'OK').map((r) => r.name);
    lines.push(`[false-completion-bundle] active gate: claimGuard + ${active.join(' + ') || 'no verifier'}`);
    return { lines, results, active };
}
export function printProbe(report) {
    for (const line of report.lines)
        console.error(line);
}
/**
 * Non-blocking npx resolvability check. Uses `npm view <spec> version` with a
 * short timeout; failures are returned as data, never thrown. Callers pass the
 * result into probeVerifiers so a SKIP line can show the exact failing command.
 */
export async function probeNpxPackages(specs, options = {}) {
    const { execFile } = await import('node:child_process');
    const run = options.runner ?? execFile;
    const ok = {};
    const failures = {};
    for (const [name, spec] of Object.entries(specs)) {
        // `npm view` needs network. Prefer the exact command the profile uses and
        // accept either a successful fetch or a resolvable local cache entry.
        const command = `npx -y -p ${spec} -c "true"`;
        try {
            await new Promise((resolve, reject) => {
                run('npx', ['-y', '-p', spec, '-c', 'true'], { timeout: options.timeoutMs ?? 3000 }, (error) => error ? reject(error) : resolve());
            });
            ok[name] = true;
        }
        catch {
            ok[name] = false;
            failures[name] = command;
        }
    }
    return { ok, failures };
}
