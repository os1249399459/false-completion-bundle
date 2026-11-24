# BUILD — rebuild, verify, and install this bundle from scratch

Everything a new session needs. Verified against the repo as of 2026-11-22
(135 tests). Run every command from the **repo root** (`~/dsh`) unless stated.

---

## 0. One-time environment

```bash
cd ~/dsh/bundle
pnpm install                       # Node >=20.6, pnpm 12
# pnpm's global store can be read-only in this WSL setup; if install fails:
#   XDG_RUNTIME_DIR=/tmp/xdg-runtime-pnpm pnpm install
# Build scripts (esbuild, protobufjs) may need approval once:
#   XDG_RUNTIME_DIR=/tmp/xdg-runtime-pnpm pnpm approve-builds --all --yes
```

Optional local trace sink (needed because the ledger is fail-closed):

```bash
bash scripts/start-otlp-local-sink.sh     # 127.0.0.1:4318, writes ~/.dsh/otlp-local/traces.ndjson
```

---

## 1. The four build steps (in order)

```bash
cd ~/dsh/bundle
pnpm run typecheck     # exits 0; no output on success
pnpm test              # 135 tests, 20 files
pnpm run build:bundle  # tsc -p tsconfig.bundle.json  → dist/
```

`build:bundle` emits `dist/entry/index.js` + `dist/src/**`. It prints **3
`TS2307` errors** for `@deepseek-ai/dsh-*` imports — expected: those are Host
peer dependencies resolved only inside a DSH profile. `tsconfig.bundle.json`
sets `noEmitOnError: false`, so **the emit still happens**. Confirm with:

```bash
ls -la dist/entry/index.js            # must exist, non-zero
grep -c "from '../src/" dist/entry/index.js   # must be >= 7
```

You do **not** need esbuild. Plain `tsc` produces a working entry (verified by
building a clean copy and packing it).

---

## 2. Pack the tarball

```bash
cd ~/dsh/bundle
XDG_RUNTIME_DIR=/tmp/xdg-runtime-pnpm npm_config_cache=/tmp/fcb-npm-cache \
  npm pack --pack-destination /tmp/fcb-pack
# → /tmp/fcb-pack/false-completion-bundle-0.1.8.tgz
```

`prepack` runs `typecheck && test` automatically, so a broken tree cannot pack.
Sanity-check the tarball contains the three things the profile needs:

```bash
tar -tzf /tmp/fcb-pack/false-completion-bundle-0.1.8.tgz \
  | grep -cE 'dist/entry/index.js|profiles/minimal.yml|locale/en.json'   # expect 3
```

`npm pack` also fails with `EACCES` on `~/.npm` in some sandboxes — always pass
`npm_config_cache=/tmp/...` as above.

---

## 3. Install into a profile

```bash
DSH=~/.npm/_npx/b5e10b118beccd0f/node_modules/.bin/dsh

# fresh profile (skip if it exists)
$DSH --profile work --from-default-profile headless --dump-config >/dev/null

# install
XDG_RUNTIME_DIR=/tmp/xdg-runtime-pnpm $DSH plugin --profile work add \
  /tmp/fcb-pack/false-completion-bundle-0.1.8.tgz
```

Then confirm the profile manifest lists the bundle **and** the resolved rows:

```bash
node -p "require('$HOME/.dsh/profiles/work/package.json').dsh.profile.bundles"
$DSH --profile work --dump-config | grep -A2 false-completion-gate
# gate row must end in .../false-completion-bundle/dist/entry/index.js
# NOT .../false-completion-bundle/profiles/dist/entry/index.js
```

If `pnpm` refuses with `ERR_PNPM_IGNORED_BUILDS`, add to the profile's
`pnpm-workspace.yaml`:

```yaml
allowBuilds:
  protobufjs: true
  esbuild: true
```

---

## 4. Verify it actually runs

```bash
export DEEPSEEK_API_KEY=$(python3 -c "
import re;t=open('$HOME/.dsh/.credentials.yaml').read()
m=re.search(r'DEEPSEEK_API_KEY:\s*[\"\']?([^\"\'\n]+)',t);print(m.group(1).strip())")

env -u HTTP_PROXY -u HTTPS_PROXY \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces \
  $DSH --profile work --json 'Call the tool get_gate_status once and paste its output.'
```

Expected startup lines on stderr:

```
[false-completion-bundle] verifier probe:
  filesystem  OK
  ...
[false-completion-bundle] active gate: claimGuard + filesystem
[false-completion-gate] OTLP endpoint = http://127.0.0.1:4318/v1/traces profile=work
Secure MCP Filesystem Server running on stdio
[false-completion-gate] agent/created received; binding turn-stopping
```

And `get_gate_status` must appear in the turn's tool calls with real output.

---

## 5. Optional gates

```bash
pnpm run test:regression   # Promptfoo suite (7 cases) via promptfoo
pnpm run metrics           # runs regression + writes .promptfoo/metrics.json
bash scripts/portability-smoke.sh   # packs, installs to clean DSH_HOME/cwd, checks rows
```

---

## 6. Failure map (fast triage)

| Symptom | Cause | Fix |
|---|---|---|
| `TS2307 cannot find @deepseek-ai/...` | Host peer deps absent outside a profile | Expected. Only check that JS was emitted |
| `dist/entry/index.js` missing | `noEmitOnError` overridden | Verify `noEmitOnError:false` in `tsconfig.bundle.json`, rerun |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm blocks postinstall scripts | `allowBuilds` block above |
| Gate row resolves to `profiles/dist/...` | Profile patch uses `./dist/` | Must be `../dist/entry/index.js` (path anchors beside the patch) |
| Tool `get_gate_status` missing at runtime | Profile has a stale bundle | Reinstall the tarball; restart DSH (tools are fixed per agent) |
| Every claim-bearing turn aborts with `category=exporter_failed` | No OTLP sink on 127.0.0.1:4318 | `bash scripts/start-otlp-local-sink.sh` |
| `Cannot access directory .../${WORKSPACE_ROOT}` loop | `${ENV}` is not Loader syntax | Use `!!js process.cwd()` |
| `MISSING_CREDENTIAL` | No API key in env | Export `DEEPSEEK_API_KEY` as above |

---

## 7. What not to rebuild

- Do **not** re-implement `claimGuard`, `completionGate`, verifiers, or the
  ledger. They are stable; see `AUDIT.md` for their proven/assumed status.
- Do **not** rename package name, plugin row ids, `serverName` values, trace
  attributes, env vars, or the abort log prefix — `NAMING-DECISIONS.md` freezes
  them and `tests/namingGuard.test.ts` enforces it.
- Do **not** change `maxRetries` default without reading
  `tests/maxRetriesDefault.test.ts`; the canonical value is `DEFAULT_MAX_RETRIES = 1`.

## 8. Current state snapshot

- Package: `false-completion-bundle@0.1.8`. The gate row loads by **package
  name** (`name: false-completion-bundle`) via `main`/`exports["."]` →
  `dist/entry/index.js`; it is no longer referenced by a relative path, so
  third-party loaders do not need to know the package layout.
  (`entry/` holds only `index.ts`; a stray compiled `entry/index.js`
  once shipped there and is now removed + guarded by a packaging test)
- Default patch: `./profiles/minimal.yml` (gate + filesystem verifier only)
- Other profiles: `standard.yml` (adds Python, requires `VERIFIER_BACKEND`),
  `strict-best-effort.yml` (all verifiers, **not** a hard gate)
- Tests: 135 / 20 files green; typecheck clean
- Read-only status tool: `get_gate_status`
- Docs: `README.md` (usage), `AUDIT.md` (state), `POSTMORTEM.md` (incidents),
  `TRIAGE.md` (first-response), `NAMING-INVENTORY.md` / `NAMING-DECISIONS.md`
  (frozen names), `ASSUMPTIONS.md` (runtime evidence)
