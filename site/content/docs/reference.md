---
title: Reference
order: 10
kicker: CLI and endpoints
description: Every command, flag and HTTP route that is documented for this release.
---

# Reference

## Commands

```text
usage: cammut <command>
  serve    -db PATH -listen ADDR [-rate N] [-burst N]
  token    create -label L -scopes a/*,b/tool [-profile lazy|direct:UPSTREAM] | scopes -label L -scopes ... | list | revoke -label L
  upstream add -name N -url U [-bearer-env VAR] | list | rm -name N
  admin    vault-init | create -username U [-generate] | passwd | totp-reset | github-link | secret set|list|delete | db-snapshot -out PATH [-keep N]
  archive  stats | verify [-sample N] [-project P] | list [-project P] [-limit N] | replica-record -remote NAME < manifest.json | pins [ack -project P]
  version
```

In the container, run them as `docker compose -f deploy/compose.yaml run --rm cammut <command>`.

`serve` flags are listed on the [Install and configure](/docs/install/) page.

## Environment

| Variable | Used by | Meaning |
|---|---|---|
| `CAMMUT_DB` | `cammut` | Default database path |
| `TEI_API_KEY` | `serve` | Key for the embeddings server given with `-tei-url` |
| *(your names)* | `serve` | Each upstream's bearer secret, named by `-bearer-env` |
| `CAMMUT_TOKEN_CLAUDE`, `CAMMUT_TOKEN_CODEX`, `CAMMUT_TOKEN_MCP` | agent config | The token your agent presents |
| `CAMMUT_MEMORY_TOKEN` | adapters | Default `cammut.tokenEnv` for the memory hooks |
| `SHARED_MEMORY_BYPASS=1` | adapters | Turn the hooks off for one shell |

## HTTP surface

| Route | Auth | Purpose |
|---|---|---|
| `POST /mcp` | Bearer token | The MCP endpoint (streamable HTTP, stateless) |
| `GET /healthz` | none | Liveness |
| `GET /` | none | Landing page |
| `/console/` | login | The console |
| `GET /api/v1/me`, `GET /api/v1/auth/methods` | session / none | Console session and available login methods |
| `/v1/memory/*` | Bearer, `memory/*` scopes | Memory REST used by the hooks: brief, recall, remember, status |
| `PUT, HEAD, GET /v1/archive/segments/{id}` | Bearer, `archive/*` scopes | Archive segments |
| `GET /v1/archive/segments`, `/v1/archive/status` | Bearer | Archive listing and status |
| `GET /v1/archive/sessions/{agent}/{session}/coverage` | Bearer | Which byte ranges of a session are archived |

## MCP tools

**Lazy profile:** `cammut_servers`, `cammut_search`, `cammut_describe`, `cammut_call`.

**Memory upstream:** `memory_brief`, `memory_recall`, `memory_remember`, `memory_handoff`, `memory_projects`.

## Files the adapters use

| Path | Purpose |
|---|---|
| `~/.claude/shared-memory.json` | Shared config: `cammut.url`, `cammut.tokenEnv`, `archive.*`, per-feature switches |
| `~/.claude/shared-memory-recipients.txt` | Public age recipients for the archive |
| `~/.claude/state/shared-memory/` | `hook.log`, `spool/`, `sessions/`, `outbox/`, `breaker.json`, brief cache |
| `~/.claude/scripts/shared-memory/` | Installed adapter files (`node adapters/install.mjs`) |
