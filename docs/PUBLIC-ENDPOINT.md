# Public MCP endpoint

How to put Cammut's `/mcp` on the internet for cloud callers (Composio, Warp, remote agents), what was tested, and what was not.
Nothing here has been run against a live deployment: the code and tests are local, every deployment step is for the user.

The public name is never written into the code. It is `cammut.<tld>`, chosen when the domain is bought. Every example below uses
`https://cammut.example` or `<your-cammut-host>`; replace it with your own. The server takes it from one place, the `-site-origin`
flag, and the compose file reads that from `CAMMUT_SITE_ORIGIN` (see "Compose" below).

## What is exposed

`/mcp` is the one thing a cloud caller needs. The gateway listener (`127.0.0.1:7421`) also serves `/healthz`, the landing page `/`,
and, when `-site-origin` is set, the console routes (`/api/v1/`, `/auth/`, `/console/`) and the bearer-gated REST routes
(`/v1/memory/`, `/v1/archive/`). Console login is off on this listener unless `-public-login` is set, but there is no reason to
reach any of it from the internet. **Forward only `/mcp` and `/healthz` at the proxy.**

| Path | Public? | Gate |
|---|---|---|
| `POST /mcp` | yes | bearer token, per-token rate limit, per-address slowdown on bad tokens, scopes |
| `GET/DELETE /mcp` | answers 405 | stateless server |
| `/healthz` | yes | none; body is exactly `ok` |
| `/`, `/console/`, `/api/v1/`, `/auth/`, `/v1/memory/`, `/v1/archive/` | no (block at the proxy) | session cookie or bearer, not meant for the internet |

## Exposure option A: Cloudflare Tunnel

`cloudflared` runs on the VDS and dials out to Cloudflare, so no inbound port is opened and the origin stays on loopback. UNVERIFIED:
none of this was run.

```yaml
# /etc/cloudflared/config.yml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: cammut.example
    path: ^/(mcp|healthz)$        # regex; everything else falls through to the 404 below
    service: http://127.0.0.1:7421
  - service: http_status:404
```

Then `cloudflared tunnel route dns <TUNNEL_NAME> cammut.example` and `cloudflared tunnel run <TUNNEL_NAME>` (or the systemd unit).

Client address: Cloudflare puts the caller's address last in `X-Forwarded-For`, `cloudflared` connects from loopback, and the gateway
(`internal/clientip`) believes the last element only when the peer is loopback. Tested with a reverse proxy that appends the way
Cloudflare does (`TestThroughAReverseProxy`); that Cloudflare really sends that shape is UNVERIFIED. If it does not, every caller looks
like `127.0.0.1` and the per-address slowdown is off (see below), nothing else changes.

## Exposure option B: Caddy

Caddy terminates TLS and proxies to the gateway. It must forward the original client address; its `reverse_proxy` adds
`X-Forwarded-For` by default.

```
cammut.example {
    @mcp path /mcp /healthz
    handle @mcp {
        reverse_proxy 127.0.0.1:7421
    }
    respond 404
}
```

Behind the existing Xray REALITY front on 443, Caddy sees every connection from `127.0.0.1`, so the gateway sees loopback and does not
slow any address. Tokens are 256-bit; the per-token rate limit still applies.

## Compose

`deploy/compose.yaml` reads the public origin from the environment of `docker compose`, not from the code:

```
CAMMUT_SITE_ORIGIN=https://cammut.example docker compose -f deploy/compose.yaml up -d
```

or put `CAMMUT_SITE_ORIGIN=https://cammut.example` in a `.env` file next to `deploy/compose.yaml`. Compose refuses to start with a
message if it is unset. It sets `-site-origin`, which the console uses for its origin check and which `GET /api/v1/me` returns to a
signed-in user so the Agent setup page can fill in the MCP URL. Adapters need no public name: they default to the loopback tunnel
`http://127.0.0.1:7421` and take `SM_CAMMUT_URL` or `cammut.url` in `~/.claude/shared-memory.json` when you want a direct URL.

## One token per client, minimal scopes

Make a separate token for each cloud client, so one can be revoked alone. For a client that only needs memory:

```
cammut token create -label composio \
  -scopes memory/memory_brief,memory/memory_recall,memory/memory_remember,memory/memory_handoff \
  -profile direct:memory
```

* `-profile direct:memory` makes `tools/list` return the tools as `memory__memory_brief`, ... natively, which is what a platform that
  imports a tool list wants. The default `lazy` profile returns four meta-tools (`cammut_servers`, `cammut_search`, `cammut_describe`,
  `cammut_call`) that reach any upstream the scopes allow.
* The scopes are checked on **both** `tools/list` and `tools/call`. A `direct:` token lists only the tools its scopes grant; calling
  any other name is refused by the protocol; the lazy tools filter the same way. `memory_projects` is left out above on purpose.
* Use the `memory/memory_*` spellings for cloud tokens. They do not satisfy the REST routes (`memory/brief`, `memory/recall`,
  `memory/remember`), so a cloud token cannot reach `/v1/memory/*` at all. Do not give a cloud token `*` or `memory/*`: `*` also
  grants every other upstream (for example GitHub) through the lazy tools.
* A token with `memory/memory_remember` can write to, and supersede notes in, any project. There is no per-project scope yet. Decide
  that before handing out a write token to a less trusted agent.
* Nothing destructive is reachable by a bearer token: the memory server has exactly five tools (no delete, no retract), the gateway
  four, the console API accepts a cookie session only, and `TestToolSetIsClosed` fails if a tool is added without a decision.
  Retracting a note is a console action.

Rate limit: 20 requests per second per token, burst 40 (`-rate`, `-burst`). A 429 carries `Retry-After`.

## Registering with Composio

From Composio's docs (docs.composio.dev, "Custom MCP", read 2026-10-17, marked experimental there):

* The server must be at a **public HTTPS URL**. Composio registers `app_url` and an auth scheme (no auth, API key, or DCR OAuth),
  creates a `CUSTOM_*` toolkit, syncs the tools, and proxies tool execution.
* **`app_url` and `auth_schemes` cannot be changed after registration** (409). To change either, delete the toolkit (which revokes its
  connections) and register again. So register only when the final `https://cammut.<tld>/mcp` is live and will not move.
* The first sync runs when the first connected account becomes active, so Composio calls `tools/list` at connect time.

For Cammut the registration is, in the user's notes: `app_url` = `https://cammut.example/mcp`, API-key scheme, and the header map
`"Authorization": "Bearer {{generic_api_key}}"`, with the API key being the Cammut token made above. UNVERIFIED: the exact JSON field
names of the API-key scheme (the docs page shows only the no-auth example in its static text); read the "API key" tab of the
upsert reference before sending.

## The JSONResponse decision

The gateway answers every POST with a single `application/json` body (`JSONResponse: true`, `Stateless: true`) instead of an SSE
stream. The MCP spec lets a server do either and requires clients to accept both.

Composio's client transport is not documented: the pages above say "remote MCP server" and "public HTTPS endpoint" and nothing about
Streamable HTTP versus SSE. So the decision rests on other clients:

| Client | Result |
|---|---|
| Go MCP SDK client (same code base as the server) | full lifecycle passes |
| Official Python SDK `mcp` 1.27.0 (`TestInteropWithOfficialPythonClient`) | initialize, list, call, call: pass |
| Official TypeScript SDK 1.32.1 (`TestInteropWithOfficialNodeClient`, needs `CAMMUT_INTEROP_SDK`) | pass |
| Raw HTTP: initialize, `notifications/initialized` (202), `tools/list`, `tools/call`, `ping`, `prompts/list`, `resources/list` | pass |
| Through `httputil.ReverseProxy` with `X-Forwarded-*` | pass, audit shows the forwarded address |

Decision: **keep JSON.** Nothing showed an incompatibility, a plain JSON reply is simpler for proxies (no long-lived stream, no
buffering concerns, `Cache-Control: no-store`), and the server never needs to push to the client. Reconsider only if Composio's sync
fails with a content-type error: the symptom would be a successful `initialize` followed by an empty tool list; the remedy is
`JSONResponse: false` in `internal/gateway/gateway.go`, a one-line change, with the tests adjusted.

Behaviours worth knowing, all covered by `internal/gateway/conformance_test.go`:

* Each POST is independent (stateless): no `Mcp-Session-Id` is issued, `tools/list` works without a prior `initialize`.
* `Accept`: the SDK insists on both `application/json` and `text/event-stream`. The gateway completes a missing or partial `Accept`
  (including none, `application/json`, `*/*`), because cloud callers are not always careful and the reply is JSON either way.
* `Content-Type` must be `application/json` (a charset parameter is fine); anything else is 415.
* `MCP-Protocol-Version`: absent is fine; `2024-11-05`, `2025-03-26`, `2025-06-18` pass; an unknown value is 400.
* `GET`, `DELETE`, `PUT`, `PATCH` on `/mcp` answer 405 with `Allow: POST` at once. They never open a stream.
* A body over 1 MiB is 413; a JSON array (batch) is 400, because one POST must be one rate-limit credit.
* A method the SDK does not know at all answers a plain-text 400 (`JSON RPC not handled`), not a JSON-RPC error object, with or
  without an id. Methods it knows but refuses (`resources/subscribe`, an unknown tool name) answer a proper JSON-RPC error with the
  request id. No real client sends the former.
* A tool result over 1 MiB (once wrapped) becomes the tool error `result too large`; one just under arrives whole. A 1.5 s tool
  answers correctly and does not delay other calls.

## Brute force, auth and responses

* **Slowdown per client address.** After five invalid tokens from one address (`internal/clientip`, last `X-Forwarded-For` element
  when the peer is loopback), further requests from it get `429` with `Retry-After` for one minute, doubling up to 15 minutes, even
  with a valid token. Other addresses are unaffected. A request with no `Authorization` header is not a failure. A blocked request
  does not extend the block. The table is bounded (10,000 addresses).
* **Loopback is exempt.** The SSH tunnel and a proxy that does not forward the client both appear as `127.0.0.1`; slowing that would
  lock the owner out. So behind REALITY-to-Caddy the slowdown is effectively off. Tokens are 256-bit random, stored as SHA-256, and
  the stored digest is compared in constant time; guessing is not the risk, load is, and the per-token limit covers that.
* **No token oracle.** Unknown, revoked and expired tokens get the same 401, byte for byte (`WWW-Authenticate: Bearer realm="cammut"`).
  Timing of the database lookup is not equalised; it depends on a hash the caller cannot steer.
* Failed attempts from a tracked address are logged (`invalid token`, address and path, never the token). They are not audited in
  the database, so a flood cannot grow the audit table.
* **Audit.** One row per `tools/call` and per `tools/list`: time, token id, client address, upstream, tool, ok, duration, a fixed
  note word. Never arguments, results or error text. Refused and unknown tool names are rows with `ok = 0`.
* **Redaction.** `memory_remember` and `memory_handoff` pass text through `memory.Redact` before storing: API keys, bearer and
  `password:` forms, private-key blocks. Tested over MCP with a fake `sk-` key, a PEM block and a `password:` value, checked in the
  recall output and in every table of the SQLite file, including full-text shadow tables and the audit log.
* **Headers.** Every `/mcp` reply, including 401, 405, 413 and 429, carries `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`. No `Access-Control-*` header is ever sent, so a browser page cannot call `/mcp`; `OPTIONS`
  preflights get no CORS answer. `/healthz` returns `ok` and `Cache-Control: no-store` and nothing else.

## Tested and not tested

Tested (local, `go test ./...`, node and web suites; see the commits on `feat/public-mcp`):

* the conformance table above, the scope/tool-set/REST-isolation/redaction/audit/header/slowdown behaviours, a bearer token being
  refused by the console API, official Python and TypeScript SDK clients, a reverse-proxy pass.
* Go tests run on Linux (cross-built test binaries, run in WSL) pass in full; on Windows ten tests that check POSIX file modes
  (`vault`, `archive`, `cmd/cammut`) fail because NTFS reports `0444` instead of `0400`. They are unrelated to this work.

UNVERIFIED, needs the real service or a third party:

* Composio's actual transport and sync against this endpoint, and the API-key scheme's JSON fields.
* Cloudflare's `X-Forwarded-For` shape and its request timeout (about 100 s on the free plan, per Cloudflare's docs); `cloudflared`
  path-regex ingress syntax; Caddy snippet.
* Behaviour under real internet traffic: TLS, HTTP/2, a slow client, idle connections. The server's write timeout is 120 s
  (`cmd/cammut/wire.go`); a tool slower than that, or than the proxy's read timeout, fails.
* The race detector (`-race`) was not run locally (no cgo toolchain on this machine); `dev/gate.sh` does it on the VDS and is for
  the user to run.

## Steps for the user, in order

1. Buy `cammut.<tld>`; point it at Cloudflare (option A) or the VDS (option B).
2. Set `CAMMUT_SITE_ORIGIN=https://cammut.<tld>`, deploy 0.3.0 (own backup, smoke and rollback), start the tunnel or Caddy with the
   path restriction.
3. From outside: `GET https://cammut.<tld>/healthz` returns `ok`; `POST /mcp` without a token returns 401; `/api/v1/me` returns 404.
4. Make one token per client with the minimal scopes above; store it in the client, never in a file in the repository.
5. Only now register in Composio, once, with the final `app_url`.
6. After a week, read the audit log for unexpected tools or addresses, and revoke anything unused (`cammut token revoke -label L`).
