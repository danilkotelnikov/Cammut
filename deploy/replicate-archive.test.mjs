// Tests the bash logic of deploy/replicate-archive with a fake rclone and a fake docker. No network, no real archive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'replicate-archive').replace(/\\/g, '/');
const BASH = process.env.SM_BASH || 'bash';
const hasBash = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
const hasTools = hasBash && spawnSync(BASH, ['-c', 'command -v sha256sum && find . -maxdepth 0 -printf x'], { encoding: 'utf8' }).status === 0;
const fwd = (p) => p.replace(/\\/g, '/');
const t = (name, fn) => test(name, { skip: !hasTools && 'bash, sha256sum or GNU find not available' }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// archive dir with segments, plus stub rclone/docker that log what they were asked
function sandbox(ids = ['a1', 'b2', 'c3']) {
  const root = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'repl-')));
  const dir = `${root}/archive`;
  const bin = `${root}/bin`;
  fs.mkdirSync(bin);
  const segs = {};
  for (const x of ids) {
    const id = (x + 'f'.repeat(32)).slice(0, 32).toLowerCase();
    fs.mkdirSync(`${dir}/${id.slice(0, 2)}`, { recursive: true });
    const body = Buffer.from(`age-encryption.org/v1\nciphertext of ${x}`);
    fs.writeFileSync(`${dir}/${id.slice(0, 2)}/${id}.age`, body);
    segs[x] = { id, rel: `${id.slice(0, 2)}/${id}.age`, sha: sha(body) };
  }
  fs.mkdirSync(`${dir}/zz`, { recursive: true });
  fs.writeFileSync(`${dir}/zz/partial.age.tmp`, 'upload in progress');
  const log = `${root}/calls.log`; fs.writeFileSync(log, '');
  const stdin = `${root}/docker.stdin`;
  const combined = `${root}/combined.txt`;
  const stub = (n, body) => { fs.writeFileSync(`${bin}/${n}`, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); return `${bin}/${n}`; };
  const rclone = stub('rclone', `echo "rclone $*" >> "$STUB_LOG"
case "$1" in
  copy) exit \${FAKE_COPY_RC:-0};;
  check) cat "$FAKE_COMBINED"; exit 1;;
esac`);
  const docker = stub('docker', `echo "docker $*" >> "$STUB_LOG"; cat > "$STUB_STDIN"; exit \${FAKE_DOCKER_RC:-0}`);
  const setCombined = (lines) => fs.writeFileSync(combined, lines.join('\n') + (lines.length ? '\n' : ''));
  setCombined(Object.values(segs).map((s) => `= ${s.rel}`));
  const env = { ...process.env, REPL_ARCHIVE_DIR: dir, REPL_RCLONE: rclone, REPL_DOCKER: docker, STUB_LOG: log, STUB_STDIN: stdin, FAKE_COMBINED: combined, RCLONE_CONFIG_PASS: 'TOPSECRET-CONFIG-PASSWORD' };
  const run = (args = ['mega:cammut-archive'], extra = {}) => spawnSync(BASH, [SCRIPT, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, dir, segs, run, setCombined, calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), manifest: () => JSON.parse(fs.readFileSync(stdin, 'utf8')) };
}

t('the script is valid bash', () => {
  assert.equal(spawnSync(BASH, ['-n', SCRIPT], { encoding: 'utf8' }).status, 0);
});

t('every segment verified offsite: copy is immutable, check downloads both sides, the manifest carries id and local sha256, exit 0', () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verified=3 unreplicated=0 remote=mega/);
  const calls = s.calls();
  assert.ok(calls[0].startsWith('rclone copy') && calls[0].includes('--immutable') && calls[0].includes('--transfers 2') && calls[0].includes('mega:cammut-archive'));
  assert.ok(calls[1].startsWith('rclone check') && calls[1].includes('--one-way') && calls[1].includes('--download') && calls[1].includes('--combined -'));
  assert.ok(calls[2].startsWith('docker exec -i cammut-cammut-1 /cammut archive replica-record -remote mega'));
  const m = s.manifest();
  assert.deepEqual(m.items.map((i) => i.id).sort(), Object.values(s.segs).map((x) => x.id).sort());
  for (const i of m.items) assert.equal(i.sha256, Object.values(s.segs).find((x) => x.id === i.id).sha, 'the sha256 is the hash of the LOCAL ciphertext');
});

t('a segment missing remotely, one that differs and one that errored are not in the manifest; exit 1 with unreplicated=N, and the run is still recorded', () => {
  const s = sandbox(['a1', 'b2', 'c3', 'd4']);
  const v = s.segs;
  s.setCombined([`= ${v.a1.rel}`, `+ ${v.b2.rel}`, `* ${v.c3.rel}`, `! ${v.d4.rel}`]);
  const r = s.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /verified=1 unreplicated=3/);
  assert.deepEqual(s.manifest().items.map((i) => i.id), [v.a1.id]);
  assert.ok(s.calls().some((c) => c.startsWith('docker exec')), 'last_run_at moves even when nothing is fully verified');
});

t('a check that does not cover every local segment records NOTHING (a failed run must not make the replica look fresh) and exits 3', () => {
  const s = sandbox();
  s.setCombined([`= ${s.segs.a1.rel}`]);
  const r = s.run();
  assert.equal(r.status, 3);
  assert.ok(!s.calls().some((c) => c.startsWith('docker')));
  s.setCombined([]);
  assert.equal(s.run().status, 3, 'an empty answer with segments on disk means the remote could not be read');
});

t('the manifest and the output carry no credential, and unreadable docker or a bad remote name are reported', () => {
  const s = sandbox();
  const r = s.run();
  assert.ok(!(r.stdout + r.stderr + JSON.stringify(s.manifest())).includes('TOPSECRET'));
  assert.equal(s.run(['mega:x'], { FAKE_DOCKER_RC: '1' }).status, 3);
  assert.equal(s.run([]).status, 2);
  assert.equal(s.run(['nocolon']).status, 2);
  assert.equal(s.run(['bad name:x']).status, 2);
  assert.equal(s.run(['mega:x'], { REPL_ARCHIVE_DIR: `${s.root}/missing` }).status, 2);
});

t('an empty archive replicates trivially: exit 0, an empty manifest, still recorded', () => {
  const s = sandbox([]);
  s.setCombined([]);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.manifest(), { items: [] });
});

t('the in-progress *.tmp file of an upload is never counted or listed', () => {
  const s = sandbox();
  const r = s.run();
  assert.match(r.stdout, /unreplicated=0/);
  assert.ok(!JSON.stringify(s.manifest()).includes('partial'));
});
