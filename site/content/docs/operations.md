---
title: Operations
order: 9
kicker: Run it
description: Backups, upgrades with rollback, health checks and troubleshooting.
---

# Operations

## What to back up

| What | Why | How |
|---|---|---|
| The vault key | Without it every stored secret is unreadable | Copy `cammut-vault.key` somewhere separate from the server |
| The database | Tokens, upstreams, console accounts, notes, audit | `cammut admin db-snapshot -out PATH [-keep N]` makes a consistent `VACUUM INTO` copy while Cammut is writing. Use it instead of tarring the live volume |
| The archive | Ciphertext of your transcripts | `deploy/replicate-archive REMOTE:PATH` (rclone) and verify the replica |
| Your age private keys | Reading the archive | Keep them off the server (see [Encrypted archive](/docs/archive/)) |

A nightly job that snapshots the database and prunes old copies is enough for one operator.

## Health checks

```bash
curl -fsS https://cammut.example.org/healthz             # gateway answers
docker compose -f deploy/compose.yaml logs --tail 20 cammut
cammut version                                           # prints the running version
```

`deploy/smoke.sh` runs a post-deploy check list. Set `CAMMUT_SMOKE_TOKEN` to also check `GET /v1/memory/status`.

On start the log shows `cammut listening ... version X` and `archive reconcile: temp=0 missing=0`.

## Upgrade with a rollback path

1. Back up: `cammut admin db-snapshot`.
2. Tag the running image so you can return to it: `docker tag cammut:0.3.0 cammut:0.3.0-pre-0.4.0`.
3. Unpack the new release, then `docker compose -f deploy/compose.yaml build` and `up -d`.
4. Read the log line with the new version, run `deploy/smoke.sh`.
5. If anything is wrong: restore the previous compose file and image tag, `up -d` again. Older images ignore tables they do not know about.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Agent gets `401` | Token wrong, revoked or expired. Tokens from the console expire (default 30 days) |
| `cammut_servers` is empty | The token's scopes do not include any upstream. `cammut token list`, then `token scopes` |
| An upstream shows `unreachable` | The upstream is down or blocks your server; stale tools are still listed |
| Console is off, gateway works | The vault key file is missing or unreadable by uid 65532. The log says which |
| Container will not start after a deploy | Docker created a *directory* where the vault key file should be, because the container started before the file existed |
| Memory hooks print nothing | They are failing open. Run `sm.mjs status` and read `hook.log` in `~/.claude/state/shared-memory/` |
| Recall is full-text only | No `-tei-url`. See [Memory](/docs/memory/) |
| Memory recall went quiet | The token expired |

## Logs and state

Container logs rotate (10 MB × 3). On your computer the adapters keep `hook.log`, a `spool/` of pending chunks (failed ones are parked in `spool/failed/` and deleted after 14 days) and an `outbox/` of encrypted archive segments in `~/.claude/state/shared-memory/`.
