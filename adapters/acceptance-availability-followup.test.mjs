import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityOf, putCheckpoint, restoreCheckpoint } from './common.mjs';
import { fakeServer } from './test-helpers.mjs';

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cammut-availability-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cfg = { stateDir: path.join(cwd, 'state'), cammut: { url: 'http://127.0.0.1:1', token: 'synthetic' }, requestMs: 150, recallMs: 150 };
  const fields = {
    agent: 'claude-code', session_id: 'synthetic', goal: 'Keep current checkpoint', decisions: ['No deployment'],
    open_tasks: [], next_actions: ['Continue synthetic evaluation'], artifact_refs: [], validation: ['Synthetic only'],
  };
  const payload = (revision, parent = '') => ({ cwd, ...fields, source_revision: revision, parent_revision: parent });
  const remote = (revision, parent = '') => ({ ...identityOf(cfg, cwd), ...fields, source_revision: revision, parent_revision: parent });
  const restore = () => restoreCheckpoint(cfg, { cwd, agent: 'codex', session_id: 'synthetic-resumer' });
  const online = (url) => {
    fs.rmSync(path.join(cfg.stateDir, 'breaker.json'), { force: true }); // Own synthetic breaker only.
    cfg.cammut.url = url;
  };
  return { cwd, cfg, payload, remote, restore, online };
}

test('availability: initial GET404 then exact durable POST replays a causal chain without duplicate application', async (t) => {
  const e = setup(t);
  await putCheckpoint(e.cfg, e.payload('r1'));
  await putCheckpoint(e.cfg, e.payload('r2', 'r1'));
  let head = null;
  const server = await fakeServer((c) => {
    if (c.method === 'GET') return head ? { status: 200, json: { checkpoint: head } } : { status: 404, json: { error: 'not_found' } };
    if (c.body.parent_revision !== (head?.source_revision || '')) return { status: 409, json: {} };
    head = c.body;
    return { status: 201, json: { checkpoint: head, state: 'server_durable' } };
  });
  t.after(() => server.srv.close());
  e.online(server.url);
  const first = await e.restore();
  assert.equal(first.checkpoint.source_revision, 'r2');
  assert.equal(first.state, 'server_durable');
  assert.equal(first.source, 'server');
  assert.deepEqual(server.calls.filter((c) => c.method === 'POST').map((c) => c.body.source_revision), ['r1', 'r2']);
  await e.restore();
  assert.equal(server.calls.filter((c) => c.method === 'POST').length, 2);
  assert.equal((await putCheckpoint(e.cfg, e.payload('r3', 'r2'))).state, 'server_durable');
});

test('availability: cached durable checkpoint with GET404 and no queue performs no phantom POST', async (t) => {
  const e = setup(t);
  let legacy = false;
  const server = await fakeServer(() => legacy
    ? { status: 404, json: { error: 'unsupported_endpoint' } }
    : { status: 200, json: { checkpoint: e.remote('r1') } });
  t.after(() => server.srv.close());
  e.online(server.url);
  assert.equal((await e.restore()).checkpoint.source_revision, 'r1');
  legacy = true;
  for (let i = 0; i < 2; i++) {
    const restored = await e.restore();
    assert.equal(restored.checkpoint.source_revision, 'r1');
    assert.equal(restored.source, 'local');
    assert.equal(restored.state, 'server_durable');
  }
  assert.deepEqual(server.calls.map((c) => c.method), ['GET', 'GET', 'GET']);
});

test('availability: failed collision history is byte-preserved while a newer valid remote head remains authoritative', async (t) => {
  const e = setup(t);
  await putCheckpoint(e.cfg, { ...e.payload('r1'), goal: 'Conflicting offline payload' });
  let head = e.remote('r1');
  const server = await fakeServer((c) => c.method === 'GET'
    ? { status: 200, json: { checkpoint: head } }
    : { status: 500, json: { error: 'unexpected_post' } });
  t.after(() => server.srv.close());
  e.online(server.url);
  assert.equal((await e.restore()).checkpoint.goal, head.goal);
  const identity = identityOf(e.cfg, e.cwd);
  const dir = path.join(e.cfg.stateDir, 'checkpoints', identity.project_id, identity.workspace_id);
  const failed = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => path.join(dir, name)).find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).state === 'failed');
  assert.ok(failed);
  const history = fs.readFileSync(failed, 'utf8');
  assert.equal(JSON.parse(history).failure, 'source_revision_collision');
  head = { ...e.remote('r2', 'r1'), goal: 'Authoritative remote successor' };
  const next = await e.restore();
  assert.equal(next.checkpoint.source_revision, 'r2');
  assert.equal(next.checkpoint.goal, head.goal);
  assert.equal(next.source, 'server');
  assert.equal(fs.readFileSync(failed, 'utf8'), history);
  assert.equal(server.calls.filter((c) => c.method === 'POST').length, 0);
});

test('availability: a queued causal descendant still wins over its older durable remote parent', async (t) => {
  const e = setup(t);
  let readOnly = false;
  const server = await fakeServer((c) => c.method === 'GET'
    ? { status: 200, json: { checkpoint: e.remote('r1') } }
    : { status: readOnly ? 503 : 500, json: {} });
  t.after(() => server.srv.close());
  e.online(server.url);
  await e.restore();
  e.online('http://127.0.0.1:1');
  assert.equal((await putCheckpoint(e.cfg, e.payload('r2', 'r1'))).state, 'local_queued');
  readOnly = true;
  e.online(server.url);
  const restored = await e.restore();
  assert.equal(restored.checkpoint.source_revision, 'r2');
  assert.equal(restored.state, 'local_queued');
  assert.equal(restored.source, 'local');
});
