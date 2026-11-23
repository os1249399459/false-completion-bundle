/**
 * Rename guard: fails if a deprecated name reappears in code or config.
 *
 * Enforces the outcome of NAMING-DECISIONS.md without renaming any frozen
 * external contract. Historical mentions are allowed only in POSTMORTEM.md
 * (and the two naming-document files, which must be able to quote old names).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

/** Files allowed to mention deprecated names: history and the naming docs. */
// Files allowed to mention deprecated names: history, the naming docs, and this
// guard itself (it must be able to spell what it forbids).
const ALLOWED_HISTORY = new Set([
  'POSTMORTEM.md',
  'NAMING-INVENTORY.md',
  'NAMING-DECISIONS.md',
  'tests/namingGuard.test.ts',
])

const SKIP_DIRS = new Set(['node_modules', 'dist', '.venv', '.promptfoo', '.promptfoo-build', '__pycache__', '.git'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|mjs|js|yml|yaml|json|md|sh|py)$/.test(entry)) out.push(full)
  }
  return out
}

function offenders(pattern: RegExp): string[] {
  const hits: string[] = []
  for (const file of walk(root)) {
    const rel = relative(root, file)
    if (ALLOWED_HISTORY.has(rel)) continue
    const text = readFileSync(file, 'utf8')
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${rel}:${index + 1}: ${line.trim()}`)
    })
  }
  return hits
}

describe('deprecated-name guard', () => {
  it('no file restates the old display name', () => {
    expect(offenders(/False-completion plugin bundle/)).toEqual([])
  })

  it('no profile or code references the removed strict.yml', () => {
    // The only legitimate mention is the packaging test asserting it is absent.
    const hits = offenders(/profiles\/strict\.yml|strict\.yml$/).filter(
      (hit) => !hit.startsWith('tests/packaging.test.ts'),
    )
    expect(hits).toEqual([])
  })

  it('ghost config keys do not appear in code, profiles, or configs', () => {
    const hits = offenders(/\b(requireVerifierPass|onExhausted|manageSink)\b/)
    expect(hits).toEqual([])
  })

  it('basePath does not appear in bundle code or profiles', () => {
    const hits = offenders(/\bbasePath\b/).filter((hit) => !hit.endsWith('.json'))
    expect(hits).toEqual([])
  })

  it('frozen contracts are still present (guard cannot silently pass on deletion)', () => {
    const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
    expect(read('src/gate/abortReason.ts')).toContain('category=')
    expect(read('src/gate/abortReason.ts')).toContain('[false-completion-gate] abort')
    expect(read('src/adapters/ledgerAdapter.ts')).toContain("'evidence.profile'")
    expect(read('src/telemetry/otelExporter.ts')).toContain("'evidence.ref'")
    expect(read('package.json')).toContain('"name": "false-completion-bundle"')
    expect(read('package.json')).toContain('./profiles/minimal.yml')
    expect(read('profiles/minimal.yml')).toContain('false-completion-gate')
  })
})
