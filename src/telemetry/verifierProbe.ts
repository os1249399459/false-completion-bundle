/**
 * Startup environment probe for verifier availability.
 *
 * Diagnostic only: prints one stderr block and returns a structured result.
 * Never throws in minimal/standard; strict mode decides separately (in the
 * profile's !!js guards) whether a missing dependency aborts startup.
 *
 * No verifier, gate, claimGuard or exporter logic is involved here.
 */
export interface ProbeResult {
  readonly name: 'filesystem' | 'python' | 'playwright' | 'github'
  readonly state: 'OK' | 'SKIP'
  readonly reason?: string
}

export interface ProbeReport {
  readonly lines: readonly string[]
  readonly results: readonly ProbeResult[]
  readonly active: readonly string[]
}

export interface ProbeEnv {
  readonly cwd?: string
  readonly playwrightEnabled?: boolean
  readonly verifierBackend?: string
  readonly githubToken?: string
  readonly hasBrowser?: boolean
  readonly hasFilesystemServer?: boolean
  /** Which npx packages are resolvable (checked by the caller). */
  readonly npxFilesystemOk?: boolean
  readonly npxPlaywrightOk?: boolean
  readonly npxGithubOk?: boolean
  /** Exact commands that failed, for SKIP lines. */
  readonly npxFailures?: Readonly<Record<string, string>>
}

const FIXES: Record<string, string> = {
  python: 'see README (Python setup section)',
  playwright: 'run `npx playwright install chromium` to enable',
  github: 'set GITHUB_TOKEN to enable',
  filesystem: 'pre-install locally or allow network access',
}

export function probeVerifiers(env: ProbeEnv = {}): ProbeReport {
  const results: ProbeResult[] = []

  // Filesystem: baseline verifier. An npx resolution failure is a SKIP with
  // the exact failing command; it never throws or blocks startup.
  const fsOk = env.hasFilesystemServer !== false && env.npxFilesystemOk !== false
  results.push(
    fsOk
      ? { name: 'filesystem', state: 'OK' }
      : {
          name: 'filesystem',
          state: 'SKIP',
          reason: `${env.npxFailures?.filesystem ?? 'npx server-filesystem unavailable'}`,
        },
  )

  const backend = env.verifierBackend ?? ''
  results.push(
    ['ragas', 'trulens', 'deepeval'].includes(backend)
      ? { name: 'python', state: 'OK' }
      : { name: 'python', state: 'SKIP', reason: 'no deterministic backend configured' },
  )

  const pwEnabled = env.playwrightEnabled === true
  const hasBrowser = env.hasBrowser === true
  results.push(
    pwEnabled && hasBrowser && env.npxPlaywrightOk !== false
      ? { name: 'playwright', state: 'OK' }
      : {
          name: 'playwright',
          state: 'SKIP',
          reason: env.npxPlaywrightOk === false
            ? `${env.npxFailures?.playwright ?? 'npx playwright unavailable'}`
            : hasBrowser || !pwEnabled ? 'not enabled' : 'browser binary not found',
        },
  )

  results.push(
    env.githubToken && env.npxGithubOk !== false
      ? { name: 'github', state: 'OK' }
      : {
          name: 'github',
          state: 'SKIP',
          reason: env.npxGithubOk === false
            ? `${env.npxFailures?.github ?? 'npx github unavailable'}`
            : 'GITHUB_TOKEN not set',
        },
  )

  const lines: string[] = ['[false-completion-bundle] verifier probe:']
  for (const result of results) {
    const name = result.name.padEnd(11)
    lines.push(
      result.state === 'OK'
        ? `  ${name} OK`
        : `  ${name} SKIP (${result.reason}; ${FIXES[result.name]})`,
    )
  }
  const active = results.filter((r) => r.state === 'OK').map((r) => r.name)
  lines.push(`[false-completion-bundle] active gate: claimGuard + ${active.join(' + ') || 'no verifier'}`)

  return { lines, results, active }
}

export function printProbe(report: ProbeReport): void {
  for (const line of report.lines) console.error(line)
}

/**
 * Non-blocking npx resolvability check. Uses `npm view <spec> version` with a
 * short timeout; failures are returned as data, never thrown. Callers pass the
 * result into probeVerifiers so a SKIP line can show the exact failing command.
 */
export async function probeNpxPackages(
  specs: Readonly<Record<string, string>>,
  options: { timeoutMs?: number; runner?: typeof import('node:child_process').execFile } = {},
): Promise<{ ok: Record<string, boolean>; failures: Record<string, string> }> {
  const { execFile } = await import('node:child_process')
  const run = options.runner ?? execFile
  const ok: Record<string, boolean> = {}
  const failures: Record<string, string> = {}
  for (const [name, spec] of Object.entries(specs)) {
    // `npm view` needs network. Prefer the exact command the profile uses and
    // accept either a successful fetch or a resolvable local cache entry.
    const command = `npx -y -p ${spec} -c "true"`
    try {
      await new Promise<void>((resolve, reject) => {
        run('npx', ['-y', '-p', spec, '-c', 'true'], { timeout: options.timeoutMs ?? 3000 }, (error) =>
          error ? reject(error) : resolve(),
        )
      })
      ok[name] = true
    } catch {
      ok[name] = false
      failures[name] = command
    }
  }
  return { ok, failures }
}
