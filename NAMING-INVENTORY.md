# NAMING-INVENTORY — external-facing names (pre-rename audit)

Read-only inventory. No renames are proposed here; this only records what exists,
where it is referenced, and whether external things depend on it.

Scope: bundle at `/home/hex636869/dsh/bundle` plus the launcher
`/home/hex636869/dsh/start_dsh.sh` (it reads bundle contracts).
Paths are relative to `bundle/` unless absolute.

Legend for **Contract**: `YES` = external code/config depends on it (renaming
requires coordinated change); `PARTIAL` = referenced by tests/docs only;
`NO` = internal, free to rename.

---

## 1. Package and product names

| Name | Layer | Where it appears | Contract | What it does |
|---|---|---|---|---|
| `false-completion-bundle` | product (npm package) | `package.json` `name`; `README.md:1` title was "False-completion plugin bundle"; `ASSUMPTIONS.md` (install commands); `/home/hex636869/.dsh/profiles/web/package.json` dependencies key | **YES** — installed into DSH profiles as this package name | The distributable package identity |
| `False-completion plugin bundle` (README H1) | product (display) | `README.md:1` | NO | Human-facing title |
| `dsh` (repo folder) | product (repo path) | repo root `/home/hex636869/dsh`; `start_dsh.sh:108` `TRIAGE_REPO="$HOME/dsh/TRIAGE.md"`; `ASSUMPTIONS.md` paths | **PARTIAL** — launcher hardcodes `~/dsh` | Repo directory name |
| `./profiles/minimal.yml` | config-key (`dsh.bundle.patch`) | `package.json` `dsh.bundle.patch`; `tests/packaging.test.ts:36`; `scripts/portability-smoke.sh`; `README.md` | **YES** — DSH loads this on install | Default patch layer |
| `false-completion-bundle/dist/entry/index.js` | plugin-row name (resolved) | emitted by Loader; asserted in `tests/packaging.test.ts`, `AUDIT.md`, `POSTMORTEM.md` | PARTIAL | Resolved gate entry path |

## 2. Plugin rows

Row ids are patch keys; `serverName` values become MCP tool names
(`mcp__<serverName>__<tool>`).

| Name | Layer | Where it appears | Contract | What it does |
|---|---|---|---|---|
| `false-completion-gate` | plugin-row | `profiles/minimal.yml:8`, `profiles/standard.yml:9`, `profiles/strict-best-effort.yml:6`, `cordis.patch.yml:10`, `gate.patch.yml:12`; `README.md`; `AUDIT.md`; `tests/packaging.test.ts` | **YES** — patch id | Mounts the gate plugin entry |
| `false-completion-filesystem-mcp` | plugin-row | `profiles/minimal.yml:12`, `profiles/standard.yml:12`, `profiles/strict-best-effort.yml:9`, `cordis.patch.yml:16`; `README.md`; `AUDIT.md` | **YES** — patch id | Filesystem MCP client row |
| `false-completion-playwright-mcp` | plugin-row | `profiles/minimal.yml:27`, `profiles/standard.yml:26`, `profiles/strict-best-effort.yml:25`, `cordis.patch.yml:28` | **YES** — patch id | Playwright MCP client row |
| `false-completion-github-mcp` | plugin-row | `profiles/minimal.yml:38`, `profiles/standard.yml:50`, `profiles/strict-best-effort.yml:49`, `cordis.patch.yml:55` | **YES** — patch id | GitHub MCP client row (always disabled here) |
| `false-completion-python-mcp` | plugin-row | `profiles/minimal.yml:52`, `profiles/standard.yml:38`, `profiles/strict-best-effort.yml:36`, `cordis.patch.yml:43`; `ASSUMPTIONS.md:158` | **YES** — patch id | Python grounding MCP client row |
| `false-completion-filesystem` | plugin-row (`serverName`) | `profiles/minimal.yml:15`, `profiles/standard.yml:15`, `profiles/strict-best-effort.yml:12`, `cordis.patch.yml:19`; tool name in `AUDIT.md:154`, `ASSUMPTIONS.md:189` | **YES** — becomes `mcp__false-completion-filesystem__*` | MCP server namespace |
| `false-completion-playwright` | plugin-row (`serverName`) | `profiles/minimal.yml:31`, `profiles/standard.yml:30`, `profiles/strict-best-effort.yml:29`, `cordis.patch.yml:31` | **YES** — tool namespace | MCP server namespace |
| `false-completion-github` | plugin-row (`serverName`) | `profiles/minimal.yml:42`, `profiles/standard.yml:54`, `profiles/strict-best-effort.yml:53`, `cordis.patch.yml:59` | **YES** — tool namespace | MCP server namespace |
| `false-completion-python` | plugin-row (`serverName`) | `profiles/minimal.yml:56`, `profiles/standard.yml:42`, `profiles/strict-best-effort.yml:40`, `cordis.patch.yml:46`; `ASSUMPTIONS.md:158,222` | **YES** — becomes `mcp__false-completion-python__verify_claim` | MCP server namespace |
| `false-completion-ledger` / `false-completion-suspend` / `false-completion-verifier` | plugin-row (reference-only) | `gate.patch.yml:6,19`, `verifier.patch.yml:27` — **never loaded by any profile** | NO (non-live snippets) | Historical reference rows |
| `dsh-false-completion-plugin` | plugin-row/config (OTel `serviceName`) | `gate.patch.yml:9`; `src/adapters/ledgerAdapter.ts:166`; `src/telemetry/otelExporter.ts:158` | **PARTIAL** — appears as OTel `service.name`; also `OTEL_SERVICE_NAME` override | Service name reported to the trace backend |

## 3. Internal modules (filenames on disk; not user-facing APIs)

| Name | Layer | Where it appears | Contract | What it does |
|---|---|---|---|---|
| `claimGuard` | internal-module | `src/schema/claimGuard.ts`; imported by `src/gate/completionGate.ts`, `src/telemetry/verifierProbe.ts`, `entry/index.ts`; tests: `claimGuard`, `endToEnd`, `verifierGateSeam`, `fixedClaimGateSeam`, `packaging`; appears in probe text `claimGuard + ...` (`src/telemetry/verifierProbe.ts:103`; `README.md`) | NO (but the string shows in the probe line) | Evidence/claim validation |
| `completionGate` | internal-module | `src/gate/completionGate.ts`; `entry/index.ts`; `gate.patch.yml:13`; tests `completionGate`, `gateLimits`, `abortReason`, `verifierGateSeam`, `fixedClaimGateSeam`, `endToEnd` | NO | Turn-completion decision + limits |
| `ledgerAdapter` | internal-module | `src/adapters/ledgerAdapter.ts`; `entry/index.ts`; `gate.patch.yml:7`; tests `ledgerAdapter`, `abortReason`, `verifierGateSeam`, `fixedClaimGateSeam`, `repetitionGuard`, `claimGuard`, `endToEnd` | NO | Redaction, hashing, span emission |
| `verifierDispatcher` | internal-module | `src/verifier/verifierDispatcher.ts`; `verifier.patch.yml:28`; `promptfoo/fixtures.mjs`; tests `verifierDispatcher`, `endToEnd`, `pythonMcpVerifier`, `verifierGateSeam` | NO | Routes claims to verifiers |
| `otelExporter` | internal-module | `src/telemetry/otelExporter.ts`; imported by `src/adapters/ledgerAdapter.ts`; test `fixedClaimGateSeam` | NO | Private tracer provider + OTLP |
| `repetitionGuard` | internal-module | `src/adapters/repetitionGuard.ts`; test `repetitionGuard` | NO | Read-only repeat detection |
| `abortReason` | internal-module | `src/gate/abortReason.ts`; `src/gate/completionGate.ts`; `src/gate/abortLog.ts`; `entry/index.ts`; tests `abortReason`, `abortLogSink`, `verifierGateSeam`, `fixedClaimGateSeam` | NO | Categories + pure formatter |
| `abortLog` | internal-module | `src/gate/abortLog.ts`; `entry/index.ts`; test `abortLogSink` | NO | stderr + `DSH_ABORT_LOG` sink |
| `verifierProbe` | internal-module | `src/telemetry/verifierProbe.ts`; `entry/index.ts`; test `packaging` | NO | Startup availability probe |
| `suspendAdapter` | internal-module | `src/gate/suspendAdapter.ts`; `entry/index.ts`; `gate.patch.yml:20`; tests `completionGate`, `gateLimits`, `abortReason`, `verifierGateSeam`, `fixedClaimGateSeam`, `endToEnd` | NO | Suspension records/reason |

## 4. Config keys

| Name | Layer | Where it appears | Contract | What it does |
|---|---|---|---|---|
| `maxRetries` | config-key | `src/gate/completionGate.ts` (type + logic); `entry/index.ts` env `FALSE_COMPLETION_MAX_RETRIES`; `README.md`; `ASSUMPTIONS.md`; `tests/*` (38 refs); `profiles/minimal.yml:6` comment | **YES** | Invalid-output tolerance before suspend |
| `maxStepsPerTurn` | config-key | `src/gate/completionGate.ts`; `tests/gateLimits.test.ts`; `tests/abortReason.test.ts`; `README.md` "Divergence defaults" | **YES** | Step budget (default 20) |
| `maxToolCallsPerTurn` | config-key | same as above | **YES** | Tool-call budget (default 30) |
| `maxConsecutiveNoProgressSteps` | config-key | same as above | **YES** | No-progress streak (default 3) |
| `requireVerifierPass` | config-key (documented only) | `profiles/minimal.yml:7` comment only — **no code reference** | NO (not implemented) | Claimed default in comment; not read anywhere |
| `onExhausted` | config-key (documented only) | `profiles/minimal.yml:6` comment only — **no code reference** | NO (not implemented) | Describes suspend behavior; not a real key |
| `basePath` | config-key | **0 references** anywhere in repo | NO (does not exist) | Listed in the audit brief; absent from code/config |
| `manageSink` | config-key | **0 references** anywhere in repo | NO (does not exist) | Listed in the audit brief; absent from code/config |

## 5. Log prefixes and line format

| Name | Layer | Where it appears | Contract | What it does |
|---|---|---|---|---|
| `[false-completion-gate]` | log-prefix | `src/gate/abortReason.ts:91`, `src/gate/abortLog.ts:20`, `entry/index.ts:72,79,90,94,100,176`; `README.md`; `AUDIT.md`; `POSTMORTEM.md`; `TRIAGE.md` | **YES** — grep target in docs and triage | Prefix for gate lines |
| `[false-completion-bundle]` | log-prefix | `src/telemetry/verifierProbe.ts:93,103`; `README.md`; `AUDIT.md` | PARTIAL | Prefix for probe block |
| `category=` | log-field | `src/gate/abortReason.ts:66,91`; `README.md`; `TRIAGE.md`; `AUDIT.md`; `tests/abortReason.test.ts`, `fixedClaimGateSeam.test.ts` | **YES** — grep contract (`grep "category=verifier_failed"`) | Abort category field |
| `claim=` | log-field | `src/gate/abortReason.ts:84`; `README.md`; `TRIAGE.md`; `tests/abortReason.test.ts` | **YES** | Offending claim text |
| `evidence=` | log-field | `src/gate/abortReason.ts:85`; `README.md`; tests | **YES** | Cited evidence ids |
| `verifier=` | log-field | `src/gate/abortReason.ts:86-88`; `README.md`; tests | **YES** | Verifier type:detail |
| `counts=` | log-field | `src/gate/abortReason.ts:89`; `README.md`; tests | **YES** | actual/limit |
| `profile=` | log-field | `entry/index.ts:72`; `README.md`; `AUDIT.md` | PARTIAL | Startup attribution line |
| `session=` | log-field (trace attribute value shown) | `AUDIT.md`; `POSTMORTEM.md`; sink output | PARTIAL | Session shown in trace inspection |
| `detail=` | log-field | `src/gate/abortReason.ts:90`; `README.md`; tests | **YES** | Free-text reason |

## 6. Environment variables

| Name | Layer | Where it appears | Contract | What it does |
|---|---|---|---|---|
| `DSH_ABORT_LOG` | env-var | `src/gate/abortLog.ts:13`; `/home/hex636869/dsh/start_dsh.sh` (default path); `tests/abortLogSink.test.ts`; `README.md`; `AUDIT.md`; `POSTMORTEM.md` | **YES** — launcher + bundle + tests | Optional append-only abort log file |
| `DSH_REPEATED_TOOL_CALLS_JSON` | env-var | `scripts/metrics.mjs` only | **YES** (metrics contract) | In-memory repeat counts for metrics |
| `DSH_DIVERGED_TURNS_JSON` | env-var | `scripts/metrics.mjs`; `README.md` | **YES** (metrics contract) | In-memory divergence counts |
| `DSH_FALSE_COMPLETION_PLAYWRIGHT` | env-var | `entry/index.ts`; `profiles/minimal.yml:29`, `profiles/standard.yml:28`, `profiles/strict-best-effort.yml:27`; `README.md`; `AUDIT.md` | **YES** — read by patch `!!js` guards | Enables Playwright row |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | env-var | `src/telemetry/otelExporter.ts`; `entry/index.ts:72`; `gate.patch.yml:10`; `ASSUMPTIONS.md`; `README.md`; `POSTMORTEM.md` | **YES** — standard OTel contract | Trace export endpoint |
| `DSH_PROFILE` | env-var | `entry/index.ts` (fallback for attribution); `POSTMORTEM.md`; launcher uses its own `DSH_PROFILE_LAUNCH` | PARTIAL — standard DSH-ish name, read as fallback | Profile attribution fallback |
| `FALSE_COMPLETION_MAX_RETRIES` | env-var | `entry/index.ts`; `ASSUMPTIONS.md`; `README.md`; `POSTMORTEM.md` | **YES** — real config input | Retry budget |
| `AUDIT_REDACT_KEYS` | env-var | `src/adapters/ledgerAdapter.ts`; `README.md` | **YES** | Extra redaction keys |
| `VERIFIER_BACKEND` | env-var | `entry/index.ts`; profiles; `verifier.patch.yml`; `python/mcp_verifier/test_server.py`; `README.md` | **YES** — Python verifier contract | Selects ragas/trulens/deepeval |
| `GITHUB_TOKEN` | env-var | `entry/index.ts`; profiles (guards/env); `tests/packaging.test.ts`; `ASSUMPTIONS.md` | **YES** | GitHub MCP credential |
| `OTEL_SERVICE_NAME` | env-var | `src/telemetry/otelExporter.ts`; `ASSUMPTIONS.md`; `README.md` | **YES** — standard OTel | Overrides service.name |

## 7. Trace attributes / span names

| Name | Layer | Where it appears | Contract | What it does |
|---|---|---|---|---|
| `tool.call.evidence` | trace-attribute (span name) | `src/adapters/ledgerAdapter.ts`; `tests/fixtures/otel/86921db8…json`, `eca7609…json`; `tests/otelTraceShape.test.ts`; `ASSUMPTIONS.md`; `README.md`; `AUDIT.md` | **YES** — fixtures + tests assert it | Span name for one evidence emission |
| `evidence.ref` | trace-attribute | `src/adapters/ledgerAdapter.ts`; `tests/otelTraceShape.test.ts`; both fixtures; `ASSUMPTIONS.md`; `README.md` | **YES** — consumed by tests + correlation docs | Stable evidence id on the span |
| `evidence.profile` | trace-attribute | `src/adapters/ledgerAdapter.ts`; `tests/ledgerAdapter.test.ts`; `AUDIT.md`; `POSTMORTEM.md` | **YES** — attribution test asserts it | Profile name |
| `evidence.session.id` | trace-attribute | `src/adapters/ledgerAdapter.ts`; both fixtures; `tests/ledgerAdapter.test.ts`; `tests/otelTraceShape.test.ts`; `ASSUMPTIONS.md`; `README.md` | **YES** | Real session identity |
| `evidence.repeated` | trace-attribute | `src/adapters/ledgerAdapter.ts:237`; `tests/repetitionGuard.test.ts` | **YES** — repetition test asserts it | Marks a cached repeat |
| `evidence.snapshot` | trace-attribute | `src/adapters/ledgerAdapter.ts`; both fixtures; `tests/otelTraceShape.test.ts`; `ASSUMPTIONS.md`; `README.md` | **YES** — required by trace-shape test | JSON string side-effect snapshot |
| `evidence.args.hash` / `evidence.result.hash` / `evidence.exit_code` / `evidence.timestamp` / `evidence.error.name` / `evidence.error.code` / `evidence.redacted_fields` | trace-attribute | `src/adapters/ledgerAdapter.ts`; both fixtures; `tests/otelTraceShape.test.ts` | **YES** — asserted set | Evidence detail attributes |

## 8. Doc filenames

| Name | Layer | Where it appears | Contract | What it does |
|---|---|---|---|---|
| `README.md` | doc-filename | `package.json` `files`; `tests/fixedClaimGateSeam.test.ts`, `tests/packaging.test.ts` (read it); `ASSUMPTIONS.md`; `AUDIT.md` | **YES** — tests read it | Operator quick start + reference |
| `ASSUMPTIONS.md` | doc-filename | `package.json` `files`; `README.md`; `AUDIT.md`; `POSTMORTEM.md`; `src/adapters/adapters.d.ts` comment | PARTIAL — docs + one code comment | Confirmed APIs / open assumptions |
| `AUDIT.md` | doc-filename | `POSTMORTEM.md`; `TRIAGE.md` footer | PARTIAL | Current-state audit |
| `POSTMORTEM.md` | doc-filename | `AUDIT.md`; `TRIAGE.md` footer | PARTIAL | Incident history |
| `TRIAGE.md` | doc-filename | `/home/hex636869/dsh/start_dsh.sh:108-109,112` (`TRIAGE_REPO`, `TRIAGE_HOME`) | **YES** — launcher copies it | Standalone triage card |
| `OTEL-LOCAL-SINK.md` | doc-filename | **not in repo**; exists only at `/home/hex636869/.dsh/profiles/web/OTEL-LOCAL-SINK.md` | NO (out-of-repo) | Local sink notes |

## 9. Flags

### 9a. Technical-only names exposed to users

- `claimGuard` — appears in the user-visible probe line `active gate: claimGuard + filesystem` (`src/telemetry/verifierProbe.ts:103`, `README.md`). Users see an internal module name.
- `filesystem` / `python` / `playwright` / `github` — probe labels are verifier category names, not the `false-completion-*` row names; the mapping is implicit (`src/telemetry/verifierProbe.ts`).
- `OTelEvidenceExporter`, `BasicTracerProvider`, `SimpleSpanProcessor` — only in `README.md`/source, but surfaced by error strings like `EvidenceExportError: OTLP evidence export failed` (`src/telemetry/otelExporter.ts`).
- `tool.call.evidence` — a span name users grep in traces; reads like an API identifier.

### 9b. Names appearing in more than one layer (drift risk)

- `false-completion-*` prefix is used for **row ids**, **serverName / MCP tool prefixes**, **package name**, **OTel serviceName (`dsh-false-completion-plugin`)**, and **log prefix (`[false-completion-gate]` / `[false-completion-bundle]`)**. Renaming the prefix touches patches, tool names, docs, and tests.
- `evidence.*` spans two layers: trace attributes and the `evidence=` log field. They are related but not the same namespace.
- `profile` appears as trace attribute `evidence.profile`, log field `profile=`, env fallback `DSH_PROFILE`, and launcher variable `DSH_PROFILE_LAUNCH` (four spellings of one concept).
- `session` appears as `evidence.session.id` (attribute), `session=` (log), and `sessionId` (campaign/config field).
- `abort` appears as the decision kind `kind:'abort'`, the log word `abort`, and module names `abortReason` / `abortLog`.
- `maxRetries` is both a TypeScript config field and the `FALSE_COMPLETION_MAX_RETRIES` env var.

### 9c. Do-not-rename list (stable external contracts)

1. **Trace attributes** — `tool.call.evidence`, `evidence.ref`, `evidence.profile`, `evidence.session.id`, `evidence.repeated`, `evidence.snapshot`, `evidence.args.hash`, `evidence.result.hash`, `evidence.exit_code`, `evidence.timestamp`, `evidence.error.name`, `evidence.error.code`, `evidence.redacted_fields`. Consumed by `tests/otelTraceShape.test.ts`, `tests/ledgerAdapter.test.ts`, `tests/repetitionGuard.test.ts`, and the two captured fixtures. Renaming breaks tests and invalidates stored traces.
2. **Env vars** — `DSH_ABORT_LOG`, `DSH_REPEATED_TOOL_CALLS_JSON`, `DSH_DIVERGED_TURNS_JSON`, `DSH_FALSE_COMPLETION_PLAYWRIGHT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `VERIFIER_BACKEND`, `GITHUB_TOKEN`, `AUDIT_REDACT_KEYS`, `OTEL_SERVICE_NAME`, `FALSE_COMPLETION_MAX_RETRIES`. Read by the launcher, metrics script, profile `!!js` guards, and Python server; user environments already set some.
3. **Plugin row ids and `serverName` values** — `false-completion-gate`, `false-completion-{filesystem,playwright,github,python}-mcp`, and `serverName: false-completion-{filesystem,playwright,github,python}`. Row ids are patch targets; `serverName` becomes `mcp__<serverName>__<tool>`, which the model and docs already reference (`ASSUMPTIONS.md:158,189,222`, `AUDIT.md:154`).
4. **Log grep contract** — `[false-completion-gate]`, `category=`, `claim=`, `evidence=`, `verifier=`, `counts=`, `detail=`. Documented as grep targets in `README.md` and `TRIAGE.md`; `tests/abortReason.test.ts` asserts the exact prefix and field order.
5. **`dsh.bundle.patch` value** — `./profiles/minimal.yml`; asserted by `tests/packaging.test.ts` and used by `scripts/portability-smoke.sh`.
6. **Package name** `false-completion-bundle` — installed into DSH profiles; changing it requires reinstalling every profile.
7. **`OTEL_SERVICE_NAME` default** `dsh-false-completion-plugin` — appears in exported spans; changing it splits trace history in the backend.
8. **`TRIAGE.md` filename** — the launcher copies it to `~/.dsh/TRIAGE.md`; renaming silently stops the copy.

### 9d. Names that look like config but are not implemented

`requireVerifierPass` and `onExhausted` appear only in a `profiles/minimal.yml` comment; `basePath` and `manageSink` appear nowhere. Treat all four as **non-contracts** — do not document them as real keys, and do not assume renaming them would change behavior.
