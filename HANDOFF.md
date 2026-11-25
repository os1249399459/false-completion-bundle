# HANDOFF — false-completion-bundle + environment state

Written 2026-11-23 ~17:00 (Asia/Shanghai). Verified against the live system at
write time. Where your brief and the system disagreed, **the system wins and the
delta is flagged** (see §5). Read §5 first if you are resuming quickly.

---

## 1. Environment & system state

### DSH host

| Item | Value |
|---|---|
| Process | pid 316283/316284, `sh -c dsh web` + `node .../bin/dsh web` |
| Started | 2026-11-22 18:38:17 (~22h uptime at write time) |
| GUI | http://127.0.0.1:3080 (HTTP 401 = auth required, i.e. alive) |
| DSH version | 0.2.1-rc.5 |
| Checkout | `/home/hex636869/.npm/_npx/b5e10b118beccd0f/` (npx install, not a source clone) |

**The host needs a restart** — see §3, but note it has already been up 22h and
survived the plugin installs below.

### `web` profile

| Item | Verified value |
|---|---|
| Profile dir | `~/.dsh/profiles/web/` |
| Bundle | `false-completion-bundle` **0.1.9**, installed 2026-11-25 18:24. Published to npm this day with SLSA provenance (see §9) |
| `dsh-memory-palace` | declared **1.8.6**, installed **1.8.6** (mtime 11-22 11:08) |
| `dsh-workbuddy-connect-community` | declared **0.1.26**, installed **0.1.26** (mtime 11-22 11:08) |
| WorkBuddy env | `WORKBUDDY_ELECTRON_BIN` must point at the Windows `WorkBuddy.exe`; set in `~/dsh/start_dsh.sh`. Changing it requires a host restart. Launcher entry is `start_dsh.bat` only. |

**On `bundle/dist-pack/`**: a packed-artifact staging directory (gitignored), not
load-bearing at runtime. It holds `false-completion-bundle-0.1.9.tgz`, which the
`web` profile references by absolute path in its `package.json`. Older tarballs
are deleted on each bump; only the current one is kept.

### `false-completion-bundle` status

| Item | Verified |
|---|---|
| Gate | **active** — `inject: ['tools']`, bound on `agent/turn-stopping` |
| `get_gate_status` | **registered and callable.** Live values as of 0.1.9: `maxRetries=1 steps=20 toolCalls=10 noProgress=3`, verifiers=filesystem, otel `http://localhost:4318 (default)`. The 10 tool-call cap comes from `FALSE_COMPLETION_MAX_TOOL_CALLS` exported by `start_dsh.sh`. |
| Tests | **147 passing / 21 files** (2026-11-25 18:32) |
| Typecheck | clean |
| Abort log default | `~/.dsh/logs/aborts/web/$(date +%F).log`, set by `start_dsh.sh` **for the `web` profile only** |
| OTLP sink (4318) | **UP** — `GET /` and `POST /v1/traces` both return 200 (rechecked 17:03) |

---

## 2. Data & workspace audit status

### Quant / market data (`~/dsh/quant`)

| Item | Verified |
|---|---|
| `market.db` `bars` latest | **2026-11-20** |
| `market.db` `etf_shares` latest | **2026-11-20** |
| NAV cache | `nav_cache_513050.json`, mtime **2026-11-22 10:54** |
| `core.preflight()` | `ok=True` **with two warnings** |

Preflight warnings at write time:

```
⚠ NAV_CACHE_STALE: 30.1h old — nav_zone() uses stale NAV; refresh nav_cache_513050.json
⚠ REPORT_DENSITY_STALE: 287.2h old — is_report_peak() uses stale disclosure density
ok= True
```

**`NAV_CACHE_STALE` is live, not resolved.** Your brief said "NAV cache
resolved" — it was refreshed on 11-22 but has since aged past the 24h TTL again.
Refresh with `python3 mechanism.py --cache` before any trading run.

### `REPORT_DENSITY_STALE` — deliberate, leave it

`is_report_peak()` consumes disclosure density from a cache file that **does not
exist** on this machine, so the staleness is permanent rather than transient.
It is a non-blocking WARN: preflight still returns `ok=True` and trading
decisions are unaffected. Refreshing the value would require rebuilding the
disclosure dataset for a signal that is not on the trading path. **Decision:
leave it.** If it ever flips to BLOCK, that is a behavior change worth
investigating rather than papering over.

### Workspace

`du -sh ~/dsh` = **2.6G** at write time. I cannot independently confirm the
"283MB freed" figure — no cleanup log survives. Two extra repos exist that were
not in earlier sessions: `~/dsh/claimgate` and `~/dsh/no-receipts` (both created
11-23 per your project memory; `done-gate` is the renamed successor of
`claimgate`).

---

## 3. Pending actions

### Already done — do not redo

- `dsh-memory-palace` **is already 1.8.6** (declared == installed).
- `dsh-workbuddy-connect-community` **is already 0.1.26** (declared == installed).

Both were installed 2026-11-22 11:08, before the host started at 18:38, so the
running host already loads them. No upgrade action is outstanding.

### Still needed

1. **Restart the host** if you want `get_gate_status` callable in a new chat —
   not because of the plugins, but because tool schemas are fixed per session.
   Restart via `start_dsh.bat` (the only supported entry point).
2. ~~Tune `maxToolCallsPerTurn` down to 10~~ — **DONE 2026-11-23, §7.**
   `entry/index.ts` now reads the three limit env vars and forwards them to the
   `CompletionGate` constructor; `start_dsh.sh` exports
   `FALSE_COMPLETION_MAX_TOOL_CALLS=10`. Verified against the *installed* copy:
   abort at tool call 11/10, `category=tool_call_budget_exceeded`. **The running
   host still enforces 30 until it is restarted** — the gate is built at boot
   and has no runtime setter.
3. Refresh the NAV cache before the next trading session (`mechanism.py --cache`).

---

## 4. Important context & lessons

### Token cost: the 900k "zombie session"

A session ballooned to ~900k tokens because the model kept hunting for evidence
to satisfy the gate — reading files, grepping, retrying — instead of concluding.
The gate was working correctly; the *search strategy* was unbounded. Mitigations
in place: divergence limits (`no_progress_exceeded` at 3 identical steps,
`tool_call_budget_exceeded` at 30). Lowering the tool-call budget to 10 is the
pending hardening (§3.2). Watch for a session whose turn count climbs while its
claims do not change — that is the zombie signature.

### The gate is fail-closed

If the OTLP sink on `127.0.0.1:4318` dies, **every claim-bearing turn aborts**
with `category=exporter_failed`. The gate cannot record an audit trail, so it
refuses to certify completion. This is by design, not a bug.

Restart the sink:

```bash
cd ~/dsh && nohup python3 bundle/scripts/otlp_local_sink.py &
# verify
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4318/   # expect 200
```

After a WSL reboot this is mandatory — see `~/.dsh/profiles/web/OTEL-LOCAL-SINK.md`.
Port ownership on this box cannot be resolved via `ss -p`/`lsof`/`fuser`
(permission denied on other processes' fds); match the script path in `cmdline`
instead.

Also avoid: `exporter_failed` is often misread as a gate rejection. Check
`category=` first — `exporter_failed` is infrastructure, every other category is
the agent.

### Latent inconsistency spotted while writing this (not yet fixed)

### Static `sessionId: 'dsh-host'` — FIXED 2026-11-23

All three occurrences (ledger adapter default, gate `sessionId`, `gate.evaluate`
context) are gone. `sessionIdOf(agent)` now resolves the real DSH session id per
turn and is used for evidence spans, `gate.evaluate` and suspend records; when
the host exposes no id, the field is omitted rather than replaced with a
placeholder. A wiring test asserts no code line contains
`sessionId: 'dsh-host'`.

Separately: the package used to ship a **stale compiled `entry/index.js`**
(Nov-20 build, `inject = []`, old signature) beside `entry/index.ts`. No config
referenced it, but it was a live trap. Removed; `package.json` now lists
`entry/index.ts` instead of `entry/**`, and a packaging test fails if a `.js`
reappears under `entry/`.

### Key references

| Doc | Use |
|---|---|
| `bundle/AUDIT.md` | what is proven vs assumed, per component |
| `bundle/POSTMORTEM.md` | 17 incidents, root causes, lookalike-failure table |
| `bundle/BUILD.md` | rebuild → pack → install → verify, with failure map |
| `bundle/GETTING-STARTED.md` | first-day explanation of the gate |
| `bundle/TRIAGE.md` (also `~/.dsh/TRIAGE.md`) | first response when a turn aborts |
| `bundle/NAMING-DECISIONS.md` | frozen names; enforced by `tests/namingGuard.test.ts` |

---

## 5. Deltas — brief vs verified reality

Read this before acting on the brief.

| Your brief said | Verified state |
|---|---|
| Upgrade memory-palace to 1.8.6 | **Already 1.8.6** |
| Upgrade workbuddy to 0.1.26 | **Already 0.1.26** |
| NAV cache resolved | **Stale again** (30.1h > 24h TTL); preflight WARN |
| bars up to 11-20, etf_shares 11-20 | **Confirmed true** |
| 283MB freed | **Not verifiable**; workspace is 2.6G |
| `~/.dsh/logs/aborts/` default | Only for `web` profile, set by launcher |
| Tune `maxToolCallsPerTurn` to 10 | **Wired 2026-11-23** (env → constructor); takes effect on the next host restart |

---

## 6. How to start the next session

Paste this into a new chat:

> Resuming work on `~/dsh`. Read `HANDOFF.md` at the repo root first — it has
> verified environment state and a deltas section. Then:
> 1. Confirm the OTLP sink on 4318 is up (it is fail-closed).
> 2. Run `get_gate_status` and paste the output so we agree on the baseline.
> 3. Wire `maxToolCallsPerTurn` through `entry/index.ts` so it can be set to 10,
>    then rebuild, reinstall to the web profile, and tell me to restart via
>    `start_dsh.bat`.
>
> Do not re-upgrade memory-palace or workbuddy — already current.
> Do not refresh `REPORT_DENSITY_STALE` — deliberately deferred.

If `get_gate_status` is not in the tool list, the host has not been restarted
since 2026-11-22 10:04; restart first, then re-ask.

---

## 7. 2026-11-23 session — what changed and what remains

### Changed (verified against the installed copy, not just the source)

1. **Divergence limits are now wired end-to-end.** Defaults moved into the gate
   as exported constants (`DEFAULT_MAX_STEPS_PER_TURN` = 20,
   `DEFAULT_MAX_TOOL_CALLS_PER_TURN` = 30,
   `DEFAULT_MAX_CONSECUTIVE_NO_PROGRESS_STEPS` = 3); `gateStatus.ts` imports
   them instead of restating `{20, 30, 3}`, so a *reported* limit can no longer
   drift from an *enforced* one. `entry/index.ts` reads
   `FALSE_COMPLETION_MAX_STEPS` / `_MAX_TOOL_CALLS` / `_MAX_NO_PROGRESS` and
   passes all three into the `CompletionGate` constructor.
2. **`maxToolCallsPerTurn = 10`** exported by `start_dsh.sh`
   (`${FALSE_COMPLETION_MAX_TOOL_CALLS:-10}`), the profile's only env owner.
3. **Static `sessionId: 'dsh-host'` removed** from all three sites; a
   `sessionIdOf(agent)` helper supplies the real id (omitted when absent).
4. **Stale `entry/index.js` deleted** from the package; `package.json` `files`
   now lists `entry/index.ts`. Two packaging tests guard both.
5. Bundle **0.1.0 → 0.1.5**, packed, installed into the `web` profile. The gate
   row still resolves to `.../false-completion-bundle/dist/entry/index.js`.
6. Tests **109/17 → 116/18**, typecheck clean. Docs (README divergence table,
   BUILD.md current-state) updated to match.

### Verification actually performed

- `get_gate_status` baseline captured before any change (see §1).
- OTLP sink: `GET /` → 200, `POST /v1/traces` → 200.
- Against the **installed** 0.1.5 dist: status reports
  `toolCalls=10 steps=20 noProgress=3`; with a distinct evidence id per step the
  gate aborts at call **11** with `category=tool_call_budget_exceeded`,
  `counts {actual:11, limit:10}`.
- `--dump-config` confirms the gate row path and that no `profiles/dist/` path
  leaked in.

### Still outstanding

1. **Restart the host via `start_dsh.bat`.** Until then the *running* process
   still uses 30 tool calls and the old session ids — the gate is constructed at
   boot with no runtime setter. This session's own `get_gate_status` will keep
   reporting 30.
2. **Tarball lineage in `dist-pack/`:** `0.1.0` (original baseline), `0.1.3`
   (first wiring attempt), `0.1.4` (stale-entry cleanup), **`0.1.5` (installed,
   current)**. Only `0.1.5` is referenced by the profile. `0.1.3`/`0.1.4` can be
   deleted once you are past this session.
3. `NAV_CACHE_STALE` is still live (see §2) — refresh with
   `mechanism.py --cache` before the next trading session.
4. `REPORT_DENSITY_STALE` — still deliberately deferred, unchanged.
5. Note on the build: `pnpm run build:bundle` prints **4 `TS2345` errors**
   (dual `@deepseek-ai/dsh-agent` peer installs — the npx checkout vs the
   bundle's `node_modules`). They are pre-existing: the unmodified 0.1.0 entry
   build produces the same 4. A 5th appeared when `sessionIdOf` took an `Agent`
   argument; it was fixed by making the parameter structural. `noEmitOnError: false` still emits; `dist/entry/index.js` is
   current. `pnpm run typecheck` (the stricter project tsconfig) is clean.

---

## 8. Cross-Repo Sync Discipline

`false-completion-bundle` (this repo) and `no-receipts` are **two independent
implementations of the same contract**. They are deliberately *not* merged and do
**not** share an npm package: the code differs (`completionGate.ts` is 367 lines
with OTel/cordis deps; `no-receipts/src/gate.ts` is 266 lines and zero-dependency),
the hosts differ, and a shared package would add a release axis and token cost for
no correctness gain. **The contract is shared; the code is not.**

### The three invariants that must match

| # | Invariant | Bundle test | Sibling check |
|---|---|---|---|
| I1 | **Fail-closed export.** If evidence cannot be exported, abort with `exporter_failed`. Never complete on unexported evidence. | `tests/shared_invariants.test.ts` → `I1:` | `no-receipts/tests/` must assert the same |
| I2 | **Three-state decisions.** `complete` / `feedback` / `abort` distinct, mutually exclusive, and `abort` reachable. | `I2:` block | same |
| I3 | **Stable ASCII-only abort line.** One grep-able line, fixed shape, gate-authored prose is raw English (no CJK). | `I3:` block | same |

### Sync status (as of 2026-11-25)

| Invariant | `false-completion-bundle` | `no-receipts` |
|---|---|---|
| I1 fail-closed | `I1:` in `tests/shared_invariants.test.ts` | `I1:` in `tests/shared_invariants.test.ts` |
| I2 three-state | `I2:` block | `I2:` block |
| I3 ASCII-only | `I3:` block | `I3:` block |

**Both copies exist and are green** (bundle 147 tests / 21 files; no-receipts 68
tests / 4 files). The CJK negative control was run in both repos: injecting
`(无证据)` into the formatter fails 3 I3 cases in each, naming the character and
its index.

`no-receipts` deliberately has **no `exporter_failed` category and no
`verifier=` field** — its ledger is in-memory/append-only-file with no network
export step. Its I1 is therefore written as *"unverifiable evidence never yields
`complete`"* (abort, or a propagated store error), which is the property that
actually holds in both implementations. Do not "align" it by inventing an
`exporter_failed` category there.

### Sync procedure (manual, deliberate)

`tests/shared_invariants.test.ts` is the sync artifact. There is no automation
wiring the two repos together, on purpose — the denylist forbids a shared package
and a CI wheel.

1. Change an invariant in one repo → **copy the test block** to the other.
2. Adapt only the *harness* (module paths, log prefix). The assertions on
   categories, state names and ASCII-ness must stay identical.
3. Run both suites. A green suite in one repo proves nothing about the other.
4. Never copy an implementation across. If the two disagree on behaviour, that is
   a contract bug — fix both, do not pick a winner.

### Known harness differences (adapt, don't "fix")

- Log prefix: `[false-completion-gate]` here, `[no-receipts]` there.
- Gate construction: `CompletionGate({ ledger, suspendAdapter, ... })` here vs
  the zero-dep gate in `no-receipts`; the injected-double approach is the same.
- `no-receipts` has a full `ci.yml` matrix (3 OS × 3 Node). This repo's
  `ci.yml` is Ubuntu-only × Node 22/24, because the filesystem seam test spawns a
  stdio MCP server and leans on POSIX paths.

### English-only logging (why I3 exists)

The GUI/chat prompts the model in whatever language the user writes, and models
readily translate tool output. Gate logs must **not** follow: they are grep'd,
counted and parsed. Raw English keeps them byte-stable and token-cheap. The
formatter is already ASCII-only for every field the gate authors; the single
legitimate exception is `claim_text`, which echoes model-authored text verbatim
inside quotes.

Enforcement is a plain non-ASCII regex — deliberately not an AST pass. If the
gate's prose is ever translated (e.g. `(无证据)`), `I3` fails and names the
offending character.

---

## 9. 2026-11-25 — 0.1.9 released; security cleanup closed

### GitHub MCP row removed (0.1.9)

The `false-completion-github-mcp` row was **deleted outright** in 0.1.9 after the
maintainer of `dsh-plugin-index` flagged it during index review
(`polang233/dsh-plugin-index#745`). It was worse than a misconfiguration:

| Property | Reality |
|---|---|
| Verifier implementation | **None.** No github verifier in `src/verifier/`; `grep false-completion-github` over `src/`+`entry/` had zero readers |
| Tools exposed | **26, of which 12 write** — `create_or_update_file`, `push_files`, `create_repository`, `merge_pull_request`, `create_pull_request_review`, `update_pull_request_branch`, … |
| Credential variable | **Wrong.** The server honours only `GITHUB_PERSONAL_ACCESS_TOKEN`; the profile passed `GITHUB_TOKEN`, so it could never authenticate |
| Tool restriction | **Impossible.** No `--tools` flag, no `GITHUB_TOOLSETS`, no read-only mode. All candidate flags/env vars set at once still returned all 26 tools |

So it contributed no verification capability while handing the model write
access to the repo the gate is supposed to police. Removal was the only fix that
eliminated the exposure; a filtering wrapper was deliberately out of scope for a
patch release.

Remaining rows are all read-only or local: `filesystem`, `playwright`, `python`.
`tests/hostEntry.test.ts` now fails if the row, the server pin, or either
credential variable reappears.

**Do not re-add `@modelcontextprotocol/server-github` directly.** See the 0.2.0
roadmap below.

### CI/CD via OIDC is fully functional

0.1.9 was the first release published entirely by CI:

- `release.yml` on tag `v*` → `npm stage publish` over OIDC trusted publishing
  (`id-token: write`, no `NODE_AUTH_TOKEN`/`NPM_TOKEN` anywhere).
- `registry-url` **must stay** in `setup-node`; removing it breaks the OIDC
  exchange (that mistake produced `403 OIDC permission denied`).
- The trusted publisher grants `npm publish` + `npm stage publish` only, so
  `npm stage publish` is correct and `npm publish --provenance` is not.
- A maintainer still approves the staged version with 2FA in the npm UI — that
  interactive step is the point of the restriction and cannot be automated.
- **0.1.9 carries SLSA provenance** (`slsa.dev/provenance/v1`, shasum
  `09e5c592…`). Verified on the public registry.
- `ci.yml` runs on every push/PR to `main` (Node 22 + 24); `scripts/check-contract.mjs`
  runs first to catch a missing shared invariant before install.

### Release history (npm)

| Version | Note |
|---|---|
| 0.1.2 | last token-published (pre-CI) |
| 0.1.8 | package-name entry + real GitHub pin; published via stage + UI approval |
| **0.1.9** | **GitHub MCP row removed; first fully-CI release with provenance** |

---

## 10. Next Steps — roadmap for 0.2.0

### Primary: strict read-only GitHub MCP wrapper

Tracked as a GitHub issue in this repo:
**`[Feature] Implement a strict read-only GitHub MCP Wrapper (v0.2.0)`**

Because the upstream server cannot be restricted, the only safe way back to a
GitHub verifier is a wrapper that proxies stdio to
`@modelcontextprotocol/server-github` and filters `tools/list` down to a fixed
allowlist:

- `get_file_contents` — read a file/blob (content hashing for evidence)
- `list_commits` — confirm a commit exists
- `get_pull_request_status` — the actual CI/merge state check

Everything else must be dropped **before** the list reaches the model, not merely
"not called". Requirements for the implementation:

1. Filter `tools/list` responses; never forward a write tool in the advertised
   list. Fail closed: an unexpected/unknown tool is dropped, not passed through.
2. Use `GITHUB_PERSONAL_ACCESS_TOKEN` (the variable the server actually reads).
3. Keep it out of the default profiles until it has its own tests proving the
   filtered list — a test that asserts the advertised set is exactly the
   three-tool allowlist.
4. No new runtime dependencies in the gate itself; the wrapper is a separate
   executable, not part of `dist/entry`.

### Secondary / candidate items

- **Shared-invariant cross-repo diff.** `scripts/check-contract.mjs` asserts
  presence only; it cannot detect divergent *content* between this repo and
  `no-receipts`. A two-repo checkout job could diff the assertion text, at the
  cost of coupling the two CIs.
- **Branch protection** on `main` requiring the `ci` check, so a PR cannot merge
  on a red suite.
- **`~/dsh` is still not a git repo**, so anything outside `bundle/` (launcher
  scripts, quant tree) is unversioned. If more tooling accumulates there, this
  becomes worth fixing.

### Deliberately not planned

- Re-adding the GitHub row without the wrapper.
- Merging this repo with `no-receipts` (separate implementations, shared
  contract; see §8).
