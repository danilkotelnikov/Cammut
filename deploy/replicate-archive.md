# Offsite replica of the encrypted archive

The archive (`/data/archive` in the `cammut_cammut-data` volume) is age ciphertext, so it may be copied anywhere. Because the PC deletes its
transcripts after they are archived, a lost server would lose them unless a copy exists elsewhere. **The retention sweeper refuses to run
without a verified replica of each segment it relies on** (`no-replica`, `replica-stale`, `not-replicated`), so this is a precondition, not a courtesy.

`deploy/replicate-archive REMOTE:PATH` does four things:

1. `rclone copy <archive dir> REMOTE:PATH --immutable --transfers 2` (ciphertext only; existing remote files are never overwritten).
2. `rclone check <archive dir> REMOTE:PATH --one-way --download --combined -` reads **both** sides and compares the bytes, so it works with every
   backend, including those that expose no sha256. A line `= xx/<id>.age` means: the remote copy was just downloaded and equals the local file.
3. Builds `{"items":[{"id","sha256"}]}` for exactly those segments (the sha256 of the local ciphertext).
4. `docker exec -i cammut-cammut-1 /cammut archive replica-record -remote NAME < manifest.json`. The server records a replica only when the id
   exists and the sha256 equals the stored ciphertext sha256, and always writes one run row so `last_run_at` moves. A recorded manifest is the
   result of a **complete** check and REPLACES that remote's verified set in one transaction: a segment verified yesterday that is corrupt or gone
   on the remote today loses its claim (`replicated` turns false), so the sweeper can no longer count it. Other remotes are untouched. There is no
   HTTP route for this and no token on the PC can claim a replica.

Exit status: `0` every segment verified; `1` some are not (`unreplicated=N`, the run is still recorded); `3` the check did not cover every local
segment (remote unreachable): **nothing is recorded**, so a failed run never makes the replica look fresh; `2` usage. Output is counts only.

## Set up (you do this; nothing here is automated)

```
apt-get install -y rclone                 # on the server
rclone config                             # create a remote you own, e.g. "mega" or a Google Drive remote; the files are already encrypted
bash /opt/cammut/deploy/replicate-archive mega:cammut-archive      # once by hand; read: verified=N unreplicated=0
docker exec cammut-cammut-1 /cammut archive stats             # "replica  last run ..., unreplicated 0"
```

Daily by a systemd timer (as root on the server):

`/etc/systemd/system/cammut-replicate.service`
```
[Unit]
Description=Replicate the Cammut archive offsite and record the verified segments
After=docker.service
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/cammut/deploy/replicate-archive mega:cammut-archive
```

`/etc/systemd/system/cammut-replicate.timer`
```
[Unit]
Description=Daily offsite replica of the Cammut archive
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15min
Persistent=true
[Install]
WantedBy=timers.target
```

`systemctl daemon-reload && systemctl enable --now cammut-replicate.timer`. The sweeper wants a run younger than 36 hours; the doctor warns above that.
A failed run (`exit 3`) shows up as `systemctl status cammut-replicate.service` failing and as a replica that gets older.

## What does and does not count

- A provider **volume snapshot** is a useful extra but cannot satisfy the precondition: it yields no per-segment verification.
- `mem-backup` with `ARCHIVE_MODE=tar` keeps a second encrypted copy on the **same host**. That is not disaster recovery and not a replica.
- Restoring after server loss: copy the ciphertext back from the remote into a fresh `archive/` directory; with the private key (`cammut-archive.mjs decrypt`
  or plain `age -d -i key` plus any zstd tool) every segment is readable without any Cammut software. The sqlite index is rebuilt from the database
  backup (`cammut_cammut-data` snapshot in `mem-backup`).

## Tests

`node --test deploy/replicate-archive.test.mjs` runs the script with a fake `rclone` and `docker` (variables `REPL_RCLONE`, `REPL_DOCKER`,
`REPL_ARCHIVE_DIR`, `REPL_CONTAINER`): a segment missing remotely, a differing one and an errored one stay out of the manifest; an incomplete check
records nothing; the manifest holds ids and hashes only. Whether `rclone check --download --combined` behaves as assumed on the real remote (output
format, throughput for about 500 MB) is spec item 18 and is checked by the first manual run above.
