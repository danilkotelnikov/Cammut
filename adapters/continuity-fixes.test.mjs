import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityOf, putCheckpoint, restoreCheckpoint, formatCheckpoint } from './common.mjs';
import { fakeServer, tmp } from './test-helpers.mjs';

const SM = fileURLToPath(new URL('./claude-code/sm.mjs', import.meta.url));
const cfgFor = (base, url) => ({ stateDir: path.join(base, 'state'), cammut: { url, token: 'synthetic' }, requestMs: 300, recallMs: 300 });
const state = (cwd, revision, parent = '', over = {}) => ({
  cwd, agent: 'claude-code', session_id: 'native-1', goal: `Goal ${revision}`, decisions: [], open_tasks: [], next_actions: [],
  artifact_refs: [], validation: [], source_revision: revision, parent_revision: parent, ...over,
});
const cpDir = (cfg, ids) => path.join(cfg.stateDir, 'checkpoints', ids.project_id, ids.workspace_id);
const SECRET = 'cmt_' + '0123456789abcdef0123456789abcdef';

test('a rejected write leaves no failed head behind, and invalid fields write nothing', async (t) => {
  const base = tmp('cp-fix1-');
  const srv = await fakeServer((c) => (c.method === 'GET' ? { status: 404, json: {} } : { status: 409, json: {} }));
  t.after(() => srv.srv.close());
  const cfg = cfgFor(base, srv.url);
  const first = await putCheckpoint(cfg, state(base, 'r1'));
  assert.equal(first.state, 'failed');
  const second = await putCheckpoint(cfg, state(base, 'r2')); // used to throw: parent_revision is not the local head
  assert.equal(second.checkpoint.source_revision, 'r2');
  const ids = identityOf(cfg, base);
  fs.rmSync(cpDir(cfg, ids), { recursive: true, force: true });
  for (const bad of [{ session_id: 'has space' }, { goal: 'x'.repeat(2001) }, { decisions: ['y'.repeat(501)] }, { parent_revision: 5 }]) {
    await assert.rejects(putCheckpoint(cfg, state(base, 'r9', '', bad)), /invalid explicit checkpoint/);
  }
  assert.equal(fs.existsSync(path.join(cpDir(cfg, ids), 'head.json')), false, 'validation runs before anything is written');
});

test('401 and 403 keep the queued checkpoint instead of failing it', async (t) => {
  for (const status of [401, 403]) {
    const base = tmp('cp-fix2-');
    const srv = await fakeServer((c) => (c.method === 'GET' ? { status: 404, json: {} } : { status, json: {} }));
    t.after(() => srv.srv.close());
    const cfg = cfgFor(base, srv.url);
    const entry = await putCheckpoint(cfg, state(base, 'r1'));
    assert.equal(entry.state, 'local_queued', `status ${status}`);
  }
});

test('token-shaped ids are refused and nothing secret is printed by formatCheckpoint', async () => {
  const base = tmp('cp-fix3-');
  const cfg = cfgFor(base, 'http://127.0.0.1:1');
  for (const over of [{ session_id: SECRET }, { source_revision: SECRET }, { parent_revision: SECRET }]) {
    await assert.rejects(putCheckpoint(cfg, state(base, 'r1', '', over)), /invalid explicit checkpoint/);
  }
  const text = formatCheckpoint({ ...identityOf(cfg, base), agent: 'codex', session_id: SECRET, source_revision: SECRET, goal: SECRET,
    decisions: [SECRET], open_tasks: [], next_actions: [], artifact_refs: [], validation: [] });
  assert.doesNotMatch(text, /cmt_0123/);
});

test('a restore past its deadline serves nothing and writes no receipt', async () => {
  const base = tmp('cp-fix4a-');
  const cfg = cfgFor(base, 'http://127.0.0.1:1');
  await putCheckpoint(cfg, state(base, 'r1')); // queued locally: a normal restore would serve it
  const ac = new AbortController();
  ac.abort();
  assert.equal(await restoreCheckpoint(cfg, { cwd: base, agent: 'claude-code', session_id: 's' }, { signal: ac.signal }), null);
  const ids = identityOf(cfg, base);
  assert.deepEqual(fs.readdirSync(cpDir(cfg, ids)).filter((n) => n.startsWith('receipt-')), []);
  assert.ok(await restoreCheckpoint(cfg, { cwd: base, agent: 'claude-code', session_id: 's' }), 'without the abort it is served');
});

test('SessionStart exits within its budget when the checkpoint route never answers', async (t) => {
  const base = tmp('cp-fix4b-');
  const sockets = new Set();
  // the brief answers after 900 ms; the checkpoint route never answers
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/memory/brief')) setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ project: 'x', version: 1, body: '# brief', stale: false })); }, 900);
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); srv.close(); });
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ hindsight: { recall: false, capture: false }, openviking: { recall: false, capture: false },
    cammut: { url: `http://127.0.0.1:${srv.address().port}` } }));
  const env = { ...process.env, SM_CONFIG: configFile, SM_STATE_DIR: path.join(base, 'state'), SM_NO_SPAWN: '1', CAMMUT_MEMORY_TOKEN: 'synthetic' };
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SM, 'recall'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(JSON.stringify({ cwd: base, session_id: 'hang', hook_event_name: 'SessionStart' }));
    child.on('close', resolve);
  });
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms: brief and checkpoint must share one budget`);
});

test('local history is pruned to the newest 20 files, never the head and never queued entries', async (t) => {
  const base = tmp('cp-fix5-');
  const srv = await fakeServer((c) => (c.method === 'GET' ? { status: 404, json: {} } : { status: 401, json: {} }));
  t.after(() => srv.srv.close());
  const cfg = cfgFor(base, srv.url);
  const ids = identityOf(cfg, base);
  let parent = '';
  for (let i = 1; i <= 25; i++) { await putCheckpoint(cfg, state(base, `q${i}`, parent)); parent = `q${i}`; }
  const dir = cpDir(cfg, ids);
  const hex = (n) => n.toString(16).padStart(64, '0');
  for (let i = 0; i < 30; i++) {
    const f = path.join(dir, `${i % 2 ? 'receipt' : 'server'}-${hex(i)}.json`);
    fs.writeFileSync(f, '{}');
    fs.utimesSync(f, new Date(Date.now() - (100 + i) * 1000), new Date(Date.now() - (100 + i) * 1000));
  }
  await restoreCheckpoint(cfg, { cwd: base, agent: 'claude-code', session_id: 's' });
  const names = fs.readdirSync(dir);
  assert.equal(names.filter((n) => /^(server|receipt)-/.test(n)).length <= 20, true);
  assert.equal(names.filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).length, 25, 'queued entries are never pruned');
  assert.ok(names.includes('head.json'));
});
