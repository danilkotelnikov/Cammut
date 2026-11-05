---
title: Limits
order: 11
kicker: Honest list
description: What Cammut does not do yet, and which claims are not verified.
---

# Limits

A tool you trust with your keys should tell you where it stops. This list comes from the project's own review notes.

## By design for now

- **One operator.** Token scopes have no project dimension: any token with `memory/remember` can change any project's notes. Fine for one person; decide before giving a less-trusted agent a write token.
- **HTTP upstreams only.** Stdio MCP servers are on the roadmap.
- **Upstream secrets come from environment variables** (`-bearer-env`). There is no managed OAuth flow for third-party apps and no catalogue of integrations.
- **Direct egress only.** Cammut connects to upstreams from the server it runs on.
- **No built-in agent.** Cammut serves agents; it does not run one.

## Search and recall

- `cammut_search` matches English tool descriptions only; a query in another language returns nothing. A multilingual index using embeddings is planned.
- Keyword search has no BM25 ranking.
- Memory recall is full-text unless you run an embeddings server (see [Memory](/docs/memory/)).

## Security gaps

See [Security](/docs/security/#known-gaps): no per-client rate limit on failed authentication behind a proxy, no DNS-based SSRF checks, search and describe calls are not audited.

## Not verified

These are stated plainly because the project's own notes mark them **unverified**:

- Whether `claude --resume` accepts a transcript restored from the archive.
- Whether the Codex Stop hook payload always carries the transcript path, and whether a Codex session id is always the file name's trailing UUID. The Codex adapter was tested on synthetic rollouts only.
- Memory with Warp depends on the agent following `AGENTS.md`; Warp has no hooks.
- The Hindsight retain path assumes a server that honours a client-supplied `operation_id`; an upstream that does not parks the item as `operation_id_mismatch`.

## Roadmap, no dates

A scribe and memory consolidation, project-scoped token scopes, and stdio upstreams.
