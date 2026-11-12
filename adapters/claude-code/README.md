# Automatic shared memory (Hindsight + OpenViking)

Installed 2026-10-10. Registered in `~/.claude/settings.json` (SessionStart, UserPromptSubmit, SubagentStart, Stop, SubagentStop, PreCompact, SessionEnd) by `adapters/tools/install-hooks.mjs`.
The full autotrigger matrix, the noise and latency controls, Cammut-only mode (`cammut.only` / `SM_CAMMUT_ONLY=1`) and the PostToolUse decision are in `docs/HOOKS-AUTOTRIGGER.md`.
One dependency-free hook file, `sm.mjs`, with its siblings `common.mjs` (config, Cammut client, redaction, atomic writes) and `archive.mjs` (encrypted raw archive); tests: `node --test "adapters/**/*.test.mjs"` from the repo root.

| Hook | Command | What it does |
|---|---|---|
| SessionStart, UserPromptSubmit | `sm.mjs recall` | Queries Hindsight (bank `default`) and OpenViking, injects a `<shared-memory>` block (labelled untrusted data) as additional context. ~1.5 s. |
| SubagentStart | `sm.mjs recall` | Brief plus recall by the subagent's task text, so a spawned agent is not amnesiac (additionalContext, <= 10,000 characters). |
| SubagentStop | `sm.mjs capture` | The subagent's final report as a low-trust journal entry (`epistemic:inferred`); never spooled. |
| Stop | `sm.mjs capture` | Reads the new part of the transcript, keeps user and assistant prose only, redacts secrets, and spools a chunk once 3 turns or 6000 chars have accumulated. |
| PreCompact, SessionEnd | `sm.mjs capture --flush` | Same, but flushes everything left (compaction is where context is lost). |
| (detached) | `sm.mjs drain` | Delivers spooled chunks to Hindsight; retries later if the SSH tunnel is down. Hindsight gets one document per chunk (`cc-<session>-<offset>-<n>`, so a retry replaces rather than duplicates). OpenViking session capture is **off by default** (see below). Then, when `archive.enabled`, cuts the transcript into segments, encrypts them with `age` and uploads them (below). |

State lives in `~/.claude/state/shared-memory/` (`hook.log`, `spool/`, `sessions/`, `outbox/`, `breaker.json`). `node sm.mjs status` shows health, spool size, breaker and the archive line.

## What the spool holds (phase 2)
A spool item is a **reference** `{file, start, end}` to a byte range of the agent's own transcript, never text. The drain reads the range when it sends, builds the messages in RAM and splits them into chunks (`cc-<session>-<start>-<n>`); a partial delivery resumes at the next chunk. If the file is gone or shorter than `end`, or Hindsight refuses the chunk for good, or the spool already holds 300 items, the item moves to `spool/failed/` (`failure` says why: `source_gone`, `retain_<status>`, `operation_id_mismatch`, `spool_overflow`, `retry_limit`) and `hook.log` says `source gone <session>` where it applies. Capture never stops because of it; failed items are deleted after 14 days, `chain-doctor` counts them, and until then they still stop the sweeper from deleting their transcript. Hindsight retain is asynchronous: the drain sends a seeded `operation_id` (derived from bank and chunk), remembers it in the item and polls `/operations/<id>` on later drains, so a lost response never produces a second retain. This needs a Hindsight that honours a client-supplied `operation_id` (UNVERIFIED for the version on the VDS; a server that answers with another id fails the item as `operation_id_mismatch`). Items written by the previous version (with `messages`) are still delivered.

## Encrypted raw archive (off until `archive.enabled` is true)
`~/.claude/shared-memory.json`: `{"archive": {"enabled": true}}` (defaults: `recipientsFile ~/.claude/shared-memory-recipients.txt`, `segmentBytes 1048576`, `flushIdleMs 600000`, `redact true`, `outboxMaxBytes 536870912`; Cammut URL and the token variable names under `cammut`). The hooks only record the session in `sessions/<id>.json` (`arch`: file, fingerprint, acknowledged ranges, cursor) and start the drain; the drain cuts whole lines (about 1 MiB), redacts every JSON string value, replaces base64 images with stubs, compresses, encrypts with `age -R recipients`, keeps the ciphertext in `outbox/` and uploads it with `PUT /v1/archive/segments/<id>`. A range counts as archived only after the server answered 200/201; the cursor then advances over contiguous acknowledged ranges. `409 content_mismatch` (the bytes of that range changed since it was archived) marks the range changed and the file un-deletable; other 4xx retry 5 times and then stay as `failed` in the outbox; 429/5xx/network keep everything for the next drain. Nothing is deleted by this code. `.no-memory`, `SHARED_MEMORY_BYPASS=1` and `archive.enabled=false` keep a session out of the archive. Subagent files (`<session>/subagents/*.jsonl`) are archived once the session is flushed or idle for 10 minutes; `tool-results/` and `file-history/` are not archived.

## Controls
- Off for one shell: `SHARED_MEMORY_BYPASS=1`.
- Off for a project: create an empty `.no-memory` file in the project folder (or any parent).
- Per service: `~/.claude/shared-memory.json`, e.g. `{"openviking": {"capture": true}, "hindsight": {"recall": true}}` (also `url`, `bank`).
- **OpenViking session capture is off by default** (memory v2, phase 1): every OpenViking session commit copies the raw messages into `history/archive_NNN/messages.jsonl`, i.e. raw dialogue at rest. Only an explicit `{"openviking": {"capture": true}}` turns the old path back on; any other value keeps it off. Recall from OpenViking is unchanged. `sm.mjs status` prints `openviking: capture=false (raw session archives are not written)`. Notes will reach OpenViking from phase 5 through `content/write`, not through session commits.

## Design rules
- Every entry point fails open: a dead tunnel or server logs one line and exits 0. A 45 s circuit breaker stops repeated waits.
- Redaction runs before truncation and on the recall query too (tokens, keys, `password: x`, URL credentials, PEM blocks, long hex, high-entropy strings). It is a floor, not a guarantee: do not paste secrets into chat.
- Recall injects a Hindsight note only if it has a real semantic match (score >= 0.3). Hindsight always returns its top hits, so without this an unrelated new project received unrelated notes; with it an irrelevant prompt injects nothing (measured 2026-10-11: unrelated prompt -> keyword-only hits, no semantic score; relevant prompts -> 0.34-0.70). OpenViking has its own 0.45 cutoff.
- Tool output, thinking, subagent traffic and our own injected blocks are never captured.
- No `process.exit()`: on Windows it can crash inside libuv after fetch and turn a good run into exit 127.
- Needs the user env vars `SHARED_MEMORY_HINDSIGHT_API_KEY` and `SHARED_MEMORY_OPENVIKING_API_KEY` and the SSH tunnel to 127.0.0.1:8888 / :1933.

## Source of truth
The canonical copy of these files lives in the Cammut repository under `adapters/claude-code/`. Edit them there and install with
`node adapters/install.mjs` (it refuses to overwrite a file edited in place unless `--force` is given). Do not edit the installed directory by hand.

## Explicit checkpoints
`sm.mjs checkpoint` takes one JSON object on stdin that the agent wrote itself: `cwd`, native `session_id`, a unique `source_revision`, `parent_revision` (the previous revision, `""` for the first), `goal`, and the arrays `decisions`, `open_tasks`, `next_actions`, `artifact_refs`, `validation` (at most 30 items of 500 characters each; secrets are redacted). It posts to `POST /v1/memory/checkpoints` (token scope `memory/remember`). If Cammut does not answer, the checkpoint is queued under `checkpoints/<project_id>/<workspace_id>/` and replayed in causal order on the next start.

`sm.mjs recall` on SessionStart reads `GET /v1/memory/checkpoints` (scope `memory/brief`) in parallel with the brief and puts a `<checkpoint>` block, labelled untrusted data, in front of the other context. The project ID comes from the Git common directory and the workspace ID from the worktree root; `cammut.projectMappings` maps absolute paths to shared `p_...` IDs. Both commands fail soft: they log one line and exit 0, and a down server never delays the session beyond the hook budget. The receipt under the same directory says `served` until stdout accepted the bytes, then `emitted`; neither means the model used it.
