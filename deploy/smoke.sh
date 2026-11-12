#!/usr/bin/env bash
# Run on the VDS: smoke-test the gateway. The token comes from $CAMMUT_TOKEN or stdin, never from argv.
set -euo pipefail
TOK="${CAMMUT_TOKEN:-}"; [ -n "$TOK" ] || IFS= read -r TOK
[ -n "$TOK" ] || { echo "usage: CAMMUT_TOKEN=... smoke.sh   (or pipe the token on stdin)"; exit 2; }
URL=${CAMMUT_URL:-http://127.0.0.1:7421/mcp}
rpc() { printf 'Authorization: Bearer %s\n' "$TOK" | curl -s --max-time 60 -H @- -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$1" "$URL"; }
echo "--- no token -> $(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' "$URL") (want 401)"
echo "--- tools/list:"; rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c 'import sys,json; print([t["name"] for t in json.load(sys.stdin)["result"]["tools"]])'
call() { rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(("ERROR " if r.get("isError") else "")+r["content"][0]["text"][:600])'; }
echo "--- servers:"; call cammut_servers '{}'
echo "--- search recall:"; call cammut_search '{"query":"recall memory","limit":5}'
echo "--- search (Russian):"; call cammut_search '{"query":"поиск воспоминаний","limit":5}'
if [ -n "${CAMMUT_SMOKE_TOKEN:-}" ]; then
  echo "--- memory status:"; printf 'Authorization: Bearer %s\n' "$CAMMUT_SMOKE_TOKEN" | curl -s --max-time 30 -H @- "${CAMMUT_URL%/mcp}/v1/memory/status" | head -c 600; echo
fi
