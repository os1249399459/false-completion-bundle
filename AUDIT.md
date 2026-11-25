# AUDIT — false-completion-bundle

Read-only audit as of 2026-11-22. Audience: a future maintainer re-establishing
this on a different WSL distro, DSH version, or profile. This describes what
exists today; it does not prescribe new work.

## 1. Component inventory

Every row below maps to a real file or a real config row.

### DSH plugin rows (`profiles/minimal.yml` is the default load path)

| Row / file | Purpose |
|---|---|
| `false-completion-gate` → `entry/index.ts` (built `dist/entry/index.js`) | Plugin entry: binds `agent/turn-stopping`, emits evidence, applies gate/repetition/divergence aborts. |
| `false-completion-filesystem-mcp` | `@deepseek-ai/dsh-mcp-client` row for `@modelcontextprotocol/server-filesystem@1.0.0`; deterministic file existence/hash checks. |
| `false-completion-playwright-mcp` | MCP client for `@playwright/mcp@0.0.86`; disabled unless `DSH_FALSE_COMPLETION_PLAYWRIGHT=1`. |
| `false-completion-python-mcp` | MCP client for `python/mcp_verifier/server.py` (FastMCP); disabled in minimal, mandatory in standard/strict-best-effort. |
| `cordis.patch.yml` | Authoritative reference patch (all four rows), kept for manual/`--patch` use; default install uses `profiles/minimal.yml`. |
| `gate.patch.yml`, `verifier.patch.yml` | Historical reference snippets; NOT loaded by any profile. |

**Removed in 0.1.9 — `false-completion-github-mcp`.** This row was an
over-designed placeholder: no verifier implementation ever consumed it
(`grep` over `src/` had zero readers), so it contributed no verification
capability while registering **26 MCP tools, 12 of them write operations**
(`create_or_update_file`, `push_files`, `create_repository`,
`merge_pull_request`, `create_pull_request_review`, ...). It also read the
wrong credential variable — the upstream server honours only
`GITHUB_PERSONAL_ACCESS_TOKEN`, never `GITHUB_TOKEN` — so it could not have
authenticated even when enabled. The upstream server offers **no** way to
restrict its tool list (no `--tools` flag, no `GITHUB_TOOLSETS`, no
read-only mode; verified empirically — all 26 tools are still returned with
every candidate flag and env var set). Removing the row was the only
fix that eliminated the exposure. A future GitHub verifier must be written
against a wrapper that filters `tools/list`, not against this server directly.

**Roadmap:** a strict read-only wrapper is planned for 0.2.0 — see
`HANDOFF.md` §10 and this repo's issue *Implement a strict read-only GitHub MCP
Wrapper (v0.2.0)*. It must filter `tools/list` down to `get_file_contents`,
`list_commits` and `get_pull_request_status`, and read
`GITHUB_PERSONAL_ACCESS_TOKEN`. Do not re-add the upstream server directly.

### Source adapters / core

| File | Purpose |
|---|---|
| `src/adapters/adapters.d.ts` | P0 contracts: `ToolBoundaryAdapter`, `CompletionHookAdapter`, `LedgerAdapter`, `VerifierAdapter`, evidence/claim types. |
| `src/adapters/ledgerAdapter.ts` | Redaction, canonical JSON hashing, OTLP span emission, `evidence.*` attributes, `getEntry` ok-bit lookup. |
| `src/adapters/repetitionGuard.ts` | Per-turn fingerprint allowlist for read-only tools; one feedback then cached result on repeats; fail-open. |
| `src/schema/claim.schema.ts` | Zod `claims[]` schema and validation result types. |
| `src/schema/claimGuard.ts` | Rejects done-without-evidence, unresolved/failed evidence, undisclosed unknown/blocked. |
| `src/gate/completionGate.ts` | Completion decision, retry budget, three divergence limits, suspend-based abort, structured reasons. |
| `src/gate/suspendAdapter.ts` | Default suspend adapter; records suspension and produces reason; injectable bridge for DSH approval. |
| `src/gate/abortReason.ts` | Unified abort categories, `abortDecision`, pure `formatAbortLine`, `categoryForIssue`. |
| `src/gate/abortLog.ts` | stderr emission plus optional append-only file at `DSH_ABORT_LOG`. |
| `src/telemetry/otelExporter.ts` | Private `BasicTracerProvider` + OTLP/HTTP exporter, fail-closed awaited export. |
| `src/telemetry/verifierProbe.ts` | Startup availability probe and `probeNpxPackages` helper; SKIP with one-line fixes. |
| `src/verifier/verifierDispatcher.ts` | Routes claim by `verification.type`; unknown → unknown (never pass). |
| `src/verifier/cliVerifier.ts` | Runs allowlisted local commands, exit-code driven, hashes output. |
| `src/verifier/filesystemMcpVerifier.ts` | Deterministic file existence/hash check over Filesystem MCP. |
| `src/verifier/playwrightMcpVerifier.ts` | Element/text/state assertion over Playwright MCP. |
| `src/verifier/pythonMcpVerifier.ts` | Deterministic-signal gate over Python grounding MCP; judge-only → unknown. |

### Scripts, profiles, harness

| File | Purpose |
|---|---|
| `scripts/metrics.mjs` | Runs Promptfoo and emits metrics from `.promptfoo/results.json`; env-supplied in-memory counters. |
| `scripts/otlp_local_sink.py` | Local-only OTLP/HTTP sink writing `~/.dsh/otlp-local/traces.ndjson`. |
| `scripts/start-otlp-local-sink.sh` | Idempotent launcher for that sink. |
| `scripts/otlp_capture_sink.py` | One-shot capture sink used to save raw trace fixtures. |
| `scripts/portability-smoke.sh` | Packs tarball, installs to clean DSH_HOME/cwd, checks resolved rows and no `.venv`. |
| `profiles/*.yml` | minimal / standard / strict-best-effort mount layers. |
| `promptfooconfig.yaml`, `promptfoo/cases/*.yaml`, `promptfoo/fixtures.mjs` | Declarative regression suite and fixture provider. |
| `tests/*.test.ts`, `tests/fixtures/otel/*.json` | 89 unit/seam tests plus two captured OTLP payloads. |
| `python/mcp_verifier/server.py`, `requirements.txt`, `test_server.py` | FastMCP grounding verifier (deterministic lexical overlap; optional judge). |
| `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest.config.ts`, `.npmrc` | Build/test/pack config. |
| `README.md`, `ASSUMPTIONS.md`, `AUDIT.md`, `POSTMORTEM.md` | Operator docs and audit trail. |

## 2. Data flow (text diagram)

```
model step / tool call
   │
   ├─ tools/pre-execute → repetitionGuard.beforeToolCall
   │     └─ read-only allowlist; fingerprint = tool_name + digestJson(redacted args)
   │          1st repeat → feedback; 2nd repeat → cached decision (no execution)
   │
   ├─ tool executes (MCP: filesystem / playwright / python; or CLI)
   │     └─ result in session (often only assistant text, not tool/result at turn-stopping)
   │
   ├─ tools/post-execute → repetitionGuard.afterToolCall (attach cached result)
   │
   └─ agent/turn-stopping → entry listener
         ├─ readPendingOutput(agent.session.snapshotEvents()) → ClaimsDocument
         ├─ OtelLedgerAdapter.emitEvidence() → evidence span (OTLP/HTTP → local sink)
         │     fail-closed: export error → abort category=exporter_failed
         ├─ CompletionGate.evaluate()
         │     ├─ divergence limits (steps / tool calls / no-progress) → suspend abort
         │     ├─ ClaimGuard (Zod + evidence) → issues
         │     ├─ retry budget → suspend abort (category = last cause)
         │     └─ verdict: complete | feedback (agent.steer) | abort (agent.cancel hook)
         ├─ verifier override (assistant-text ENOENT + done claim) → abort verifier_failed
         └─ abort line: formatAbortLine() → stderr + optional DSH_ABORT_LOG
```

Evidence reference `ev_<sha256-prefix>` is exported as span attribute
`evidence.ref`; trace/span IDs live on OTLP span fields. `evidence.profile` and
real `evidence.session.id` make spans self-describing.

## 3. Proven vs assumed, per component

Legend: **R** = runtime-proven in a real DSH session (evidence cited); **T** =
unit/seam test only; **A** = assumed / not verified here.

| Component | Status | Evidence |
|---|---|---|
| Gate row mounts; `agent/created` + `agent/turn-stopping` bind and fire; feedback via `steer`, abort via `cancel({kind:'hook'})` | **R** | `ASSUMPTIONS.md` §Real smoke install; startup logs `agent/created received; binding turn-stopping`, `turn-stopping fired turn=1`; `turn_end {kind:'aborted', reason:{kind:'hook'}}` with trace `390d37e9…` / `6c2be48e…` session `83d17e46…` |
| Fail-closed gate rejection of literal done/no-evidence | **R** | session `83d17e46…` `turn/end` seq 42: `Completion gate exhausted retries (2/1)`; spans `390d37e919e79791112748638a1c3b31`, `6c2be48e6e8db7b8cd0e739fa3e9ea00` |
| Evidence span shape + attributes + redaction | **R** | `tests/fixtures/otel/86921db896eb1a5a3e977e5de2849495.json`, `eca76109d6c30d40e59169bff821b796.json`; `tests/otelTraceShape.test.ts` |
| Profile attribution (`evidence.profile`, real session id) | **R** | traces `681690a1f9156e92e12b16e0689600e1` (work) and `9b35761317d3fc35151819334a9cf690` (smoke3); `tests/ledgerAdapter.test.ts` "spans from two profile values are distinguishable" |
| OTLP export from DSH process to local sink | **R** | `~/.dsh/otlp-local/traces.ndjson` (ephemeral — test runs truncate it), 10 spans at audit time; profiles seen work/smoke3/web/none-attribution-era |
| Filesystem MCP verifier returns real ENOENT | **R** | `ASSUMPTIONS.md` §MCP verifier re-enable; session `session-b9a2727f…`; seam test `tests/verifierGateSeam.test.ts` spawns the real server |
| Verifier→gate seam (fixed output, real verifier+gate) | **T/R hybrid** | `tests/verifierGateSeam.test.ts` uses real MCP + real gate, fixed model output and substituted suspend adapter |
| Python verifier starts in real DSH and returns deterministic unknown | **R** | `evidence_ref py:5922e7d8cc29024678a870cec115c6a6`, FastMCP 4.1.8 banner, real `pycheck` turn |
| Playwright MCP client works; browser missing | **R (fail path)** | real turn: `browser_navigate` → `async initialize` error; no browser binary |
| GitHub MCP | **A** | row always disabled; no token in environment |
| Langfuse UI trace visibility | **A / not closed** | no credentials; proven only at local OTLP sink |
| Repetition detection | **T** | `tests/repetitionGuard.test.ts` (7 tests); no real-DSH repetition turn recorded |
| Divergence limits | **T** | `tests/gateLimits.test.ts` (9 tests); budgets not hit in a real long turn |
| Abort categories / formatter / DSH_ABORT_LOG file sink | **T** | `tests/abortReason.test.ts`, `tests/fixedClaimGateSeam.test.ts`, `tests/abortLogSink.test.ts`; no log file written in a real DSH turn here |
| Retry budget default / naming guard | **T** | `tests/maxRetriesDefault.test.ts` (both load paths agree), `tests/namingGuard.test.ts` (deprecated names cannot reappear) |
| Loader `!!js` syntax and `process.cwd()` | **R** | `--dump-config` + real boot on `smoke3`/`web`; no `!!js` evaluation error (see POSTMORTEM) |
| `${WORKSPACE_ROOT}` interpolation | **R (broken)** | caused MCP path loop on `smoke2`; replaced by `!!js process.cwd()` |
| dsh-otel conflict with NodeSDK global provider | **R (bug)** | real DSH hung; private provider fixed it |

## 4. Fragility list

| DSH internal | What we rely on | Break if DSH changes | Detect |
|---|---|---|---|
| Event names `agent/created`, `agent/turn-stopping` | exact strings and payload `{agent,turn,signal}`, serial/awaited | hook never binds → no evidence, no aborts | startup log lacks `agent/created received; binding turn-stopping`; no `tool.call.evidence` span for a claim |
| `agent.steer(UserMessage)` / `agent.cancel({kind:'hook'})` | feedback continues, hook-cause accepted | feedback ignored or cancel rejected | turn_end reason not `kind:'hook'`; model never receives feedback |
| `MessageId` from `@deepseek-ai/dsh-llm/brand` | constructor for user message id | import failure at plugin load | startup error `ERR_MODULE_NOT_FOUND` on gate row |
| `agent.session.snapshotEvents()` | assistant text reachable at turn-stopping | claim output unreadable → no evidence span | log `parsed claim output status=undefined` alongside a visible assistant claim |
| `profileContext.name` / `ctx.get('profileContext')` | attribution value | `evidence.profile=unknown` | formatted line shows `profile=unknown` or sink attribute missing |
| MCP row schema (`serverName`, `transport: stdio`, `command`, `args`, `env`, `failOnStartupError`) | `@deepseek-ai/dsh-mcp-client` config | row fails to mount / tools missing | `--dump-config`, startup log lacks `Secure MCP Filesystem Server running on stdio` |
| Loader `!!js` expression semantics | dynamic values at mount | expressions literal or evaluation error | `--dump-config` shows literal; startup emits `disabled expression failed` |
| `dsh-otel` global provider | avoided by private provider | global resolution returns noop → no spans (or hang) | no span in sink despite gate firing; standalone exporter still works |
| OTLP default endpoint `localhost:4318` | fail-closed when sink absent | dead sink aborts every claim-bearing turn | formatted/log reason `category=exporter_failed` with `ECONNREFUSED 127.0.0.1:4318` |
| Relative path anchoring in patches | `../dist/entry/index.js` from `profiles/` | gate row resolves to `profiles/dist/...` and fails to import | startup `ERR_MODULE_NOT_FOUND .../profiles/dist/entry/index.js` |
| npm/npx cache permissions | pinned servers fetched via npx | install/network failure | probe line `SKIP ... pre-install locally or allow network access` |

## 5. Current gaps

- **Sink lifecycle**: local sink is a `nohup` Python process; after a WSL reboot it must be restarted with `scripts/start-otlp-local-sink.sh` or every claim-bearing turn aborts fail-closed.
- **Langfuse**: not closed — no credentials/endpoint; never validated in UI.
- **Log default path vs env override**: abort lines always go to stderr; file logging only when `DSH_ABORT_LOG` is set. No default file exists; `~/.dsh/abort.log` is only a documented example.
- **strict-best-effort**: not a hard gate — DSH logs `disabled expression failed` and keeps booting. Name intentionally renamed from `strict.yml`.
- **Multi-profile behavior**: attribution now distinguishes profiles, but profiles are separate installations; no shared state, and old hosts keep pre-reload code until HMR/config touch or restart.
- **Playwright / GitHub**: disabled-with-reason (no browser binary, no token).
- **Full real-model persistence**: not reproducible — models self-correct after deterministic failures; the seam test substitutes fixed output.
- **Metrics counters**: `repeated_tool_calls` and `diverged_turns_by_reason` default to zero from env; not proof of absence.
- **Session cleanup**: no DSH CLI bulk archive; manual UI action needed; backups documented in ASSUMPTIONS.md.

## 6. What to check first when something breaks (ordered triage)

1. **Sink alive?** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4318/` → must be 200; if not, run `scripts/start-otlp-local-sink.sh`.
2. **No remote endpoint leaked?** check env/profile for Langfuse/Phoenix/OTEL URLs; only `127.0.0.1` expected.
3. **Profile rows present?** `dsh --profile <name> --dump-config | grep false-completion` → gate + filesystem row; absent means the bundle was not added to `dsh.profile.bundles`.
4. **Gate path resolves?** row must end in `.../false-completion-bundle/dist/entry/index.js`, not `profiles/dist/...`.
5. **Hook bound?** startup log contains `agent/created received; binding turn-stopping` and `turn-stopping fired turn=1`.
6. **Claim parsed?** log line `parsed claim output status=...`; `undefined` with a visible claim means session read/extraction broke.
7. **Trace present?** `tail ~/.dsh/otlp-local/traces.ndjson` for a fresh `tool.call.evidence` with correct `evidence.profile`.
8. **Abort category correct?** `grep "category=" "$DSH_ABORT_LOG"` or stderr; distinguish exporter_failed / verifier_failed / claim_invalid / divergence limit.
9. **MCP tools visible?** startup `Secure MCP Filesystem Server running on stdio`; tool names `mcp__false-completion-filesystem__*`.
10. **Attribution correct?** span `evidence.profile` equals expected profile; session id is not the legacy `dsh-host`.
11. **Tests**: `pnpm test` and `pnpm run typecheck`; if only tests pass but runtime fails, suspect wiring/DSH version rather than logic.
