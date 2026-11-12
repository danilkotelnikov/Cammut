# Cammut core (branch `consolidate/20261016`)

One MCP endpoint with scoped tokens for every agent, plus shared project memory (notes, brief, recall, handoff), adapters for
Claude Code, Codex and Warp, and console pages to manage it. Built from `memory-v2` plus three lines of work; nothing is deployed
and nothing here was run against a live service.

## What is in it

| Area | Content | Source line |
|---|---|---|
| Gateway, console, archive, retention | as in `memory-v2` (Phases 1-2, note store, brief, REST `/v1/memory`, in-process `memory` MCP upstream) | `memory-v2` |
| Node security fixes (F2, F4, F5, F6, F7, F8) | `adapters/archive.mjs`, `sweep.mjs`, `common.mjs`, `tools/cammut-archive.mjs` | `mv2-p2-nodefix` |
| Brief and recall adapters (Task 3.7) | `<project-brief>` at SessionStart, `<brief-update>` mid-session, Cammut notes in recall, `sm.mjs brief [--write]`, Codex `cm.mjs recall`, Warp `adapters/warp/AGENTS.memory.md` + `mcp.json.example` | `mv2-3-7-adapters` |
| Console | Memory page (notes, brief, retract, archive alerts), Agent setup page, login method-error handling, `internal/admin/memory.go` | GPT union, selected files |
| Reliability | idempotent Hindsight retain (seeded `operation_id`, polling), recall-side redaction, failed spool items in `spool/failed/` (age-pruned, capture never stops), `chain-doctor` spool classification, Windows/Unix free-space split, free-space check now fails closed | GPT union + fixes |
| Tooling | `dev/fmt.sh` (gofmt on the VDS, changed files come back), `deploy/` helper scripts | new / union |

Fixes made on top (each with a test that failed first): spool never stops and failed items are parked (`sm.test.mjs`, `sweep.test.mjs`,
`chain-doctor.test.mjs`); Agent setup page scopes (`AgentSetup.test.tsx`, `TestTokensMintedByTheSetupPageServeTheHooks`); free-space
check fails closed (`TestUnreadableFreeSpaceRefusesInsteadOfAdmitting`); FTS recall query capped at 12 terms (`TestFTSQueryIsBounded`);
Codex README hook table kept (`cm.test.mjs`).

## Memory quality gates

Keyed state notes, the epistemic gate, an adaptive relevance gate with `abstained`, Hindsight recall controls, supersession candidates and the memory-calibrate tool
are described in `docs/MEMORY-GATES.md` (branch `feat/memory-gates`; adds a migration that must be renumbered at merge).

## Scopes

The REST API used by the hooks checks `memory/brief`, `memory/recall`, `memory/remember`. The MCP tools check `memory/memory_brief`,
`memory_recall`, `memory_remember`, `memory_handoff`, `memory_projects`. The Agent setup page mints both spellings. A token made by hand
with only one spelling works for only one of the two. Tokens made by the page expire after the chosen period (default 30 days, shown on the
page; "never" is offered). After expiry hooks fail open and memory stops silently.

Public exposure of `/mcp` (Cloudflare Tunnel or Caddy, Composio registration, hardening, what is tested and what is not): `docs/PUBLIC-ENDPOINT.md`.

## Parked, not in this branch (still on `snap/gpt-union-20261016`)

- Checkpoint/continuity protocol (`internal/memory/checkpoint*.go`, memoryapi checkpoint routes, `adapters/continuity*`,
  `claude-code/continuity-hook*`, capture-status, `acceptance-*.test.mjs`, `codex/client-canary*`): a second handoff channel with its own
  project identity and tables, no Warp support, extra hook latency. `memory_handoff` plus the brief covers the use case.

## Gates

Run from the repository root.

```
bash dev/gate.sh                 # gofmt -l, go vet, go test -race ./... on the VDS (about 5 minutes; run it in the background)
bash dev/fmt.sh                  # when gofmt complains: rewrites the files on the VDS and brings them back
bash dev/remote.sh 'GOOS=windows go build ./cmd/cammut'
node --test "adapters/**/*.test.mjs" "deploy/*.test.mjs"
cd web && npx vitest run && npm run build
```

Results of the last full run are in the final report of the consolidation, not here (this file does not assert a pass).

## Not done

- Hindsight provider switch (planned as a console form writing `HINDSIGHT_API_LLM_*` plus a canary; needs a check of the Hindsight version on the VDS first).
- Built-in agent (no code anywhere).
- Deploy of 0.3.0 (compose already references `cammut:0.3.0`; no deploy script with backup and rollback, `smoke.sh` does not cover `/v1/memory`).
- Plans 5-6 (scribe, consolidation).
- Doctor row for a 401/403 from the Cammut client; project-scoped token scopes.

## Acceptance steps before the production deploy (the user or the orchestrator, not done here)

1. Scratch stack, not production: run the 0.3.0 image on a second port. Create a token on the Agent setup page. `memory_remember`, then
   `memory_recall` over MCP and over REST (store-then-recall round trip). Retract a note on the Memory page and see the next brief drop it.
2. Claude Code and Codex SessionStart hooks against the scratch stack: the brief is injected; switch agents and read the handoff; stop the
   tunnel and see the stale cached brief; disable Hindsight and see capture queue in `spool/` and drain later; confirm the Hindsight version
   honours a client-supplied `operation_id` (otherwise items land in `spool/failed` as `operation_id_mismatch`).
3. A real Warp run: Warp has no hooks, so memory depends on the agent following `AGENTS.memory.md`; check that it reads the brief and leaves a handoff.
4. Decide the project scope of tokens: scopes have no project dimension, any token with `memory/remember` can change any project's notes. Acceptable
   for one user; decide before giving Warp or other less-trusted agents a write token.
5. Before adding a Git remote: scrub the VDS address in `dev/remote.sh` and `dev/remote-web.sh` and run a secret scan over the history.
6. Deploy 0.3.0 as the user's own step with a paste-ready script (backup, deploy, smoke, rollback).
