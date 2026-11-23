# NAMING-DECISIONS — target naming scheme

Decisions derived from `NAMING-INVENTORY.md`. **No renames applied.** This file
only records what would change, in what order, and at what cost.

Constraint summary: every name in the inventory's §9c do-not-rename list is
frozen. The `false-completion-*` prefix is decided **per layer**, never as one
global rename. Ghost config keys are handled in §8, not in the rename map.
The four profile spellings are kept and explained in §5.

---

## 1. Product name

The npm package name `false-completion-bundle` is frozen (§4.6), so "product
name" can only mean the **display name** used in docs and prose (today:
`README.md:1` → "False-completion plugin bundle").

| Role | Candidate | Rationale |
|---|---|---|
| **Chosen** | `false-completion-bundle` | Identical string to the frozen package name, so `grep -r false-completion-bundle` finds code, profiles, docs and install commands in one pass. No second spelling to drift. |
| Alternative (rejected) | `evidence-gated-completion` | More descriptive of the mechanism, but it anchors to nothing in code or config; every doc mention would need a manual mapping and greps would miss it. Rejected on grep-ability. |

Decision: **use `false-completion-bundle` everywhere a display name is needed**
(README H1, doc prose). Kill the current hyphenation drift "False-completion
plugin bundle" (spaces + different word order) because it does not grep with the
package name.

Migration cost: docs-only. References: `README.md:1`, prose in `AUDIT.md`,
`POSTMORTEM.md`, `TRIAGE.md`. No code, no config, no tests.

---

## 2. Per-layer mapping table

| Layer | Current name | Target | Reason | References to update | Migration risk |
|---|---|---|---|---|---|
| Product display | `False-completion plugin bundle` | `false-completion-bundle` | Match frozen package name; single grep token | `README.md:1`, prose in `AUDIT.md`, `POSTMORTEM.md`, `TRIAGE.md` | none (docs only) |
| Package name | `false-completion-bundle` | **keep** | Frozen: installed into DSH profiles | — | — |
| Plugin row ids | `false-completion-{gate,filesystem-mcp,playwright-mcp,github-mcp,python-mcp}` | **keep** | Frozen: patch ids | — | — |
| `serverName` / `mcp__` tool names | `false-completion-{filesystem,playwright,github,python}` | **keep** | Frozen: becomes `mcp__<serverName>__<tool>`, referenced in docs | — | — |
| OTel `serviceName` default | `dsh-false-completion-plugin` | **keep** | Frozen: appears in exported spans; renaming splits backend trace history | — | — |
| Gate log prefix | `[false-completion-gate]` | **keep** | Frozen grep contract; asserted by `tests/abortReason.test.ts` | — | — |
| Probe log prefix | `[false-completion-bundle]` | **keep** | Not frozen, but already equals the package name — renaming buys nothing and would break `AUDIT.md` greps | — | none (no change) |
| Resolved entry path | `dist/entry/index.js` | **keep** | Derived from `tsconfig.bundle.json` + patch; renaming requires touching build config and every profile | — | requires real-DSH verification if changed |
| Internal module filenames | `claimGuard`, `completionGate`, `ledgerAdapter`, `verifierDispatcher`, `otelExporter`, `repetitionGuard`, `abortReason`, `abortLog`, `verifierProbe`, `suspendAdapter` | **keep** | Not ambiguous; camelCase file names are already consistent and greppable; `claimGuard` also appears in the user-visible probe line, so a rename has one external edge | `src/**`, `tests/**`, `entry/index.ts`, `gate.patch.yml`, `verifier.patch.yml`, `promptfoo/fixtures.mjs` | low but non-zero: 40+ files, plus the probe string |
| Config keys | see §6 | mostly **keep** | — | — | — |
| Ghost keys | see §8 | **excluded** | Not implemented | — | — |

Nothing in this table proposes a global `false-completion-*` rename.

---

## 3. Prefix decision per layer

| # | Layer | Decision | Justification | Verification required |
|---|---|---|---|---|
| 1 | Package name | **keep** | Frozen contract; changing forces reinstall of every profile | — |
| 2 | Plugin row ids | **keep** | Frozen patch targets; wrong row id silently skips the layer | — |
| 3 | `serverName` → `mcp__` tool names | **keep** | Model prompts and docs already cite `mcp__false-completion-python__verify_claim`; renaming requires a live MCP tool-call proof per row | If ever renamed: boot a real DSH profile, call each `mcp__<new>__*` tool, confirm the model sees it |
| 4 | OTel `serviceName` default | **keep** | Splits trace history; backend dashboards key on it | — |
| 5 | Gate log prefix `[false-completion-gate]` | **keep** | Frozen grep contract + exact-order assertion in tests | — |
| 6 | Probe log prefix `[false-completion-bundle]` | **keep** | Already matches package name; no drift to fix | — |

No layer is proposed as `rename-with-verification-required`; the only hypothetical
(serverName) is explicitly gated behind a real MCP call proof above.

---

## 4. Keep-unchanged (exhaustive — mirrors inventory §9c exactly)

Anything not listed here is fair game. This list has the same 8 items and the
same contents as the inventory; nothing added, nothing omitted.

1. **Trace attributes and span name** — `tool.call.evidence`, `evidence.ref`,
   `evidence.profile`, `evidence.session.id`, `evidence.repeated`,
   `evidence.snapshot`, `evidence.args.hash`, `evidence.result.hash`,
   `evidence.exit_code`, `evidence.timestamp`, `evidence.error.name`,
   `evidence.error.code`, `evidence.redacted_fields`.
   Why: consumed by `tests/otelTraceShape.test.ts`, `tests/ledgerAdapter.test.ts`,
   `tests/repetitionGuard.test.ts`, and the captured fixtures
   `tests/fixtures/otel/86921db8….json`, `eca7609….json`; renaming breaks tests
   and invalidates stored traces.
2. **Env vars** — `DSH_ABORT_LOG`, `DSH_REPEATED_TOOL_CALLS_JSON`,
   `DSH_DIVERGED_TURNS_JSON`, `DSH_FALSE_COMPLETION_PLAYWRIGHT`,
   `OTEL_EXPORTER_OTLP_ENDPOINT`, `VERIFIER_BACKEND`, `GITHUB_TOKEN`,
   `AUDIT_REDACT_KEYS`, `OTEL_SERVICE_NAME`, `FALSE_COMPLETION_MAX_RETRIES`.
   Why: read by the launcher, `scripts/metrics.mjs`, profile `!!js` guards and
   `python/mcp_verifier/server.py`; users already set some.
3. **Plugin row ids and `serverName` values** — `false-completion-gate`,
   `false-completion-{filesystem,playwright,github,python}-mcp`, and
   `serverName: false-completion-{filesystem,playwright,github,python}`.
   Why: row ids are patch targets; `serverName` becomes `mcp__<serverName>__<tool>`
   and is cited in `ASSUMPTIONS.md:158,189,222` and `AUDIT.md:154`.
4. **Log grep contract** — `[false-completion-gate]`, `category=`, `claim=`,
   `evidence=`, `verifier=`, `counts=`, `detail=`.
   Why: documented grep targets in `README.md`/`TRIAGE.md`; `tests/abortReason.test.ts`
   asserts the prefix and exact field order.
5. **`dsh.bundle.patch` value** — `./profiles/minimal.yml`.
   Why: asserted by `tests/packaging.test.ts`, used by `scripts/portability-smoke.sh`.
6. **Package name** — `false-completion-bundle`.
   Why: installed into DSH profiles; a change requires reinstalling each profile.
7. **`OTEL_SERVICE_NAME` default** — `dsh-false-completion-plugin`.
   Why: appears in exported spans; renaming splits trace history.
8. **`TRIAGE.md` filename**.
   Why: `start_dsh.sh:108-109` copies it to `~/.dsh/TRIAGE.md`; renaming silently
   stops the copy.

---

## 5. Log line: final shape and the four profile spellings

**Frozen abort line shape** (`src/gate/abortReason.ts:84-91`):

```
[false-completion-gate] abort category=<cat> claim=<"…"|-> evidence=<ids|-> verifier=<type:"detail"|-> counts=<n/m|-> detail="<text>"
```

Fixed field names (frozen, §4.4): `category`, `claim`, `evidence`, `verifier`,
`counts`, `detail`. Field **order** is also asserted by
`tests/abortReason.test.ts`; do not reorder.

Free (not part of the frozen grep contract):

- `profile=` — a startup line field (`entry/index.ts:72`), not part of the abort line.
- `session=` — appears only in trace inspection prose, not in the abort line.

Supported grep examples (must keep working):

```bash
grep 'category=claim_invalid'      "$DSH_ABORT_LOG"
grep 'category=verifier_failed'    "$DSH_ABORT_LOG"
grep 'category=exporter_failed'    "$DSH_ABORT_LOG"
grep 'category=no_progress_exceeded' "$DSH_ABORT_LOG"
grep 'category=step_budget_exceeded' "$DSH_ABORT_LOG"
grep 'category=tool_call_budget_exceeded' "$DSH_ABORT_LOG"
grep -c 'category=' "$DSH_ABORT_LOG"     # one line per aborted turn
```

### The four profile spellings — keep all four, do not unify

| Spelling | Role | Where | Why it must not be merged |
|---|---|---|---|
| `evidence.profile` | **data contract** (trace attribute) | `src/adapters/ledgerAdapter.ts`; asserted in `tests/ledgerAdapter.test.ts` | Backend/trace consumer contract; renaming invalidates stored spans |
| `profile=` | **log projection** of the same value | `entry/index.ts:72` startup line | Operator-facing startup diagnostic; distinct from abort-line fields |
| `DSH_PROFILE` | **env fallback** when `profileContext.name` is unavailable | `entry/index.ts` | Standard-ish DSH env name; also read by other tooling |
| `DSH_PROFILE_LAUNCH` | **launcher variable** (this repo's own) | `start_dsh.sh:18,100,122,136,143` | Owned by the launcher, not by the bundle; carries the profile this launch boots |

Hierarchy: launcher decides `DSH_PROFILE_LAUNCH` → DSH provides
`profileContext.name` → bundle falls back to `DSH_PROFILE` → value is emitted as
trace attribute `evidence.profile` and logged as `profile=`. Each is a different
role at a different layer; no concrete breakage justifies merging them.

---

## 6. Config keys (renames only where ambiguous or implementation-leaking)

| Key | Decision | Reason | Migration risk |
|---|---|---|---|
| `maxRetries` | **keep** | Clear, unitless but conventional | none |
| `maxStepsPerTurn` | **keep** | Unambiguous, names the unit and scope | none |
| `maxToolCallsPerTurn` | **keep** | Unambiguous | none |
| `maxConsecutiveNoProgressSteps` | **keep** | Long but precise; shortening would hide "consecutive" | none |
| `LedgerConfig.redactKeys` / `additionalRedactKeys` | **keep** | Clear | none |
| `LedgerConfig.profileId` | **keep** (flag only) | Internal field named `profileId` while the emitted attribute is `evidence.profile`; a mild cross-layer inconsistency, but it is a TS interface field, not user config. Renaming touches `src/adapters/ledgerAdapter.ts` + `entry/index.ts` only. Recommend documenting the mapping rather than renaming now. | low (2 files) |
| `LedgerConfig.sessionId` | **keep** (flag only) | Same shape as above vs `evidence.session.id` | low |
| `RepetitionOptions.allowlist` / `recordRepetition` | **keep** | Clear | none |

No key in this section is ambiguous enough to justify renaming today. Nothing
here leaks implementation words to users; the ghost keys are in §8.

---

## 7. Rename order (avoids touching the same file twice)

Because every contract layer is frozen, the only *optional* renames left are
(a) the docs display name and (b) the probe prefix / internal filenames if ever
pursued. Order, cheapest-and-innermost first:

1. **Internal modules** (if ever) — `src/**` + `tests/**` + `entry/index.ts` imports.
   Touches only TypeScript.
2. **Probe log prefix** (if ever) — `src/telemetry/verifierProbe.ts` + `AUDIT.md`.
3. **Plugin row ids** — FROZEN, skipped. (Would otherwise be next because
   profiles and `cordis.patch.yml` both name them.)
4. **Package name** — FROZEN, skipped. (Would otherwise force profile reinstalls.)
5. **Docs display name** — `README.md`, `AUDIT.md`, `POSTMORTEM.md`, `TRIAGE.md`.

Why this order: steps 1–2 live entirely under `src/` + `tests/`; step 5 touches
only Markdown. Doing docs last means the display name is written once, after all
code-adjacent strings are final, so no Markdown file is edited twice. The frozen
layers (3, 4) are skipped rather than sequenced, precisely because renaming them
would force re-touching profiles and reinstalls after the docs were already
updated — the one ordering that guarantees a file is never opened twice.

If a frozen layer ever *did* change, it would have to go **first** (before docs),
because row ids and package name appear inside install commands quoted in docs.

---

## 8. Doc debt: remove or implement

### 8a. Ghost config keys (excluded from §6 and §2)

| Key | Where | Reality | Recommended action |
|---|---|---|---|
| `requireVerifierPass` | `profiles/minimal.yml:7` comment only | Not read by any code | **Delete from the comment.** The gate already requires evidence; a separate flag would be a second policy path. If a team truly needs a disable switch, implement it as a real `CompletionGateConfig` field with a test — do not leave it as prose. |
| `onExhausted` | `profiles/minimal.yml:6` comment only | Not read by any code; suspension is unconditional on exhaustion | **Delete from the comment** and state "on exhaustion the gate always suspends". Implementing it would add a second abort mode, which conflicts with "no second abort path". |
| `basePath` | Nowhere in repo | Does not exist | **Remove from any external checklist/doc that implies it.** If a path base is ever needed, the confirmed mechanism is `!!js process.cwd()` in the profile — document that instead. |
| `manageSink` | Nowhere in repo | Does not exist | **Remove.** Sink lifecycle is owned by the launcher (`scripts/start-otlp-local-sink.sh`), not by a bundle config key. |

### 8b. Other stale references found

| Stale item | Where | Why stale | Action |
|---|---|---|---|
| Two different `maxRetries` defaults | `profiles/minimal.yml:6` says `maxRetries=1`; `CompletionGateConfig` defaults to `2`; entry env default is `1` | The profile comment describes the entry's env default, but the TS type default differs — a reader cannot tell which applies | **Document the precedence** in README: env (`FALSE_COMPLETION_MAX_RETRIES`) → gate default 2; the profile comment's `1` only reflects the launcher-era env default. Prefer one documented default. |
| "This session did NOT install it" / MCP rows "declarative but not live" | `ASSUMPTIONS.md:158` | The bundle has since been installed into `web`/`work` and MCP rows are live | **Mark resolved** (or delete the unresolved paragraph) so it does not read as a live blocker. |
| Removed debug profiles named as if current | `ASSUMPTIONS.md:175,184,222,239-241` (`smoke2`, `pycheck`; `smoke3` kept) | `smoke2`/`pycheck`/`hygiene` were deleted in the hygiene step; only `smoke3` remains | **Annotate** those sections as historical; keep `smoke3` as the golden reference. |
| `verifier.patch.yml` / `gate.patch.yml` described as authoritative-sounding | `ASSUMPTIONS.md:157`, `NAMING-INVENTORY.md:42` | They are never loaded by any profile | Keep as reference snippets but **rename the prose** to "non-loaded reference" consistently (already partly done). |
| README "Divergence defaults" table has no `#configuration` anchor link from profiles | `profiles/minimal.yml:7` → `README#configuration` | The anchor exists (`README.md:92 ## Configuration`) but the comment also cites defaults that live in the divergence section | **Point the comment at both anchors** (`#configuration`, `#divergence-defaults`) or simplify the comment to one line. |
| `OTEL-LOCAL-SINK.md` documented as if part of the repo | `NAMING-INVENTORY.md` §8 | It exists only at `~/.dsh/profiles/web/OTEL-LOCAL-SINK.md` | **State its location explicitly** in docs, or move the content into `README.md` so it ships. |

---

## Summary of what changes vs what does not

- **Changes (optional, docs-only):** display name → `false-completion-bundle`;
  four ghost-key comments deleted; stale ASSUMPTIONS paragraphs annotated.
- **Does not change:** package name, all plugin row ids, all `serverName`
  values, `dsh.bundle.patch`, `OTEL_SERVICE_NAME` default, every trace
  attribute and the span name, the 10 env vars, the gate log prefix and its six
  fields, `TRIAGE.md`, and all four profile spellings.
- **Migration cost:** none for anything in this document; the only non-trivial
  hypothetical (serverName) is gated behind a real MCP tool-call verification.
