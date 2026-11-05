import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, MANIFEST } from './install.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-install-'));
const M = [{ from: 'sm.mjs', to: 'sm.mjs' }, { from: 'README.md', to: 'README.md' }];
const ONE = [{ from: 'sm.mjs', to: 'sm.mjs' }];
const HERE = path.dirname(fileURLToPath(import.meta.url));

test('install copies, is idempotent, refuses to clobber a local edit and obeys --force', () => {
  const src = tmp(); const dst = tmp();
  fs.writeFileSync(path.join(src, 'sm.mjs'), 'export const v = 1;\n');
  fs.writeFileSync(path.join(src, 'README.md'), '# r\n');
  let r = install({ srcDir: src, dstDir: dst, manifest: M });
  assert.deepEqual(r.map((x) => x.status).sort(), ['installed', 'installed']);
  r = install({ srcDir: src, dstDir: dst, manifest: M });
  assert.ok(r.every((x) => x.status === 'unchanged'));
  fs.writeFileSync(path.join(src, 'sm.mjs'), 'export const v = 2;\n');
  r = install({ srcDir: src, dstDir: dst, manifest: M });
  assert.equal(r.find((x) => x.name === 'sm.mjs').status, 'updated');
  fs.appendFileSync(path.join(dst, 'sm.mjs'), '// local hack\n');
  fs.writeFileSync(path.join(src, 'sm.mjs'), 'export const v = 3;\n');
  r = install({ srcDir: src, dstDir: dst, manifest: M });
  assert.equal(r.find((x) => x.name === 'sm.mjs').status, 'skipped');
  assert.ok(fs.readFileSync(path.join(dst, 'sm.mjs'), 'utf8').includes('local hack'), 'a local edit is never overwritten without --force');
  r = install({ srcDir: src, dstDir: dst, manifest: M, force: true });
  assert.equal(r.find((x) => x.name === 'sm.mjs').status, 'updated');
  const manifest = JSON.parse(fs.readFileSync(path.join(dst, '.installed.json'), 'utf8'));
  assert.ok(manifest.files['sm.mjs'].match(/^[0-9a-f]{64}$/));
  assert.deepEqual(install({ srcDir: src, dstDir: dst, manifest: M, check: true }).filter((x) => x.status !== 'unchanged'), []);
});

test('check never writes, reports drift and missing files; files outside the manifest are not installed', () => {
  const src = tmp(); const dst = tmp();
  fs.writeFileSync(path.join(src, 'sm.mjs'), 'a\n');
  fs.writeFileSync(path.join(src, 'sm.test.mjs'), 'tests stay in the repo\n');
  fs.writeFileSync(path.join(src, 'notes.txt'), 'x');
  assert.deepEqual(install({ srcDir: src, dstDir: dst, manifest: ONE, check: true }).map((x) => x.status), ['missing']);
  assert.deepEqual(fs.readdirSync(dst), [], 'check is read-only');
  install({ srcDir: src, dstDir: dst, manifest: ONE });
  assert.deepEqual(fs.readdirSync(dst).sort(), ['.installed.json', 'sm.mjs']);
  fs.writeFileSync(path.join(dst, 'sm.mjs'), 'b\n');
  assert.deepEqual(install({ srcDir: src, dstDir: dst, manifest: ONE, check: true }).map((x) => x.status), ['differs']);
});

test('a pre-existing different file with no manifest is treated as locally modified', () => {
  const src = tmp(); const dst = tmp();
  fs.writeFileSync(path.join(src, 'sm.mjs'), 'new\n');
  fs.writeFileSync(path.join(dst, 'sm.mjs'), 'old, installed by hand\n');
  assert.equal(install({ srcDir: src, dstDir: dst, manifest: ONE })[0].status, 'skipped');
  assert.equal(fs.readFileSync(path.join(dst, 'sm.mjs'), 'utf8'), 'old, installed by hand\n');
});

test('a file from the hand-installed era (known hash, no manifest) is updated; any other pre-existing file is not', () => {
  const src = tmp(); const dst = tmp();
  const old = 'export const v = 0;\n';
  fs.writeFileSync(path.join(dst, 'sm.mjs'), old);
  fs.writeFileSync(path.join(src, 'sm.mjs'), 'export const v = 9;\n');
  const legacy = { 'sm.mjs': crypto.createHash('sha256').update(old).digest('hex') };
  assert.equal(install({ srcDir: src, dstDir: dst, manifest: ONE, legacy })[0].status, 'updated');
  assert.equal(fs.readFileSync(path.join(dst, 'sm.mjs'), 'utf8'), 'export const v = 9;\n');
  fs.writeFileSync(path.join(dst, 'sm.mjs'), 'something else\n');
  fs.rmSync(path.join(dst, '.installed.json'));
  assert.equal(install({ srcDir: src, dstDir: dst, manifest: ONE, legacy })[0].status, 'skipped');
});

test('a manifest entry can live in a subdirectory of the install directory, and a missing source is a loud error', () => {
  const src = tmp(); const dst = tmp();
  fs.mkdirSync(path.join(src, 'codex'));
  fs.writeFileSync(path.join(src, 'codex', 'cm.mjs'), 'export const x = 1;\n');
  const m = [{ from: 'codex/cm.mjs', to: 'codex/cm.mjs' }];
  assert.equal(install({ srcDir: src, dstDir: dst, manifest: m })[0].status, 'installed');
  assert.ok(fs.existsSync(path.join(dst, 'codex', 'cm.mjs')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dst, '.installed.json'), 'utf8')).files['codex/cm.mjs'].length, 64);
  assert.throws(() => install({ srcDir: src, dstDir: dst, manifest: [{ from: 'nope.mjs', to: 'nope.mjs' }] }), /nope\.mjs is missing/);
});

test('an optional manifest entry is skipped while its source does not exist and installed once it does', () => {
  const src = tmp(); const dst = tmp();
  fs.writeFileSync(path.join(src, 'sm.mjs'), 'a');
  const m = [{ from: 'sm.mjs', to: 'sm.mjs' }, { from: 'SWEEPER-REVIEW.md', to: 'SWEEPER-REVIEW.md', optional: true }];
  assert.deepEqual(install({ srcDir: src, dstDir: dst, manifest: m }).map((x) => x.name), ['sm.mjs']);
  fs.writeFileSync(path.join(src, 'SWEEPER-REVIEW.md'), 'reviewed-sha256: x');
  assert.deepEqual(install({ srcDir: src, dstDir: dst, manifest: m }).map((x) => `${x.name}:${x.status}`), ['sm.mjs:unchanged', 'SWEEPER-REVIEW.md:installed']);
});

test('every file of the real manifest exists in the repo, and the installed flat layout runs', () => {
  for (const m of MANIFEST) assert.ok(m.optional || fs.existsSync(path.join(HERE, m.from)), m.from);
  const dst = tmp();
  const r = install({ srcDir: HERE, dstDir: dst });
  assert.ok(r.every((x) => x.status === 'installed'));
  for (const m of MANIFEST.filter((x) => !x.optional)) {
    assert.ok(fs.readFileSync(path.join(dst, m.to)).equals(fs.readFileSync(path.join(HERE, m.from))), `${m.to}: the installed file is byte-identical to the repo file (chain-doctor compares hashes)`);
  }
  const out = spawnSync(process.execPath, [path.join(dst, 'sm.mjs'), 'status'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, SM_CONFIG: path.join(dst, 'none.json'), SM_STATE_DIR: dst, SM_HS_URL: 'http://127.0.0.1:1', SM_OV_URL: 'http://127.0.0.1:1', SHARED_MEMORY_HINDSIGHT_API_KEY: 'dummy', SHARED_MEMORY_OPENVIKING_API_KEY: 'dummy' },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^hindsight: key=set health=FAIL/m);
  const tool = spawnSync(process.execPath, [path.join(dst, 'cammut-archive.mjs'), 'help'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, SM_CONFIG: path.join(dst, 'none.json'), SM_STATE_DIR: dst } });
  assert.equal(tool.status, 0, tool.stderr);
  assert.match(tool.stdout, /backfill/);
  const sweeper = spawnSync(process.execPath, [path.join(dst, 'sweep.mjs'), 'bogus'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, SM_CONFIG: path.join(dst, 'none.json'), SM_STATE_DIR: dst } });
  const cm = spawnSync(process.execPath, [path.join(dst, 'codex', 'cm.mjs'), 'capture'], { encoding: 'utf8', timeout: 20000, input: '{}', env: { ...process.env, SM_CONFIG: path.join(dst, 'none.json'), SM_STATE_DIR: dst } });
  assert.equal(cm.status, 0, cm.stderr);
  assert.equal(sweeper.status, 2, 'the installed sweeper runs flat and prints its usage');
});
