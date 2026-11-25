/** Packaging guarantees: portable defaults + probe output format. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeVerifiers, probeNpxPackages } from '../src/telemetry/verifierProbe.js'

const root = join(__dirname, '..')

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8')
}

describe('packaging: minimal.yml portability', () => {
  const minimal = read('profiles/minimal.yml')

  it('contains no machine-specific absolute paths', () => {
    // Allowed: npx package specifiers and !!js process.cwd(); forbidden:
    // /home/, /Users/, C:\, or a pinned npx cache path.
    expect(minimal).not.toMatch(/\/home\//)
    expect(minimal).not.toMatch(/\/Users\//)
    expect(minimal).not.toMatch(/[A-Za-z]:\\/)
    expect(minimal).not.toMatch(/\.npm\/_npx/)
  })

  it('uses only confirmed Loader syntax (!!js) and process.cwd()', () => {
    expect(minimal).toContain('!!js process.cwd()')
    expect(minimal).not.toContain('${WORKSPACE_ROOT}')
    expect(minimal).not.toContain('${HOME}')
  })

  it('sets the documented zero-edit defaults', () => {
    expect(minimal).toContain('false-completion-filesystem-mcp')
    expect(minimal).toMatch(/Python grounding verifier — OFF by default|python verifier.*OFF/i)
  })

  it('package.json points the bundle patch at profiles/minimal.yml', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.dsh.bundle.patch).toBe('./profiles/minimal.yml')
    expect(pkg.files).toContain('profiles/*.yml')
    expect(pkg.files.join(' ')).not.toContain('.venv')
    expect(pkg.scripts.prepack).toContain('typecheck')
    expect(pkg.scripts.prepack).toContain('test')
  })
})

describe('packaging: pinned npx packages', () => {
  const profiles = ['minimal.yml', 'standard.yml', 'strict-best-effort.yml']
  for (const profile of profiles) {
    const text = read(`profiles/${profile}`)
    it(`${profile} pins every npx package to an exact version`, () => {
      expect(text).not.toMatch(/@latest/)
      // Every `-p <pkg>` spec must carry an exact @version suffix.
      const specs = [...text.matchAll(/'-p',\s*'([^']+)'/g)].map((m) => m[1])
      for (const spec of specs) {
        expect(spec, `${profile}: ${spec}`).toMatch(/^@[^@]+\/[^@]+@\d+\.\d+\.\d+$/)
      }
      // The filesystem spec is passed as a single arg (multi-line form).
      if (text.includes('server-filesystem')) {
        expect(text).toMatch(/@modelcontextprotocol\/server-filesystem@\d+\.\d+\.\d+/)
      }
    })
  }

  it('no profile is named strict.yml (semantics are not enforced)', () => {
    expect(() => read('profiles/strict.yml')).toThrow()
    const readme = read('README.md')
    expect(readme).toContain('strict-best-effort.yml')
    // Normalize markdown line breaks and emphasis before matching the warning.
    const flat = readme.replace(/[*_\n\r]+/g, ' ').replace(/\s+/g, ' ')
    expect(flat).toMatch(/best-effort only, not a hard guarantee/i)
    expect(flat).toMatch(/shell-check workaround/i)
  })
})

describe('probe: npx failure becomes SKIP with a fix', () => {
  it('shows the exact failing command and a one-line fix, never throws', () => {
    const report = probeVerifiers({
      npxFilesystemOk: false,
      npxFailures: { filesystem: 'npx -y -p @modelcontextprotocol/server-filesystem@1.0.0 -c "true"' },
    })
    const line = report.lines.find((l) => l.includes('filesystem'))!
    expect(line).toContain('SKIP')
    expect(line).toContain('npx -y -p')
    expect(line).toContain('pre-install locally or allow network access')
    expect(report.active).not.toContain('filesystem')
  })

  it('probeNpxPackages returns failure data instead of throwing', async () => {
    const result = await probeNpxPackages(
      { filesystem: '@modelcontextprotocol/server-filesystem@1.0.0' },
      {
        timeoutMs: 1,
        runner: ((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) =>
          cb(new Error('network down'))) as never,
      },
    )
    expect(result.ok.filesystem).toBe(false)
    expect(result.failures.filesystem).toContain('npx -y -p')
  })
})

describe('probe output format', () => {
  it('prints one block with three verifiers and an active-gate line', () => {
    // The github probe was removed in 0.1.9: the row exposed 26 tools (12
    // write) with no verifier implementation behind it.
    const report = probeVerifiers({
      verifierBackend: '',
      playwrightEnabled: false,
      hasBrowser: false,
    })
    expect(report.lines).toHaveLength(5)
    expect(report.lines[0]).toBe('[false-completion-bundle] verifier probe:')
    expect(report.lines[1]).toMatch(/filesystem\s+OK/)
    expect(report.lines[2]).toMatch(/python\s+SKIP.*deterministic backend/)
    expect(report.lines[2]).toContain('Python setup section')
    expect(report.lines[3]).toContain('playwright')
    expect(report.lines[4]).toBe('[false-completion-bundle] active gate: claimGuard + filesystem')
    expect(report.active).toEqual(['filesystem'])
    // No github line survives.
    expect(report.lines.join('\n')).not.toContain('github')
    expect(report.lines.join('\n')).not.toContain('GITHUB_TOKEN')
  })

  it('every SKIP line maps to a one-line fix in README', () => {
    const readme = read('README.md')
    const report = probeVerifiers({ verifierBackend: '', playwrightEnabled: false })
    for (const line of report.lines.filter((l) => l.includes('SKIP'))) {
      if (line.includes('Python setup')) expect(readme).toContain('## Python setup')
      if (line.includes('playwright')) expect(readme).toContain('npx playwright install chromium')
    }
  })
})
