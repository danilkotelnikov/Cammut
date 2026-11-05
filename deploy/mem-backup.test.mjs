// Tests the bash logic of deploy/mem-backup with stub age/zstd/docker commands injected through MEM_BACKUP_* variables.
// Nothing here needs the real age, zstd or docker, and nothing touches a real volume.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASH = process.env.SM_BASH || 'bash';
const hasBash = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const fwd = (p) => p.replace(/\\/g, '/');
// Keep native paths for Node and convert paths passed to MSYS/WSL command tools.
const bashPath = (p) => {
  if (process.platform !== 'win32' || !hasBash) return fwd(p);
  const r = spawnSync(BASH, ['-c', 'if command -v cygpath >/dev/null; then cygpath -u "$1"; elif command -v wslpath >/dev/null; then wslpath -u "$1"; else printf "%s\\n" "$1"; fi', '--', fwd(p)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const SCRIPT = bashPath(path.join(here, 'mem-backup'));
const tmp = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-backup-')));
const PUB = 'age1' + 'q'.repeat(58);
const PUB2 = 'age1' + 'p'.repeat(58);
const t = (name, fn) => test(name, { skip: !hasBash && 'bash not available' }, fn);

// A sandbox: stub commands that log every call, a backup dir and a recipients file.
function sandbox({ recipients = `# backups\n${PUB}\n${PUB2}\n` } = {}) {
  const root = tmp();
  const shellRoot = bashPath(root);
  const bin = `${root}/bin`;
  fs.mkdirSync(bin);
  const log = `${root}/calls.log`;
  fs.writeFileSync(log, '');
  const stub = (name, body) => { fs.writeFileSync(`${bin}/${name}`, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); return `${shellRoot}/bin/${name}`; };
  const docker = stub('docker', `echo "docker $*" >> "$STUB_LOG"
case "$1" in
  compose) for a in "$@"; do case $a in stop|start|ps) sub=$a;; esac; done; [ "$sub" = ps ] && echo cid123; exit 0;;
  inspect) echo fake/hindsight:test; exit 0;;
  exec) [ -n "$STUB_FAIL_EXEC" ] && exit 1; exit 0;;
  run) while [ $# -gt 0 ]; do [ "$1" = -v ] && vol=\${2%%:*}; shift; done
       if [ "$vol" = "$STUB_FAIL_VOL" ]; then printf PARTIAL; exit 1; fi
       printf 'TARDATA-%s' "$vol"; exit 0;;
esac`);
  const zstd = stub('zstd', 'echo "zstd $*" >> "$STUB_LOG"; printf "Z:"; cat');
  const age = stub('age', `while [ $# -gt 0 ]; do case $1 in -R) R=$2; shift 2;; -o) O=$2; shift 2;; *) shift;; esac; done
echo "age -R $R" >> "$STUB_LOG"
{ printf 'age-encryption.org/v1\\n'; cat; } > "$O"`);
  const backups = `${root}/backups`;
  fs.mkdirSync(backups);
  const recip = `${root}/recipients.txt`;
  if (recipients !== null) fs.writeFileSync(recip, recipients);
  const env = {
    ...process.env, STUB_LOG: `${shellRoot}/calls.log`, STUB_FAIL_VOL: '', STUB_FAIL_EXEC: '',
    MEM_BACKUP_DIR: `${shellRoot}/backups`, MEM_BACKUP_RECIPIENTS: `${shellRoot}/recipients.txt`, MEM_BACKUP_COMPOSE_DIR: shellRoot,
    MEM_BACKUP_AGE: age, MEM_BACKUP_ZSTD: zstd, MEM_BACKUP_DOCKER: docker, MEM_BACKUP_SKIP_MODE_CHECK: '1',
  };
  const run = (args = [], extra = {}) => spawnSync(BASH, [SCRIPT, ...args.map((a, i) => i === 1 && args[0] === '--verify' ? bashPath(a) : a)], { env: { ...env, ...extra }, encoding: 'utf8' });
  const calls = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { root, backups, recip, run, calls, env };
}

const ls = (d) => fs.readdirSync(d).filter((f) => !f.startsWith('.')).sort();

t('the script is valid bash', () => {
  const r = spawnSync(BASH, ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

t('--dry-run prints three tar|zstd|age pipelines, the prune and the recipients file, and runs nothing', () => {
  const s = sandbox({ recipients: null });
  const r = s.run(['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/--entrypoint tar .* \| .*zstd -T2 -10 -q \| .*age -R /g) || []).length, 3);
  for (const v of ['hindsight-data', 'openviking-data', 'cammut_cammut-data']) assert.ok(r.stdout.includes(`-v ${v}:/v:ro`), v);
  assert.match(r.stdout, /recipients file: .*\(required\)/);
  assert.match(r.stdout, /-name '\*\.tar\.zst\.age' -mtime \+14 -delete/);
  assert.deepEqual(s.calls(), [], 'no command was executed');
  assert.deepEqual(ls(s.backups), []);
});

t('without a recipients file nothing is stopped, nothing is written and the old backup is untouched (exit 3)', () => {
  const s = sandbox({ recipients: null });
  fs.writeFileSync(`${s.backups}/hindsight-data-old.tar.zst.age`, 'old');
  const r = s.run();
  assert.equal(r.status, 3);
  assert.deepEqual(s.calls(), [], 'docker was never called, so no service was stopped');
  assert.deepEqual(ls(s.backups), ['hindsight-data-old.tar.zst.age']);
  assert.equal(fs.readFileSync(`${s.backups}/hindsight-data-old.tar.zst.age`, 'utf8'), 'old');
});

t('a recipients file that holds anything but public keys is refused without echoing it', () => {
  const secret = 'AGE-SECRET-KEY-1' + 'Q'.repeat(58);
  const s = sandbox({ recipients: `${PUB}\n${secret}\n` });
  const r = s.run();
  assert.equal(r.status, 3);
  assert.ok(!(r.stdout + r.stderr).includes('AGE-SECRET-KEY'), 'the offending line is never printed');
  assert.deepEqual(s.calls(), []);
  const empty = sandbox({ recipients: '# nothing\n\n' });
  assert.equal(empty.run().status, 3);
});

t('a missing tool exits 3 before anything is stopped', () => {
  const s = sandbox();
  const r = s.run([], { MEM_BACKUP_AGE: 'age-does-not-exist-here' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /missing tool/);
  assert.deepEqual(s.calls(), []);
});

t('a recipients file that is not mode 0600 is refused where the filesystem has POSIX modes', (ctx) => {
  const s = sandbox();
  const recip = s.env.MEM_BACKUP_RECIPIENTS;
  const probe = spawnSync(BASH, ['-c', 'chmod 644 "$1"; a=$(stat -c %a "$1"); chmod 600 "$1"; b=$(stat -c %a "$1"); echo $a $b', '--', recip], { encoding: 'utf8' }).stdout.trim();
  if (probe !== '644 600') return ctx.skip('no POSIX modes on this filesystem');
  spawnSync(BASH, ['-c', 'chmod 644 "$1"', '--', recip]);
  const r = s.run([], { MEM_BACKUP_SKIP_MODE_CHECK: '' });
  assert.equal(r.status, 3);
  assert.deepEqual(s.calls(), []);
  spawnSync(BASH, ['-c', 'chmod 600 "$1"', '--', recip]);
  assert.equal(s.run([], { MEM_BACKUP_SKIP_MODE_CHECK: '' }).status, 0);
});

t('a full run writes three verifiable .age files, restarts services, prunes only old .age files and keeps unencrypted ones', () => {
  const s = sandbox();
  const day = 24 * 3600 * 1000;
  const old = (name, age) => { const f = `${s.backups}/${name}`; fs.writeFileSync(f, 'x'); const when = new Date(Date.now() - age * day); fs.utimesSync(f, when, when); };
  old('hindsight-data-20260101T000000Z.tar.zst.age', 15);
  old('hindsight-data-20260901T000000Z.tar.zst.age', 2);
  old('hindsight-data-20250101T000000Z.tar.zst', 400);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const files = ls(s.backups);
  const fresh = files.filter((f) => /-\d{8}T\d{6}Z\.tar\.zst\.age$/.test(f) && !f.includes('2026010') && !f.includes('2026090') && !f.includes('2025'));
  assert.equal(fresh.length, 3);
  assert.ok(!files.some((f) => f.endsWith('.part')));
  assert.ok(files.includes('hindsight-data-20260901T000000Z.tar.zst.age'), 'a recent .age file is kept');
  assert.ok(!files.includes('hindsight-data-20260101T000000Z.tar.zst.age'), 'an .age file older than 14 days is pruned');
  assert.ok(files.includes('hindsight-data-20250101T000000Z.tar.zst'), 'an unencrypted backup is never deleted by the script');
  for (const f of fresh) assert.equal(s.run(['--verify', `${s.backups}/${f}`]).status, 0);
  const body = fs.readFileSync(`${s.backups}/${fresh.find((f) => f.startsWith('openviking-data'))}`, 'latin1');
  assert.ok(body.startsWith('age-encryption.org/v1\n') && body.endsWith('Z:TARDATA-openviking-data'), 'tar | zstd | age order');
  const calls = s.calls();
  const stop = calls.findIndex((c) => / stop hindsight openviking/.test(c));
  const start = calls.findIndex((c) => / start hindsight openviking/.test(c));
  const firstRun = calls.findIndex((c) => c.startsWith('docker run'));
  assert.ok(stop >= 0 && firstRun > stop && start > firstRun, 'stop, then the volume copies, then start');
  assert.equal(calls.filter((c) => c.startsWith('age -R')).length, 3);
  assert.ok(calls.filter((c) => c.startsWith('age -R')).every((c) => c.endsWith(s.env.MEM_BACKUP_RECIPIENTS)));
});

t('a failing pipeline leaves no file for that volume, no .part, restarts the services, skips pruning and exits 1', () => {
  const s = sandbox();
  const oldF = `${s.backups}/hindsight-data-20260101T000000Z.tar.zst.age`;
  fs.writeFileSync(oldF, 'old');
  const when = new Date(Date.now() - 20 * 24 * 3600 * 1000);
  fs.utimesSync(oldF, when, when);
  const r = s.run([], { STUB_FAIL_VOL: 'openviking-data' });
  assert.equal(r.status, 1);
  const files = ls(s.backups);
  assert.ok(!files.some((f) => f.startsWith('openviking-data')), 'no file, and no .part, for the failed volume');
  assert.ok(files.some((f) => f.startsWith('hindsight-data-2') && f !== 'hindsight-data-20260101T000000Z.tar.zst.age'));
  assert.ok(files.some((f) => f.startsWith('cammut_cammut-data')), 'the other volumes are still backed up');
  assert.ok(files.includes('hindsight-data-20260101T000000Z.tar.zst.age'), 'pruning is skipped after a failure');
  assert.ok(s.calls().some((c) => / start hindsight openviking/.test(c)), 'services restarted');
});

t('--verify accepts an age header and rejects anything else', () => {
  const s = sandbox();
  const good = `${s.root}/good.age`; fs.writeFileSync(good, 'age-encryption.org/v1\n-> X25519 abc\n');
  const bad = `${s.root}/bad.age`; fs.writeFileSync(bad, 'plain tar data');
  const empty = `${s.root}/empty.age`; fs.writeFileSync(empty, '');
  assert.equal(s.run(['--verify', good]).status, 0);
  assert.equal(s.run(['--verify', bad]).status, 1);
  assert.equal(s.run(['--verify', empty]).status, 1);
  assert.equal(s.run(['--verify', `${s.root}/missing`]).status, 1);
});

t('the Cammut volume is backed up from a db-snapshot taken in the container, never by tarring the live database', () => {
  const s = sandbox();
  const dry = s.run(['--dry-run']);
  assert.match(dry.stdout, /docker exec cammut-cammut-1 \/cammut admin db-snapshot -out \/data\/snapshots\/cammut-\d{8}T\d{6}Z\.db -keep 3/);
  assert.match(dry.stdout, /-v cammut_cammut-data:\/v:ro --entrypoint tar <hindsight image> -cp -C \/v snapshots \|/);
  assert.match(dry.stdout, /-v hindsight-data:\/v:ro --entrypoint tar <hindsight image> -cp -C \/v \. \|/);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const calls = s.calls();
  const snap = calls.findIndex((c) => c.startsWith('docker exec cammut-cammut-1 /cammut admin db-snapshot -out /data/snapshots/cammut-'));
  const tar = calls.findIndex((c) => c.startsWith('docker run') && c.includes('-v cammut_cammut-data:/v:ro'));
  assert.ok(snap >= 0 && tar > snap, 'snapshot first, then the tar of the volume');
  assert.ok(calls[tar].endsWith('-cp -C /v snapshots'), calls[tar]);
  assert.ok(!calls[tar].includes('archive'), 'the ciphertext archive directory is not in the default backup');
  assert.ok(calls.filter((c) => c.startsWith('docker run') && c.includes('hindsight-data')).every((c) => c.endsWith('-cp -C /v .')));
});

t('ARCHIVE_MODE=tar adds the archive directory as a second same-host copy', () => {
  const s = sandbox();
  const r = s.run([], { ARCHIVE_MODE: 'tar' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(s.calls().some((c) => c.includes('-v cammut_cammut-data:/v:ro') && c.endsWith('-cp -C /v snapshots archive')));
});

t('a failing db-snapshot leaves no file for the Cammut volume, never tars the live volume, restarts the services and exits 1', () => {
  const s = sandbox();
  const r = s.run([], { STUB_FAIL_EXEC: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /db-snapshot/);
  assert.ok(!ls(s.backups).some((f) => f.startsWith('cammut_cammut-data')), 'no backup file, no .part');
  assert.ok(!s.calls().some((c) => c.startsWith('docker run') && c.includes('cammut_cammut-data')), 'the live volume is not tarred as a fallback');
  assert.ok(ls(s.backups).some((f) => f.startsWith('hindsight-data')), 'the other volumes are still backed up');
  assert.ok(s.calls().some((c) => / start hindsight openviking/.test(c)));
});
