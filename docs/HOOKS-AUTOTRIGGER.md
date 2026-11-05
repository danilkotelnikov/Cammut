# Memory autotrigger matrix (branch `feat/hooks-autotrigger`)

Goal (user order 2026-10-17): memory fires by itself at every useful moment, with no manual calls and without adding noise.
Nothing here was run against a live service: every test uses fake servers and synthetic data. Items marked UNVERIFIED need one real session.

## 1. The matrix (Claude Code)

`sm.mjs` has two entry commands; the event name inside the hook payload decides what happens, so settings.json stays simple.

| Event | Command | Injects? | What it does | Gate / budget |
|---|---|---|---|---|
| `SessionStart` (every source: startup, resume, clear, compact, fork) | `sm.mjs recall` | yes | Cammut project brief (cached 5 min, stale copy when Cammut is down); with no brief, a status recall from Hindsight/OpenViking. After `compact` and `clear` the "already shown" state is reset, so the brief and the hits are primed again | 1.5 s |
| `UserPromptSubmit` | `sm.mjs recall` | yes | Gated recall by the prompt text (Cammut notes, plus Hindsight/OpenViking unless Cammut-only), brief delta when the brief changed | typical <= 3 s, hard abort 6 s (section 2) |
| `SubagentStart` | `sm.mjs recall` | yes | Brief plus recall by the subagent's task text, as `hookSpecificOutput.additionalContext` (`hookEventName: "SubagentStart"`, at most 10,000 characters). Plain stdout would not be added by Claude Code | <= 3 s; stays silent when nothing is found or Cammut is down |
| `Stop` | `sm.mjs capture` | no | New transcript text -> redacted -> spool -> detached drain | local only |
| `SubagentStop` | `sm.mjs capture` | no | The subagent's final report (`last_assistant_message`) as a low-trust journal entry, `epistemic: inferred` (section 4) | <= 2 s, nothing is spooled |
| `PreCompact`, `SessionEnd` | `sm.mjs capture --flush` | no (these events cannot inject) | Flush everything left, start the drain, register the archive tail | local only; `SessionEnd` shares a 1.5 s default budget, the hook's own `timeout` (5) raises it |
| `PostToolUse` | not registered | | See section 5: decided against | |

Facts used (code.claude.com/docs/en/hooks, fetched 2026-10-17): `SubagentStart` stdin carries only the common fields plus `agent_id` and
`agent_type` (no task text); `SubagentStop` carries `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path` and `last_assistant_message`;
context injection works for SessionStart, UserPromptSubmit, PostToolUse, SubagentStart, SubagentStop and Stop; PreCompact/PostCompact/SessionEnd cannot inject.

## 2. Noise and latency controls

All defaults can be overridden in `~/.claude/shared-memory.json`.

| Control | Default | Key |
|---|---|---|
| Hits per injection | 3 (Cammut notes first, then Hindsight, then OpenViking) | `inject.maxHits` |
| Characters per injection (whole block, wrapper included) | 1,500; whole hits are dropped from the end, a single hit is shortened | `inject.maxChars` |
| Server verdict `abstained: true` in the Cammut recall answer | the Cammut notes are discarded even if the answer lists some. The field is optional (an older server never sends it) | none |
| Local floor for Cammut notes | relative score >= 0.55 **and** one word of the prompt (prefix match, stop words removed) in the note's title, body or tags. A note without a `score` (older server) is kept | `inject.minScore`, `inject.requireOverlap` |
| Hindsight / OpenViking floors | unchanged: semantic score >= 0.3, OpenViking score >= 0.45 | |
| No repeat of a hit | not again within the last 20 prompts of the same session; reset by `PreCompact`, `SessionStart` with source `compact` or `clear` | `inject.dedupePrompts` |
| Budget | each source is given 3 s from the start of the prompt hook (Cammut 1.5 s); anything later is dropped | `hooks.promptBudgetMs` |
| Hard abort | at 6 s the hook prints nothing and exits 0, whatever a server or a lock does | `hooks.promptAbortMs` |
| Fail open | every error exits 0 without blocking the prompt. If every source that was asked failed, one line `Shared memory unavailable this session ...` is injected, **once per session** | |

Why the local floor needs the word-overlap rule: Cammut's recall score is normalised to the best hit of the answer, so the best of a bad
lot always scores 1 and the score alone cannot say "nothing relevant". The server-side `abstained` flag (being added on `feat/memory-gates`)
is the real answer; the overlap rule is the client-side safety net. The price: a hit that is related by meaning but shares no word with the
prompt is not injected (`inject.requireOverlap: false` turns the rule off). `abstained` suppresses the Cammut notes only; in the default
mode Hindsight still answers by its own floor, in Cammut-only mode it means nothing is injected.

## 3. Cammut-only mode

`cammut.only: true` in `~/.claude/shared-memory.json`, or `SM_CAMMUT_ONLY=1` in the environment (the variable can only switch it on).
Default behaviour is unchanged when neither is set.

- Recall, brief, brief updates and the `SubagentStart` recall go through `/v1/memory` with the token from the variable named by
  `cammut.tokenEnv` (default `CAMMUT_MEMORY_TOKEN`); the session id travels in `X-Memory-Session`.
- Hindsight and OpenViking are never contacted: no recall, no retain, no `/health` probe in `sm.mjs status` (it prints a `cammut-only` line).
- Capture queues nothing for them either; the cursor still advances. The raw archive (`archive.enabled`) is untouched and is the capture path
  in this mode. Items the default mode queued earlier stay in `spool/` (not sent, not dropped) and drain after you switch back.
- With a missing or rejected token the hooks fail open and the once-per-session unavailable line appears.
- Gaps: Cammut has no journal store, so a `SubagentStop` report is written only when `hooks.subagentNotes` is on (a `finding` note, importance 1,
  tags `epistemic:inferred`, `source:subagent`); the user tools in `adapters/tools/` (`hs-client.mjs`, `ov-client.mjs`, `chain-doctor.mjs`) are separate
  programs and still talk to the legacy services when you run them.

## 4. Subagents

`SubagentStart` gets no task text from Claude Code, so `sm.mjs` looks for it in this order: a `prompt` field (if a later version adds one), the first
user message of `agent_transcript_path`, then the latest `Agent`/`Task` tool call in the last 256 KiB of the main transcript whose `subagent_type`
equals `agent_type`. With no task found only the brief is injected. UNVERIFIED on a real session: whether the main transcript already holds the tool
call when the hook runs; two parallel subagents of one type can get the wrong task (the latest wins). The brief is cut so the whole context stays under
10,000 characters; the injection does not touch the parent session's state.

`SubagentStop`: the report is redacted, capped at 3,000 characters, skipped when shorter than 200 characters (`hooks.subagentMinChars`), when
`agent_type` is empty (Claude Code's own internal agents), when `stop_hook_active` is true, or when that `agent_id` was already stored. It is sent to
Hindsight immediately (2 s timeout) with tags `source:claude-code-subagent`, `epistemic:inferred`, `project:<name>` and a first line saying it is an
unverified AI report. It is not spooled (the spool holds byte ranges of transcripts, never text), so a dead tunnel loses it, which is the right price for
low-trust text. `hooks.subagent: false` switches both subagent hooks off.

## 5. PostToolUse: decided against

A selective hook (`matcher: Bash`, `if: Bash(git commit *)` or deploy commands) was considered and not built:

1. Value is low. Stop/PreCompact capture already carry the assistant's own account of a commit or deploy, and `git log` is the authority for commit facts.
2. Cost is real: one `sm.mjs` start measured 203-237 ms on this PC (Node cold start with imports), per matching call, inside the tool loop.
3. There is no good destination for an "inferred candidate": Hindsight would duplicate what Stop already retains, and Cammut notes would fill the brief (the same reason `subagentNotes` is off).
4. Injecting context after a tool call adds mid-turn noise, which is the complaint this work answers.

Revisit when Cammut has a reviewed inbox for candidate notes; the design then is an `async: true` PostToolUse hook limited by `if` filters, so it costs no model latency.

## 6. Parity

| Event | Claude Code | Codex (`adapters/codex/cm.mjs`) | Warp |
|---|---|---|---|
| SessionStart / UserPromptSubmit recall | yes | yes (same `recallFor`, plain stdout) | no hooks: `AGENTS.memory.md` tells the agent to call `memory_brief` and `memory_recall` |
| SubagentStart recall | yes | registered as `cm.mjs recall`; brief only unless the payload has a `prompt` (fields UNVERIFIED) | the rules file tells the agent to copy brief lines into a sub-agent's task |
| Stop / PreCompact / SessionEnd capture | yes | yes, through the rollout archive (`SessionEnd` gets 1 s by default, up to 3 s) | agent calls `memory_handoff` itself |
| SubagentStop capture | low-trust journal entry | not registered (the rollout archive carries the subagent's work) | none |
| Noise caps, unavailable line, Cammut-only | yes | yes (shared code) | n/a |

## 7. Installing

`adapters/tools/install-hooks.mjs <settings.json>` prints a unified diff of the `hooks` block and names the backup file; it writes only with
`--apply`, is idempotent, updates existing `sm.mjs` handlers in place and keeps every other hook (the Terax notification hooks) and setting. Tests
run on temporary copies; it was not run against the real settings file.

```powershell
# 1. copy the changed hook files into ~/.claude/scripts/shared-memory (refuses to overwrite a hand-edited file unless --force)
node adapters\install.mjs --check
node adapters\install.mjs
# 2. look at the diff, then apply (a backup settings.json.bak-<time> is made next to the file)
node adapters\tools\install-hooks.mjs "$env:USERPROFILE\.claude\settings.json"
node adapters\tools\install-hooks.mjs "$env:USERPROFILE\.claude\settings.json" --apply
# 3. start a new Claude Code session (hooks are read at start); /hooks lists what is registered
```

Optional `~/.claude/shared-memory.json` additions: `{"cammut": {"only": true}, "inject": {"maxHits": 3}, "hooks": {"subagentNotes": false}}`.

## 8. Server-side Hindsight autotriggers (created 2026-10-17, bank `alice-shared`)

Recorded from the order of 2026-10-17; this branch did not read them back (no call to the live Hindsight was made), so check them with
`list_mental_models`, `list_directives` and `get_bank`.

- Mental models: `state-vds-vpn-cammut`, `working-preferences`, `open-decisions`, `active-projects`, created with the trigger: delta mode,
  `refresh_after_consolidation`, minimum interval 3,600 s. They refresh by themselves after each consolidation, so the client hooks never trigger a refresh.
- Two directives (standing rules for what the bank retains and how it answers) and the retain and observations missions (what to extract and what to
  consolidate). Their text lives in the bank and is not copied here.
