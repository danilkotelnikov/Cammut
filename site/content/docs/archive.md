---
title: Encrypted archive
order: 7
kicker: 0.3.0
description: Keep complete agent transcripts as age ciphertext the server cannot read.
---

# Encrypted archive

Cammut can store the complete Claude Code and Codex transcripts, but only as **age ciphertext whose private key is never on the server**. The server validates the `age-encryption.org/v1` header, sizes and the ciphertext SHA-256, keeps plaintext metadata (agent, project, session id, byte range, sizes, times) and **cannot decrypt anything**: there is no identity, no key-encryption key and no decrypt code in the binary. A test greps the repository for `AGE-SECRET-KEY` and for the age library in `go.mod`.

Off until you enable it: `{"archive": {"enabled": true}}` in `~/.claude/shared-memory.json`.

## Key model

You hold two keys: a daily key locked with a passphrase, and a recovery key on a USB stick. Only their **public** halves (`age1...`) are on your computer (`~/.claude/shared-memory-recipients.txt`) and on the server. The server pins the recipient set it first saw per project and flags any change in `cammut archive pins`, `status` and the chain doctor.

Losing the server loses the archive unless the ciphertext is replicated offsite. Losing both private keys makes the archive unreadable, by design.

## Tokens

The computer's token needs `archive/put` and `archive/verify` only. Reading ciphertext back, and seeing replica status, needs a second token with `archive/get`, `archive/list` and `archive/verify`. Give that one an expiry.

## What happens on your computer

The Stop and SessionEnd hooks only record offsets and start a detached drain. The drain cuts whole lines (about 1 MiB), redacts every JSON string value, replaces base64 images with stubs, compresses, encrypts with the `age` CLI, keeps the ciphertext in an outbox and uploads it.

- A range counts as archived only after the server answered. With Cammut or the network down nothing is lost and nothing is deleted: transcripts stay, the outbox keeps ciphertext (capped at 512 MiB) and `status` says what is waiting.
- Re-uploading an id keeps the first copy; if the plaintext hash differs the answer is `409 content_mismatch` and the range is marked changed.
- Tool results and file-history directories are not archived. Metadata (project names, session ids, times, sizes) is visible to the server host.

## Server side

`PUT /v1/archive/segments/{id}` (4 MiB limit, streamed to disk, mode 0600, fsync, rename; the id is recomputed from the metadata), `HEAD` and `GET /v1/archive/segments/{id}`, `GET /v1/archive/sessions/{agent}/{session}/coverage`, `GET /v1/archive/segments`, `GET /v1/archive/status`.

Server CLI:

```bash
cammut archive stats
cammut archive verify -sample 50
cammut archive list -project my-project -limit 20
cammut archive pins            # recipient sets seen per project
cammut archive pins ack -project my-project   # accept a changed set
```

Quota and free-space guards are `-archive-max-bytes` (20 GiB) and `-archive-min-free` (5 GiB).

## Offsite replica

`deploy/replicate-archive REMOTE:PATH` copies the archive with rclone, re-reads both sides and records which segments are verified offsite. The retention sweeper refuses to act without it.

## Retention (off until you enable it)

`sweep.mjs` removes a local transcript only after it has proved, in that run, that **these exact bytes** are archived (every acknowledged range re-hashed from the file and equal to the server's plaintext hash, no gap), replicated offsite, and recoverable (a restore audit younger than 90 days with both keys). It also requires a dry run you read, a quiet file that is not running, not in the spool and older than the retention days.

Deletion is two-phase: a rename into `.cammut-quarantine`, and 48 hours later, only if everything still verifies and the file is byte-identical, the unlink. The code refuses to rename or unlink unless `adapters/SWEEPER-REVIEW.md` holds `reviewed-sha256: <sha256 of sweep.mjs>`, a line only a human who read the sweeper creates. `quarantine list|restore --id X` puts a file back.

## Restore

`cammut-archive.mjs restore --session ID --identity KEY` rebuilds the transcript file from the redacted archive. Whether `claude --resume` accepts a restored file is **unverified**; use `--strip-thinking` if it does not. Every segment is a separate age file, so a passphrase-locked key asks for its passphrase once per segment.

## Rollback

`{"archive": {"enabled": false}}` stops new segments. `retention disable` stops deleting. `quarantine restore` returns files within the grace period.
