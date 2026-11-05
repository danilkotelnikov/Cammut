import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as common from './common.mjs';
import { fakeServer, tmp } from './test-helpers.mjs';
const { identityOf, putCheckpoint, restoreCheckpoint, recordCheckpointEmission, checkpointReceipt } = common;

function worktrees() {
  const base = tmp('continuity-');
  const main = path.join(base, 'one', 'Cammut');
  const feature = path.join(base, 'two', 'Cammut');
  const unrelated = path.join(base, 'elsewhere', 'Cammut');
  for (const root of [main, feature, unrelated]) fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
  fs.writeFileSync(path.join(feature, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`);
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
  return { base, main, feature, unrelated };
}

const config = (base, url = 'http://127.0.0.1:1', identity = {}) => ({
  stateDir: path.join(base, 'state'),
  cammut: { url, token: 'synthetic', ...identity },
  requestMs: 150,
});

const state = (cwd, agent, sessionId, revision, parent = '') => ({
  cwd, agent, session_id: sessionId,
  goal: `Finish ${revision}`,
  decisions: ['Use explicit checkpoint, not inferred facts'],
  open_tasks: ['Finish synthetic test'],
  next_actions: ['Run the fake-service checks'],
  artifact_refs: ['adapters/fixtures/continuity-acceptance.json'],
  validation: ['Node tests pending'],
  source_revision: revision,
  parent_revision: parent,
});

test('opaque project identity follows a Git common directory, while workspace and same-name clones stay distinct', () => {
  assert.equal(typeof identityOf, 'function', 'identity resolver must exist');
  const w = worktrees();
  const cfg = config(w.base);
  const main = identityOf(cfg, w.main);
  const feature = identityOf(cfg, w.feature);
  const unrelated = identityOf(cfg, w.unrelated);
  assert.match(main.project_id, /^p_[0-9a-f]{32}$/);
  assert.match(main.workspace_id, /^w_[0-9a-f]{32}$/);
  assert.equal(main.project_id, feature.project_id);
  assert.notEqual(main.workspace_id, feature.workspace_id);
  assert.notEqual(main.project_id, unrelated.project_id);
  assert.equal(main.project, 'Cammut');
  const mapped = identityOf(config(w.base, '', { projectMappings: { [w.main]: 'p_11111111111111111111111111111111' } }), w.main);
  assert.equal(mapped.project_id, 'p_11111111111111111111111111111111', 'explicit cross-machine mapping is authoritative');
  assert.equal(identityOf(config(w.base, '', { projectMappings: { [w.main]: mapped.project_id } }), w.feature).project_id,
    mapped.project_id, 'mapping the common Git project also maps its linked worktrees');
});

test('Claude to Codex to Claude uses a versioned explicit checkpoint without replacing parallel worktree state', async (t) => {
  assert.equal(typeof putCheckpoint, 'function', 'explicit checkpoint writer must exist');
  const w = worktrees();
  const heads = new Map();
  const server = await fakeServer((call) => {
    const url = new URL(`http://local${call.url}`);
    const key = `${url.searchParams.get('project_id')}:${url.searchParams.get('workspace_id')}`;
    if (call.method === 'GET') return heads.has(key) ? { status: 200, json: { checkpoint: heads.get(key) } } : { status: 404, json: {} };
    const c = call.body;
    heads.set(`${c.project_id}:${c.workspace_id}`, c);
    return { status: 201, json: { checkpoint: c, state: 'server_durable' } };
  });
  t.after(() => server.srv.close());
  const cfg = config(w.base, server.url);
  const first = state(w.main, 'claude-code', 'claude-native-s1', 'cc:s1:1');
  assert.equal((await putCheckpoint(cfg, first)).state, 'server_durable');
  const codex = await restoreCheckpoint(cfg, { cwd: w.main, agent: 'codex', session_id: 'codex-native-s2' });
  assert.equal(codex.delivery, 'served');
  assert.equal(codex.checkpoint.source_revision, first.source_revision);
  assert.deepEqual(codex.checkpoint.next_actions, first.next_actions);
  assert.equal((await putCheckpoint(cfg, state(w.feature, 'claude-code', 'parallel', 'cc:p:1'))).state, 'server_durable');
  const second = state(w.main, 'codex', 'codex-native-s2', 'cx:s2:2', 'cc:s1:1');
  assert.equal((await putCheckpoint(cfg, second)).state, 'server_durable');
  const restart = await restoreCheckpoint(cfg, { cwd: w.main, agent: 'claude-code', session_id: 'claude-native-s3', source: 'compact' });
  assert.equal(restart.checkpoint.goal, 'Finish cx:s2:2');
  assert.equal(restart.checkpoint.parent_revision, 'cc:s1:1');
  const other = await restoreCheckpoint(cfg, { cwd: w.feature, agent: 'codex', session_id: 'new' });
  assert.equal(other.checkpoint.source_revision, 'cc:p:1', 'parallel worktree is independent');
  const stranger = await restoreCheckpoint(cfg, { cwd: w.unrelated, agent: 'codex', session_id: 'new' });
  assert.equal(stranger, null, 'same basename cannot retrieve another project');
});

test('offline checkpoint is queued durably; replay and restart use it without claiming client confirmation', async () => {
  assert.equal(typeof restoreCheckpoint, 'function', 'checkpoint reader must exist');
  const w = worktrees();
  const cfg = config(w.base);
  const first = state(w.main, 'claude-code', 'claude-native-s1', 'cc:s1:1');
  const queued = await putCheckpoint(cfg, first);
  assert.equal(queued.state, 'local_queued');
  const restored = await restoreCheckpoint(cfg, { cwd: w.main, agent: 'codex', session_id: 'cx:s2' });
  assert.equal(restored.checkpoint.goal, first.goal);
  assert.equal(restored.delivery, 'served');
  assert.equal(checkpointReceipt(cfg, restored.checkpoint)?.delivery, 'served');
  recordCheckpointEmission(cfg, restored.checkpoint);
  assert.equal(checkpointReceipt(cfg, restored.checkpoint)?.delivery, 'emitted');
  assert.notEqual(checkpointReceipt(cfg, restored.checkpoint)?.delivery, 'confirmed');
  await assert.rejects(
    putCheckpoint(cfg, state(w.main, 'codex', 'cx:s2', 'cx:s2:2', 'stale:revision')),
    /parent_revision/,
  );
  const duplicate = await putCheckpoint(cfg, first);
  assert.equal(duplicate.state, 'local_queued');
  await assert.rejects(putCheckpoint(cfg, { ...first, goal: 'conflicting revision' }), /source_revision/);
});

test('offline causal checkpoints replay in order once a server returns; subsequent restores do not reapply them', async (t) => {
  const w = worktrees();
  const cfg = config(w.base);
  const first = state(w.main, 'claude-code', 'cc-native', 'cc:offline:1');
  const second = state(w.main, 'codex', 'cx-native', 'cx:offline:2', first.source_revision);
  assert.equal((await putCheckpoint(cfg, first)).state, 'local_queued');
  assert.equal((await putCheckpoint(cfg, second)).state, 'local_queued');
  let head = null;
  const posts = [];
  const server = await fakeServer((call) => {
    if (call.method === 'GET') return head ? { status: 200, json: { checkpoint: head } } : { status: 404, json: {} };
    posts.push(call.body.source_revision);
    if (call.body.parent_revision !== (head?.source_revision || '')) return { status: 409, json: {} };
    head = call.body;
    return { status: 201, json: { checkpoint: head, state: 'server_durable' } };
  });
  t.after(() => server.srv.close());
  const online = config(w.base, server.url);
  fs.rmSync(path.join(online.stateDir, 'breaker.json'), { force: true }); // synthetic 45s breaker expiry
  const restored = await restoreCheckpoint(online, { cwd: w.main, agent: 'claude-code', session_id: 'cc-restart' });
  assert.equal(restored.checkpoint.source_revision, second.source_revision);
  assert.equal(restored.state, 'server_durable');
  assert.deepEqual(posts, [first.source_revision, second.source_revision]);
  const afterRestart = await restoreCheckpoint(online, { cwd: w.main, agent: 'codex', session_id: 'cx-restart' });
  assert.equal(afterRestart.checkpoint.source_revision, second.source_revision);
  assert.deepEqual(posts, [first.source_revision, second.source_revision]);
  assert.equal((await putCheckpoint(online, first)).state, 'server_durable');
  assert.deepEqual(posts, [first.source_revision, second.source_revision]);
});

test('a remote divergent head wins restoration without deleting an offline conflict', async (t) => {
  const w = worktrees();
  const offline = config(w.base);
  const pending = state(w.main, 'claude-code', 'cc-native', 'cc:offline:1');
  await putCheckpoint(offline, pending);
  const remote = {
    ...identityOf(offline, w.main),
    ...state(w.main, 'codex', 'cx-native', 'cx:remote:1'),
  };
  delete remote.cwd;
  const server = await fakeServer((call) => call.method === 'GET'
    ? { status: 200, json: { checkpoint: remote } }
    : { status: 409, json: {} });
  t.after(() => server.srv.close());
  const online = config(w.base, server.url);
  fs.rmSync(path.join(online.stateDir, 'breaker.json'), { force: true }); // synthetic 45s breaker expiry
  const restored = await restoreCheckpoint(online, { cwd: w.main, agent: 'codex', session_id: 'cx-restart' });
  assert.equal(restored.checkpoint.source_revision, remote.source_revision);
  assert.equal(restored.source, 'server');
  const id = identityOf(offline, w.main);
  const records = fs.readdirSync(path.join(online.stateDir, 'checkpoints', id.project_id, id.workspace_id))
    .filter((name) => /^[0-9a-f]{64}\.json$/.test(name)); // server cache is separate from failed local history
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(online.stateDir, 'checkpoints', id.project_id, id.workspace_id, records[0]), 'utf8')).state, 'failed');
});

test('a successful HTTP status without a durable checkpoint receipt stays queued until a later exact server read', async (t) => {
  const w = worktrees();
  let remote = null;
  const server = await fakeServer((call) => {
    if (call.method === 'GET') return remote ? { status: 200, json: { checkpoint: remote } } : { status: 404, json: {} };
    remote = call.body;
    return { status: 202, json: {} }; // Accepted, but the response body was lost or incomplete.
  });
  t.after(() => server.srv.close());
  const cfg = config(w.base, server.url);
  const first = state(w.main, 'claude-code', 'cc-native', 'cc:ambiguous:1');
  assert.equal((await putCheckpoint(cfg, first)).state, 'local_queued');
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1);
  const restored = await restoreCheckpoint(cfg, { cwd: w.main, agent: 'codex', session_id: 'cx-native' });
  assert.equal(restored.state, 'server_durable', 'exact read reconciles the ambiguous POST');
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 1);
});

test('large offline chains replay incrementally while the latest local descendant remains restorable', async (t) => {
  const w = worktrees();
  const cfg = config(w.base);
  const revisions = ['cc:offline:1', 'cx:offline:2', 'cc:offline:3'];
  for (let i = 0; i < revisions.length; i++) {
    assert.equal((await putCheckpoint(cfg, state(w.main, i % 2 ? 'codex' : 'claude-code', `native-${i}`,
      revisions[i], revisions[i - 1] || ''))).state, 'local_queued');
  }
  let remote = null;
  const server = await fakeServer((call) => {
    if (call.method === 'GET') return remote ? { status: 200, json: { checkpoint: remote } } : { status: 404, json: {} };
    assert.equal(call.body.parent_revision, remote?.source_revision || '');
    remote = call.body;
    return { status: 201, json: { checkpoint: remote, state: 'server_durable' } };
  });
  t.after(() => server.srv.close());
  const online = config(w.base, server.url);
  fs.rmSync(path.join(online.stateDir, 'breaker.json'), { force: true });
  const first = await restoreCheckpoint(online, { cwd: w.main, agent: 'codex', session_id: 'new' });
  assert.equal(first.checkpoint.source_revision, revisions[2]);
  assert.equal(first.state, 'local_queued');
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 2);
  const second = await restoreCheckpoint(online, { cwd: w.main, agent: 'claude-code', session_id: 'new' });
  assert.equal(second.checkpoint.source_revision, revisions[2]);
  assert.equal(second.state, 'server_durable');
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, 3);
});

test('a queued child of a cached remote head survives unsupported GET or POST checkpoint routes', async (t) => {
  const w = worktrees();
  const offline = config(w.base);
  const remote = { ...identityOf(offline, w.main), ...state(w.main, 'claude-code', 'remote', 'cc:remote:1') };
  delete remote.cwd;
  let mode = 'supported';
  const server = await fakeServer((call) => {
    if (call.method === 'GET') return mode === 'no-get'
      ? { status: 404, json: { error: 'not_found' } }
      : { status: 200, json: { checkpoint: remote } };
    return { status: 404, json: { error: 'not_found' } };
  });
  t.after(() => server.srv.close());
  const online = config(w.base, server.url);
  assert.equal((await restoreCheckpoint(online, { cwd: w.main, agent: 'codex', session_id: 'first' })).state, 'server_durable');
  const child = state(w.main, 'codex', 'offline', 'cx:offline:2', remote.source_revision);
  assert.equal((await putCheckpoint(offline, child)).state, 'local_queued');
  fs.rmSync(path.join(online.stateDir, 'breaker.json'), { force: true });
  mode = 'no-get';
  assert.equal((await restoreCheckpoint(online, { cwd: w.main, agent: 'codex', session_id: 'second' })).checkpoint.source_revision, child.source_revision);
  assert.equal((await restoreCheckpoint(offline, { cwd: w.main, agent: 'claude-code', session_id: 'third' })).state, 'local_queued');
  fs.rmSync(path.join(online.stateDir, 'breaker.json'), { force: true });
  mode = 'supported'; // Reads work, but the old server rejects writes.
  const restored = await restoreCheckpoint(online, { cwd: w.main, agent: 'codex', session_id: 'fourth' });
  assert.equal(restored.checkpoint.source_revision, child.source_revision);
  assert.equal(restored.state, 'local_queued');
  assert.equal((await putCheckpoint(offline, child)).state, 'local_queued', 'the original queued child remains idempotent');
});
