---
title: Overview
order: 1
kicker: Documentation
description: What Cammut is, how its pieces fit together and where to start.
---

# Cammut documentation

Cammut is a personal **MCP gateway**. You register upstream MCP servers once, give each agent a scoped token, and every agent reaches all of it through a single endpoint. On top of the gateway it adds **agent memory** (notes, a project brief, recall, handoff) and an optional **encrypted archive** of full transcripts.

```text
 Claude Code ─┐                       ┌─► upstream MCP servers (HTTP)
 Codex CLI  ──┼─ Bearer token ─► /mcp │
 Warp       ──┘     Cammut ───────────┼─► memory      (in-process: notes, brief, recall, handoff)
                       │              └─► console     (/console/, password + authenticator)
                       └─► archive: age ciphertext only; the server cannot decrypt it
```

## Where to start

| You want to | Read |
|---|---|
| Run it and connect one agent | [Quickstart](/docs/quickstart/), then the [Setup guide](/setup/) |
| Understand tokens, scopes and profiles | [Concepts](/docs/concepts/) |
| Configure a server for real use | [Install and configure](/docs/install/) |
| Configure Claude Code, Codex CLI or Warp | [Agents](/docs/agents/) |
| Use memory across agents | [Memory](/docs/memory/) |
| Keep full transcripts safely | [Encrypted archive](/docs/archive/) |
| Know what is protected and what is not | [Security](/docs/security/) and [Limits](/docs/limits/) |

## Design in four sentences

- **One door.** Agents see one URL and four tools, however many servers sit behind it.
- **Least privilege.** A token carries scopes, an optional profile, and can be revoked on its own.
- **Small.** One static Go binary, one SQLite file, about 17 MB resident when idle.
- **Fails open.** If Cammut is unreachable your agent keeps working; hooks log one line and move on.

## Who it is for

One operator running a few agents on a small server. The design accepts that scopes have no project dimension, which is fine for one person and a reason to think twice before handing a write token to a less-trusted agent. See [Limits](/docs/limits/).
