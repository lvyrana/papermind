#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_XPI="$(mktemp "${TMPDIR:-/tmp}/papermind-connector.XXXXXX.xpi")"
trap 'rm -f "$TMP_XPI"' EXIT
rm -f "$TMP_XPI"

node --check "$PLUGIN_DIR/bootstrap.js"
python3 -m json.tool "$PLUGIN_DIR/manifest.json" >/dev/null

(
    cd "$PLUGIN_DIR"
    zip -X -q -j "$TMP_XPI" manifest.json bootstrap.js
)

mv "$TMP_XPI" "$PLUGIN_DIR/papermind-connector.xpi"
echo "Built $PLUGIN_DIR/papermind-connector.xpi"
