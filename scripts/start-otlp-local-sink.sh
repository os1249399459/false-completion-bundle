#!/usr/bin/env bash
# Start the local-only OTLP sink used by the false-completion bundle.
# Loopback only (127.0.0.1:4318); writes ~/.dsh/otlp-local/traces.ndjson.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.dsh/otlp-local"
if ss -tln 2>/dev/null | grep -q '127.0.0.1:4318 '; then
  echo "local OTLP sink already listening on 127.0.0.1:4318"; exit 0
fi
nohup python3 "$DIR/otlp_local_sink.py" >>"$HOME/.dsh/otlp-local/sink.log" 2>&1 &
echo "started local OTLP sink (pid $!); log: $HOME/.dsh/otlp-local/sink.log"
