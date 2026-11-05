# mem-backup: encrypted nightly backup of the memory volumes

`deploy/mem-backup` replaces `/usr/local/bin/mem-backup` on the server. The nightly job (01:10 UTC) keeps calling the same path.

What it does, in order:

1. Checks `/root/private/backup-recipients.txt` (one `age1...` public key per line, mode 0600), `age`, `zstd` and `docker`. If anything is missing or wrong it exits **3 before stopping any service** and writes nothing; earlier backups stay as they are.
2. Stops `hindsight openviking` with the same compose invocation as before (`docker compose --env-file /root/private/shared-memory.env -f compose.yaml -f compose.4gb.yaml`, in `/opt/shared-memory/deployment`). An exit trap starts them again however the run ends.
3. For each of `hindsight-data`, `openviking-data` and `cammut_cammut-data` runs `tar -cp | zstd -T2 -10 | age -R recipients -o FILE.part` and renames `FILE.part` to `<volume>-<UTC stamp>.tar.zst.age` only when the whole pipeline succeeded. A failed volume leaves no file and no `.part`; the other volumes are still written and the exit code is 1.
   **The Cammut volume is not tarred live.** Before its copy the script runs `docker exec cammut-cammut-1 /cammut admin db-snapshot -out /data/snapshots/cammut-<stamp>.db -keep 3` (a `VACUUM INTO` copy that is consistent while Cammut writes in WAL mode; the directory is created by the command, the three newest snapshots are kept) and tars only `snapshots/` of that volume. If the snapshot fails, no file is written for that volume and the live database is **not** tarred as a fallback (exit 1). The raw archive directory (`archive/`, already age ciphertext) is left out; it is replicated offsite by `deploy/replicate-archive`. `ARCHIVE_MODE=tar mem-backup` adds `archive/` to the Cammut file as a second copy on the same host (that is not disaster recovery and not a replica). Container name override: `MEM_BACKUP_CAMMUT_CTR`.
4. If every volume succeeded, deletes `*.tar.zst.age` older than 14 days. It never deletes the old unencrypted `*.tar.zst` files (you remove them yourself, see step 8 below).
5. Prints the size of each new file.

Other forms: `mem-backup --dry-run` prints the commands and changes nothing; `mem-backup --verify FILE` checks the age header (the server cannot decrypt: it has no private key).

The Hindsight image is used for all three `tar` runs (the Cammut image is distroless and has no `tar`). The image name is read from the stopped Hindsight container; set `MEM_BACKUP_IMG` to override.

## The one rule about keys

The private key never goes to the server. Only public keys are in `backup-recipients.txt`; the script refuses a file that contains anything else (and does not print the offending line). The same file is reused for the archive of plan 2.

## Install on the server (run by the user)

Before replacing the script, read the current one (this script was written without access to it): `cat /usr/local/bin/mem-backup`, and check that the volume names and the compose invocation match (`docker volume ls`).

```
apt-get install -y age
install -m 0600 /dev/null /root/private/backup-recipients.txt
# paste the public keys (age1...) of the daily key and of the recovery key, one per line
cp /usr/local/bin/mem-backup /usr/local/bin/mem-backup.v1
install -m 0755 mem-backup /usr/local/bin/mem-backup      # copy the file over first, e.g. with scp
mem-backup --dry-run
mem-backup
ls -la /var/backups/memory/*.age
mem-backup --verify /var/backups/memory/<one file>.tar.zst.age
```

`mem-backup --dry-run` works before the recipients file exists and shows `[MISSING]`; a real run then exits 3.

Rollback: `cp /usr/local/bin/mem-backup.v1 /usr/local/bin/mem-backup`.

## Restore on the PC

Copy a `.age` file down, then decrypt with the passphrase-wrapped identity (`age` prompts for the passphrase). Use cmd.exe, Git Bash or WSL for the pipes (older PowerShell corrupts binary pipes), or decrypt to a file first.

```
age -d -i %USERPROFILE%\.age\memory.key.age FILE | zstd -d | tar -tf -                   # list
age -d -i %USERPROFILE%\.age\memory.key.age FILE | zstd -d | tar -xf - -C restore/       # extract into restore/
```

(`winget install --id FiloSottile.age` and `winget install --id Meta.Zstandard`.)

## Tests

`node --test deploy/mem-backup.test.mjs` runs the script with stub `age`, `zstd` and `docker` commands (variables `MEM_BACKUP_AGE`, `MEM_BACKUP_ZSTD`, `MEM_BACKUP_DOCKER`, `MEM_BACKUP_DIR`, `MEM_BACKUP_RECIPIENTS`, `MEM_BACKUP_COMPOSE_DIR`, `MEM_BACKUP_IMG`). `MEM_BACKUP_SKIP_MODE_CHECK=1` disables only the mode-0600 check on filesystems without POSIX modes (the tests on Windows); never set it on the server.
