<!-- version: 1 | date: 2026-11-12 -->
# Raw archive

Cammut can store the complete Claude Code and Codex transcripts, but only as **age ciphertext whose private key is never on the VDS**.
The server validates the `age-encryption.org/v1` header, sizes and the ciphertext sha256, keeps plaintext metadata (agent, project,
session id, byte range, sizes, times) and cannot decrypt anything: there is no identity, no key-encryption key and no decrypt code in the
binary (a test greps the repository for `AGE-SECRET-KEY` and for `filippo.io/age` in `go.mod`).

**Key model.** You hold two keys: a daily key locked with a passphrase (`memory.key.age`) and a recovery key on a USB stick. Only their public
halves (`age1...`) are on the PC (`~/.claude/shared-memory-recipients.txt`) and on the VDS. A lost VDS loses the archive unless the ciphertext is replicated
offsite; losing both private keys makes the archive unreadable by design. The server pins the recipient set it first saw per project and flags any
change in `cammut archive pins`, `status` and the chain doctor.

**Tokens.** The PC token has `archive/put` and `archive/verify` only. A second token with `archive/get`, `archive/list`, `archive/verify`
(`-expires 90d`) is needed to read ciphertext back, to see the replica status (`status`, `audit`, `fetch`, the sweeper and the doctor).

**Server side.** `PUT /v1/archive/segments/{id}` (4 MiB limit, streamed to disk, 0600, fsync, rename; the id is recomputed from the metadata),
`HEAD`/`GET /v1/archive/segments/{id}`, `GET /v1/archive/sessions/{agent}/{session}/coverage`, `GET /v1/archive/segments`, `GET /v1/archive/status`.
Re-uploading an id keeps the first copy; if the plaintext hash differs the answer is `409 content_mismatch`. CLI on the VDS (it opens the database
directly, no HTTP route): `cammut archive stats|verify [-sample N]|list|replica-record -remote NAME < manifest.json|pins [ack -project P]`,
`cammut admin db-snapshot -out PATH [-keep N]` (a `VACUUM INTO` copy that is consistent while Cammut writes; `mem-backup` uses it instead of tarring
the live volume). Flags: `-archive-dir` (`/data/archive`), `-archive-max-bytes` (20 GiB), `-archive-min-free` (5 GiB).

**Replica.** `deploy/replicate-archive REMOTE:PATH` (see `deploy/replicate-archive.md`) copies the archive with rclone, re-reads both sides and
records which segments are verified offsite. The sweeper requires it.

**PC side** (`adapters/`, Node 24, no dependencies, the `age` CLI): the Stop/SessionEnd hooks only record offsets and start a detached drain; the drain cuts
whole lines (about 1 MiB), redacts every JSON string value, strips base64 images, compresses (zstd, brotli if absent), encrypts, keeps the ciphertext in an
outbox and uploads it. A range counts as archived only after the server answered. With Cammut or the tunnel down nothing is lost and nothing is deleted:
the transcripts stay, the outbox keeps ciphertext (capped at 512 MiB) and `status` says what is waiting. The spool no longer holds text, only references
`{file, start, end}` into the agent's own transcript. `adapters/tools/cammut-archive.mjs`: `backfill`, `status`, `fetch`, `decrypt`, `restore`, `audit`,
`pins`, `doctor`, plus `sweep`, `retention`, `quarantine`.

**Retention** (off until you enable it): `adapters/sweep.mjs` removes a transcript from the PC only after it has proved, in that run, that **these bytes**
are archived (every acknowledged range re-hashed from the file and equal to the server's plaintext hash, no gap), replicated offsite, and recoverable
(a restore audit younger than 90 days with both keys), after a dry run you read, with the file quiet, not running, not in the spool and older than the
retention days. Deletion is two-phase: a rename into `.cammut-quarantine` and, 48 hours later and only if everything still verifies and the file is
byte-identical, the unlink. The code refuses to rename or unlink unless `adapters/SWEEPER-REVIEW.md` holds `reviewed-sha256: <sha256 of adapters/sweep.mjs>`,
a line only a human who read the sweeper creates. `quarantine list|restore --id X` puts a file back.

**Restore.** `cammut-archive.mjs restore --session ID --identity KEY` rebuilds `~/.claude/projects/<project>/<id>.jsonl` from the redacted archive;
whether `claude --resume` accepts it is UNVERIFIED (use `--strip-thinking` if it does not). Every segment is a separate age file, so a passphrase-locked
identity asks for its passphrase once per segment.

**Scope of "complete".** Transcripts and subagent transcripts, after string-level redaction, with base64 images replaced by stubs and with
`tool-results/` and `file-history/` excluded. Metadata (project names, session ids, times, sizes) is visible to the VDS host.

**Rollback.** `{"archive": {"enabled": false}}` stops new segments; `retention disable` stops deleting; `quarantine restore` returns files within the grace
period; image `cammut:0.2.0` removes the endpoints (the migration-2 tables stay). Deploy (compose needs `CAMMUT_SITE_ORIGIN`, the public origin, from the shell or `deploy/.env`; see `docs/PUBLIC-ENDPOINT.md`): `cd /opt/cammut && git fetch && git checkout memory-v2 &&
docker compose -f deploy/compose.yaml build && docker compose -f deploy/compose.yaml up -d`; the log then shows `cammut listening ... version 0.3.0`
and `archive reconcile: temp=0 missing=0`.
