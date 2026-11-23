# POSTMORTEM — false-completion-bundle

Chronological record of non-trivial problems encountered while building and
deploying this bundle. Each entry separates the observed symptom from the real
root cause, the evidence that distinguished it from lookalikes, the fix, and a
rule to carry forward. Read `ASSUMPTIONS.md` for the corresponding runtime
facts; `AUDIT.md` for the current state.

## 1. Guessed DSH APIs in P0

- **Symptom**: adapter declarations assumed hook names and payload shapes; the first real plugin failed at apply with `cannot get property "false-completion-gate" without inject`.
- **Root cause**: two separate guesses — (a) `agent.cancel({kind:'policy'})` is not a legal `AgentCancelCause`; only `user|parent|hook|disposed` exist; (b) `ctx['some-key']` requires a declared `inject`, and the plugin injected nothing.
- **Diagnosis**: real boot log showed the exact loader error; reading DSH type declarations gave the legal cause kinds.
- **Fix**: use `{kind:'hook'}`; move all gate config to env vars (`FALSE_COMPLETION_MAX_RETRIES`, `FALSE_COMPLETION_LEDGER`).
- **Rule**: never ship a hook/config contract without booting it once; read the installed `.d.ts` for enum-like fields before choosing a value.

## 2. `session.events` and greedy claim regex

- **Symptom**: gate saw `parsed claim output status=undefined` even though the assistant visibly emitted a `claims[]` JSON.
- **Root cause**: used a non-existent `Session.events` accessor, and a greedy `/\{[\s\S]*"claims"[\s\S]*\}/` regex that swallowed surrounding JSON.
- **Diagnosis**: reading `@deepseek-ai/dsh-session` types showed only `snapshotEvents()`; decompressed session log showed the exact assistant text.
- **Fix**: `agent.session.snapshotEvents()` plus `indexOf('{')`/`lastIndexOf('}')` slice on the first text block containing `"claims"`.
- **Rule**: session reads are deprecated-sync; verify the accessor exists in the installed version and slice JSON by braces, not greedy regex.

## 3. Relative gate path resolved beside the patch (`profiles/dist/...`)

- **Symptom**: after packaging, `--dump-config` showed `.../false-completion-bundle/profiles/dist/entry/index.js`; real boot failed with `ERR_MODULE_NOT_FOUND`.
- **Root cause**: Loader anchors inserted relative paths beside the patch file; `profiles/minimal.yml` used `./dist/entry/index.js`, which meant `profiles/dist/...`.
- **Diagnosis**: compared the resolved row in `--dump-config` with the installed tarball layout.
- **Fix**: changed all three profiles to `../dist/entry/index.js`; re-packed and re-installed into `work`.
- **Rule**: a path in a patch is relative to the patch, not the package root; always verify the resolved row in `--dump-config`.

## 4. `${WORKSPACE_ROOT}` is not Loader syntax → MCP path loop

- **Symptom**: real `smoke2` startup repeated `Cannot access directory /home/.../${WORKSPACE_ROOT}, skipping` / `Error: None of the specified directories are accessible`; session hung.
- **Root cause**: `${ENV}` interpolation is not a DSH Loader feature. The literal string was passed to the filesystem MCP server as an allowed root.
- **Diagnosis**: shipped `dsh-base/cordis.patch.yml` and `cordis-composition-reference/SKILL.md` showed `!!js <expression>`; `!!js process.cwd()` is the documented idiom.
- **Fix**: enabled MCP rows with `!!js process.cwd()` and npx package specifiers; removed `--from-default-profile` staging in the portability script where EXDEV interfered.
- **Rule**: only use `!!js` for dynamic patch values; never `${...}`.

## 5. `dsh-otel` global-provider conflict

- **Symptom**: exporter worked standalone but a real DSH turn hung with no span; earlier NodeSDK build had produced spans only outside DSH.
- **Root cause**: DSH mounts its own OTel service; global `trace.getTracer()` resolved to a no-op/incompatible provider, so the span never reached our processor. A second bug compounded it: `AwaitableSpanExporter.export()` rejected on failure but never resolved pending promises on success.
- **Diagnosis**: standalone vs in-process comparison; added diagnostics to confirm `WRAPPER export called` never happened in DSH; inspected installed OTel source.
- **Fix**: private `BasicTracerProvider({resource, spanProcessors:[new SimpleSpanProcessor(awaitable)]})` with own `getTracer()`; resolve pending promises on success.
- **Rule**: do not use global OTel singletons inside a host that owns its own telemetry; keep a private provider and an awaited export result.

## 6. Chunked OTLP body / sink parse failures

- **Symptom**: exporter reported success; sink log said `parse error ()` and no spans landed.
- **Root cause**: the Node OTLP HTTP exporter uses chunked transfer encoding; the simple `content-length` sink read zero bytes. Also protobuf-vs-JSON confusion in earlier probes.
- **Diagnosis**: tee proxy showed `Transfer-Encoding: chunked`, `Content-Length: 0`, body hex empty.
- **Fix**: chunked-aware reader in `scripts/otlp_local_sink.py`; later `ThreadingHTTPServer` with `Connection: close`.
- **Rule**: local collectors must handle chunked HTTP; verify with a raw request, not just exporter success.

## 7. npx keep-alive hang caused fail-closed aborts

- **Symptom**: after fixing attribution, real turns ended exit=1 with `EvidenceExportError: Request Timeout`; sink health later returned `health=000`.
- **Root cause**: single-threaded `HTTPServer` kept a connection open; subsequent exporter requests timed out. Fail-closed correctly aborted, but for an infrastructure reason.
- **Diagnosis**: `curl health` failed while process existed; thread/connection inspection.
- **Fix**: `ThreadingHTTPServer` + `Connection: close` header in the sink, and idempotent launcher script.
- **Rule**: a fail-closed gate makes sink health part of correctness; always health-check the sink before interpreting a rejection.

## 8. Default endpoint / dead sink masquerading as gate problem

- **Symptom**: `turn_end {kind:'aborted', reason:'Evidence export failed: ... ECONNREFUSED 127.0.0.1:4318'}` looked like a gate rejection.
- **Root cause**: `OTEL_EXPORTER_OTLP_ENDPOINT` unset → exporter defaults to `localhost:4318`; no collector present.
- **Diagnosis**: log said `Evidence export FAILED (fail-closed)` before any claim issue; port 4318 empty.
- **Fix**: start local sink; later map exporter failure to `category=exporter_failed` so it is never confused with `verifier_failed` or retries.
- **Rule**: distinguish infrastructure failure from policy failure in the abort reason; set the endpoint explicitly.

## 9. Profile mix-up: `work` trace reported as `web`

- **Symptom**: reported a trace ID as web-profile evidence; it came from `--profile work`.
- **Root cause**: the only one-shot-capable profile was `work`; the web profile is a server. I used it for convenience and mislabeled provenance.
- **Diagnosis**: trace timestamp/process inventory; later `evidence.profile` attribute made it explicit.
- **Fix**: re-ran with a web-host turn, killed the extra `--port 3099` instance so only `dsh web` remained, and recorded trace `292761cda67e9d226b15e9c89beda8ad` with session `65fbf304…` (sink file later truncated by tests; see ASSUMPTIONS.md). Added self-describing attribution.
- **Rule**: prove provenance from process inventory + in-band attributes, never from the command you meant to run.

## 10. Hard-coded `evidence.session.id = dsh-host`

- **Symptom**: all spans showed `session=dsh-host`; web provenance rested on timestamps and process lists.
- **Root cause**: entry passed a static string to the ledger.
- **Diagnosis**: grep of entry confirmed literal; session dirs showed real ids.
- **Fix**: pass real `agent.session.id` per emission; add `evidence.profile` from `profileContext.name` / `DSH_PROFILE`; keep legacy field.
- **Rule**: attribution must be in the telemetry itself; external correlation is fragile.

## 11. Relative venv/server paths resolved against profile cwd

- **Symptom**: Python tests passed 5/5, but the MCP row was initially disabled with "needs .venv"; row command `.venv/bin/python` existed only in the bundle.
- **Root cause**: MCP client resolves relative `command`/`args` against the profile cwd, not the bundle. Classification: **path misconfiguration**, not missing environment or consolidation loss.
- **Diagnosis**: `--dump-config` left paths literal; `ls ~/.dsh/profiles/pycheck/.venv/bin/python` missing.
- **Fix**: absolute paths in `cordis.patch.yml`; re-enabled row; real FastMCP turn verified.
- **Rule**: MCP row paths must be absolute (or npx package specs); verify with `--dump-config` and a real boot.

## 12. Pinned npx dependency drift / cache permission

- **Symptom**: plain `npx` failed with root-owned-cache errors in one shell; `@playwright/mcp@latest` and `@modelcontextprotocol/server-github@latest` floated.
- **Root cause**: workspace-sandbox blocked `~/.npm` writes (environment artifact), and unpinned specs invited drift.
- **Diagnosis**: retried with `danger-full-access`; `npx -y -p <spec> -c ...` succeeded and resolved a Linux x64 binary.
- **Fix**: pin all MCP packages to tested exact versions; add packaging test rejecting `@latest`; document pre-install and network requirement.
- **Rule**: pin third-party executable versions and state the first-run network assumption.

## 13. Strict mode silently degrading to minimal

- **Symptom**: `strict.yml` guards threw `disabled expression failed` but DSH logged and kept booting (exit 0).
- **Root cause**: DSH does not turn Loader guard failures into a fatal process exit; no supported plugin-level fatal hook was reachable from a config row.
- **Diagnosis**: real boot with missing env showed guard errors but exit 0.
- **Fix**: rename to `strict-best-effort.yml`, update all references, document shell-check workaround; add packaging test forbidding `strict.yml`.
- **Rule**: do not name a mode "strict" unless the runtime enforces it; assert enforcement or rename honestly.

## 14. Repetition threshold off by one

- **Symptom**: first repeat returned `cached` instead of `feedback`.
- **Root cause**: `count >= 2` was treated as "second repeat"; actual sequence is 1 = initial, 2 = first repeat, 3 = second repeat.
- **Diagnosis**: a tiny debug test printed the decision sequence.
- **Fix**: `count > 2` for cached; count 2 returns feedback.
- **Rule**: count state transitions explicitly with a debug trace before tuning thresholds.

## 15. Retry-exhaustion category masked the real cause

- **Symptom**: every retry abort grepped as `category=retry_exhausted`; claim, verifier, and divergence causes were only in text.
- **Root cause**: gate hard-coded the category for that abort site.
- **Diagnosis**: reviewed abort sites and category mapping helper.
- **Fix**: category now comes from `categoryForIssue(lastIssue.code)`; exhaustion moved to `counts {actual,limit}` and `detail` containing `retries exhausted (n/m)`.
- **Rule**: the category is the cause, not the mechanism; mechanism belongs in counts/detail.

## 16. `claim_text`/`evidence_ids` missing from abort lines

- **Symptom**: formatted line showed `claim=- evidence=-` for specific failures.
- **Root cause**: gate abort reason did not extract the offending claim; verifier abort did not carry the claim under test.
- **Diagnosis**: seam assertions showed empty fields.
- **Fix**: `offendingClaim(output, issue.path)` populates text/ids; verifier abort carries claim text; formatter escapes quotes/backslashes and uses `-` only for genuinely absent fields.
- **Rule**: a log line must identify the offending object, not just the failure class.

## 17. Model refusing to fabricate claims during testing

- **Symptom**: subagents declined "repeat this false done JSON" prompts, or self-corrected to `blocked`/`FALSE` after MCP feedback.
- **Root cause**: well-aligned models refuse explicit dishonesty; this is correct behavior, not a harness defect.
- **Diagnosis**: compared multiple prompts; only a real-work-with-omitted-evidence scenario produced a literal `done`, and even then the model revised after feedback.
- **Fix / mitigation**: seam tests with fixed model output (`tests/verifierGateSeam.test.ts`, `tests/fixedClaimGateSeam.test.ts`) prove the verifier→gate seam; real-model single-turn persistence documented as not reproducible.
- **Rule**: test code-level seams with fixed inputs; do not depend on a model to misbehave on demand.

## Lookalike failures

Same symptom, different cause — use the structured abort line to distinguish:

| Symptom | Possible causes | Distinguishing field |
|---|---|---|
| "gate aborted" | claim_invalid, evidence_missing, evidence_failed, verifier_failed, retry_exhausted mechanism, divergence limit, exporter_failed | `category=` + `counts=` + `detail=` in `[false-completion-gate] abort ...` |
| "no span in sink" | sink down, wrong endpoint, NodeSDK/global provider conflict, claim not parsed | sink `curl`; `OTLP endpoint` startup line; `parsed claim output status`; private-provider code |
| "MCP tool missing" | row disabled, `${WORKSPACE_ROOT}` path loop, npx fetch failure, browser/token absent | `--dump-config` row + `disabled`; startup `Secure MCP Filesystem Server running on stdio`; probe SKIP line |
| "tests pass but runtime fails" | profile cwd paths, stale installed bundle, pre-reload host code, DSH version drift | `--dump-config` resolved paths; installed `dist` mtime; HMR/config touch; `dsh --version` |
| "stale provenance" | work trace mislabeled as web, hard-coded session id | `evidence.profile`, `evidence.session.id`, process inventory |

## What we would do differently on a fresh environment

1. Verify `dsh --version` and the installed package `.d.ts` before writing any adapter; treat all hook names as unverified until booted.
2. Start the local OTLP sink first and keep it in a supervised launcher; health-check it before any gate test.
3. Create one clean profile; install the packed bundle once; inspect `--dump-config` for gate path and MCP rows before running a turn.
4. Use only `!!js` in patches; pin every npx package; pre-install them where the network is restricted.
5. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `DSH_ABORT_LOG` explicitly; never rely on defaults for either.
6. Use seam tests with fixed model output for gate/verifier behavior; use real DSH turns only to prove mounting, hooks, and telemetry.
7. Confirm attribution on the first span (`evidence.profile`, real session id) before drawing provenance conclusions.
8. Reuse one golden debug profile with `--patch` overlays; archive debug profiles instead of accumulating them.
9. Prefer `maxRetries: 0` for abort-path tests so retries cannot mask the cause; for real turns expect models to self-correct.
10. Re-run `pnpm test`, `pnpm run typecheck`, and `scripts/portability-smoke.sh` after any packaging change; read ASSUMPTIONS.md before changing config.
