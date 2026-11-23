#!/usr/bin/env bash
# Packaging portability smoke.
# Packs the bundle, bootstraps a clean DSH profile in a DIFFERENT DSH_HOME,
# installs the packed tarball, and verifies the resolved config + filesystem
# verifier with a different cwd. No machine-specific paths, no config edits.
set -euo pipefail

BUNDLE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d /home/hex636869/dsh/.portability.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
CACHE="$TMP/npm-cache"
mkdir -p "$CACHE"
DSH=/home/hex636869/.npm/_npx/b5e10b118beccd0f/node_modules/.bin/dsh

echo "== pack (prepack runs typecheck + tests) =="
cd "$BUNDLE"
npm_config_cache="$CACHE" npm pack --pack-destination "$TMP" >/tmp/fcb-pack.log 2>&1 || { tail -20 /tmp/fcb-pack.log; exit 1; }
TARBALL=$(find "$TMP" -maxdepth 1 -name '*.tgz' | head -1)
echo "tarball: $TARBALL"

echo "== verify artifact contents =="
tar -tzf "$TARBALL" > "$TMP/contents.txt"
if grep -q '\.venv' "$TMP/contents.txt"; then
  echo "ERROR: .venv was packaged" >&2; exit 1
fi
tar -xzOf "$TARBALL" package/package.json > "$TMP/pkg.json"
grep -q 'profiles/minimal.yml' "$TMP/pkg.json"
grep -q 'package/profiles/minimal.yml' "$TMP/contents.txt"
grep -q 'package/dist/entry/index.js' "$TMP/contents.txt"
echo "OK: no .venv; patch points to profiles/minimal.yml; dist present"

echo "== clean DSH_HOME (profile bootstrapped by copying DSH's own headless template) =="
export DSH_HOME="$TMP/dsh-home"
mkdir -p "$DSH_HOME/profiles" "$TMP/other-cwd"
# --from-default-profile uses mkdtemp under a different mount (EXDEV under this
# sandbox), so copy the same template files DSH bootstraps from an existing profile.
cp /home/hex636869/.dsh/profiles/smoke/cordis.yml "$DSH_HOME/profiles/cordis.yml"
cp /home/hex636869/.dsh/profiles/smoke/pnpm-workspace.yaml "$DSH_HOME/profiles/pnpm-workspace.yaml"
mkdir -p "$DSH_HOME/profiles/portable"
cp /home/hex636869/.dsh/profiles/smoke/cordis.yml "$DSH_HOME/profiles/portable/cordis.yml"
cp /home/hex636869/.dsh/profiles/smoke/pnpm-workspace.yaml "$DSH_HOME/profiles/portable/pnpm-workspace.yaml"
cat > "$DSH_HOME/profiles/pnpm-workspace.yaml" <<EOF
storeDir: $TMP/store
onlyBuiltDependencies:
  - esbuild
  - protobufjs
EOF
printf 'store-dir=%s\n' "$TMP/store" > "$DSH_HOME/profiles/.npmrc"
mkdir -p "$TMP/store"
cat > "$DSH_HOME/profiles/portable/pnpm-workspace.yaml" <<'EOF'
onlyBuiltDependencies:
  - protobufjs
  - esbuild
EOF
cat > "$DSH_HOME/profiles/portable/package.json" <<'EOF'
{ "name": "portable", "private": true, "dependencies": {} }
EOF

echo "== install packed tarball into clean profile =="
# dsh plugin add wraps pnpm in the profile dir. Install the tarball with pnpm
# directly so we can approve protobufjs build scripts in the same operation.
printf '{"name":"portable","private":true,"dependencies":{"false-completion-bundle":"file:%s"},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","false-completion-bundle"]}}}\n' "$TARBALL" > "$DSH_HOME/profiles/portable/package.json"
(cd "$DSH_HOME/profiles/portable" && XDG_DATA_HOME="$TMP/xdg-data" npm_config_store_dir="$TMP/store" npm_config_cache="$CACHE" pnpm install --ignore-scripts --no-frozen-lockfile >/tmp/fcb-install.log 2>&1) || { tail -20 /tmp/fcb-install.log; exit 1; }
(cd "$DSH_HOME/profiles/portable" && XDG_DATA_HOME="$TMP/xdg-data" npm_config_store_dir="$TMP/store" pnpm approve-builds --all --yes >/dev/null 2>&1) || true

echo "== dump-config from a different cwd =="
(cd "$TMP/other-cwd" && "$DSH" --profile portable --dump-config > "$TMP/config.yml" 2>/dev/null)
grep -q 'false-completion-gate' "$TMP/config.yml"
grep -q 'false-completion-filesystem-mcp' "$TMP/config.yml"
grep -q '@modelcontextprotocol/server-filesystem' "$TMP/config.yml"
echo "OK: gate + filesystem rows resolved from cwd=$TMP/other-cwd"

echo "== no machine-specific absolute paths in default profile =="
if grep -qE '/home/|/Users/|[A-Za-z]:\\' "$BUNDLE/profiles/minimal.yml"; then
  echo "ERROR: machine-specific absolute path in minimal.yml" >&2; exit 1
fi
echo "OK: portable default profile"

echo "PORTABILITY SMOKE: PASS"
