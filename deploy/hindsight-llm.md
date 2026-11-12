# hindsight-llm: switch the LLM behind Hindsight

`deploy/hindsight-llm` (Python 3, standard library only) changes which model Hindsight uses for retain, consolidation and reflect: any provider, any endpoint, your own key. Hindsight reads its LLM only from environment variables (no API, no per-bank setting), so a switch means recreating the `hindsight` container. The tool does that safely: dry run by default, a snapshot first, a canary after, an automatic rollback on any failure. OpenViking and every other service are not touched.

## USER STEPS (paste-ready)

**1. Copy the script to the VDS and install it** (PowerShell on the PC, in the repo folder, then the VDS shell):

```powershell
scp -i ~/.ssh/your_key deploy\hindsight-llm root@your-server:/tmp/hindsight-llm
ssh -i ~/.ssh/your_key root@your-server
```

```bash
install -m 0755 /tmp/hindsight-llm /usr/local/bin/hindsight-llm && rm /tmp/hindsight-llm
hindsight-llm show          # current settings, key shown only as "set (length N)"
hindsight-llm presets
```

**2. Dry run, then switch back to General Compute (the current setup, minimax-m2.7), keeping the key it already uses:**

```bash
hindsight-llm set --preset general-compute --keep-key            # dry run: prints exactly what would change
hindsight-llm set --preset general-compute --keep-key --yes      # apply
```

**3. Switch to an OpenAI-compatible provider (OpenAI, OpenRouter, a local gateway, ...), key typed at a hidden prompt:**

```bash
read -rs KEY; printf %s "$KEY" | hindsight-llm set --provider openai --base-url https://api.openai.com/v1 --model gpt-4o-mini --key-stdin --yes; unset KEY
# OpenRouter:
read -rs KEY; printf %s "$KEY" | hindsight-llm set --preset openrouter --model openai/gpt-4o-mini --key-stdin --yes; unset KEY
```

**4. Switch to Anthropic:**

```bash
read -rs KEY; printf %s "$KEY" | hindsight-llm set --preset anthropic --model claude-haiku-4-5 --key-stdin --yes; unset KEY
```

**5. Test (probe + scratch-bank round trip, changes nothing), history, rollback:**

```bash
hindsight-llm test
hindsight-llm history
hindsight-llm rollback                       # back to the state before the last change
hindsight-llm rollback --to 20261016T120000Z # a specific snapshot from `history`
```

Drop `--yes` from any `set` to see the plan first. A key can also come from a file: `--key-file /root/private/some-key.txt`.

## Commands

| Command | What it does |
|---|---|
| `show` | Provider, base URL, model, timeout, concurrency, retries from the running container (`docker inspect`; falls back to `docker compose config` when it is not running). Key only as `set (length N)`. Lists per-operation overrides (`HINDSIGHT_API_RETAIN_LLM_*` etc.) and other `HINDSIGHT_API_*LLM*` variable names (values hidden). |
| `presets` | `general-compute`, `openai`, `anthropic`, `openrouter` (provider `openai` + OpenRouter URL), `deepseek`, `groq`, `custom`. The model of a preset is only a suggestion: pass `--model`. `custom` needs `--provider`, `--model` and `--base-url`. |
| `set ...` | Dry run unless `--yes`. Needs exactly one of `--key-stdin`, `--key-file PATH`, `--keep-key` (reuses `/root/private/hindsight-llm.env`, else the key of the running container). Unset `--timeout/--max-concurrent/--max-retries` keep the current values (defaults 120 / 2 / 1). `--base-url ""` (or a preset without a URL) means the provider's own default. |
| `test` | Probe plus scratch-bank round trip; changes nothing. |
| `rollback [--to STAMP]` | Restores a snapshot (default: the newest). It first snapshots the current state, so running `rollback` again undoes the rollback. |
| `history` | Snapshots: stamp, provider, model, base URL host of the state **before** that change. No keys. |

## What `set --yes` does, in order

1. Takes `/var/lock/hindsight-llm.lock` and also the nightly backup's lock `/var/backups/memory/.mem-backup.lock` (the file `deploy/mem-backup` flocks). If either is held it exits 3 and changes nothing. While a switch runs, `mem-backup` exits 4 ("another mem-backup is running") instead of stopping Hindsight in the middle of the canary.
2. Snapshot in `/var/lib/hindsight-llm/history/<UTC stamp>/` (mode 700): `compose.llm.yaml`, the previous `hindsight-llm.env` (mode 600, so a rollback can restore the key), `meta.json` (image id, key-file sha256, provider/model/host).
3. Writes `/root/private/hindsight-llm.env` (mode 600; `HINDSIGHT_LLM_API_KEY='...'`) and `/opt/shared-memory/deployment/compose.llm.yaml`, both atomically (temp file in the same directory, fsync, rename). The override holds only `HINDSIGHT_API_LLM_*` for the `hindsight` service and refers to the key as `${HINDSIGHT_LLM_API_KEY:?...}`. `shared-memory.env` is never edited, so OpenViking keeps `GENERALCOMPUTE_API_KEY`.
4. `docker compose ... config --format json` must show the new values for the hindsight service (proves the override really merged; nothing is printed).
5. `docker compose -p shared-memory-pilot -f compose.yaml -f compose.4gb.yaml -f compose.llm.yaml --env-file /root/private/shared-memory.env --env-file /root/private/hindsight-llm.env up -d --no-deps hindsight`.
6. Waits for `GET /health` (up to 180 s).
7. Canary: `POST /v1/default/banks/default/health/llm` (the `test_bank_llm` probe; read-only), then a scratch bank `llm-canary-<epoch>`: create, synchronous retain of one synthetic sentence, recall with a plain question, at least one fact must come back, then delete the bank (always, also on failure; one retry).
8. Any failure in steps 3 to 7 triggers the automatic rollback: files restored byte for byte from the snapshot (or removed if there was none), service recreated, health checked again, exit 1. If the rollback itself fails the tool prints `!!! ROLLBACK FAILED` with the manual commands and exits 4.

Exit codes: 0 ok, 1 failed and rolled back (or `test` failed), 2 bad input, 3 refused (lock, missing file, no API key), 4 rollback failed.

## Safety rules

- Base URL must be `https://`. `http://` only with `--allow-insecure-url` and only for loopback/private hosts (`localhost`, `host.docker.internal`, 127.x, 10.x, 172.16-31.x, 192.168.x). Inside the container `127.0.0.1` is the container itself, so use `host.docker.internal` or the bridge address for a host-side Ollama.
- No user info in the URL; no whitespace or control characters in any value; provider `[a-z0-9-]`; model `[A-Za-z0-9._:/@+-]`; URL without `$`, quotes or backslash; provider must be in the known list unless `--provider-unlisted` (warns; the canary decides).
- The key comes only from stdin or a file (8 to 4096 printable characters, no spaces or quotes). It is never read from argv or the environment, never printed, never logged (output and log pass through a redactor), and written only to `/root/private/hindsight-llm.env` and the snapshot copy. `curl` receives URL, bearer and body on stdin (`-K -`), so no secret is ever in a process list.
- Log `/var/log/hindsight-llm.log`: timestamp, command, outcome, provider, model, host. No keys.

## Things to know

- **Always include the override when you recreate Hindsight by hand.** Any `docker compose up` that omits `-f compose.llm.yaml` and `--env-file /root/private/hindsight-llm.env` silently goes back to General Compute. That includes the fallback command printed by `adapters/tools/hs-no-text.mjs`. `mem-backup` only stops and starts the existing container, so it is safe.
- **The probe is off by default in Hindsight** (`HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH`, default false; HTTP 404 when off). A 404, 405 or 501 is reported and skipped; the scratch-bank round trip is the proof. To make the probe active, add `HINDSIGHT_API_ENABLE_BANK_LLM_HEALTH: "true"` to the hindsight environment in `compose.4gb.yaml`.
- Per-operation overrides (`HINDSIGHT_API_RETAIN_LLM_*`, `REFLECT`, `CONSOLIDATION`, `MENTAL_MODEL_REFRESH`) win over `HINDSIGHT_API_LLM_*`. The tool warns when the running container has any; it does not touch them.
- Existing memories keep their embeddings; only fact extraction, consolidation and reflect change. A weaker model gives weaker facts for what is retained from now on.
- `vertexai`, `bedrock` and OAuth providers need variables this tool does not set; use `--provider-unlisted` only if you add those to the compose files yourself.

## Environment overrides (tests and non-default layouts)

`HLLM_ROOT` (prefix for every default path), `HLLM_COMPOSE_DIR` (`/opt/shared-memory/deployment`), `HLLM_SHARED_ENV` (`/root/private/shared-memory.env`, must hold `HINDSIGHT_API_KEY`), `HLLM_LLM_ENV` (`/root/private/hindsight-llm.env`), `HLLM_STATE_DIR` (`/var/lib/hindsight-llm`), `HLLM_LOCK` (`/var/lock/hindsight-llm.lock`), `HLLM_BACKUP_LOCK` (`/var/backups/memory/.mem-backup.lock`), `HLLM_LOG` (`/var/log/hindsight-llm.log`), `HLLM_DOCKER`, `HLLM_CURL` (command lines, split like a shell), `HLLM_API` (`http://127.0.0.1:8888`), `HLLM_BANK` (`default`), `HLLM_PROJECT` (`shared-memory-pilot`), `HLLM_CONTAINER` (`shared-memory-pilot-hindsight-1`), `HLLM_HEALTH_WAIT` (180 s), `HLLM_POLL` (3 s).

## Tests

`node --test deploy/hindsight-llm.test.mjs` runs the real script with a fake `docker` and a fake `curl` (one Node script, state in a temp dir) under a temp `HLLM_ROOT`. Needs Python 3 (`SM_PYTHON` to pick one). The mode checks (0600/0700) run only where the filesystem has POSIX modes; the lock tests use `fcntl` on Linux and `msvcrt` on Windows.
