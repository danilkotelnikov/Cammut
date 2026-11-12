# Memory quality gates

Five changes to how Cammut stores and returns memory, from the memory-lab screen (`_memory-lab/REPORT.md`, sections 4 and 6). They target four
problems: stale facts that outlive their replacement, recall that answers with weak matches, guesses stored as if they were facts, and duplicate
notes. Nothing here is deployed and nothing was run against a live Cammut or Hindsight; every number below comes from the synthetic
tests in this repository.

| # | Gate | Where it lives |
|---|---|---|
| 1 | Keyed state notes | `internal/memory/{store,service}.go`, REST `/v1/memory/{notes,history}`, MCP `memory_remember key`, `memory_history`, console Memory page |
| 2 | Epistemic gate | same files; `memory_confirm` (MCP), `POST /v1/memory/confirm` (REST), console Confirm button |
| 3 | Relevance gate | `internal/memory/{rank,relevance}.go`, golden set `internal/memory/testdata/golden`, `adapters/tools/memory-calibrate.mjs` |
| 4 | Hindsight recall controls | `adapters/hs-recall.mjs` (the one-line wiring into `sm.mjs` is the hooks line of work) |
| 5 | Supersession candidates | `internal/memory/review.go`, console review list |

## Schema change

One migration, appended as the next index (user_version 4 on top of the three that exist on `consolidate/20261016`). The branch `feat/llm-gateway`
adds a migration too, so **the orchestrator renumbers at merge**: the order of the entries in the `migrations` slice in `internal/store/migrate.go`
is the only thing that matters, and the SQL does not refer to any other table.

```
ALTER TABLE mem_notes ADD COLUMN note_key TEXT;                       -- nullable; the column is note_key because KEY is an SQL keyword, the JSON field is "key"
ALTER TABLE mem_notes ADD COLUMN epistemic TEXT NOT NULL DEFAULT 'inferred' CHECK(epistemic IN ('observed','inferred','speculative'));
CREATE UNIQUE INDEX mem_notes_key_active ON mem_notes(project, note_key) WHERE note_key IS NOT NULL AND status='active';
CREATE INDEX mem_notes_key ON mem_notes(project, note_key) WHERE note_key IS NOT NULL;
CREATE TABLE mem_review(id, project, note_id, candidate_id, cosine, status pending|applied|dismissed, created_at, resolved_at, UNIQUE(note_id, candidate_id));
```

Notes that exist before the migration get `epistemic='inferred'` (an honest default: nobody recorded who vouched for them) and no key. `inferred`
behaves exactly like the old behaviour in the brief and in recall, so nothing changes for them until a person confirms or retracts them.
The migration is additive; rolling back means restoring the database snapshot taken before the deploy (step 2 below).

## 1. Keyed state notes

A note may carry a `key` (1 to 80 characters, `[A-Za-z0-9][A-Za-z0-9._:-]*`, for example `cammut.deployed` or `pref.work-style`). Among the active notes of
a project a key is held by exactly one note (a unique index, so concurrent writers cannot both win). `memory_remember` / `POST /v1/memory/notes` with a key
that an active note already holds retires the old note (`status=superseded`, `superseded_by` set) and stores the new one with `supersedes` pointing back,
in one transaction. The chain stays in the table.

- `GET /v1/memory/history?project=P&key=K` and MCP `memory_history` list every version, newest first (scope `memory/recall` and `memory/memory_history`).
- The brief and recall show only active notes, so after `cammut.deployed` = 0.2.0 then 0.3.0 they show only 0.3.0. The scenario is a test:
  `TestKeyedStateNoteSupersedesThePreviousVersionAndHistoryKeepsBoth`, repeated over REST, MCP and the console.
- Re-activating a retracted note whose key has since been taken is refused with a 400 (no 500, no second holder).
- If a call gives both `key` and `supersedes`, both old notes are retired; only the last pointer is kept on the new note.
- Mirroring a keyed note to Hindsight with `document_id="state:<key>"` (REPORT item 1) is not built: no Cammut code writes to Hindsight today.

## 2. Epistemic gate

`epistemic` is `observed` (a person saw or said it), `inferred` (an agent concluded it) or `speculative` (a guess, a plan, a budget).

- Agents write `inferred` by default and may write `speculative`. They cannot write `observed`; the console writes `observed` by default.
- `observed` needs a person (console) or a REST token that holds the scope `memory/observe` (a `memory/*` token has it). MCP cannot set it: the gateway does not pass
  token scopes to the in-process memory server, and changing the gateway was out of this branch's scope.
- `speculative` notes are stored, redacted first like every note, and shown in the console. They never enter the brief (core, full, pages, accounting) and recall
  and `GET /v1/memory/notes` return them only with `include_speculative: true` (the console always lists them). `memory.Forwardable(note)` is false for them: any code that forwards notes to Hindsight must check it.
- `memory_confirm` (MCP, scope `memory/memory_confirm`) and `POST /v1/memory/confirm {id, epistemic}` (REST, scope `memory/remember`) upgrade a note:
  speculative to inferred for agents, anything to observed for a person or a `memory/observe` token. Nothing is ever downgraded. The console button
  "Confirm" marks a note observed.
- The Agent setup page mints `memory/memory_history` (read) and `memory/memory_confirm` (write). Tokens made before this change lack them; add them with
  `cammut token scopes` or re-create the token.

## 3. Relevance gate

The old recall matched every word of the query (stop words included) by prefix in full-text search and fused it with vectors above a fixed cosine floor of 0.3.
Any question therefore returned its "least bad" notes. Now:

1. The query is reduced to content terms (English and Russian stop words dropped, one-letter words dropped). A query with none abstains.
2. A note is returned when at least `need(n)` of the n content terms occur in it as word prefixes (all of them for one or two terms, 2 for three to six, then one more per four terms), or
   its vector's cosine reaches the adaptive threshold tau, or both arms agree (one term occurs and the cosine is within 0.04 of tau).
3. tau is 0.48 for a short query (fewer than 3 terms or at most 12 characters), 0.38 for a normal one and 0.30 for a long one (7 terms or more than 50 characters), never below 0.22.
   When the best note leads the second best by 0.12 it alone is admitted 0.06 lower. When the best note is a clear match (cosine at least 0.6), notes with no word match whose cosine
   is under 60% of it are not added.
4. If nothing is left the answer is empty and carries `"abstained": "below_threshold"` (REST and MCP; the field is absent otherwise). It is not an error.
5. Without an embedder (or when it is down or slow) only the word rule applies, as before.

Server knobs: `CAMMUT_RECALL_GATE="base,short,long"` in the container environment (for example `0.38,0.48,0.30`, with short >= base >= long, all in [0.22, 1)). The other constants are `DefaultGate` in
`internal/memory/relevance.go`.

### The golden set

`internal/memory/testdata/golden` has 24 invented notes about an invented build tool and 40 queries: 20 on topic with the notes that must come back (15 answerable by words, 5 paraphrases that need
vectors) and 20 off topic that must return nothing (including five hard negatives that share one word with a note, and a query made only of a stop word). `go test ./internal/memory -run Golden` runs it twice: full-text only and with a deterministic stand-in embedder
(`conceptEmb` in `golden_test.go`: hashed words plus a topic lexicon, ambiguous words left out). `GOLDEN_REPORT=1 go test ./internal/memory -run Golden -v` prints the numbers.

| | precision | recall | off-topic queries answered |
|---|---|---|---|
| old ranker, full-text only | 0.23 | 1.00 (15/15) | 20 of 20 |
| old ranker, with vectors | 0.25 | 1.00 (20/20) | 20 of 20 |
| new gate, full-text only | 1.00 | 1.00 (15/15) | 0 of 20 |
| new gate, with vectors | 1.00 | 1.00 (20/20) | 0 of 20 |

Read these as a regression net, not as a measurement: the notes and queries are small and written by the same hand as the gate, and the stand-in embedder is not a sentence model. The real cosines of the
production embedder are unknown until the next section is done.

### Calibrating on real data (counts only)

1. Write about 40 labelled queries in a file outside the repository: `[{"q": "...", "expect": ["note.key"]}, {"q": "...", "expect": []}]`. Use keys (or ids); an empty list marks an off-topic query.
2. With the tunnel up, in PowerShell 7 (the token is typed, not stored in history):
   ```
   $env:CAMMUT_URL = 'http://127.0.0.1:7421'          # the local end of your tunnel; adjust the port
   $env:CAMMUT_MEMORY_TOKEN = Read-Host -MaskInput 'recall token'
   node adapters\tools\memory-calibrate.mjs --queries $HOME\queries.json --project <project>
   ```
   It prints, for example: `on-topic: answered=18 abstained=2, expected notes found 17/20`, `off-topic: abstained=19 leaked=1 (query #34)`, `hits per query: 0:21 1:12 2:5 3+:2`. It never prints a query, a title, a body or a key.
3. Too many leaks: raise the three numbers of `CAMMUT_RECALL_GATE`. Too many missed paraphrases: lower `base` and `long`. Change the variable in the server's env file, restart the container, run again, compare the counts.
   Keep the golden set green after a change of defaults in code.

## 4. Hindsight recall controls

Cammut's own code never queries Hindsight; the only client that does is `adapters/claude-code/sm.mjs` (`hsRecall`), which already sends `types`. `adapters/hs-recall.mjs` adds
`recallBody(query, opts)` (types observation, world, experience; `prefer_observations: true`; `min_scores`), `parseMinScores` (`semantic=0.3,final=0.1` or JSON, env `SM_HS_MIN_SCORES`) and
`recallWithFallback(send, body)`, which retries once without the new fields on HTTP 400 or 422 and skips them for ten minutes. The default floor is `{semantic: 0.3}`, the same as `MIN_SEMANTIC` in `sm.mjs`.
`min_scores` keys, from the Hindsight source in the lab: `semantic`, `keyword` (inside their own arm), `reranker`, `final` (after ranking; the reranker's absolute scores are not calibrated across queries, so it is not the default).

Wiring (the hooks line of work owns `sm.mjs`, so it is not done here):
```js
import { recallBody, parseMinScores, recallWithFallback } from '../hs-recall.mjs';
// in hsRecall:
const send = (body) => call(cfg, 'hs', 'POST', `/v1/default/banks/${encodeURIComponent(cfg.hs.bank)}/memories/recall`, body, cfg.recallMs);
const r = await recallWithFallback(send, recallBody(query, { minScores: parseMinScores(process.env.SM_HS_MIN_SCORES) }));
```
Mental models refresh after consolidation in delta mode with `trigger: {"mode": "delta", "refresh_after_consolidation": true}` (mutually exclusive with `refresh_cron`).
This is a Hindsight-side setting; apply it to a scratch bank first.

## 5. Supersession candidates

A note written without a key, without `supersedes` and not speculative is compared (cosine of its embedding) with the same agent's active notes of the same project and kind. Never across projects, kinds or agents.

- cosine >= 0.92 and the same numbers in both texts: a duplicate. It is not stored. REST answers 200 `{"stored": false, "duplicate_of": "<id>", ...}`, MCP returns the same JSON. Pass `force: true` to store it anyway.
  "Same numbers" matters: "version 0.2.0" and "version 0.3.0" are 0.97 alike and are an update, not a duplicate.
- cosine >= 0.85 (the top three): the note is stored and the answer carries `possible_supersedes: [{id, title, cosine}]`; each pair is queued in `mem_review`.
- Nothing is applied automatically. The console Memory page shows "Suggested replacements" with "Replace the old note" (the old one becomes superseded) and "Keep both". API: `GET /api/v1/memory/review?project=`,
  `POST /api/v1/memory/review/{id}/apply|dismiss` (session and CSRF header required).
- The check embeds the new note synchronously (at most 2.5 s). If the embedder is down the note is stored without the check. Go callers of `Service.Remember` skip the duplicate refusal (they store what they are given); `RememberFull` is what REST and MCP use.
- Thresholds: `DefaultDedup` in `internal/memory/review.go`.

## What was run, and what was not

Run locally, on Windows, with the Go 1.26.0 toolchain from the module cache (the same version as the `golang:1.26` image): `gofmt -l`, `go vet ./...`, `go test ./...`, `npx vitest run` and `npx tsc --noEmit`, `node --test "adapters/**/*.test.mjs" "deploy/*.test.mjs"`.
Ten Go tests fail on Windows on the base commit as well (file-mode checks in `cmd/cammut`, `internal/archive`, `internal/vault`); they are unchanged. Not run: `go test -race` (needs cgo), `dev/gate.sh` (ssh to your server), anything against a live service.

## Steps for you (production)

Replace `<server>` and paths with your own. Nothing below was executed.

1. **Merge.** The orchestrator renumbers the migration (see Schema change), builds the image and runs `bash dev/gate.sh`.
2. **Back up first.** On the server: `docker exec cammut-cammut-1 /cammut admin db-snapshot -out /data/snapshots/pre-gates.db -keep 3`.
3. **Deploy** with your usual deploy of the new image. After it starts, `PRAGMA user_version` has gone up by one; the console Memory page loads; `GET /v1/memory/status` answers.
4. **Optional gate numbers.** Add `CAMMUT_RECALL_GATE=0.38,0.48,0.30` to `/root/private/cammut.env` and restart the container; without it the defaults apply.
5. **Scopes.** Tokens from the Agent setup page made earlier lack `memory/memory_history` and `memory/memory_confirm`. Re-create them on the page, or add the scopes.
6. **Hindsight.** Have the hooks line wire `hs-recall.mjs` into `sm.mjs`; set `SM_HS_MIN_SCORES` if you want another floor; set delta refresh on the mental models you use.
7. **Calibrate** (section 3) once you have real notes and a labelled query list.
