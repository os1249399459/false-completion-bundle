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

// Only files DSH actually loads (dsh.bundle.patch -> profiles/minimal.yml).
// A root-level cordis.patch.yml used to be listed here; it was never loaded and
// duplicated rows when passed via --patch, so it was deleted in 0.2.0.
const PATCH_FILES = ['profiles/minimal.yml', 'profiles/standard.yml', 'profiles/strict-best-effort.yml']

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

describe('github MCP row: removed, not merely reconfigured', () => {
  // 0.1.9 removed the row outright. It registered 26 tools (12 of them write
  // operations: create_or_update_file, push_files, merge_pull_request, ...) with
  // NO verifier implementation consuming it, and the upstream server cannot be
  // restricted (no --tools / GITHUB_TOOLSETS / read-only mode; verified
  // empirically — all 26 tools are returned even with every flag set). It was a
  // pure capability exposure, so it must not come back in any form.
  it('no profile or patch file mentions the github row or server', () => {
    for (const file of PATCH_FILES) {
      const text = read(file)
      expect(text, `${file} still references the github row`).not.toMatch(/false-completion-github/)
      expect(text, `${file} still pins the github MCP server`).not.toMatch(/server-github@/)
    }
  })

  it('the github credential variable is gone from the config layer', () => {
    // The row also read the wrong variable: the server only honours
    // GITHUB_PERSONAL_ACCESS_TOKEN, never GITHUB_TOKEN.
    for (const file of PATCH_FILES) {
      expect(read(file), `${file} still wires a github token`).not.toMatch(/GITHUB_TOKEN|GITHUB_PERSONAL_ACCESS_TOKEN/)
    }
  })

  it('the probe and status tool no longer advertise a github verifier', () => {
    const probe = read('src/telemetry/verifierProbe.ts')
    expect(probe).not.toMatch(/github/i)
    const status = read('src/gate/gateStatus.ts')
    expect(status).not.toMatch(/github/i)
  })
})

