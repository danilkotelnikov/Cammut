// Autotrigger matrix, noise/latency controls and Cammut-only mode. Fake servers and synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as sm from './sm.mjs';
import { fakeServer, tmp, line } from '../test-helpers.mjs';
import { loadConfig, loadSession, saveSession } from '../common.mjs';

process.env.SM_NO_SPAWN = '1';

const cfgFor = (dir, url, over = {}) => ({
  stateDir: dir, requestMs: 2000, recallMs: 1500,
  cammut: { url, token: 'cmt_test', brief: true, recall: true, briefTier: 'core', briefCache: true },
  briefCache: { enabled: true },
  hs: { url: 'http://127.0.0.1:1', bank: 'b', key: 'hs-key', capture: false, recall: false },
  ov: { url: 'http://127.0.0.1:1', key: 'ov-key', capture: false, recall: false },
  ...over,
});
const start = (sid = 's1', over = {}) => ({ hook_event_name: 'SessionStart', cwd: 'C:/x/Cammut', session_id: sid, source: 'startup', ...over });
const prompt = (sid = 's1', text = 'how do I run the go tests on the vds?') => ({ ...start(sid), hook_event_name: 'UserPromptSubmit', prompt: text });
const ctx = (out) => out?.hookSpecificOutput.additionalContext;
const note = (id, over = {}) => ({ id, kind: 'howto', title: `Gate ${id}`, body: `bash dev/gate.sh runs the go tests on the vds (${id})`, updated_at: '2026-10-11T00:00:00Z', score: 1, ...over });
// A child process must never reach the real tunnel (127.0.0.1:8888/1933) or use real keys: dead URLs, no keys, no inherited flags.
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, SM_HS_URL: 'http://127.0.0.1:1', SM_OV_URL: 'http://127.0.0.1:1', SM_NO_SPAWN: '1', ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('SHARED_MEMORY_') && !(k in extra)) delete env[k];
  if (!('SM_CAMMUT_ONLY' in extra)) delete env.SM_CAMMUT_ONLY;
  return env;
};
const recallServer = (json, status = 200) => fakeServer((c) => (c.url.startsWith('/v1/memory/recall') ? { status, json } : { status: 404, json: {} }));

test('noise: a server that says abstained injects nothing, even when it still lists notes', async (t) => {
  const cm = await recallServer({ notes: [note('n1')], abstained: true });
  t.after(() => cm.srv.close());
  const dir = tmp();
  assert.equal(await sm.recallFor(cfgFor(dir, cm.url), prompt()), null);
  assert.deepEqual(loadSession(cfgFor(dir, cm.url), 's1').seen || [], []);
});

test('noise: at most 3 hits and 1,500 characters reach the model', async (t) => {
  const many = Array.from({ length: 6 }, (_, i) => note(`n${i}`, { body: `bash dev/gate.sh runs the go tests ${'x'.repeat(280)}` }));
  const cm = await recallServer({ notes: many });
  t.after(() => cm.srv.close());
  const out = await sm.recallFor(cfgFor(tmp(), cm.url), prompt());
  const text = ctx(out);
  assert.equal((text.match(/^- \[/gm) || []).length, 3);
  assert.ok(text.length <= 1500, `injected ${text.length} chars`);
  const tight = await sm.recallFor(cfgFor(tmp(), cm.url, { inject: { maxHits: 3, maxChars: 700 } }), prompt('s2'));
  assert.ok(ctx(tight).length <= 700);
  assert.ok((ctx(tight).match(/^- \[/gm) || []).length >= 1, 'the first hit survives a tight cap');
});

test('noise: a hit that does not pass the local floor is dropped; when none passes nothing is injected', async (t) => {
  const weak = note('w', { score: 0.2 });
  const offTopic = note('o', { score: 1, title: 'Lab freezer', body: 'antibody aliquots live in rack B' });
  const cm = await recallServer({ notes: [offTopic, weak] });
  t.after(() => cm.srv.close());
  assert.equal(await sm.recallFor(cfgFor(tmp(), cm.url), prompt()), null, 'relative score 0.2 and no shared term with the prompt');
  const good = await recallServer({ notes: [offTopic, note('g', { score: 0.8 })] });
  t.after(() => good.srv.close());
  const text = ctx(await sm.recallFor(cfgFor(tmp(), good.url), prompt()));
  assert.match(text, /Gate g/);
  assert.ok(!text.includes('Lab freezer'));
});

test('noise: the overlap rule can be switched off, and unscored notes from an older server are kept', async (t) => {
  const cm = await recallServer({ notes: [note('a', { title: 'Lab freezer', body: 'antibody aliquots', score: 0.9 })] });
  t.after(() => cm.srv.close());
  assert.ok(ctx(await sm.recallFor(cfgFor(tmp(), cm.url, { inject: { maxHits: 3, maxChars: 1500, minScore: 0.55, requireOverlap: false } }), prompt())));
  const old = await recallServer({ notes: [{ id: 'u', kind: 'howto', title: 'Gate', body: 'bash dev/gate.sh', updated_at: '2026-10-11T00:00:00Z' }] });
  t.after(() => old.srv.close());
  assert.ok(ctx(await sm.recallFor(cfgFor(tmp(), old.url), prompt())));
});

test('noise: a note injected within the last N prompts is not repeated and comes back after the window', async (t) => {
  const cm = await recallServer({ notes: [note('n1')] });
  t.after(() => cm.srv.close());
  const cfg = cfgFor(tmp(), cm.url, { inject: { maxHits: 3, maxChars: 1500, dedupePrompts: 2, minScore: 0.55, requireOverlap: true } });
  const q = (n) => prompt('win', `how do I run the go tests on the vds? attempt ${n}`);
  assert.ok(ctx(await sm.recallFor(cfg, q(1))), 'prompt 1 injects');
  assert.equal(await sm.recallFor(cfg, q(2)), null, 'prompt 2 is inside the window');
  assert.equal(await sm.recallFor(cfg, q(3)), null, 'prompt 3 is inside the window');
  assert.ok(ctx(await sm.recallFor(cfg, q(4))), 'prompt 4 is past the window');
});

test('noise: a dead Cammut gives one "memory unavailable" line per session and never throws', async () => {
  const cfg = cfgFor(tmp(), 'http://127.0.0.1:1');
  const first = ctx(await sm.recallFor(cfg, prompt('down')));
  assert.match(first, /memory unavailable/i);
  assert.ok(first.length < 200);
  assert.equal(await sm.recallFor(cfg, prompt('down')), null, 'once per session');
  assert.match(ctx(await sm.recallFor(cfg, prompt('other'))), /memory unavailable/i, 'a new session may be told again');
});

test('latency: a hung Cammut is abandoned at the prompt budget, not at the transport timeout', async (t) => {
  const cm = await fakeServer(() => ({ hang: true }));
  t.after(() => { cm.srv.closeAllConnections(); cm.srv.close(); });
  const cfg = cfgFor(tmp(), cm.url, { hooks: { promptBudgetMs: 400, promptAbortMs: 6000 }, recallMs: 5000 });
  const t0 = Date.now();
  await sm.recallFor(cfg, prompt('slow'));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('latency: withAbort answers null at the hard limit and passes a fast result through', async () => {
  assert.equal(await sm.withAbort(new Promise(() => {}), 50), null);
  assert.equal(await sm.withAbort(Promise.resolve({ a: 1 }), 500).then((r) => r.a), 1);
  assert.equal(await sm.withAbort(Promise.reject(new Error('boom')), 500), null, 'fail open');
});

test('loadConfig: noise and latency defaults match the order, and everything can be overridden', () => {
  const dir = tmp();
  const c = loadConfig({ SM_CONFIG: path.join(dir, 'none.json'), SM_STATE_DIR: dir });
  assert.deepEqual([c.inject.maxHits, c.inject.maxChars, c.hooks.promptBudgetMs, c.hooks.promptAbortMs], [3, 1500, 3000, 6000]);
  assert.equal(c.cammutOnly, false);
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ cammut: { only: true }, inject: { maxHits: 2 }, hooks: { promptAbortMs: 5000 } }));
  const d = loadConfig({ SM_CONFIG: f, SM_STATE_DIR: dir });
  assert.deepEqual([d.cammutOnly, d.inject.maxHits, d.inject.maxChars, d.hooks.promptAbortMs], [true, 2, 1500, 5000]);
  assert.equal(loadConfig({ SM_CONFIG: path.join(dir, 'none.json'), SM_CAMMUT_ONLY: '1' }).cammutOnly, true);
  assert.equal(loadConfig({ SM_CONFIG: f, SM_CAMMUT_ONLY: '0' }).cammutOnly, true, 'the env var only switches on');
});

// ---- Cammut-only mode ---------------------------------------------------------------------------------------

const onlyWorld = async (t, cmHandler) => {
  const hs = await fakeServer(() => ({ status: 200, json: { results: [{ id: 'h', text: 'legacy hit', scores: { semantic: 0.9 } }], async: false, success: true } }));
  const ov = await fakeServer(() => ({ status: 200, json: { result: { entries: [] } } }));
  const cm = await fakeServer(cmHandler || ((c) => (c.url.startsWith('/v1/memory/recall') ? { status: 200, json: { notes: [note('n1')] } }
    : c.url.startsWith('/v1/memory/brief') ? { status: 200, json: { project: 'Cammut', version: 2, body: '# brief', stale: false } } : { status: 404, json: {} })));
  t.after(() => { hs.srv.close(); ov.srv.close(); cm.srv.close(); });
  const dir = tmp();
  const cfg = cfgFor(dir, cm.url, {
    cammutOnly: true,
    hs: { url: hs.url, bank: 'b', key: 'hs-key', capture: true, recall: true },
    ov: { url: ov.url, key: 'ov-key', capture: true, recall: true },
  });
  return { hs, ov, cm, dir, cfg };
};

test('cammut-only: prompts are recalled from Cammut with the config token and Hindsight/OpenViking see no request', async (t) => {
  const w = await onlyWorld(t);
  const out = await sm.recallFor(w.cfg, prompt('co1'));
  assert.match(ctx(out), /Gate n1/);
  assert.ok(!ctx(out).includes('legacy hit'));
  assert.equal(w.cm.calls[0].auth, 'Bearer cmt_test');
  assert.equal(w.cm.calls[0].headers['x-memory-session'], 'co1');
  assert.deepEqual([w.hs.calls.length, w.ov.calls.length], [0, 0]);
});

test('cammut-only: SessionStart serves the Cammut brief, and with no brief it still does not fall back to Hindsight', async (t) => {
  const w = await onlyWorld(t);
  assert.match(ctx(await sm.recallFor(w.cfg, start('co2'))), /<project-brief project="Cammut" version="2"/);
  const down = await onlyWorld(t, () => ({ status: 503, json: {} }));
  const out = await sm.recallFor(down.cfg, start('co3'));
  assert.match(ctx(out), /memory unavailable/i);
  assert.deepEqual([down.hs.calls.length, down.ov.calls.length], [0, 0]);
});

test('cammut-only: capture queues nothing for Hindsight/OpenViking, advances its cursor and drain leaves old items alone', async (t) => {
  const w = await onlyWorld(t);
  const file = path.join(w.dir, 't.jsonl');
  fs.writeFileSync(file, ['hello there', 'second', 'third', 'fourth'].map((m, i) => line({ type: i % 2 ? 'assistant' : 'user', timestamp: '2026-10-17T10:00:0' + i + 'Z', message: { role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text: m }] : m } })).join(''));
  await sm.captureFor(w.cfg, { session_id: 'co4', transcript_path: file, cwd: 'C:/x/Cammut', hook_event_name: 'SessionEnd' }, true);
  assert.equal(sm.spoolFiles(w.cfg).length, 0);
  assert.equal(loadSession(w.cfg, 'co4').offset, fs.statSync(file).size);
  // an item queued by the default mode before the switch stays put instead of being delivered or dropped
  sm.enqueue(w.cfg, { kind: 'range', sid: 'old', project: 'Cammut', file, start: 0, end: fs.statSync(file).size, chunkId: 'cc-old-0' });
  await sm.drain(w.cfg);
  assert.equal(sm.spoolFiles(w.cfg).length, 1);
  assert.deepEqual([w.hs.calls.length, w.ov.calls.length], [0, 0]);
});

test('cammut-only: the default (flag off) keeps talking to Hindsight exactly as before', async (t) => {
  const w = await onlyWorld(t);
  w.cfg.cammutOnly = false;
  const out = await sm.recallFor(w.cfg, prompt('co5'));
  assert.match(ctx(out), /legacy hit/);
  assert.ok(w.hs.calls.length >= 1);
});

test('cammut-only: the real entry point obeys SM_CAMMUT_ONLY=1, status never probes the legacy services', async (t) => {
  const w = await onlyWorld(t);
  const dir = tmp();
  const env = cleanEnv({ SM_CONFIG: path.join(dir, 'none.json'), SM_STATE_DIR: path.join(dir, 'state'), SM_CAMMUT_URL: w.cm.url, CAMMUT_MEMORY_TOKEN: 'cmt_test',
    SM_HS_URL: w.hs.url, SM_OV_URL: w.ov.url, SHARED_MEMORY_HINDSIGHT_API_KEY: 'k', SHARED_MEMORY_OPENVIKING_API_KEY: 'k', SM_CAMMUT_ONLY: '1' });
  const run = (args, input) => new Promise((resolve) => {
    const child = execFile(process.execPath, [fileURLToPath(new URL('./sm.mjs', import.meta.url)), ...args], { env, timeout: 15000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
  const r = await run(['recall'], JSON.stringify(prompt('co6')));
  assert.equal(r.error, null);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Gate n1/);
  const s = await run(['status']);
  assert.match(s.stdout, /cammut-only/i);
  assert.deepEqual([w.hs.calls.length, w.ov.calls.length], [0, 0]);
});

// ---- compaction re-prime ------------------------------------------------------------------------------------

test('compact: SessionStart(source=compact) injects the brief again and makes earlier hits eligible once more', async (t) => {
  const cm = await fakeServer((c) => (c.url.startsWith('/v1/memory/recall') ? { status: 200, json: { notes: [note('n1')] } }
    : { status: 200, json: { project: 'Cammut', version: 3, body: '# brief v3', stale: false } }));
  t.after(() => cm.srv.close());
  const cfg = cfgFor(tmp(), cm.url);
  assert.match(ctx(await sm.recallFor(cfg, start('cp'))), /# brief v3/);
  assert.match(ctx(await sm.recallFor(cfg, prompt('cp'))), /Gate n1/);
  assert.equal(await sm.recallFor(cfg, prompt('cp')), null, 'inside the window: not repeated');
  const again = await sm.recallFor(cfg, start('cp', { source: 'compact' }));
  assert.match(ctx(again), /<project-brief[\s\S]*# brief v3/, 'the brief is re-primed after compaction');
  assert.match(ctx(await sm.recallFor(cfg, prompt('cp'))), /Gate n1/, 'the model lost the earlier injection, so it may be shown again');
});

test('compact: resume keeps the dedupe state, clear resets it', async (t) => {
  const cm = await fakeServer((c) => (c.url.startsWith('/v1/memory/recall') ? { status: 200, json: { notes: [note('n1')] } }
    : { status: 200, json: { project: 'Cammut', version: 3, body: '# brief v3', stale: false } }));
  t.after(() => cm.srv.close());
  const cfg = cfgFor(tmp(), cm.url);
  await sm.recallFor(cfg, prompt('rs'));
  await sm.recallFor(cfg, start('rs', { source: 'resume' }));
  assert.equal(await sm.recallFor(cfg, prompt('rs')), null);
  await sm.recallFor(cfg, start('rs', { source: 'clear' }));
  assert.ok(await sm.recallFor(cfg, prompt('rs')));
});

test('compact: PreCompact capture forgets the injected-hit window as well as the ids', async () => {
  const dir = tmp();
  const cfg = cfgFor(dir, 'http://127.0.0.1:1', { archive: { enabled: false } });
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '');
  saveSession(cfg, 'pc', { seen: ['cm:a'], seenAt: { 'cm:a': 4 } });
  await sm.captureFor(cfg, { session_id: 'pc', transcript_path: file, cwd: 'C:/x/Cammut', hook_event_name: 'PreCompact' }, true);
  const st = loadSession(cfg, 'pc');
  assert.deepEqual([st.seen, st.seenAt], [[], {}]);
});

// ---- SubagentStart ------------------------------------------------------------------------------------------

const subStart = (over = {}) => ({ hook_event_name: 'SubagentStart', cwd: 'C:/x/Cammut', session_id: 'parent1', agent_id: 'agent-abc', agent_type: 'Explore', ...over });
const mainTranscript = (dir, uses) => {
  const f = path.join(dir, 'main.jsonl');
  fs.writeFileSync(f, [line({ type: 'user', message: { role: 'user', content: 'please look into the gate script' } }),
    ...uses.map((input, i) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'delegating' }, { type: 'tool_use', id: `tu${i}`, name: 'Agent', input }] } }))].join(''));
  return f;
};
const subServer = (briefBody = '# brief v3') => fakeServer((c) => (c.url.startsWith('/v1/memory/recall') ? { status: 200, json: { notes: [note('n1')] } }
  : { status: 200, json: { project: 'Cammut', version: 3, body: briefBody, stale: false } }));

test('SubagentStart: the subagent gets the brief and notes recalled by its task text, as valid additionalContext', async (t) => {
  const cm = await subServer();
  t.after(() => cm.srv.close());
  const dir = tmp();
  const cfg = cfgFor(dir, cm.url);
  const transcript_path = mainTranscript(dir, [{ description: 'Gate check', prompt: 'Find how the go tests run on the vds', subagent_type: 'Explore' }]);
  const out = await sm.recallFor(cfg, subStart({ transcript_path }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
  const text = ctx(out);
  assert.match(text, /<project-brief project="Cammut"/);
  assert.match(text, /Gate n1/);
  assert.ok(text.length <= 10000);
  JSON.parse(JSON.stringify(out));
  const recall = cm.calls.find((c) => c.url.startsWith('/v1/memory/recall'));
  assert.match(recall.body.query, /Find how the go tests run on the vds/);
  assert.equal(recall.body.project, 'Cammut');
});

test('SubagentStart: the task is matched by agent type, taken from the subagent transcript or a prompt field when present', async (t) => {
  const cm = await subServer();
  t.after(() => cm.srv.close());
  const dir = tmp();
  const cfg = cfgFor(dir, cm.url);
  const transcript_path = mainTranscript(dir, [{ description: 'one', prompt: 'task for Plan agent about migrations', subagent_type: 'Plan' }, { description: 'two', prompt: 'task for Explore agent about gate script', subagent_type: 'Explore' }]);
  await sm.recallFor(cfg, subStart({ transcript_path }));
  const q = (n) => cm.calls.filter((c) => c.url.startsWith('/v1/memory/recall'))[n]?.body.query;
  assert.match(q(0), /gate script/);
  assert.ok(!/migrations/.test(q(0)));
  const agent_transcript_path = path.join(dir, 'sub.jsonl');
  fs.writeFileSync(agent_transcript_path, line({ type: 'user', message: { role: 'user', content: 'Summarise the retention sweeper in this repository' } }));
  await sm.recallFor(cfg, subStart({ agent_id: 'agent-2', agent_transcript_path }));
  assert.match(q(1), /retention sweeper/);
  await sm.recallFor(cfg, subStart({ agent_id: 'agent-3', prompt: 'direct prompt about brief caching' }));
  assert.match(q(2), /brief caching/);
});

test('SubagentStart: with no task text only the brief is injected, with no recall request', async (t) => {
  const cm = await subServer();
  t.after(() => cm.srv.close());
  const out = await sm.recallFor(cfgFor(tmp(), cm.url), subStart({ transcript_path: path.join(tmp(), 'missing.jsonl') }));
  assert.match(ctx(out), /<project-brief/);
  assert.ok(!ctx(out).includes('<shared-memory'));
  assert.equal(cm.calls.filter((c) => c.url.startsWith('/v1/memory/recall')).length, 0);
});

test('SubagentStart: an oversized brief is cut so the context stays under the 10,000 character cap', async (t) => {
  const cm = await subServer('# big\n' + 'line of the brief\n'.repeat(2000));
  t.after(() => cm.srv.close());
  const dir = tmp();
  const transcript_path = mainTranscript(dir, [{ description: 'Gate check', prompt: 'Find how the go tests run', subagent_type: 'Explore' }]);
  const text = ctx(await sm.recallFor(cfgFor(dir, cm.url), subStart({ transcript_path })));
  assert.ok(text.length <= 10000, `${text.length}`);
  assert.match(text, /Gate n1/, 'the task-specific hits survive the cut');
  assert.match(text, /brief cut for the subagent/);
});

test('SubagentStart: opt-outs, the hooks.subagent switch and Cammut-only are honoured; the parent session state is untouched', async (t) => {
  const w = await onlyWorld(t);
  const dir = w.dir;
  const transcript_path = mainTranscript(dir, [{ description: 'd', prompt: 'Find how the go tests run', subagent_type: 'Explore' }]);
  saveSession(w.cfg, 'parent1', { prompts: 7, seen: ['cm:x'], seenAt: { 'cm:x': 7 } });
  const out = await sm.recallFor(w.cfg, subStart({ transcript_path }));
  assert.match(ctx(out), /Gate n1/);
  assert.deepEqual([w.hs.calls.length, w.ov.calls.length], [0, 0]);
  assert.deepEqual(loadSession(w.cfg, 'parent1'), { prompts: 7, seen: ['cm:x'], seenAt: { 'cm:x': 7 } });
  assert.equal(await sm.recallFor({ ...w.cfg, hooks: { subagent: false } }, subStart({ transcript_path })), null);
  const marked = path.join(dir, 'marked'); fs.mkdirSync(marked); fs.writeFileSync(path.join(marked, '.no-memory'), '');
  assert.equal(await sm.recallFor(w.cfg, subStart({ cwd: marked, transcript_path })), null);
});

test('SubagentStart: the entry point prints the JSON, and a dead Cammut prints nothing and exits 0', async (t) => {
  const cm = await subServer();
  t.after(() => cm.srv.close());
  const dir = tmp();
  const mk = (url) => cleanEnv({ SM_CONFIG: path.join(dir, 'none.json'), SM_STATE_DIR: path.join(dir, 'state' + (url === cm.url ? 'a' : 'b')), SM_CAMMUT_URL: url, CAMMUT_MEMORY_TOKEN: 'cmt_test', SHARED_MEMORY_HINDSIGHT_API_KEY: 'test-key' });
  const run = (env) => new Promise((resolve) => {
    const child = execFile(process.execPath, [fileURLToPath(new URL('./sm.mjs', import.meta.url)), 'recall'], { env, timeout: 15000 }, (error, stdout) => resolve({ error, stdout }));
    child.stdin.end(JSON.stringify(subStart({ transcript_path: mainTranscript(dir, [{ description: 'd', prompt: 'Find how the go tests run', subagent_type: 'Explore' }]) })));
  });
  const ok = await run(mk(cm.url));
  assert.equal(ok.error, null);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.hookEventName, 'SubagentStart');
  const dead = await run(mk('http://127.0.0.1:1'));
  assert.equal(dead.error, null);
  assert.equal(dead.stdout, '');
});

// ---- SubagentStop -------------------------------------------------------------------------------------------

const REPORT = 'Findings: the gate script runs gofmt, go vet and go test -race on the VDS; it takes about five minutes and should run in the background. '.repeat(3);
const subStop = (over = {}) => ({ hook_event_name: 'SubagentStop', cwd: 'C:/x/Cammut', session_id: 'parent1', agent_id: 'agent-abc', agent_type: 'Explore', stop_hook_active: false, last_assistant_message: REPORT, ...over });
const hsOk = () => fakeServer(() => ({ status: 200, json: { async: true, success: true } }));
const retains = (hs) => hs.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/memories'));

test('SubagentStop: the final report is retained as a low-trust, inferred journal entry, redacted, once per agent', async (t) => {
  const hs = await hsOk();
  t.after(() => hs.srv.close());
  const cfg = cfgFor(tmp(), 'http://127.0.0.1:1', { hs: { url: hs.url, bank: 'b', key: 'hs-key', capture: true, recall: false } });
  const secret = 'sk-' + 'Ab3dE5gH7jK9mN1pQ3rS5tU7';
  await sm.captureFor(cfg, subStop({ last_assistant_message: `${REPORT} token ${secret}` }), false);
  assert.equal(retains(hs).length, 1);
  const item = retains(hs)[0].body.items[0];
  assert.match(item.content, /subagent/i);
  assert.match(item.content, /unverified/i);
  assert.ok(!item.content.includes(secret));
  assert.ok(item.tags.includes('epistemic:inferred') && item.tags.includes('source:claude-code-subagent') && item.tags.includes('project:Cammut'));
  assert.equal(item.metadata.epistemic, 'inferred');
  assert.equal(retains(hs)[0].body.async, true);
  assert.match(retains(hs)[0].body.operation_id, /^[0-9a-f-]{36}$/);
  assert.ok(item.content.length <= 3500);
  await sm.captureFor(cfg, subStop(), false);
  assert.equal(retains(hs).length, 1, 'the same agent id is not stored twice');
  await sm.captureFor(cfg, subStop({ agent_id: 'agent-2' }), false);
  assert.equal(retains(hs).length, 2);
});

test('SubagentStop: trivial reports, internal agents, continuation stops, opt-outs and switched-off hooks store nothing', async (t) => {
  const hs = await hsOk();
  t.after(() => hs.srv.close());
  const dir = tmp();
  const cfg = cfgFor(dir, 'http://127.0.0.1:1', { hs: { url: hs.url, bank: 'b', key: 'hs-key', capture: true, recall: false } });
  const marked = path.join(dir, 'marked'); fs.mkdirSync(marked); fs.writeFileSync(path.join(marked, '.no-memory'), '');
  for (const [i, over] of [{ last_assistant_message: 'Done.' }, { agent_type: '' }, { stop_hook_active: true }, { cwd: marked }, { last_assistant_message: undefined }, { agent_id: undefined }].entries()) {
    await sm.captureFor(cfg, subStop({ agent_id: `a${i}`, ...over }), false);
  }
  await sm.captureFor({ ...cfg, hooks: { subagent: false } }, subStop({ agent_id: 'off' }), false);
  assert.equal(retains(hs).length, 0);
});

test('SubagentStop: a dead Hindsight loses the low-trust report quietly and fast', async () => {
  const cfg = cfgFor(tmp(), 'http://127.0.0.1:1', { hs: { url: 'http://127.0.0.1:1', bank: 'b', key: 'hs-key', capture: true, recall: false } });
  const t0 = Date.now();
  await sm.captureFor(cfg, subStop(), false);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(sm.spoolFiles(cfg).length, 0, 'report text is never written to the spool');
});

test('SubagentStop: in Cammut-only mode nothing goes to Hindsight, and a Cammut note is written only when hooks.subagentNotes is on', async (t) => {
  const w = await onlyWorld(t, () => ({ status: 201, json: { id: 'x' } }));
  await sm.captureFor(w.cfg, subStop(), false);
  assert.deepEqual([w.hs.calls.length, w.ov.calls.length, w.cm.calls.length], [0, 0, 0]);
  const on = { ...w.cfg, hooks: { subagent: true, subagentNotes: true, subagentMinChars: 200 } };
  await sm.captureFor(on, subStop({ agent_id: 'agent-n' }), false);
  const post = w.cm.calls.find((c) => c.url === '/v1/memory/notes');
  assert.equal(post.auth, 'Bearer cmt_test');
  assert.deepEqual([post.body.project, post.body.kind, post.body.importance], ['Cammut', 'finding', 1]);
  assert.ok(post.body.tags.includes('epistemic:inferred') && post.body.tags.includes('source:subagent'));
  assert.ok(post.body.title.length <= 120 && post.body.body.length <= 1500);
  assert.deepEqual([w.hs.calls.length, w.ov.calls.length], [0, 0]);
});

test('SubagentStop: the capture entry point routes the event and exits 0', async (t) => {
  const hs = await hsOk();
  t.after(() => hs.srv.close());
  const dir = tmp();
  const env = cleanEnv({ SM_CONFIG: path.join(dir, 'none.json'), SM_STATE_DIR: path.join(dir, 'state'), SM_HS_URL: hs.url, SHARED_MEMORY_HINDSIGHT_API_KEY: 'test-key' });
  const r = await new Promise((resolve) => {
    const child = execFile(process.execPath, [fileURLToPath(new URL('./sm.mjs', import.meta.url)), 'capture'], { env, timeout: 15000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(JSON.stringify(subStop()));
  });
  assert.equal(r.error, null);
  assert.equal(r.stdout, '');
  assert.equal(retains(hs).length, 1);
});
