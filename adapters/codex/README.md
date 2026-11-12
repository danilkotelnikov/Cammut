# Codex CLI: Cammut memory and rollout archive capture

`cm.mjs recall` injects the complete core project brief at SessionStart and Cammut notes at UserPromptSubmit. It prints plain
text to stdout, which Codex adds as developer context. Recalled text is labelled untrusted data; slash prompts print nothing.
The project comes from the basename of `cwd`. Notes already shown in the session are not repeated.

The shared config is `~/.claude/shared-memory.json`; `cammut.url` defaults to `http://127.0.0.1:7421` (the SSH tunnel to the gateway; set it to `https://cammut.example` style
values of your own host to go direct) and
`cammut.tokenEnv` defaults to `CAMMUT_MEMORY_TOKEN`. Put the token in that environment variable, never in the config.
`cammut.brief` and `cammut.recall` default to true; `cammut.briefTier` defaults to `core`.
Briefs are cached under `<stateDir>/brief` for five minutes. A failed fetch uses the cached brief marked stale, at any age.
Set `cammut.briefCache=false` to disable cache reads and writes (the older `briefCache.enabled=false` also works).
Version checks run at most once per five minutes; updates arrive whole as deltas, or a line asks you to call `memory_brief`
when history is unavailable. Briefs and their page lists are never truncated; `inject.warnTokens` (default 8,000) only logs
a size warning. Hook calls to Cammut time out after 1.5 s and fail open; repeated transport failures open a 45 s breaker.

`cm.mjs capture` records which rollout belongs to a Codex session and starts the shared drain (`sm.mjs drain`), which cuts, redacts,
encrypts with `age` and uploads the rollout to Cammut exactly like a Claude Code transcript (agent `codex`). It does nothing unless
`~/.claude/shared-memory.json` has `{"archive": {"enabled": true}}`. Capture prints nothing; ingest comes in a later plan.

Installed by `node adapters/install.mjs` as `~/.claude/scripts/shared-memory/codex/cm.mjs` (next to `common.mjs` one level up).

## Hooks to merge (you do this once, by hand)
Add these entries to `~/.codex/hooks.json`, in the same shape your existing entries use (event name, then a list of command
hooks), and trust them once in Codex with `/hooks`. Replace `<install dir>` with the folder where you installed the adapter, and adjust the node path to yours.

| Event | Command | Why |
|---|---|---|
| `SessionStart` | `node "<install dir>\codex\cm.mjs" recall` | inject the project brief |
| `UserPromptSubmit` | `node "...\codex\cm.mjs" recall` | recall relevant notes and check for brief updates |
| `SubagentStart` | `node "...\codex\cm.mjs" recall` | give a spawned agent the brief (and a recall by its task when the payload names it) |
| `Stop` | `node "<install dir>\codex\cm.mjs" capture` | after every turn: note the rollout, start the drain |
| `PreCompact` | `node "...\codex\cm.mjs" capture --flush` | cut the tail before context is compacted |
| `SessionEnd` | `node "...\codex\cm.mjs" capture --flush` | Codex allows this hook about 1 s: it only records and spawns the drain |

Example shape (merge into the existing file, do not replace it):

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node \"C:\\Users\\you\\.claude\\scripts\\shared-memory\\codex\\cm.mjs\" capture", "timeout": 10 } ] } ] } }
```

## Notes
- The hook payload carries `session_id`, `transcript_path` (can be null), `cwd` and `hook_event_name`. With a null path the rollout is
  found by scanning `~/.codex/sessions/**/rollout-*-<session_id>.jsonl`; `hook.log` says `capture codex Stop transcript_path=null located=yes`.
  Whether the Stop payload really carries the path, and whether the session id is always the file name's trailing UUID, are spec
  items 4 and 11 and are still **UNVERIFIED** on the real PC (this adapter was tested on synthetic rollouts only; no real rollout was read).
- Codex has no running-session registry, so the sweeper requires 24 hours of quiet (`retention.codexQuietMinutes`) before it touches
  a rollout, plus an unchanged size and mtime, plus (when Sysinternals `handle64.exe` is on PATH) no open handle.
- Opt-outs are the same as for Claude Code: `SHARED_MEMORY_BYPASS=1`, a `.no-memory` file in the project folder or any parent, and
  `archive.enabled=false` for capture. Use `cammut.brief=false` and `cammut.recall=false` to disable the Cammut reads.
- Without an MCP client, `sm.mjs brief --write [--project X]` writes a labelled brief to `<cwd>/.memory/HANDOFF.md`.
  Add `.memory/` to your global gitignore yourself. `sm.mjs brief` prints it instead. Handoff uses the `memory_handoff` tool.

## Autotrigger parity (see docs/HOOKS-AUTOTRIGGER.md)
Same matrix as Claude Code through the shared `recallFor`: noise caps (3 hits, 1,500 characters), the `abstained` verdict, windowed dedupe,
one "memory unavailable" line per session and the 3 s / 6 s prompt budget all apply. `cammut.only` / `SM_CAMMUT_ONLY=1` works here too.
Gaps: `SubagentStop` is not registered (a subagent's work is in the rollout the archive uploads; there is no separate low-trust entry);
`SubagentStart` and `SubagentStop` payload fields are taken from the Codex docs summary and are UNVERIFIED on a real run, so without a `prompt`
field the subagent gets the brief only; `SessionEnd` gets 1 s by default (up to 3 s), enough to record the rollout and start the drain.

## Explicit checkpoints
`cm.mjs checkpoint` (stdin JSON as for Claude Code, see `../claude-code/README.md`) saves a checkpoint as agent `codex`; `cm.mjs recall` on SessionStart prints the current `<checkpoint>` block before the brief. Same scopes, same fail-soft behaviour. `client-canary.mjs` is an opt-in check against an installed Codex CLI (`node adapters/codex/client-canary.mjs --run --codex-bin <path>`); it uses a synthetic loopback provider and is skipped by `node --test`.
