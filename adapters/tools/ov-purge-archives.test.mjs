import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { plan, verdict, deletable, run } from './ov-purge-archives.mjs';
import { makeClient } from './hs-client.mjs';
import { fakeServer, tmp } from '../test-helpers.mjs';

test('plan reduces a recursive listing to per-session archive sizes and never lists non-history paths as deletable', () => {
  const ls = [
    { uri: 'viking://user/alice/sessions/cc-1/history', size: 0, isDir: true },
    { uri: 'viking://user/alice/sessions/cc-1/history/archive_001', size: 0, isDir: true },
    { uri: 'viking://user/alice/sessions/cc-1/history/archive_001/messages.jsonl', size: 8319 },
    { uri: 'viking://user/alice/sessions/cc-1/history/archive_001/memory_diff.json', size: 5023 },
    { uri: 'viking://user/alice/sessions/cc-1/messages.jsonl', size: 0 },
    { uri: 'viking://user/alice/sessions/mcp-store-2/history/archive_001/messages.jsonl', size: 100 },
    { uri: 'viking://user/alice/memories/events/2026/10/10/x.md', size: 500 },
  ];
  const p = plan(ls);
  assert.deepEqual(p, [
    { id: 'cc-1', history_uri: 'viking://user/alice/sessions/cc-1/history', history_bytes: 13342, files: 2 },
    { id: 'mcp-store-2', history_uri: 'viking://user/alice/sessions/mcp-store-2/history', history_bytes: 100, files: 1 },
  ]);
  assert.equal(deletable('viking://user/alice/sessions/cc-1/history'), true);
  assert.equal(deletable('viking://user/alice/sessions/cc-1'), false);
  assert.equal(deletable('viking://user/alice/memories'), false);
  assert.equal(deletable('viking://user/alice/sessions/../memories/history'), false);
  assert.equal(deletable('viking://user/alice/sessions/../history'), false);
  assert.equal(deletable('viking://user/alice/sessions/cc-1/history/archive_001'), false);
  assert.equal(deletable('viking://user/alice/sessions/cc-1/history/'), false);
  assert.equal(deletable('viking://user/alice/sessions/%2e%2e/history'), false);
  assert.equal(deletable('viking://user/other/sessions/cc-1/history'), false);
});

test('verdict passes only when memory counts are unchanged and the archive is gone', () => {
  assert.equal(verdict({ memories: 20, memoryFiles: 31, historyExists: true }, { memories: 20, memoryFiles: 31, historyExists: false }), true);
  assert.equal(verdict({ memories: 20, memoryFiles: 31, historyExists: true }, { memories: 19, memoryFiles: 31, historyExists: false }), false);
  assert.equal(verdict({ memories: 20, memoryFiles: 31, historyExists: true }, { memories: 20, memoryFiles: 31, historyExists: true }), false);
  assert.equal(verdict({ memories: 20, memoryFiles: 31, historyExists: true }, { memories: 20, memoryFiles: 30, historyExists: false }), false);
  assert.equal(verdict({ memories: 20, memoryFiles: 31, historyExists: false }, { memories: 20, memoryFiles: 31, historyExists: false }), false, 'nothing was there to delete: no proof');
  assert.equal(verdict({ memories: 20, memoryFiles: NaN, historyExists: true }, { memories: 20, memoryFiles: NaN, historyExists: false }), false, 'an unreadable count is not "unchanged"');
});

// A stateful stand-in for OpenViking: a flat file map; DELETE removes a subtree. damage=true makes a delete also eat a memory.
const U = 'viking://user/alice/';
const fakeOv = ({ damage = false } = {}) => {
  const files = {
    [`${U}sessions/cc-1/history/archive_001/messages.jsonl`]: 8000,
    [`${U}sessions/cc-1/history/archive_001/memory_diff.json`]: 300,
    [`${U}sessions/cc-1/messages.jsonl`]: 0,
    [`${U}sessions/mcp-store-1b01/history/archive_001/messages.jsonl`]: 100,
    [`${U}sessions/mcp-store-1b01/history/archive_001/memory_diff.json`]: 50,
    [`${U}memories/events/e1.md`]: 500,
    [`${U}memories/entities/p1.md`]: 400,
  };
  const dirsOf = (uri) => { const out = new Set(); const parts = uri.split('/'); for (let i = 4; i < parts.length; i++) out.add(parts.slice(0, i).join('/')); return out; };
  const entries = (base, recursive) => {
    const out = new Map();
    for (const [u, size] of Object.entries(files)) {
      if (!u.startsWith(`${base}/`)) continue;
      for (const d of dirsOf(u)) if (d.startsWith(`${base}/`)) out.set(d, { uri: d, size: 0, isDir: true });
      out.set(u, { uri: u, size });
    }
    const all = [...out.values()];
    return recursive ? all : all.filter((e) => e.uri.slice(base.length + 1).split('/').length === 1);
  };
  const deletes = [];
  const server = fakeServer((c) => {
    const url = new URL(c.url, 'http://x');
    if (c.method === 'GET' && url.pathname === '/api/v1/fs/ls') return { status: 200, json: { status: 'ok', result: entries(url.searchParams.get('uri'), url.searchParams.get('recursive') === 'true') } };
    if (c.method === 'GET' && url.pathname === '/api/v1/stats/memories') return { status: 200, json: { status: 'ok', result: { total: Object.keys(files).filter((u) => u.includes('/memories/')).length * 10 } } };
    if (c.method === 'DELETE' && url.pathname === '/api/v1/fs') {
      const uri = url.searchParams.get('uri');
      deletes.push(uri);
      for (const u of Object.keys(files)) if (u.startsWith(`${uri}/`)) delete files[u];
      if (damage) delete files[`${U}memories/events/e1.md`];
      return { status: 200, json: { status: 'ok' } };
    }
    return { status: 404, json: {} };
  });
  return { files, deletes, server };
};
const client = (url) => makeClient({ urlEnv: 'X', urlDefault: url, keyEnv: 'SHARED_MEMORY_OPENVIKING_API_KEY', env: { SHARED_MEMORY_OPENVIKING_API_KEY: 'test-key' } });
const go = async (srv, argv, stateDir, extra = {}) => {
  const out = [];
  const code = await run({ ov: client(srv.url), argv, say: (s) => out.push(s), stateDir, ...extra });
  return { code, out: out.join('\n') };
};

test('dry run lists sessions with sizes and the memory count and deletes nothing', async () => {
  const f = fakeOv();
  const s = await f.server;
  const dir = tmp();
  const r = await go(s, [], dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /cc-1\s+\|\s+8300/);
  assert.match(r.out, /mcp-store-1b01\s+\|\s+150/);
  assert.match(r.out, /memories total=20/);
  assert.match(r.out, /no proof/i);
  assert.deepEqual(f.deletes, []);
  s.srv.close();
});

test('--yes refuses without a passing, fresh one-session proof and deletes nothing', async () => {
  const f = fakeOv();
  const s = await f.server;
  const dir = tmp();
  assert.equal((await go(s, ['--yes'], dir)).code, 1);
  const proof = path.join(dir, 'ov-purge-proof.json');
  fs.writeFileSync(proof, JSON.stringify({ id: 'mcp-store-1b01', before: {}, after: {}, pass: false, at: new Date().toISOString() }));
  assert.equal((await go(s, ['--yes'], dir)).code, 1, 'a failed proof does not unlock the bulk delete');
  fs.writeFileSync(proof, JSON.stringify({ id: 'mcp-store-1b01', before: {}, after: {}, pass: true, at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() }));
  const old = await go(s, ['--yes'], dir);
  assert.equal(old.code, 1);
  assert.match(old.out, /older than 7 days/);
  assert.deepEqual(f.deletes, []);
  s.srv.close();
});

test('--test-one needs --yes, an mcp-store- id, deletes exactly one history directory and writes the proof', async () => {
  const f = fakeOv();
  const s = await f.server;
  const dir = tmp();
  assert.equal((await go(s, ['--test-one', 'mcp-store-1b01'], dir)).code, 1, 'without --yes it only shows the plan');
  assert.equal((await go(s, ['--test-one', 'cc-1', '--yes'], dir)).code, 1, 'only mcp-store- sessions may be the test');
  assert.equal((await go(s, ['--test-one', 'mcp-store-nope', '--yes'], dir)).code, 1, 'an unknown session is refused');
  assert.deepEqual(f.deletes, []);
  const r = await go(s, ['--test-one', 'mcp-store-1b01', '--yes'], dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /PASS memories 20 -> 20/);
  assert.deepEqual(f.deletes, [`${U}sessions/mcp-store-1b01/history`]);
  assert.ok(Object.keys(f.files).some((u) => u.includes('sessions/cc-1/history')), 'other sessions are untouched');
  const proof = JSON.parse(fs.readFileSync(path.join(dir, 'ov-purge-proof.json'), 'utf8'));
  assert.equal(proof.pass, true);
  assert.equal(proof.id, 'mcp-store-1b01');
  s.srv.close();
});

test('a test delete that changes the memory count is a FAIL, is recorded, and keeps the bulk delete locked', async () => {
  const f = fakeOv({ damage: true });
  const s = await f.server;
  const dir = tmp();
  const r = await go(s, ['--test-one', 'mcp-store-1b01', '--yes'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL memories 20 -> 10/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ov-purge-proof.json'), 'utf8')).pass, false);
  const before = f.deletes.length;
  assert.equal((await go(s, ['--yes'], dir)).code, 1);
  assert.equal(f.deletes.length, before);
  s.srv.close();
});

test('after a passing proof --yes deletes only history directories, re-checks the memory count, and a rerun finds nothing', async () => {
  const f = fakeOv();
  const s = await f.server;
  const dir = tmp();
  assert.equal((await go(s, ['--test-one', 'mcp-store-1b01', '--yes'], dir)).code, 0);
  const r = await go(s, ['--yes'], dir);
  assert.equal(r.code, 0);
  assert.ok(f.deletes.length >= 2 && f.deletes.every(deletable), 'every delete targets sessions/<id>/history exactly');
  assert.ok(Object.keys(f.files).every((u) => !u.includes('/history/')), 'no archive is left');
  assert.ok(Object.keys(f.files).includes(`${U}sessions/cc-1/messages.jsonl`) && Object.keys(f.files).filter((u) => u.includes('/memories/')).length === 2, 'everything else is untouched');
  assert.match(r.out, /memories total=20 -> 20/);
  const n = f.deletes.length;
  const again = await go(s, ['--yes'], dir);
  assert.equal(again.code, 0);
  assert.match(again.out, /nothing to delete/);
  assert.equal(f.deletes.length, n);
  s.srv.close();
});
