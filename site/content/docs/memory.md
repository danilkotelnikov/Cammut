---
title: Memory
order: 6
kicker: 0.4.0
description: Notes, the project brief, recall and handoff, and how they travel between agents.
---

# Memory

Cammut's memory is a small note store that every connected agent shares. It is built so that a new session in any agent starts knowing what the last one learned.

## The pieces

| Piece | What it is |
|---|---|
| **Notes** | Short records an agent (or you) writes with `memory_remember`. You can retract one in the console and the next brief drops it |
| **Brief** | An exhaustive, deterministic summary of one project's notes, injected at session start. Briefs and their page lists are never truncated |
| **Recall** | Search over notes. Full-text by default; with an embeddings server, vector recall is added |
| **Handoff** | A summary and open tasks an agent leaves for the next one (`memory_handoff`) |
| **Projects** | The set of projects that have notes (`memory_projects`). The project name comes from the working directory |

## Access

- **MCP:** an in-process upstream named `memory`. Tools: `memory_brief`, `memory_recall`, `memory_remember`, `memory_handoff`, `memory_projects`. Use a token with the `direct:memory` profile to list them natively, or reach them through the lazy tools.
- **REST:** `/v1/memory/*`, used by the hooks.

## Scopes

The REST API checks `memory/brief`, `memory/recall` and `memory/remember`. The MCP tools check `memory/memory_brief`, `memory/memory_recall` and so on. The console's Agent setup page mints both spellings. If you create a token by hand, use `memory/*`, or you get a token that works over only one of the two.

Tokens made by the setup page expire after the period you choose (default 30 days, shown on the page; "never" is offered). After expiry the hooks fail open and memory stops silently, so check `sm.mjs status` if recall seems to have gone quiet.

## Vector recall

Without an embeddings server the log says `memory: no -tei-url, recall is full-text only`. To turn vectors on, run a [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference) server on loopback and add to the compose command:

```text
-tei-url http://127.0.0.1:8081 -tei-model bge-m3
```

Store the key (if your server has one) as `TEI_API_KEY` in the environment file. `-tei-model` is only a label saved with each vector; vectors with a different label are ignored, so change the label when you change the model.

## Safety rules the adapters follow

- Recalled text is labelled **untrusted historical data**. It cannot grant permissions or override your instructions.
- Redaction runs before truncation, and on the recall query too: tokens, keys, `password: x`, URL credentials, PEM blocks, long hex and high-entropy strings. It is a floor, not a guarantee: do not paste secrets into chat.
- A note is injected only when it has a real semantic match. An irrelevant prompt injects nothing.
- Tool output, thinking, subagent traffic and Cammut's own injected blocks are never captured.

## Without hooks

`sm.mjs brief` prints the brief, and `sm.mjs brief --write` writes it to `.memory/HANDOFF.md` in the project (add `.memory/` to your global gitignore yourself).
