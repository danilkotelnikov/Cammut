---
title: Security
order: 8
kicker: What is protected
description: Which properties Cammut enforces, what rests on you, and the known gaps.
---

# Security

Cammut holds the keys to your upstream services and the memory of your work, so this page says plainly what it enforces, what it leaves to you, and where it is weak. Read it with [Limits](/docs/limits/).

## What Cammut enforces

| Property | How |
|---|---|
| Tokens cannot be recovered from the database | Tokens are 256-bit random; only the hash is stored; shown once |
| Least privilege per agent | Scopes per upstream and tool; a token with no scopes can do nothing; revoke or re-scope without changing the token string |
| An upstream cannot steal another's secret | The bearer is attached only for that upstream's own host; redirects are never followed |
| Bounded resource use | Rate and burst per token, request bodies capped (`413`), upstream response bodies capped at 8 MiB, audit rows bounded and pruned |
| One request, one message | JSON-RPC batch arrays are rejected with `400` |
| Stored secrets are encrypted | They are encrypted with the vault key; without that file they are unreadable |
| Console login | Password plus authenticator code; recovery only over SSH on the server |
| The server cannot read archived transcripts | Ciphertext only; no decryption key or code in the binary |
| Hardened container | Read-only root filesystem, uid 65532, all capabilities dropped, `no-new-privileges`, PID limit |
| Clean shutdown | In-flight requests finish before the database closes |

## What is yours to do

- **Keep the vault key and your age private keys somewhere separate from the server.** Back them up. Cammut cannot recover them.
- Terminate TLS in a reverse proxy and keep the gateway on loopback.
- Treat any token with a `memory/remember` scope as able to change any project's notes (scopes have no project dimension yet).
- Do not paste secrets into agent chats. Redaction in the adapters is a floor, not a guarantee.

## Prompt injection

Everything recalled from memory is labelled **untrusted historical data**, and the adapters tell the agent it cannot grant permissions or override your instructions. That reduces the risk; it does not remove it. A note written by one agent is read by the next, so a compromised agent can leave instructions for another. The brief shows what is in memory and the console lets you retract any note.

## Known gaps

- Failed authentication is not rate-limited per client address. Behind a reverse proxy every public request reaches the gateway as `127.0.0.1`. Tokens are 256-bit, so guessing is not a realistic risk; the cost is load.
- No DNS-based SSRF checks on upstream URLs. Register only upstreams you trust.
- No auditing of search, describe and servers calls (only calls are audited).
- Metadata of archived sessions (project names, session ids, times, sizes) is visible to the server host.

## Reporting a problem

A contact address will be listed here with the first public release.
