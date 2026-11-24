#!/usr/bin/env node
/**
 * Log-noise demonstration for the completion gate — no test runner, no mocks of
 * the gate itself.
 *
 * Boots the REAL built entry (dist/entry/index.js) against minimal fakes and
 * drives two turns: a normal one and an aborting one, each with the debug env
 * var off and on. Prints a matrix so the four quadrants are visible at once.
 *
 * Run:  node scripts/log-noise-demo.mjs
 * Exit: 0 when every assertion holds, 1 otherwise.
 */
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entryPath = join(here, '..', 'dist', 'entry', 'index.js')
const { apply } = await import(pathToFileURL(entryPath).href)

const DEBUG_ENV = 'FALSE_COMPLETION_DEBUG'
const SESSION_ID = 'session-demo-xyz'

function claimEvent(status, evidenceIds = []) {
  return {
    type: 'assistant/message',
    message: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          claims: [{
            text: 'task done',
            status,
            evidence_ids: evidenceIds,
            verification: {},
            open_questions: ['q'],
            unverified_assumptions: [],
          }],
        }),
      }],
    },
  }
}

function makeHarness(events) {
  const listeners = []
  const cancelled = []
  const agent = {
    session: { id: SESSION_ID, snapshotEvents: () => events },
    ctx: {
      effect: (fn) => fn() ?? (() => {}),
      on: (event, listener) => {
        if (event === 'agent/turn-stopping') listeners.push(listener)
        return () => {}
      },
    },
    steer: () => {},
    cancel: (cause) => { cancelled.push(cause) },
  }
  const createdHandlers = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn() ?? (() => {}),
    tools: { register: () => () => {} },
    on: (event, handler) => {
      if (event === 'agent/created') createdHandlers.push(handler)
      return () => {}
    },
  }
  return { agent, listeners, cancelled, createdHandlers, ctx }
}

/** Run one scenario, returning only what the turn itself wrote to stderr. */
async function runScenario({ events, turns, debug }) {
  const savedDebug = process.env[DEBUG_ENV]
  if (debug) process.env[DEBUG_ENV] = '1'
  else delete process.env[DEBUG_ENV]

  // Silence startup probe output: it is not what we are measuring.
  const realError = console.error
  const captured = []
  let phase = 'startup'

  try {
    console.error = (...args) => {
      if (phase === 'turn') captured.push(args.map(String).join(' '))
      // 'startup' lines are swallowed deliberately; they are not turn output.
    }
    const h = makeHarness(events)
    apply(h.ctx)
    h.createdHandlers[0]({ agent: h.agent })
    phase = 'turn'
    for (const turn of turns) {
      await h.listeners[0]({ agent: h.agent, turn })
    }
    return { output: captured.join('\n'), cancelled: h.cancelled.length }
  } finally {
    console.error = realError
    if (savedDebug === undefined) delete process.env[DEBUG_ENV]
    else process.env[DEBUG_ENV] = savedDebug
  }
}

const NORMAL = { name: 'NORMAL', events: [claimEvent('done', ['ev_missing'])], turns: [1] }
const ABORT = { name: 'ABORT', events: [claimEvent('done', [])], turns: [1, 2] }

const rows = []
for (const scenario of [NORMAL, ABORT]) {
  for (const debug of [false, true]) {
    const { output, cancelled } = await runScenario({ ...scenario, debug })
    rows.push({
      scenario: scenario.name,
      debug,
      cancelled,
      hasTrace: output.includes('turn-stopping fired'),
      hasAbort: output.includes('abort category='),
      output,
    })
  }
}

const pad = (s, n) => String(s).padEnd(n)
console.log('\nscenario  DEBUG  cancelled  trace-lines  abort-line  stderr-bytes')
console.log('-'.repeat(66))
for (const r of rows) {
  console.log(
    pad(r.scenario, 10) + pad(r.debug ? 'on' : 'off', 7) + pad(r.cancelled, 11) +
    pad(r.hasTrace ? 'YES' : 'no', 13) + pad(r.hasAbort ? 'YES' : 'no', 12) + r.output.length,
  )
}

console.log('\n--- verbatim stderr, NORMAL with debug off ---')
console.log(JSON.stringify(rows[0].output))
console.log('\n--- verbatim stderr, ABORT with debug off (must contain category=) ---')
console.log(rows[2].output || '(EMPTY — BUG)')

const checks = [
  ['normal turn is silent with debug off', rows[0].output === '' && !rows[0].hasTrace && !rows[0].hasAbort],
  ['normal turn shows trace with debug on', rows[1].hasTrace],
  ['abort turn prints abort line with debug off', rows[2].hasAbort && rows[2].cancelled > 0],
  ['abort turn prints abort line with debug on', rows[3].hasAbort && rows[3].cancelled > 0],
  ['abort trace suppressed with debug off', !rows[2].hasTrace],
]

console.log('\nassertions:')
let failed = 0
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failed += 1
}
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
