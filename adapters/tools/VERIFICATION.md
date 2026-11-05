# Verification log (phase 1)

Live results are pasted here by whoever runs the tools; counts, statuses and ids only, never text.

## Task 1.2: Hindsight no document text

Offline reading of the Hindsight 0.10.x documentation (2026-10-11), before any live run:

- `HINDSIGHT_API_STORE_DOCUMENT_TEXT=false` sets `documents.original_text` to NULL and stores `chunks.chunk_text` as empty (the chunk content hash is kept for dedup). The configuration reference lists the variable as hierarchical and overridable per bank through the config API; one other page of the same site calls it a static server-level setting. The two statements disagree, so the live `verify` decides.
- The bank config PATCH body is documented as `{"updates": {...}}`, not the flat object the plan shows. The tool sends the documented form first and falls back to the flat form only on a rejection; `verify` prints which form was accepted.
- `HINDSIGHT_API_RECALL_INCLUDE_CHUNKS` is documented as a knob of the internal recall used by the reflect agent and mental-model refresh. The user-facing recall API returns chunks only when the request has `include.chunks` (an object, `{"max_tokens": N}`, not a boolean); the tool requests it so the check is meaningful. Setting `recall_include_chunks=false` is harmless but is not what keeps text out of recall responses.
- `update_mode="append"` is rejected while text storage is off; the adapter never uses it (it replaces by `document_id`).
- Endpoints present in the API reference: `GET /documents`, `GET /documents/{id}`, `GET /documents/{id}/chunks`, `GET /v1/default/chunks/{chunk_id}`. The response shape of the chunk list is not documented; the tool accepts a bare array, `{items}` or `{chunks}`.

Live `verify` run 2026-10-11 (scratch bank, deleted afterwards): config patch accepted in the documented `updates` form; `original_text` empty; chunks listed with empty text; recall returns no chunk text; facts still extracted (recall results=6) -> pass. The first attempt reported `facts_extracted=false` because the tool queried the hash marker, which has no meaning to a semantic search; the query is now a plain question about the synthetic text. `apply --yes` on `alice-shared` then resolved `store_document_text=false`, `recall_include_chunks=false`. Note: the setting only affects future retains; the 61 existing documents keep their stored text until they are re-ingested or purged in plan 8.
Live `snapshot` run 2026-10-11: hindsight total_nodes=1699 total_links=19065 total_documents=61 pending_operations=3 failed_operations=2 total_observations=609; openviking sessions=13 history_bytes=0 memories_status=200 (baseline file written).

## Task 1.4: OpenViking archive listing

Live dry run 2026-10-11: 12 session directories listed (10 `cc-*`, 2 `mcp-store-*`), each history_bytes=0 files=0; memories total=22; no proof recorded yet, so `--yes` is refused until `--test-one` has passed. Nothing deleted.

## Task 1.6: Chain doctor

Offline: the doctor and the end-to-end harness (`adapters/claude-code/e2e.test.mjs`) run against fake servers in `node --test`.
Live run 2026-10-11: before install = the three expected findings; after `adapters/install.mjs` and `hs-no-text.mjs apply --yes` every line PASS (5 hooks registered, hashes match; bank override active; `openviking-capture` capture=false). Command: `node adapters/tools/chain-doctor.mjs` (read-only; needs the two API keys in the environment; prints `key=set|MISSING`, never a value; exit 1 on any FAIL).
Expected before the user steps: `hooks-registered` WARN (no `.installed.json`, installed sm.mjs older than the repo copy), `hindsight-bank` FAIL (`store_document_text=true`), `openviking-capture` FAIL (`capture=true`). All PASS after user actions 1-2.
