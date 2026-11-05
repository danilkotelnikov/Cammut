// End-to-end harness: runs the real hook entry point (node sm.mjs <cmd>) as a child process, the way Claude Code does,
// with synthetic hook payloads, a temp state dir and fake Hindsight/OpenViking servers. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeServer, tmp } from '../test-helpers.mjs';

const SM = fileURLToPath(new URL('./sm.mjs', import.meta.url));
const DEAD = 'http://127.0.0.1:1';

function envFor(hsUrl, ovUrl, extra = {}) {
  const dir = tmp('sm-e2e-');
  const env = {
    ...process.env, SM_STATE_DIR: dir, SM_CONFIG: path.join(dir, 'no-config.json'), SM_HS_URL: hsUrl, SM_OV_URL: ovUrl,
    SHARED_MEMORY_HINDSIGHT_API_KEY: 'hs-key', SHARED_MEMORY_OPENVIKING_API_KEY: 'ov-key', ...extra,
  };
  delete env.SHARED_MEMORY_BYPASS;
  if (extra.SHARED_MEMORY_BYPASS) env.SHARED_MEMORY_BYPASS = extra.SHARED_MEMORY_BYPASS;
  return env;
}

// run('capture --flush', payload, env) -> {code, stdout, stderr, ms}; payload: object -> JSON, string -> raw, null -> stdin left open
function run(cmd, payload, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [SM, ...cmd.split(' ')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    if (payload !== null) child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}

const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, 25)); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeTranscript(messages) {
  const f = path.join(tmp('sm-tr-'), 't.jsonl');
  fs.writeFileSync(f, messages.map((m, i) => JSON.stringify({
    type: m.role, timestamp: `2026-10-11T10:00:${String(i).padStart(2, '0')}Z`,
    message: { role: m.role, content: m.role === 'user' ? m.text : [{ type: 'text', text: m.text }] },
  })).join('\n') + '\n');
  return f;
}
const spoolCount = (env) => { try { return fs.readdirSync(path.join(env.SM_STATE_DIR, 'spool')).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
const logOf = (env) => { try { return fs.readFileSync(path.join(env.SM_STATE_DIR, 'hook.log'), 'utf8'); } catch { return ''; } };

const NOTE = { id: 'a', type: 'observation', text: 'bash dev/gate.sh runs the Go tests on the VDS', scores: { semantic: 0.62, keyword: 0.4 } };
const NOISE = { id: 'b', type: 'observation', text: 'unrelated keyword hit', scores: { semantic: 0.05, keyword: 0.9 } };
const recallServer = () => fakeServer((c) => (c.url.endsWith('/memories/recall')
  ? { status: 200, json: { results: /zxqv/.test(c.body.query) ? [NOISE] : [NOTE, NOISE] } }
  : { status: 200, json: {} }));

test('SessionStart and UserPromptSubmit inject only relevant notes and always exit 0', async () => {
  const hs = await recallServer();
  const env = envFor(hs.url, DEAD);
  const r = await run('recall', { hook_event_name: 'UserPromptSubmit', cwd: 'C:/x/Cammut', session_id: 's1', prompt: 'how do I run the go tests on the vds?' }, env);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'UserPromptSubmit');
  assert.match(out.additionalContext, /bash dev\/gate\.sh/);
  assert.match(out.additionalContext, /^<shared-memory[^>]*>/);
  assert.match(out.additionalContext, /untrusted/i);
  assert.doesNotMatch(out.additionalContext, /unrelated keyword hit/, 'semantic floor 0.3: a keyword-only hit is not injected');
  const again = await run('recall', { hook_event_name: 'UserPromptSubmit', cwd: 'C:/x/Cammut', session_id: 's1', prompt: 'how do I run the go tests on the vds?' }, env);
  assert.equal(again.stdout.trim(), '', 'a note already shown in this session is not injected again');

  const callsBefore = hs.calls.length;
  const none = await run('recall', { hook_event_name: 'UserPromptSubmit', cwd: 'C:/x/Cammut', session_id: 's1b', prompt: 'zxqv blorp wibble' }, envFor(hs.url, DEAD));
  assert.equal(none.code, 0);
  assert.equal(none.stdout.trim(), '', 'an irrelevant prompt injects nothing');
  assert.ok(hs.calls.slice(callsBefore).some((c) => c.url.endsWith('/memories/recall') && /zxqv/.test(c.body.query)), 'the server really was asked (this is the semantic floor, not a shortcut)');

  const start = await run('recall', { hook_event_name: 'SessionStart', cwd: 'C:/x/Cammut', session_id: 's3', source: 'startup' }, envFor(hs.url, DEAD));
  assert.equal(start.code, 0);
  const sctx = JSON.parse(start.stdout).hookSpecificOutput;
  assert.equal(sctx.hookEventName, 'SessionStart');
  assert.match(sctx.additionalContext, /bash dev\/gate\.sh/);
  hs.srv.close();
});

test('tunnel down: every hook returns fast with exit 0, the breaker opens and the second call does not even try', async () => {
  const env = envFor(DEAD, DEAD);
  const first = await run('recall', { hook_event_name: 'SessionStart', cwd: 'C:/x/P', session_id: 's2' }, env);
  assert.equal(first.code, 0);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /memory unavailable/i, 'told once, in one line');
  assert.ok(first.ms < 3500, `first ${first.ms} ms`);
  const breaker = JSON.parse(fs.readFileSync(path.join(env.SM_STATE_DIR, 'breaker.json'), 'utf8'));
  assert.ok(breaker.hs && breaker.ov, 'both services tripped');
  // the tunnel "comes back" inside the 45 s window: the breaker must still keep the hook from calling it
  const live = await fakeServer(() => ({ status: 200, json: { results: [NOTE] } }));
  const second = await run('recall', { hook_event_name: 'UserPromptSubmit', cwd: 'C:/x/P', session_id: 's2', prompt: 'please explain the build pipeline in some detail' }, { ...env, SM_HS_URL: live.url });
  assert.equal(second.code, 0);
  assert.equal(second.stdout.trim(), '', 'the unavailable line is shown once per session');
  assert.equal(live.calls.length, 0, 'breaker short-circuits: no request was made');
  assert.ok(second.ms < 1000, `second ${second.ms} ms`);
  assert.match(logOf(env), /recall SessionStart hs=0 ov=0 injected=0/);
  // capture with the tunnel down spools locally and still exits 0
  const tr = writeTranscript([{ role: 'user', text: 'one' }, { role: 'assistant', text: 'a' }, { role: 'user', text: 'two' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'three' }, { role: 'assistant', text: 'c' }]);
  const cap = await run('capture', { hook_event_name: 'Stop', cwd: 'C:/x/P', session_id: 'dead0001-aaaa', transcript_path: tr }, { ...env, SM_NO_SPAWN: '1' });
  assert.equal(cap.code, 0);
  assert.equal(spoolCount(env), 1, 'the chunk waits in the spool');
  live.srv.close();
});

test('servers that error or never answer never break a hook', async () => {
  const bad = await fakeServer(() => ({ status: 500, json: { error: 'boom' } }));
  const r500 = await run('recall', { hook_event_name: 'UserPromptSubmit', cwd: 'C:/x/P', session_id: 's5', prompt: 'a prompt that is long enough to be queried' }, envFor(bad.url, bad.url));
  assert.equal(r500.code, 0);
  assert.match(r500.stdout, /memory unavailable/i);
  bad.srv.close();
  // accepts the connection and never replies
  const sockets = [];
  const hang = net.createServer((s) => sockets.push(s));
  await new Promise((res) => hang.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${hang.address().port}`;
  const r = await run('recall', { hook_event_name: 'UserPromptSubmit', cwd: 'C:/x/P', session_id: 's6', prompt: 'a prompt that is long enough to be queried' }, envFor(url, url));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /memory unavailable/i);
  assert.ok(r.ms < 6500, `bounded by the recall timeout: ${r.ms} ms`);
  sockets.forEach((s) => s.destroy());
  hang.close();
});

test('Stop spools, SessionEnd flushes, drain delivers once, OpenViking gets no session, and nothing secret-shaped reaches any server', async () => {
  const seen = [];
  const hs = await fakeServer((c) => { if (c.method === 'POST' && c.url.endsWith('/memories')) seen.push(JSON.stringify(c.body)); return { status: 200, json: { async: false, success: true } }; });
  const ov = await fakeServer(() => ({ status: 200, json: {} }));
  const secrets = ['sk-' + 'A1b2'.repeat(8), 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4', 'password: hunter2hunter2', 'Authorization: Bearer abcdefghijklmnop1234567890'];
  const tr = writeTranscript([
    { role: 'user', text: `my key is ${secrets[0]} and ${secrets[1]}` }, { role: 'assistant', text: 'noted' },
    { role: 'user', text: `config ${secrets[2]} ${secrets[3]}` }, { role: 'assistant', text: 'ok' },
    { role: 'user', text: 'third' }, { role: 'assistant', text: 'ok' },
  ]);
  const env = envFor(hs.url, ov.url);
  const p = { cwd: 'C:/x/Cammut', session_id: 'abcdef12-3456', transcript_path: tr };
  assert.equal((await run('capture', { hook_event_name: 'Stop', ...p }, env)).code, 0);
  assert.match(logOf(env), /capture Stop spooled 6 messages in 1 chunk/);
  assert.equal((await run('capture --flush', { hook_event_name: 'SessionEnd', ...p }, env)).code, 0);
  await waitFor(() => seen.length > 0 && spoolCount(env) === 0);
  await sleep(300);
  assert.equal(seen.length, 1, 'delivered exactly once');
  const body = JSON.parse(seen[0]);
  assert.equal(body.items[0].document_id, 'cc-abcdef12-3456-0-0');
  assert.match(body.items[0].content, /User: my key is \[REDACTED/);
  for (const s of ['sk-A1b2', 'ghp_A1b2', 'hunter2hunter2', 'abcdefghijklmnop1234567890']) assert.ok(!seen[0].includes(s), `redaction before delivery: ${s}`);
  assert.equal(ov.calls.filter((c) => c.url.includes('/sessions/')).length, 0, 'no raw session reaches OpenViking by default');
  // a repeated flush finds nothing new and delivers nothing
  assert.equal((await run('capture --flush', { hook_event_name: 'SessionEnd', ...p }, env)).code, 0);
  await sleep(300);
  assert.equal(seen.length, 1);
  hs.srv.close(); ov.srv.close();
});

test('.no-memory and SHARED_MEMORY_BYPASS switch every hook off', async () => {
  const hs = await recallServer();
  const tr = writeTranscript([{ role: 'user', text: 'one' }, { role: 'assistant', text: 'a' }, { role: 'user', text: 'two' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'three' }, { role: 'assistant', text: 'c' }]);
  const marked = tmp('sm-proj-');
  fs.writeFileSync(path.join(marked, '.no-memory'), '');
  const plain = tmp('sm-proj-');
  const hooks = (cwd, sid) => [
    ['recall', { hook_event_name: 'SessionStart', cwd, session_id: sid }],
    ['recall', { hook_event_name: 'UserPromptSubmit', cwd, session_id: sid, prompt: 'how do I run the go tests on the vds?' }],
    ['capture', { hook_event_name: 'Stop', cwd, session_id: sid, transcript_path: tr }],
    ['capture --flush', { hook_event_name: 'SessionEnd', cwd, session_id: sid, transcript_path: tr }],
  ];
  // control: the same hooks in an unmarked project do reach the server, so the checks below are not vacuous
  const envC = envFor(hs.url, DEAD, { SM_NO_SPAWN: '1' });
  for (const [cmd, payload] of hooks(plain, 'ctl00001')) await run(cmd, payload, envC);
  assert.ok(hs.calls.length > 0 && spoolCount(envC) > 0);
  const base = hs.calls.length;
  const envM = envFor(hs.url, DEAD, { SM_NO_SPAWN: '1' });
  for (const [cmd, payload] of hooks(marked, 'mark0001')) { const r = await run(cmd, payload, envM); assert.equal(r.code, 0); assert.equal(r.stdout.trim(), ''); }
  const envB = envFor(hs.url, DEAD, { SM_NO_SPAWN: '1', SHARED_MEMORY_BYPASS: '1' });
  for (const [cmd, payload] of hooks(plain, 'byp00001')) { const r = await run(cmd, payload, envB); assert.equal(r.code, 0); assert.equal(r.stdout.trim(), ''); }
  assert.equal(hs.calls.length, base, 'no request was made');
  assert.equal(spoolCount(envM) + spoolCount(envB), 0, 'nothing was spooled');
  hs.srv.close();
});

test('a malformed or empty stdin never produces a stack trace or a non-zero exit', async () => {
  const env = envFor(DEAD, DEAD, { SM_NO_SPAWN: '1' });
  const inputs = ['', 'not json', '{"hook_event_name":', 'null', '[]', '"text"', '{"session_id":5,"cwd":{},"prompt":[1],"transcript_path":7,"hook_event_name":"Stop"}'];
  for (const cmd of ['recall', 'capture', 'capture --flush']) {
    for (const input of inputs) {
      const r = await run(cmd, input, env);
      assert.equal(r.code, 0, `${cmd} <- ${JSON.stringify(input)}`);
      assert.equal(r.stdout.trim(), '');
      assert.ok(!/\bat .*\.mjs|Error:/.test(r.stderr), `stack trace on stderr: ${r.stderr.slice(0, 200)}`);
    }
  }
});

test('Hindsight recall carries the controls (types, prefer_observations, a semantic floor) and falls back to the plain request when the server rejects them', async () => {
  const hs = await fakeServer((c) => (c.url.endsWith('/memories/recall')
    ? (c.body.prefer_observations !== undefined && /reject-controls/.test(c.body.query)
      ? { status: 422, json: { detail: 'unknown field' } }
      : { status: 200, json: { results: [NOTE] } })
    : { status: 200, json: {} }));
  const recalls = () => hs.calls.filter((c) => c.url.endsWith('/memories/recall'));
  const ask = (sid, prompt) => run('recall', { hook_event_name: 'UserPromptSubmit', cwd: 'C:/x/Cammut', session_id: sid, prompt }, envFor(hs.url, DEAD));

  const ok = await ask('ctl1', 'how do I run the go tests on the vds?');
  assert.equal(ok.code, 0);
  const body = recalls()[0].body;
  assert.equal(body.prefer_observations, true, 'observations are preferred');
  assert.deepEqual(body.types, ['observation', 'world', 'experience']);
  assert.deepEqual(body.min_scores, { semantic: 0.3 }, 'the floor is also asked of the server');
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /bash dev\/gate\.sh/);

  const before = recalls().length;
  const fb = await ask('ctl2', 'reject-controls: how do I run the go tests on the vds?');
  assert.equal(fb.code, 0);
  const sent = recalls().slice(before);
  assert.equal(sent.length, 2, 'the strict request, then one plain retry');
  assert.equal(sent[1].body.prefer_observations, undefined);
  assert.equal(sent[1].body.min_scores, undefined);
  assert.match(JSON.parse(fb.stdout).hookSpecificOutput.additionalContext, /bash dev\/gate\.sh/, 'the retry still injected the note');
  hs.srv.close();
});
