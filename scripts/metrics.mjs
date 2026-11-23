/**
 * Produce acceptance metrics from a real regression run (no hand assertions).
 * Usage: node scripts/metrics.mjs
 * Requires promptfoo; writes .promptfoo/metrics.json and prints a summary.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const outDir = join(root, '.promptfoo')
mkdirSync(outDir, { recursive: true })
const jsonPath = join(outDir, 'results.json')

const env = {
  ...process.env,
  PROMPTFOO_CONFIG_DIR: outDir,
  PROMPTFOO_TELEMETRY_DISABLED: '1',
}

execFileSync('pnpm', ['exec', 'promptfoo', 'eval', '-c', 'promptfooconfig.yaml', '--no-cache', '-o', jsonPath, '--no-table'], {
  cwd: root,
  env,
  stdio: 'pipe',
})

const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
const results = data.results?.results ?? []
const count = (predicate) => results.filter(predicate).length

const total = results.length
const passed = count((r) => r.success === true)
const rejected = count((r) => !String(r.testCase?.description ?? '').startsWith('Control:') && r.success === true)
const controls = results.filter((r) => String(r.testCase?.description ?? '').startsWith('Control:'))
const falseRejects = controls.filter((r) => r.success !== true).length

// Evidence coverage: done claims in fixtures whose cited ids all resolve ok=true.
const coverage = (() => {
  let done = 0
  let covered = 0
  for (const r of results) {
    const claim = r.vars?.claim
    const doc = typeof claim === 'string' ? JSON.parse(claim) : claim
    if (!doc?.claims) continue
    for (const c of doc.claims) {
      if (c.status !== 'done') continue
      done += 1
      const ledger = r.vars?.ledger ?? {}
      if (c.evidence_ids.length > 0 && c.evidence_ids.every((ref) => ledger[ref] === true)) covered += 1
    }
  }
  return { done_claims: done, covered, pct: done ? +(100 * covered / done).toFixed(1) : 0 }
})()

// Approximate custom code size (excluding tests/config/build artifacts).
const sourceDirs = ['src/adapters', 'src/telemetry', 'src/schema', 'src/gate', 'src/verifier', 'python/mcp_verifier']
let lines = 0
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(ts|py)$/.test(entry) && !entry.endsWith('.d.ts') && !entry.startsWith('test_')) {
      lines += readFileSync(full, 'utf8').split('\n').length
    }
  }
}
sourceDirs.forEach(walk)

// Repetition counts are in-memory only (no new store). A host may supply an
// in-memory summary via env; metrics itself never persists anything.
let repeatedToolCalls = { total: 0, perTurn: {} }
if (process.env.DSH_REPEATED_TOOL_CALLS_JSON) {
  try {
    const parsed = JSON.parse(process.env.DSH_REPEATED_TOOL_CALLS_JSON)
    repeatedToolCalls = { total: Number(parsed.total ?? 0), perTurn: parsed.perTurn ?? {} }
  } catch {
    // malformed env must not break metrics
  }
}

// Divergence aborts are in-memory only (no persistence). A host may supply a
// summary via env; it DEFAULTS TO ZERO, which is not proof that no divergence
// happened. Prompt 5 will cross-check these counts against real session logs.
let divergedTurnsByReason = {}
if (process.env.DSH_DIVERGED_TURNS_JSON) {
  try {
    divergedTurnsByReason = JSON.parse(process.env.DSH_DIVERGED_TURNS_JSON)
  } catch {
    // malformed env must not break metrics
  }
}

const metrics = {
  diverged_turns_by_reason: divergedTurnsByReason,
  repeated_tool_calls: repeatedToolCalls,
  regression: { total, passed, failed: total - passed, false_completion_rate_pct: total ? +(100 * (total - passed) / total).toFixed(1) : 0 },
  gate_false_reject: { control_cases: controls.length, false_rejects: falseRejects, pct: controls.length ? +(100 * falseRejects / controls.length).toFixed(1) : null },
  evidence_coverage: coverage,
  custom_code_lines_excluding_tests_config: lines,
  rejected_cases: rejected,
}
writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2))
console.log(JSON.stringify(metrics, null, 2))
