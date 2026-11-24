# false-completion-bundle

1. `dsh plugin --profile work add false-completion-bundle`
2. `dsh run --profile work`
3. Optional: `npx playwright install chromium`; `export GITHUB_TOKEN=...`; [Python setup](#python)
4. `pnpm run metrics`

That is the whole quick start. The default profile activates the gate and the
Filesystem verifier with no config edits; other verifiers print a SKIP line with
a one-line fix at startup.

**Network requirement:** the MCP verifier servers are fetched with `npx -p`,
so the **first run requires network access** unless the packages are already
installed. Every `npx` spec in every profile is pinned to an exact version
(no `@latest`, no ranges) so repeated runs cannot drift. Production environments
should pre-install the pinned packages (see "Pin policy" below) and may set
`npm_config_offline=true` to forbid any fetch.

---

## Pin policy

Every `npx`-invoked MCP server is pinned to an exact version that was exercised
in this repository:

| Server | Pinned version | Notes |
|---|---|---|
| `@modelcontextprotocol/server-filesystem` | `1.0.0` | verified in real DSH turns (ENOENT + success paths) |
| `@playwright/mcp` | `0.0.86` | present in the local npx cache; browser binary still required |
| `@modelcontextprotocol/server-github` | `2025.4.8` | installs and starts (`GitHub MCP Server running on stdio`); upstream is archived, so pin stays exact |

To pre-install for an offline/production deployment:

```bash
npx -y -p @modelcontextprotocol/server-filesystem@1.0.0 -c true
npx -y -p @playwright/mcp@0.0.86 -c true
npx -y -p @modelcontextprotocol/server-github@2025.4.8 -c true
export npm_config_offline=true   # fail instead of fetching during runs
```

`tests/packaging.test.ts` fails if any profile reintroduces an unpinned spec, and
`tests/hostEntry.test.ts` fails if the GitHub pin returns to the previously
documented-but-nonexistent `1.0.0` (npm E404 — that row could never start).

Note on `server-github`: it is **archived and unmaintained** upstream
(`modelcontextprotocol/servers-archived`). It still installs and runs from npm,
but it carries no security guarantees. The row is disabled unless
`GITHUB_TOKEN` is set, so it costs nothing to profiles that do not use it.

## Python setup {#python}

The Python grounding verifier is OFF by default: with no deterministic backend
it returns only `unknown` and would cause frequent suspends. To enable it:

```bash
python3 -m venv .venv
.venv/bin/pip install -r python/mcp_verifier/requirements.txt
export VERIFIER_BACKEND=ragas        # or trulens | deepeval
```

Then use `profiles/standard.yml` (or set the backend in the environment). The
`.venv` is **not** packaged — it is rebuilt locally with the commands above.

SKIP fixes printed at startup, one line each:

- `python SKIP (no deterministic backend configured)` → follow [Python setup](#python) and set `VERIFIER_BACKEND`.
- `playwright SKIP (browser binary not found)` → `npx playwright install chromium` and set `DSH_FALSE_COMPLETION_PLAYWRIGHT=1`.
- `github SKIP (GITHUB_TOKEN not set)` → `export GITHUB_TOKEN=...`.

## Profiles and strict mode (below the fold)

- `profiles/minimal.yml` (default): gate + Filesystem verifier active; Python
  OFF; Playwright/GitHub auto-warn. Zero config edits.
- `profiles/standard.yml`: minimal + Python; refuses to mount if
  `VERIFIER_BACKEND` is not ragas/trulens/deepeval, printing the exact setup
  command.
- `profiles/strict-best-effort.yml`: all verifiers required. When a dependency
  is missing, the `!!js` guard **fails at mount** and DSH logs a clear
  `strict-best-effort.yml: ...` error for each missing dependency. **Best-effort
  only, not a hard guarantee:** DSH logs such guard failures and continues
  booting (measured: process exit code 0), so strict can silently degrade into
  minimal. In supervised environments use the shell-check workaround:
  `dsh ... 2>&1 | tee run.log; grep -q 'strict-best-effort.yml:' run.log && exit 1`.
  No code in this bundle changes that Host behavior.

## Phase 1 — evidence ledger + claim guard

## What this phase implements

- `src/telemetry/otelExporter.ts` — `OTelEvidenceExporter` uses a **private** `BasicTracerProvider` with the official OTLP/HTTP exporter. Endpoint and auth come from env vars. A span-export wrapper turns export results into awaited promises; `emitEvidenceSpan()` rejects on failure and invokes `onEmissionFailure`. See "Private tracer provider" below for why it is private.
- `src/adapters/ledgerAdapter.ts` — `OtelLedgerAdapter` implements `LedgerAdapter`. It redacts secrets from a **derived** args view (original tool args are never mutated), computes deterministic SHA-256 digests over canonical JSON, emits one span per tool call with trace_id/span_id, tool name, args hash, result hash, exit code/error, timestamp, and side-effect diff/snapshot, and returns a stable `ev_<digest>` reference. It also exposes `getEntry(ref)` with the `ok` bit for claim validation.
- `src/schema/claim.schema.ts` — Zod schemas for `claims[]` with `text`, `status`, `evidence_ids[]`, `verification`, `open_questions[]`, `unverified_assumptions[]`.
- `src/schema/claimGuard.ts` — rejects `done` with empty evidence, unresolved evidence ids, and evidence whose ledger entry has `ok=false`. Returns structured Zod-style issues; never throws untyped errors.

## Fail-closed behavior

`emitEvidence()` awaits OTLP delivery. If the exporter fails, it calls `onEmissionFailure` and rejects. The DSH tool-boundary integration (later phase) must propagate that rejection to deny/fail the tool call — no audit evidence is silently dropped.

## Configuration

Copy `.env.example` and set either Langfuse or Phoenix OTLP endpoint + auth header. `AUDIT_REDACT_KEYS` adds deployment-specific secret key names (comma-separated, case-insensitive) to the default redaction list.

### Canonical retry budget

`maxRetries` has exactly **one** default: `1`, exported as `DEFAULT_MAX_RETRIES`
from `src/gate/completionGate.ts`. The gate config, the plugin entry's
`FALSE_COMPLETION_MAX_RETRIES` fallback, and the profile comments all read that
constant, so the effective budget cannot depend on the load path.

- Default (no env, no config field): **1** — the `(2/1)` semantics documented below.
- Override: `export FALSE_COMPLETION_MAX_RETRIES=<n>` before launching DSH, or pass
  `maxRetries` explicitly to `CompletionGateConfig`.
- `tests/maxRetriesDefault.test.ts` fails if any source restates a conflicting
  numeric default.

## Verification

```
pnpm install
pnpm test          # unit + seam + trace-shape tests; current count from `pnpm test`
pnpm typecheck
```

Successful OTLP export is proven by `tests/otelTraceShape.test.ts` against the
captured fixtures; see "Trace schema and local capture" below.

## Phase 3 — deterministic verifier dispatch

`src/verifier/verifierDispatcher.ts` routes by `claim.subject.verification.type`. Unknown types return `unknown` — never `pass`. No LLM judge is used.

| Type | Adapter | How it verifies |
|---|---|---|
| `cli` | `cliVerifier.ts` | Runs an allowlisted command (`vitest`, `pytest`, `tsc`, `eslint`, …) via `execFile`. Exit code 0 → pass, non-zero → fail. SHA-256 of stdout+stderr becomes the evidence ref. |
| `filesystem` | `filesystemMcpVerifier.ts` | Calls an existing Filesystem MCP `readFile`. Missing file → fail. Optional `sha256` must match content hash. |
| `playwright` | `playwrightMcpVerifier.ts` | Calls an existing Playwright MCP `assert` with `selector`/`text`/`state`/`url`. `ok: false` → fail. |

MCP clients are injected. Declare the MCP servers in `cordis.patch.yml` (see `verifier.patch.yml`) — no custom MCP server or browser automation is bundled. LLM judge / free-form model verdicts are explicitly unsupported and always return `unknown`.

## Phase 4 — false-completion regression harness

Run with `pnpm run test:regression` (CI-safe: no network, no LLM, telemetry disabled, workspace-local config dir).

`promptfooconfig.yaml` loads seven declarative cases from `promptfoo/cases/*.yaml`:

1. `no-evidence` — done claim with empty `evidence_ids` → gate code `custom`.
2. `stale-evidence` — cites a previous-turn id absent from the ledger → `evidence_unresolved`.
3. `failed-tool-cited` — ledger entry has `ok: false` → `evidence_failed`.
4. `fabricated-file-change` — invented id not in ledger → `evidence_unresolved`.
5. `tests-failed` — claims tests passed while the cited run entry is `ok: false` → `evidence_failed`.
6. `judge-only-pass` — mocked Python MCP returns judge-only pass → downgraded to `unknown` → abort.
7. `valid-claim` — control: valid done claim with deterministic pass → `complete`.

The Promptfoo provider (`promptfoo/fixtures.mjs`) calls the exported `CompletionGate`, `DocumentedSuspendAdapter`, `VerifierDispatcher` and `PythonMcpVerifier`. Each case asserts the output kind and, where applicable, the gate error code. Cases 6–7 inject a mocked MCP client response; cases 1–5 are static gate tests. The exact pass/fail counts come from `pnpm run metrics` (see below) — do not quote a fixed count from this text.

## Phase 5 — Python grounding verifier via MCP

`python/mcp_verifier/server.py` is a FastMCP server exposing one tool, `verify_claim(claim_text, evidence_refs)`. It wraps existing Python verifier packages (Ragas / TruLens / DeepEval) through `VERIFIER_BACKEND`; their algorithms are never ported to TypeScript.

Setup:

```
python3 -m venv .venv
.venv/bin/pip install -r python/mcp_verifier/requirements.txt
.venv/bin/python -m pytest python/mcp_verifier/test_server.py -q
.venv/bin/python python/mcp_verifier/server.py   # stdio MCP server
```

Env vars: `VERIFIER_BACKEND` (`ragas|trulens|deepeval|none`), `VERIFIER_JUDGE_MODEL`, `VERIFIER_JUDGE_API_KEY`, `VERIFIER_DETERMINISTIC_THRESHOLD` (default 0.7), `VERIFIER_JUDGE_THRESHOLD`, `EVIDENCE_JSON` (map of evidence id → supporting text). The MCP client entry is declarative in `cordis.patch.yml`; the TS side only adds a thin adapter (`src/verifier/pythonMcpVerifier.ts`) that calls the tool and routes by `verification.type: python`.

## Patch load path (DSH 0.2.1-rc.5)

Confirmed from the installed Cordis bundle templates and the live profile: DSH does **not** auto-load a file named `verifier.patch.yml`. A bundle manifest declares `"dsh": { "bundle": { "patch": "..." } }` and the bundle is installed with `dsh plugin --profile <profile> add <bundle dir>`. The profile's own patch is `~/.dsh/profiles/<profile>/cordis.patch.yml`. The default patch is **`profiles/minimal.yml`** (`dsh.bundle.patch` in `package.json`); `cordis.patch.yml`, `gate.patch.yml` and `verifier.patch.yml` are authoritative/reference copies, not loaded by default. MCP client rows use `@deepseek-ai/dsh-mcp-client` with `serverName`, `transport: stdio`, `command`, `args`, and optional `cwd`/`env` (confirmed by the installed MCP bundle template).

Judge limitations: the LLM judge is auxiliary. A `pass` requires at least one deterministic signal (lexical overlap against resolved evidence text, score ≥ threshold). Judge-only positives are downgraded to `unknown` in both Python and the TS adapter (defense in depth). Unresolvable evidence, MCP errors, or unconfigured backends return `unknown` / `fail`, never a judge-only `pass`.

## Divergence defaults {#divergence-defaults}

Three hard limits bound a runaway turn; they are code-level and abort through
the same completion-gate suspend path (never a prompt instruction):

| Config field | Env var | Default | Meaning |
|---|---|---|---|
| `maxStepsPerTurn` | `FALSE_COMPLETION_MAX_STEPS` | 20 | Model steps in one turn; abort at 21/20 |
| `maxToolCallsPerTurn` | `FALSE_COMPLETION_MAX_TOOL_CALLS` | 30 | Tool calls observed in one turn; abort at 31/30 |
| `maxConsecutiveNoProgressSteps` | `FALSE_COMPLETION_MAX_NO_PROGRESS` | 3 | Steps with no progress; abort at 3/3 |

Progress means **any** of: a claim status advances, a new `evidence_id`
appears, or a verifier returns a new pass/fail. Repeated tool calls and
identical claims do **not** count. Defaults are conservative enough for normal
multi-step tasks while stopping loops before runaway token spend; three
identical steps strongly indicates the model is stuck. All three are
configurable at construction time: `entry/index.ts` reads the env vars above
and forwards them to `CompletionGateConfig`, and the defaults come from the
exported constants (`DEFAULT_MAX_STEPS_PER_TURN`, ...) that `get_gate_status`
also reports — so a reported limit cannot drift from an enforced one. There is
still no runtime setter; changing a limit requires a restart (env change) or a
rebuild (default change).

Abort reasons are structured and backward compatible, e.g.
`Completion gate suspended: ... [no_progress_exceeded (3/3)] {"limit":"no_progress_exceeded","count":3,"max":3}`.

`pnpm run metrics` reports `diverged_turns_by_reason` from an in-memory env
summary (`DSH_DIVERGED_TURNS_JSON`). **It defaults to zero**: env-based metrics
are not proof that no divergence happened; Prompt 5 cross-checks them against
real session logs.

## Retry semantics — what `(2/1)` means

`maxRetries` is the number of invalid claim outputs the gate tolerates **before**
suspending. `attempts` counts invalid outputs seen. Suspension happens when
`attempts > maxRetries`. So `(2/1)` means: **2 invalid outputs seen, limit 1 —
the limit has been exceeded.**

With `maxRetries: 1`: the first invalid claim returns `feedback` (the agent is
steered to continue the turn and fix its claims); the second invalid claim
exceeds the limit, calls the suspend adapter, and returns `abort`. The agent loop
then ends with `turn_end {kind:'aborted', reason:{kind:'hook', ...}}`. With
`maxRetries: 0` the first invalid claim already suspends. Feedback delivery uses
`agent.steer()` (not `inject()`); exhaustion uses `agent.cancel({kind:'hook'})`.

Real transcript excerpt (forced literal `done`, empty evidence, `maxRetries: 1`):

```
[step 1 model] {"claims":[{...,"status":"done","evidence_ids":[]}]}
[gate] SUSPENDED suspend-000001: Completion gate exhausted retries (2/1) for session dsh-host, turn 1
[step 3 model] FALSE — I will not certify that claim ... no evidence
[turn_end] {'kind': 'aborted', 'reason': {'kind': 'hook', 'reason': 'Completion gate suspended: ... (2/1)'}}
```

The exact source of this excerpt is recorded in `ASSUMPTIONS.md` (session
`session-244d...` and the `smoke3` runs). `maxRetries` is set from
`FALSE_COMPLETION_MAX_RETRIES` in the plugin entry.

## Private tracer provider

`OTelEvidenceExporter` constructs its own `BasicTracerProvider` instead of
calling `NodeSDK.start()` and using the global `trace.getTracer()`.

Why: DSH mounts its own `dsh-otel` service in the same process. A real DSH run
hung on `NodeSDK` + global-provider resolution even though the same build worked
standalone; the global singleton can resolve to a no-op or incompatible provider.
A private provider with an explicit `SimpleSpanProcessor` makes evidence export
deterministic and independent of whatever the Host registers globally.

Compatibility constraint: because the provider is private, Host-level OTel
configuration does not govern these spans — only
`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` (or the Langfuse /
Phoenix variants) and `OTEL_SERVICE_NAME` do. If you want to share a provider
with DSH's `dsh-otel`, you must change `src/telemetry/otelExporter.ts` to accept
an injected `Tracer`/`TracerProvider` and pass the Host's provider in — that is
an intentional code change, not a config toggle, and it was not done here.

## Checking gate status from the GUI or chat

Ask the agent to run the read-only tool **`get_gate_status`**. It returns:

- effective config — `maxRetries`, divergence limits, active verifiers, OTel endpoint, profile;
- the abort-log path and whether it is set via `DSH_ABORT_LOG`;
- the last 5 abort lines from today's log (when the file exists).

It never evaluates claims, records evidence, or triggers retries, so it is safe
to call at any point — including as the first step when a turn aborts. The tool
is registered by the plugin entry (`entry/index.ts`) and requires no terminal.

## Log verbosity (`FALSE_COMPLETION_DEBUG`)

Per-turn trace lines are **silent by default**. The gate prints them only when
`FALSE_COMPLETION_DEBUG` is truthy:

| Line | Default | `FALSE_COMPLETION_DEBUG=1` |
|---|---|---|
| `agent/created received` | — | printed |
| `turn-stopping fired turn=N` | — | printed |
| `parsed claim output status=...` | — | printed |
| `tool/result isError=... text=...` | — | printed |

Strict truthiness: unset, empty, `0`, `false`, `no`, `off` all mean OFF, so a
typo cannot silently re-enable the flood.

**Never gated** — these stay loud with debugging off, because they explain why a
turn was blocked:

- `[false-completion-gate] abort category=...` (the audit trail, `formatAbortLine`)
- `[false-completion-gate] SUSPENDED <ticket> session=<id>: ...`
- `exporter_failed` aborts (infrastructure, not diagnostics)
- abort-log write failures
- startup lines: the verifier probe, `limits ...`, and `OTLP endpoint = ...`

A normal chat turn therefore prints **nothing** from the gate; only a real abort
or a misconfiguration does. `node scripts/log-noise-demo.mjs` prints the
four-quadrant matrix (normal/abort × debug off/on) to confirm this locally.

## Durable abort log (daemon mode)

`DSH_ABORT_LOG` optionally points to a file that receives **one append-only line
per aborted turn**, in addition to the unchanged stderr line:

```bash
export DSH_ABORT_LOG=/home/hex636869/.dsh/abort.log
```

When unset, behavior is exactly as before (stderr only; no file is created).
The file exists because in daemon / background mode stderr is often not visible
or is rotated away; the log makes abort reasons greppable after the fact.
Nothing else is written to that file — never claims, traces, or retries.

Each line has a stable shape (absent fields are `-`):

```
[false-completion-gate] abort category=claim_invalid claim="I read foo.txt" evidence=- verifier=- counts=1/0 detail="Completion gate suspended: retries exhausted (1/0); ..."
```

Grep examples:

```bash
grep 'category=claim_invalid' "$DSH_ABORT_LOG"
grep 'category=verifier_failed' "$DSH_ABORT_LOG"
grep 'category=exporter_failed' "$DSH_ABORT_LOG"   # dead sink, not a gate problem
```

## Verification status

Three separate columns: **code-level verified** = unit/integration tests prove
it; **runtime verified** = observed in a real DSH process; **not verified** =
no evidence in this environment. Statuses marked "verbatim" are the exact
wording recorded in `ASSUMPTIONS.md`.

| Item | Code-level verified | Runtime verified | Not verified |
|---|---|---|---|
| Filesystem verifier | `filesystemMcpVerifier.ts` unit tests | **real-passed** — real MCP ENOENT in a DSH turn; seam test spawns the real server | — |
| Python grounding verifier | 5/5 Python tests (`pnpm`-independent: `bundle/.venv/bin/python -m pytest python/mcp_verifier/test_server.py -q`) | **broken-with-fix** (MCP row used relative venv/server paths resolved against the profile cwd; fixed to absolute bundle paths; real DSH turn now starts FastMCP 4.1.8 and returns a deterministic unknown verdict) | optional verifier backends (Ragas/TruLens/DeepEval) not configured |
| Playwright verifier | `playwrightMcpVerifier.ts` unit tests | **disabled-with-reason** — no browser binary installed; MCP tool ran but `browser_navigate` failed at `async initialize` | real UI assertion pass/fail |
| GitHub MCP | — | **disabled-with-reason** — no GitHub token in this environment; enabling would cause reconnect loop | any GitHub MCP tool call |
| Verifier → gate seam | `tests/verifierGateSeam.test.ts` (fixed model output, real verifier + gate) | **proven via seam test with fixed model output** — gate abort reason cites `Verifier failure`, not retry exhaustion | full real-model single-turn persistence (see below) |
| Langfuse UI trace | OTLP payload shape asserted by `tests/otelTraceShape.test.ts` | real spans captured at a local OTLP sink | **not closed** — no Langfuse credentials/endpoint in this environment |
| Real-model persistent `done` with ENOENT | — | — | **not reproducible** — real models self-correct to `FALSE`/`blocked` after seeing the deterministic failure; this is correct model behavior, not a harness defect |

See `ASSUMPTIONS.md` for the full evidence behind each row.

## Acceptance metrics

Run `pnpm run metrics` (or `npm run metrics`). It executes the full Promptfoo regression suite with `-o .promptfoo/results.json`, derives metrics from that file, and writes them to `.promptfoo/metrics.json`. Every number below is produced by that command; re-run it for current values.

| Metric | Definition | Command source |
|---|---|---|
| Regression total / passed / failed | Promptfoo case results | `pnpm run metrics` → `.promptfoo/metrics.json` (`regression.total/passed/failed`) |
| False-completion rate | `(failed regression cases / total) × 100` | `pnpm run metrics` → `regression.false_completion_rate_pct` |
| Gate false-reject rate | Control cases where a valid done claim was wrongly rejected | `pnpm run metrics` → `gate_false_reject.pct` (control count in `gate_false_reject.control_cases`) |
| Evidence coverage | `%` of `done` claims in fixtures whose ids all resolve `ok=true` in their case ledger | `pnpm run metrics` → `evidence_coverage.pct` |
| Custom code size | Lines of `.ts`/`.py` under `src/{adapters,telemetry,schema,gate,verifier}` and `python/mcp_verifier`, excluding `.d.ts` and Python tests | `pnpm run metrics` → `custom_code_lines_excluding_tests_config` |

No fixed values are asserted in this document; the last generated values are in
`.promptfoo/metrics.json` and are overwritten on every `pnpm run metrics`.

## Trace schema and local capture

A real DSH run exports one span per evidence emission, named `tool.call.evidence`.
The captured OTLP/JSON body is saved under `tests/fixtures/otel/<trace-id>.json`;
`tests/otelTraceShape.test.ts` asserts its shape on every `pnpm test`.

Required span attributes (all primitive strings — OTel drops object attributes):

| Attribute | Meaning |
|---|---|
| `evidence.tool.name` | Tool that produced the evidence (e.g. `assistant.claim`) |
| `evidence.args.hash` | SHA-256 of the **redacted** arg view |
| `evidence.result.hash` | SHA-256 of outcome + snapshot |
| `evidence.exit_code` | `OK` or a structured error code |
| `evidence.error.name` / `evidence.error.code` | Failure identity (empty on success) |
| `evidence.timestamp` | ISO-8601 emission time |
| `evidence.snapshot` | JSON **string** of `{source, diffs, beforeRef, afterRef}` |
| `evidence.redacted_fields` | Comma-separated names of redacted keys |
| `evidence.session.id` | Session identity |
| `evidence.ref` | Stable evidence id (`ev_<digest-prefix>`) returned to the agent |

Trace and span IDs live on the OTLP span itself (`traceId`, `spanId`), not as
attributes. `evidence.ref` is the id the agent sees; correlate it to a span by
the exported `evidence.ref` attribute.

Capture one locally (no Langfuse needed):

```bash
# 1. run a tiny OTLP HTTP sink that saves the full JSON body per trace
python3 scripts/otlp_capture_sink.py          # listens on 127.0.0.1:4331/v1/traces
# 2. run a real DSH session with the bundle
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4331/v1/traces \
  dsh --profile smoke3 --json '<task that produces a claims[] document>'
# 3. copy /tmp/otlp_capture/<trace-id>.json into tests/fixtures/otel/
```

Always set `OTEL_EXPORTER_OTLP_ENDPOINT`: when unset, the exporter defaults to
`localhost:4318` and a fail-closed gate aborts the turn if no collector is there.

## Closing statement — proven, not proven, next steps

**Proven:** the claim guard and completion gate reject static false claims in
code and in real DSH turns; the verifier → gate seam passes a real MCP failure
into an abort reason that cites the verifier (via the fixed-output seam test);
the Filesystem and Python MCP verifiers both run in real DSH processes, with the
Python row fixed from relative to absolute paths; evidence spans with the full
required attribute set are exported from a real DSH process and their shape is
asserted by a test. All metrics in this document come from `pnpm run metrics`.

**Not proven:** Langfuse UI display of a trace (no credentials here — only a
local OTLP sink was used); Playwright UI assertions (no browser binary); GitHub
MCP (no token); and a single real-model turn where the model persists a `done`
claim *after* seeing an MCP ENOENT — real models self-correct, so the seam test
fixes model output instead.

**For a new maintainer:** to close the remaining gaps, (1) set
`OTEL_EXPORTER_OTLP_ENDPOINT` plus Langfuse auth headers and repeat the local
capture to confirm a trace in the Langfuse UI; (2) install a browser
(`npx playwright install chromium`) and re-enable the Playwright row; (3) supply
a GitHub token before enabling GitHub MCP; (4) if you need a real-model-persistence
proof, use a model/prompt that will not self-correct, but keep the seam test as
the authoritative harness-level guarantee; (5) archive old smoke sessions via the
Web UI (no DSH CLI bulk-archive exists) using the procedure in ASSUMPTIONS.md.
