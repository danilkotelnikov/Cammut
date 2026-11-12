# Cammut

A personal MCP gateway: register upstream MCP servers once, give each agent a scoped token, and let agents
reach everything through one endpoint with four lazy tools (`cammut_servers`, `cammut_search`,
`cammut_describe`, `cammut_call`). Spec: `docs/superpowers/specs/2026-10-09-cammut-gateway-design.md`.


## Status (M1, 2026-10-10)

Deployed on the VDS as the `cammut` container (`/opt/cammut`, compose in `deploy/`), listening on `127.0.0.1:7421`,
reachable from your PC through an SSH tunnel that forwards port 7421. Upstreams: `hindsight`
(36 tools) and any other MCP server you add; bearer secrets are read from `/root/private/cammut.env` on the VDS.

Measured on the VDS (spec target: idle RSS <= 60 MB):

| What | Result |
|---|---|
| Binary / image | 13 MB static binary / 24.9 MB image |
| Idle RSS | 17 MB |
| RSS after 200 sequential searches | 18 MB |
| `cammut_search` latency (incl. curl, auth, audit write) | ~32 ms |
| Test suite | `bash dev/remote.sh go test ./...` all green (acl, ratelimit, index, store, upstream, gateway, cli) |

A bug caught by the gateway tests: the SDK keeps the protocol version negotiated with the *incoming* client in the
request context; reusing that context made Cammut propose it to upstreams, which rejected it. Upstream calls now run on a
detached context (`upstream.detach`).

Known limits (by design for M1): HTTP upstreams only (stdio containers are M2), static bearer secrets (vault is M3),
direct egress only (M4), keyword search without BM25, no public HTTPS yet (needs the `cammut` DNS record + M0).

## Review pass (0.1.1, 2026-10-10)

An independent review of M1 found no critical issues and these real ones, all fixed and covered by tests:

- Audit rows are bounded (upstream/tool clipped to 64 chars, notes are fixed words, raw errors go to the log) and the
  audit table is pruned at startup as well as daily; `last_used_at` is written at most once a minute per token.
- One POST is one JSON-RPC message: batch arrays are rejected (400) so they cannot dodge the rate limit; oversized
  bodies get 413; the `Bearer` scheme is case-insensitive.
- Upstream HTTP: redirects are never followed, the bearer is attached only for the upstream's own host, dial / header
  waits are bounded, response bodies are capped at 8 MiB.
- Retries: a tool call is repeated only when it provably never ran (dead or missing session, dial failure). The
  upstream's own JSON-RPC errors are returned as is and keep the session.
- Tool lists: stale lists are served instantly while one background refresh runs (a black-holed upstream no longer
  stalls search); `cammut_servers` reports `unreachable` even when stale tools are still served; tokens only trigger
  fetches for upstreams their scopes can see.
- Public HTTPS behind Caddy: the SDK's localhost Host-header guard is off (the bearer token is the gate).
- Clean shutdown waits for in-flight requests before the database closes.

`cammut_search` matches English tool descriptions only (a Russian query returns nothing); a multilingual index
(the shared TEI embeddings) is the planned fix in M5.

Not done on purpose: per-upstream rate limits, auditing of search/describe/servers, DNS-based SSRF checks.
The plan under `docs/superpowers/plans/` is historical; the code is now the source of truth.

## 0.1.2 (2026-10-10)

- Public at `https://<your-cammut-host>` (landing page at `/`, MCP at `/mcp`, `/healthz`). Port 443 belongs to Xray REALITY, whose `dest` is a loopback SNI router; our name reaches Caddy (127.0.0.1:9443), which proxies to the gateway on 127.0.0.1:7421.
- `cammut token scopes -label L -scopes a/*,b/tool` replaces the scopes of an active token (the token string stays valid).
- Third upstream `github` (`https://api.githubcopilot.com/mcp/`, bearer env `GITHUB_PAT`). Store the secret with `cammut-secret GITHUB_PAT` on the VDS: hidden prompt, written to `/root/private/cammut.env`, container recreated. `deploy/cammut-secret` is the script.
- Known gap (0.1.2): failed-auth requests were not rate limited per client IP. Since `feat/public-mcp` invalid tokens slow the client address down (see `docs/PUBLIC-ENDPOINT.md`); behind REALITY every public request still reaches Caddy as 127.0.0.1, which is exempt, so there it stays off. Tokens are 256-bit, so guessing is not a risk, only load.

## Console (0.2.0)

The console lives at `/console/` and is reachable two ways: on the private listener through an SSH tunnel
(`ssh -L 7422:127.0.0.1:7422 root@VDS`, then `http://cammut.localhost:7422/console/`; `http://127.0.0.1:7422/console/`
also works but its cookie is then shared with every other local web app on 127.0.0.1), and on the public name once
public login is enabled (`-public-login`, only after real client addresses reach the server; or `-public-login-github-only`, which keeps GitHub sign-in and turns the password form off). `-admin-listen`
accepts loopback addresses only.

Before the first start of 0.2.0 (once), create the vault key inside the image so that the container user owns it.
Without this file the gateway still runs, but the console is off and the log says why:

```
docker run --rm --user 0:0 -v /root/private:/keys --entrypoint /cammut cammut:0.2.0 admin vault-init -key /keys/cammut-vault.key
chown 65532:65532 /root/private/cammut-vault.key
```

Do not create the file with `head` or `touch` as root (the container user, uid 65532, could not read it), and do not
start the container before the file exists (Docker would put a directory in its place).

First login:

1. Create the account on the VDS (the password is typed on the terminal, never over the web):
   `docker compose -f /opt/cammut/deploy/compose.yaml run --rm -it cammut admin create -username <your-name>` (with `CAMMUT_SITE_ORIGIN` set, as for every compose command)
   Scan the QR code with an authenticator app and keep the recovery codes offline.
2. Open the console, enter username, password and the 6-digit code.
3. Optional GitHub login: GitHub → Settings → Developer settings → OAuth Apps → New OAuth App; name `Cammut`,
   homepage `https://<your-cammut-host>`, callback `https://<your-cammut-host>/auth/github/callback`;
   register, then Generate a new client secret. On the VDS store both values
   (`cammut admin secret set GITHUB_OAUTH_CLIENT_ID`, then `... GITHUB_OAUTH_CLIENT_SECRET`) and link your account
   with `cammut admin github-link -username <your-name> -login YOURGITHUBNAME`. GitHub only proves who you are; the
   authenticator code is still asked.
4. Recovery: `admin passwd`, `admin totp-reset`, both over SSH.

Back up `/root/private/cammut-vault.key` somewhere separate: without it every stored secret is unreadable.

## Raw archive (0.3.0)

Cammut can store the complete Claude Code and Codex transcripts, but only as **age ciphertext whose private key is never on the VDS**.
The server validates the `age-encryption.org/v1` header, sizes and the ciphertext sha256, keeps plaintext metadata (agent, project,
session id, byte range, sizes, times) and cannot decrypt anything: there is no identity, no key-encryption key and no decrypt code in the
binary (a test greps the repository for `AGE-SECRET-KEY` and for `filippo.io/age` in `go.mod`).

**Key model.** You hold two keys: a daily key locked with a passphrase (`memory.key.age`) and a recovery key on a USB stick. Only their public
halves (`age1...`) are on the PC (`~/.claude/shared-memory-recipients.txt`) and on the VDS. A lost VDS loses the archive unless the ciphertext is replicated
offsite; losing both private keys makes the archive unreadable by design. The server pins the recipient set it first saw per project and flags any
change in `cammut archive pins`, `status` and the chain doctor.

**Tokens.** The PC token has `archive/put` and `archive/verify` only. A second token with `archive/get`, `archive/list`, `archive/verify`
(`-expires 90d`) is needed to read ciphertext back, to see the replica status (`status`, `audit`, `fetch`, the sweeper and the doctor).

**Server side.** `PUT /v1/archive/segments/{id}` (4 MiB limit, streamed to disk, 0600, fsync, rename; the id is recomputed from the metadata),
`HEAD`/`GET /v1/archive/segments/{id}`, `GET /v1/archive/sessions/{agent}/{session}/coverage`, `GET /v1/archive/segments`, `GET /v1/archive/status`.
Re-uploading an id keeps the first copy; if the plaintext hash differs the answer is `409 content_mismatch`. CLI on the VDS (it opens the database
directly, no HTTP route): `cammut archive stats|verify [-sample N]|list|replica-record -remote NAME < manifest.json|pins [ack -project P]`,
`cammut admin db-snapshot -out PATH [-keep N]` (a `VACUUM INTO` copy that is consistent while Cammut writes; `mem-backup` uses it instead of tarring
the live volume). Flags: `-archive-dir` (`/data/archive`), `-archive-max-bytes` (20 GiB), `-archive-min-free` (5 GiB).

**Replica.** `deploy/replicate-archive REMOTE:PATH` (see `deploy/replicate-archive.md`) copies the archive with rclone, re-reads both sides and
records which segments are verified offsite. The sweeper requires it.

**PC side** (`adapters/`, Node 24, no dependencies, the `age` CLI): the Stop/SessionEnd hooks only record offsets and start a detached drain; the drain cuts
whole lines (about 1 MiB), redacts every JSON string value, strips base64 images, compresses (zstd, brotli if absent), encrypts, keeps the ciphertext in an
outbox and uploads it. A range counts as archived only after the server answered. With Cammut or the tunnel down nothing is lost and nothing is deleted:
the transcripts stay, the outbox keeps ciphertext (capped at 512 MiB) and `status` says what is waiting. The spool no longer holds text, only references
`{file, start, end}` into the agent's own transcript. `adapters/tools/cammut-archive.mjs`: `backfill`, `status`, `fetch`, `decrypt`, `restore`, `audit`,
`pins`, `doctor`, plus `sweep`, `retention`, `quarantine`.

**Retention** (off until you enable it): `adapters/sweep.mjs` removes a transcript from the PC only after it has proved, in that run, that **these bytes**
are archived (every acknowledged range re-hashed from the file and equal to the server's plaintext hash, no gap), replicated offsite, and recoverable
(a restore audit younger than 90 days with both keys), after a dry run you read, with the file quiet, not running, not in the spool and older than the
retention days. Deletion is two-phase: a rename into `.cammut-quarantine` and, 48 hours later and only if everything still verifies and the file is
byte-identical, the unlink. The code refuses to rename or unlink unless `adapters/SWEEPER-REVIEW.md` holds `reviewed-sha256: <sha256 of adapters/sweep.mjs>`,
a line only a human who read the sweeper creates. `quarantine list|restore --id X` puts a file back.

**Restore.** `cammut-archive.mjs restore --session ID --identity KEY` rebuilds `~/.claude/projects/<project>/<id>.jsonl` from the redacted archive;
whether `claude --resume` accepts it is UNVERIFIED (use `--strip-thinking` if it does not). Every segment is a separate age file, so a passphrase-locked
identity asks for its passphrase once per segment.

**Scope of "complete".** Transcripts and subagent transcripts, after string-level redaction, with base64 images replaced by stubs and with
`tool-results/` and `file-history/` excluded. Metadata (project names, session ids, times, sizes) is visible to the VDS host.

**Rollback.** `{"archive": {"enabled": false}}` stops new segments; `retention disable` stops deleting; `quarantine restore` returns files within the grace
period; image `cammut:0.2.0` removes the endpoints (the migration-2 tables stay). Deploy (compose needs `CAMMUT_SITE_ORIGIN`, the public origin, from the shell or `deploy/.env`; see `docs/PUBLIC-ENDPOINT.md`): `cd /opt/cammut && git fetch && git checkout memory-v2 &&
docker compose -f deploy/compose.yaml build && docker compose -f deploy/compose.yaml up -d`; the log then shows `cammut listening ... version 0.3.0`
and `archive reconcile: temp=0 missing=0`.

## Memory
Note store with full-text and optional vector recall, an exhaustive deterministic project brief, a REST surface under `/v1/memory/*` and an in-process `memory` MCP upstream (profile `direct:memory`). Tokens need the `memory/*` scope: widen an existing one with `token scopes -label L -scopes 'archive/put,archive/verify,memory/*'`, or `token create -label warp -scopes 'memory/*' -profile direct:memory`. Adapters (Claude Code, Codex, Warp) live in `adapters/`; `node adapters/install.mjs` installs them and `node ~/.claude/scripts/shared-memory/sm.mjs status` must print `cammut: token=set health=ok`.
Vectors are optional: without `-tei-url` the log says `memory: no -tei-url, recall is full-text only`. To enable them publish TEI on loopback and add `-tei-url http://127.0.0.1:8081` to the compose command, with `TEI_API_KEY` stored by `cammut-secret`. `deploy/smoke.sh` checks `GET /v1/memory/status` when `CAMMUT_SMOKE_TOKEN` is set.
