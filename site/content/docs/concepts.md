---
title: Concepts
order: 3
kicker: How it works
description: Upstreams, tokens, scopes, the lazy and direct profiles, rate limits and the audit log.
---

# Concepts

## Upstreams

An **upstream** is an MCP server Cammut talks to on your behalf. You register it with a name, a URL and optionally the name of an environment variable that holds its bearer secret. Cammut connects over HTTP, caches the tool list and refreshes it in the background.

- The secret is attached **only** to requests for that upstream's own host. Redirects are never followed, so a hostile upstream cannot bounce the secret elsewhere.
- Response bodies are capped at 8 MiB. Dial and header waits are bounded.
- A stale tool list is served instantly while one refresh runs, so a black-holed upstream cannot stall search.

There is also one **in-process upstream** named `memory`. See [Memory](/docs/memory/).

## Tokens and scopes

Every agent gets its own token. A token has a label, a list of **scopes** and a **profile**. Only the SHA-256 hash is stored; the plain token is shown once when you create it.

A scope is `upstream/tool`, and `*` matches every tool: `github/*` allows all GitHub tools, `hindsight/recall` allows one. A token with no scopes can do nothing.

```bash
cammut token create -label claude-code -scopes 'github/*,memory/*'
cammut token scopes -label claude-code -scopes 'github/*,memory/*,archive/put'   # replace scopes, token string stays valid
cammut token list
cammut token revoke -label claude-code
```

A token only triggers fetches for upstreams its scopes can see.

## Profiles: lazy and direct

The profile decides which tools the agent sees.

| Profile | The agent sees | Use it when |
|---|---|---|
| `lazy` (default) | Four tools: `cammut_servers`, `cammut_search`, `cammut_describe`, `cammut_call` | The agent uses many upstreams and you want to keep its context small |
| `direct:UPSTREAM` | That upstream's tools listed natively | One upstream, a client that cannot search (for example `direct:memory` for Warp) |

## The four lazy tools

1. `cammut_servers`: upstreams this token can see and whether each is reachable. An unreachable upstream is reported as such even while its stale tool list is still served.
2. `cammut_search`: keyword search over tool names and descriptions across all visible upstreams.
3. `cammut_describe`: the full schema of one tool.
4. `cammut_call`: call it. Scopes, the rate limit and the audit log apply.

## Limits per token

Each token is limited to `-rate` requests per second (default 20) with a `-burst` allowance (default 40). One POST carries exactly one JSON-RPC message: a batch array is rejected with `400` so it cannot dodge the limit, and an oversized body gets `413`. The `Bearer` scheme is case-insensitive.

## Audit

Every call writes an audit row: token label, upstream, tool (clipped to 64 characters), outcome as a fixed word. Raw upstream errors go to the log, not the database. Rows are pruned at startup and daily. `last_used_at` on a token is written at most once a minute.

## Retries

A tool call is repeated only when it provably never ran (a dead or missing session, a dial failure). An upstream's own JSON-RPC error is returned as it is and keeps the session.
