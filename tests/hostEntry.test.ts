/**
 * Host-entry contract for third-party loaders (e.g. dsh-plugin-index).
 *
 * A registry/loader that installs this package and boots it does NOT know the
 * package's directory layout, so it cannot use a relative path like
 * '../dist/entry/index.js'. It loads the gate by PACKAGE NAME. Two things must
 * therefore hold, and both regressed once:
 *
 *  1. every profile patch names the gate row 'false-completion-bundle';
 *  2. package.json exposes a resolvable entry ('main' + 'exports["."]').
 *
 * Also covered: the GitHub verifier must pin a version that actually exists on
 * npm. It was pinned to `@modelcontextprotocol/server-github@1.0.0`, which E404s
 * — meaning the row could never start for anyone with GITHUB_TOKEN set.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

const PATCH_FILES = ['profiles/minimal.yml', 'profiles/standard.yml', 'profiles/strict-best-effort.yml', 'cordis.patch.yml']

describe('host entry: gate loads by package name', () => {
  for (const file of PATCH_FILES) {
    it(`${file} names the gate row after the package`, () => {
      const text = read(file)
      expect(text).toMatch(/id: false-completion-gate/)
      // The row's `name` must be the package name, not a build path.
      const row = text.split(/^ {4}- id: /m).find((chunk) => chunk.startsWith('false-completion-gate'))
      expect(row, `${file} has no gate row`).toBeDefined()
      const nameLine = row!.split('\n').find((line) => line.trim().startsWith('name:'))
      expect(nameLine, `${file} gate row has no name`).toBeDefined()
      expect(nameLine!.trim()).toBe("name: 'false-completion-bundle'")
    })
  }

  it('no patch file still loads the gate through a relative build path', () => {
    for (const file of PATCH_FILES) {
      expect(read(file), `${file} still points at a build path`).not.toMatch(/name:\s*'\.\.?\/dist\/entry\/index\.js'/)
      // The old GETTING-STARTED/WRONG form: profiles/dist/... (path anchored at profiles/)
      expect(read(file)).not.toMatch(/profiles\/dist\/entry/)
    }
  })
})

describe('host entry: package.json is resolvable by name', () => {
  it('declares main pointing at the built entry', () => {
    expect(pkg.main).toBe('./dist/entry/index.js')
  })

  it('exports "." for ESM importers, plus package.json and subpaths', () => {
    expect(pkg.exports['.']).toBe('./dist/entry/index.js')
    // Loaders probe the manifest; requiring an export keeps that possible.
    expect(pkg.exports['./package.json']).toBe('./package.json')
    // Profiles/patches reference ./profiles/*.yml, so subpaths must stay open.
    expect(pkg.exports['./*']).toBe('./*')
  })

  it('the declared entry actually exists in the repo (post-build)', () => {
    for (const target of [pkg.main, pkg.exports['.']]) {
      expect(existsSync(join(root, target)), `${target} missing — run build:bundle`).toBe(true)
    }
  })

  it('ships the built entry inside the package files list', () => {
    expect(pkg.files).toContain('dist/**')
    expect(pkg.files).toContain('profiles/*.yml')
  })
})

describe('github verifier: pinned to a version that exists', () => {
  const GITHUB_SPEC = /@modelcontextprotocol\/server-github@([0-9][^'"\s,]*)/g

  it('never pins the non-existent 1.0.0', () => {
    for (const file of PATCH_FILES) {
      expect(read(file), `${file} pins the E404 version`).not.toMatch(/server-github@1\.0\.0/)
    }
  })

  it('pins an exact published-looking version (YYYY.M.D or x.y.z)', () => {
    let checked = 0
    for (const file of PATCH_FILES) {
      for (const match of read(file).matchAll(GITHUB_SPEC)) {
        checked += 1
        // Both the calendar scheme (2025.4.8) and semver are exact pins; a range
        // or a dist-tag would drift under us.
        expect(match[1], `${file}: ${match[0]}`).toMatch(/^\d+\.\d+\.\d+$/)
      }
    }
    expect(checked, 'no github verifier pin found — test is not looking at anything').toBeGreaterThan(0)
  })

  it('the github row stays optional and token-gated', () => {
    // Disabled unless GITHUB_TOKEN is present, so a missing/upstream-archived
    // server never breaks a profile that does not use it.
    const minimal = read('profiles/minimal.yml')
    const chunk = minimal.split('- id: false-completion-github-mcp')[1]?.split('- id: ')[0] ?? ''
    expect(chunk).toContain('process.env.GITHUB_TOKEN')
    expect(chunk).toContain('failOnStartupError: false')
  })
})
