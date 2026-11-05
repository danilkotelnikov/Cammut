# adapters

Node-only tooling for the memory plugins on the PC. No Go, no dependencies.

| Path | What |
|---|---|
| `claude-code/` | Canonical source of the Claude Code hook adapter (`sm.mjs`), its tests and README. |
| `common.mjs`, `archive.mjs` | Shared library: configuration, Cammut client, redaction, atomic writes; encrypted raw archive (segments, outbox, upload). |
| `install.mjs` | Copies the files of its manifest into the flat directory `~/.claude/scripts/shared-memory` (override with `SM_INSTALL_DIR`). |
| `tools/` | Verification and maintenance tools (Hindsight no-text, OpenViking purge, snapshot, chain doctor). |
| `test-helpers.mjs` | Fake HTTP servers shared by the tests. |
| `claude-code/e2e.test.mjs` | Runs the real hook entry point as a child process against fake servers. |

## Tests

`node --test <dir>` does not work with a directory argument on Node 24; use a glob:

```
node --test "adapters/**/*.test.mjs" "deploy/*.test.mjs"
```

## Install

```
node adapters/install.mjs            # install or update; prints one line per file
node adapters/install.mjs --check    # read-only; exit 1 if the installed copy differs
node adapters/install.mjs --force    # overwrite a file that was edited in place
```

A file is `installed`, `updated`, `unchanged`, or `SKIPPED (locally modified; use --force)`. The skip happens when the
installed file differs from the repo copy and from the hash recorded in `.installed.json` by the previous install.
The installer copies exactly the files listed in `MANIFEST` in `install.mjs` (never tests), never deletes anything, and writes files with mode 0600. The installed layout is flat; entry points in subdirectories (`claude-code/sm.mjs`) find their siblings (`common.mjs`) in either layout, so an installed file stays byte-identical to its repo file.
Hooks registered in `~/.claude/settings.json` run the installed copy, so installing is a deliberate user step.

Secrets are never read from files by these tools: keys come from environment variables
(`SHARED_MEMORY_HINDSIGHT_API_KEY`, `SHARED_MEMORY_OPENVIKING_API_KEY`) and are only reported as `set|MISSING`.
