import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureFor, locateRollout } from './cm.mjs';
import { drain } from '../claude-code/sm.mjs';
import { loadSession } from '../common.mjs';
import { fakeServer, fakeEncrypt, tmp, line } from '../test-helpers.mjs';

process.env.SM_NO_SPAWN = '1';
const CM = fileURLToPath(new URL('./cm.mjs', import.meta.url));
const SID = '7f6e5d4c-aaaa-bbbb-cccc-ddddeeeeffff';

function world() {
  const root = tmp('cx-');
  const codex = path.join(root, '.codex');
  const dayDir = path.join(codex, 'sessions', '2026', '10', '11');
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, `rollout-2026-10-11T10-00-00-${SID}.jsonl`);
  const rows = [line({ type: 'session_meta', payload: { id: SID, cwd: 'C:\\x\\RnaV' } })];
  for (let i = 0; i < 8; i++) rows.push(line({ type: 'response_item', payload: { role: i % 2 ? 'assistant' : 'user', text: `RAWCODEX-${i} ${'z'.repeat(60)}` } }));
  fs.writeFileSync(rollout, rows.join(''));
  fs.writeFileSync(path.join(codex, 'sessions', '2026', '10', '11', `rollout-2026-10-11T11-00-00-${'1'.repeat(8)}-aaaa-bbbb-cccc-dddddddddddd.jsonl`), 'other\n');
  const stateDir = path.join(root, 'state');
  const cfg = {
    stateDir, requestMs: 2000, encrypt: fakeEncrypt, hs: { url: 'http://127.0.0.1:1', bank: 'b', key: 'k', capture: false, recall: false }, ov: { url: 'http://127.0.0.1:1', key: 'k', capture: false, recall: false },
    cammut: { url: 'http://127.0.0.1:1', token: 'cmt_t' },
    archive: { enabled: true, recipientsFile: path.join(root, 'r.txt'), segmentBytes: 200, flushIdleMs: 0, redact: true, outboxMaxBytes: 1 << 22 },
  };
  return { root, codex, rollout, cfg, stateDir };
}
const logOf = (cfg) => { try { return fs.readFileSync(path.join(cfg.stateDir, 'hook.log'), 'utf8'); } catch { return ''; } };

test('capture with a transcript_path registers the rollout under cx-<session> as agent codex', async () => {
  const w = world();
  const ok = await captureFor(w.cfg, { session_id: SID, transcript_path: w.rollout, cwd: 'C:/x/RnaV', hook_event_name: 'Stop' }, false, w.codex);
  assert.equal(ok, true);
  const st = loadSession(w.cfg, `cx-${SID}`);
  assert.deepEqual([st.arch.agent, st.arch.file, st.arch.project, st.arch.sid, st.arch.flush], ['codex', w.rollout, 'RnaV', SID, undefined]);
  assert.match(logOf(w.cfg), /capture codex Stop transcript_path=given located=yes via=given/);
  await captureFor(w.cfg, { session_id: SID, transcript_path: w.rollout, cwd: 'C:/x/RnaV', hook_event_name: 'SessionEnd' }, true, w.codex);
  assert.equal(loadSession(w.cfg, `cx-${SID}`).arch.flush, true, 'SessionEnd asks for the tail to be cut now');
});

test('a null transcript_path is resolved by scanning for rollout-*-<session id>.jsonl, and an unknown session is reported as not located', async () => {
  const w = world();
  assert.deepEqual(locateRollout({ session_id: SID, transcript_path: null }, w.codex), { file: w.rollout, via: 'scan' });
  assert.equal(locateRollout({ session_id: 'ffffffff-0000-0000-0000-000000000000', transcript_path: null }, w.codex), null);
  assert.equal(locateRollout({ session_id: '../../x', transcript_path: null }, w.codex), null, 'the session id is never used as a path');
  assert.equal(locateRollout({ session_id: SID, transcript_path: path.join(w.root, 'missing.jsonl') }, w.codex).via, 'scan', 'a stale path falls back to the scan');
  assert.equal(await captureFor(w.cfg, { session_id: SID, transcript_path: null, cwd: 'C:/x/RnaV', hook_event_name: 'Stop' }, false, w.codex), true);
  assert.match(logOf(w.cfg), /capture codex Stop transcript_path=null located=yes via=scan/);
  assert.equal(await captureFor(w.cfg, { session_id: 'ffffffff-0000-0000-0000-000000000000', transcript_path: null, cwd: 'C:/x/P', hook_event_name: 'Stop' }, false, w.codex), false);
  assert.match(logOf(w.cfg), /capture codex Stop transcript_path=null located=no/);
  assert.ok(!fs.existsSync(path.join(w.stateDir, 'sessions', 'cx-ffffffff-0000-0000-0000-000000000000.json')));
});

test('opt-outs and archive.enabled=false register nothing', async () => {
  const w = world();
  const marked = path.join(w.root, 'proj'); fs.mkdirSync(marked); fs.writeFileSync(path.join(marked, '.no-memory'), '');
  assert.equal(await captureFor(w.cfg, { session_id: SID, transcript_path: w.rollout, cwd: marked, hook_event_name: 'Stop' }, false, w.codex), false);
  assert.equal(await captureFor({ ...w.cfg, archive: { ...w.cfg.archive, enabled: false } }, { session_id: SID, transcript_path: w.rollout, cwd: 'C:/x', hook_event_name: 'Stop' }, false, w.codex), false);
  assert.equal(await captureFor(w.cfg, { session_id: 5, transcript_path: w.rollout, cwd: 'C:/x' }, false, w.codex), false);
  assert.ok(!fs.existsSync(path.join(w.stateDir, 'sessions')));
});

test('the shared drain archives a rollout as agent codex under the uuid from its file name; the outbox holds ciphertext only', async () => {
  const w = world();
  const puts = [];
  const cm = await fakeServer((c) => { if (c.method === 'PUT') { puts.push(c); return { status: 201, json: { created: true, sha256: c.headers['x-content-sha256'], bytes: 1 } }; } return { status: 404, json: {} }; });
  w.cfg.cammut.url = cm.url;
  await captureFor(w.cfg, { session_id: SID, transcript_path: null, cwd: 'C:/x/RnaV', hook_event_name: 'SessionEnd' }, true, w.codex);
  await drain(w.cfg);
  assert.ok(puts.length >= 2);
  const meta = JSON.parse(Buffer.from(puts[0].headers['x-archive-meta'], 'base64url').toString());
  assert.deepEqual([meta.agent, meta.kind, meta.session_id, meta.project, meta.src_start], ['codex', 'transcript', SID, 'RnaV', 0]);
  const st = loadSession(w.cfg, `cx-${SID}`);
  assert.equal(st.arch.cursor, fs.statSync(w.rollout).size);
  for (const f of fs.readdirSync(path.join(w.stateDir, 'outbox'))) assert.fail(`outbox should be empty after the acknowledgement, found ${f}`);
  for (const c of puts) assert.ok(!c.raw.includes('RAWCODEX'), 'only ciphertext leaves the PC');
  cm.srv.close();
});

test('the real entry point exits 0 on garbage and on a valid payload, and registers the session', async () => {
  const w = world();
  const cfgFile = path.join(w.root, 'c.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ archive: { enabled: true, recipientsFile: w.cfg.archive.recipientsFile } }));
  const env = { ...process.env, SM_CONFIG: cfgFile, SM_STATE_DIR: w.stateDir, SM_NO_SPAWN: '1' };
  delete env.SHARED_MEMORY_BYPASS;
  const run = (args, input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CM, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; let stdout = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => (stdout += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, err, stdout }));
  });
  for (const bad of ['', 'not json', 'null', '[]', '{"session_id":5}']) assert.equal((await run(['capture'], bad)).code, 0, bad);
  assert.equal((await run(['bogus'], '')).code, 0);
  const r = await run(['capture', '--flush'], JSON.stringify({ session_id: SID, transcript_path: w.rollout, cwd: 'C:/x/RnaV', hook_event_name: 'SessionEnd' }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'capture stays silent');
  assert.ok(!/at .*\.mjs/.test(r.err));
  assert.equal(loadSession({ stateDir: w.stateDir }, `cx-${SID}`).arch.flush, true);
});

function recallRunner(w, url, script = CM) {
  const cfgFile = path.join(w.root, 'recall.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ hindsight: { recall: false }, openviking: { recall: false }, cammut: { url } }));
  const env = { ...process.env, SM_CONFIG: cfgFile, SM_STATE_DIR: w.stateDir, SM_CAMMUT_URL: url, CAMMUT_MEMORY_TOKEN: 'cmt_test', SM_NO_SPAWN: '1' };
  delete env.SHARED_MEMORY_BYPASS;
  return (input) => new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [script, 'recall'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - start }));
  });
}

test('recall SessionStart prints a labelled brief as plain text and isolates Codex session state', async (t) => {
  const w = world();
  const cm = await fakeServer(() => ({ status: 200, json: { project: 'Cammut', version: 3, stale: false, body: '# Cammut — brief\n- phase 3' } }));
  t.after(() => cm.srv.close());
  const run = recallRunner(w, cm.url);
  const payload = { hook_event_name: 'SessionStart', cwd: 'C:/x/Cammut', session_id: SID };
  const out = await run(payload);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^<project-brief project="Cammut" version="3"/);
  assert.match(out.stdout, /untrusted/i);
  assert.equal(out.stderr, '');
  const briefCalls = () => cm.calls.filter((c) => c.url.startsWith('/v1/memory/brief'));
  assert.equal(new URL(cm.url + briefCalls()[0].url).searchParams.get('session'), SID, 'send the real session id to the server');
  assert.equal(loadSession(w.cfg, `cx-${SID}`).brief.version, 3);
  assert.equal(loadSession(w.cfg, SID).brief, undefined);
  assert.match((await run(payload)).stdout, /^<project-brief/);
  assert.equal(briefCalls().length, 1, 'the second start is served from the brief cache (the checkpoint route is separate)');
});

test('recall UserPromptSubmit prints notes once, ignores slash prompts and fails open on malformed payloads', async (t) => {
  const w = world();
  const cm = await fakeServer(() => ({ status: 200, json: { notes: [{ id: '01J1', kind: 'howto', title: 'Gate', body: 'bash dev/gate.sh', updated_at: '2026-10-11T00:00:00Z' }] } }));
  t.after(() => cm.srv.close());
  const run = recallRunner(w, cm.url);
  const p = { hook_event_name: 'UserPromptSubmit', cwd: 'C:/x/Cammut', session_id: SID, prompt: 'how do I run the go tests on the vds?' };
  const first = await run(p);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /^<shared-memory/);
  assert.match(first.stdout, /Cammut notes:\n- \[howto 2026-10-11\] \*\*Gate\*\* — bash dev\/gate\.sh/);
  assert.equal((await run(p)).stdout, '');
  const calls = cm.calls.length;
  for (const input of [{ ...p, prompt: '/status' }, '', 'not json', 'null', '[]']) {
    const out = await run(input);
    assert.equal(out.code, 0);
    assert.equal(out.stdout, '');
    assert.equal(out.stderr, '');
  }
  assert.equal(cm.calls.length, calls, 'slash and malformed inputs make no calls');
});

test('recall works from the copied installed layout with sm.mjs byte-identical to the repo', async (t) => {
  const w = world();
  const installed = path.join(w.root, 'installed');
  fs.mkdirSync(path.join(installed, 'codex'), { recursive: true });
  for (const [source, target] of [['../common.mjs', 'common.mjs'], ['../hs-recall.mjs', 'hs-recall.mjs'], ['../archive.mjs', 'archive.mjs'], ['../claude-code/sm.mjs', 'sm.mjs'], ['./cm.mjs', 'codex/cm.mjs']]) {
    fs.copyFileSync(fileURLToPath(new URL(source, import.meta.url)), path.join(installed, target));
  }
  assert.ok(fs.readFileSync(path.join(installed, 'sm.mjs')).equals(fs.readFileSync(fileURLToPath(new URL('../claude-code/sm.mjs', import.meta.url)))));
  const cm = await fakeServer(() => ({ status: 200, json: { version: 1, body: '# copied', stale: false } }));
  t.after(() => cm.srv.close());
  const out = await recallRunner(w, cm.url, path.join(installed, 'codex', 'cm.mjs'))({ hook_event_name: 'SessionStart', cwd: 'C:/x/Cammut', session_id: SID });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^<project-brief/);
  assert.equal(out.stderr, '');
});

test('recall against a silent Cammut exits zero and says so once, in one line, within three seconds for either event', async (t) => {
  const cm = await fakeServer(() => ({ hang: true }));
  t.after(() => { cm.srv.closeAllConnections(); cm.srv.close(); });
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit']) {
    const w = world();
    const out = await recallRunner(w, cm.url)({ hook_event_name, cwd: 'C:/x/Cammut', session_id: SID, prompt: 'please explain how to run the project tests' });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /memory unavailable/i);
    assert.equal(out.stdout.trim().split(String.fromCharCode(10)).length, 1, 'one line, once');
    assert.equal(out.stderr, '');
    assert.ok(out.ms < 3000, `${hook_event_name} took ${out.ms} ms`);
  }
});

test('Warp templates name the memory lifecycle, label untrusted data and keep the token a placeholder', () => {
  const rules = fs.readFileSync(new URL('../warp/AGENTS.memory.md', import.meta.url), 'utf8');
  assert.ok(rules.trim().split('\n').length <= 12);
  for (const tool of ['memory_brief', 'memory_recall', 'memory_handoff']) assert.ok(rules.includes(tool));
  assert.match(rules, /untrusted.*data.*not instructions/i);
  const mcp = JSON.parse(fs.readFileSync(new URL('../warp/mcp.json.example', import.meta.url), 'utf8'));
  assert.deepEqual(mcp, { mcpServers: { 'cammut-memory': { url: 'https://cammut.example/mcp', headers: { Authorization: 'Bearer <paste the warp token here>' } } } });
});

test('the Codex README keeps the hook table (recall and capture events)', () => {
  const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd']) assert.match(readme, new RegExp('\| `' + event + '` \|'), event);
  assert.match(readme, /cm\.mjs" capture --flush|cm\.mjs capture --flush/);
});
