import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkHooks, summarizeLog, tokenize, diagnose, render, spoolKinds } from './chain-doctor.mjs';
import { install } from '../install.mjs';
import { tmp } from '../test-helpers.mjs';

const REPO_ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // adapters/: the install manifest is relative to it
const fwd = (p) => p.replace(/\\/g, '/');
const hookSettings = (node, script, over = {}) => {
  const h = (args, timeout) => [{ hooks: [{ type: 'command', command: `"${node}" "${script}" ${args}`, timeout }] }];
  return { hooks: { SessionStart: h('recall', 8), UserPromptSubmit: h('recall', 8), Stop: h('capture', 10), PreCompact: h('capture --flush', 10), SessionEnd: h('capture --flush', 10), ...over } };
};

test('tokenize keeps quoted Windows paths together', () => {
  assert.deepEqual(tokenize('"C:\\Program Files\\nodejs\\node.exe" "C:/x y/sm.mjs" capture --flush'), ['C:\\Program Files\\nodejs\\node.exe', 'C:/x y/sm.mjs', 'capture', '--flush']);
});

test('checkHooks accepts the documented registration and reports each deviation', () => {
  const fsx = { exists: () => true, sha: () => 'h1' };
  const installed = { files: { 'sm.mjs': 'h1' } };
  const good = checkHooks(hookSettings('C:/n/node.exe', 'C:/s/sm.mjs'), installed, fsx);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.warnings, []);
  assert.equal(good.hooks.length, 5);
  const wrong = hookSettings('C:/n/node.exe', 'C:/s/sm.mjs', {
    Stop: [{ hooks: [{ type: 'command', command: '"C:/n/node.exe" "C:/s/sm.mjs" capture', timeout: 3 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: '"C:/n/node.exe" "C:/s/sm.mjs" capture' }] }],
  });
  delete wrong.hooks.PreCompact;
  const bad = checkHooks(wrong, installed, fsx);
  assert.ok(bad.problems.some((p) => /Stop: timeout 3s/.test(p)));
  assert.ok(bad.problems.some((p) => /SessionEnd: runs "sm.mjs capture", expected "sm.mjs capture --flush"/.test(p)));
  assert.ok(bad.problems.some((p) => /PreCompact: no sm.mjs hook/.test(p)));
  assert.ok(checkHooks(hookSettings('n', 's/sm.mjs'), installed, { exists: () => false, sha: () => 'h1' }).problems.some((p) => /does not exist/.test(p)));
  assert.ok(checkHooks(hookSettings('n', 's/sm.mjs'), installed, { exists: () => true, sha: () => 'edited' }).problems.some((p) => /differs from the hash recorded/.test(p)));
  const unmanaged = checkHooks(hookSettings('n', 's/sm.mjs'), null, fsx);
  assert.deepEqual(unmanaged.problems, []);
  assert.equal(unmanaged.warnings.length, 1, 'a missing manifest is a warning, not a failure');
});

test('summarizeLog counts the last 24 h, finds the newest line and never repeats an error message', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const text = [
    '2026-10-09T10:00:00.000Z recall UserPromptSubmit hs=3 ov=0 injected=3',
    '2026-10-11T10:00:00.000Z recall UserPromptSubmit hs=4 ov=0 injected=2',
    '2026-10-11T10:00:01.000Z capture Stop spooled 6 messages in 1 chunk(s)',
    '2026-10-11T10:00:02.000Z drain hs permanent failure status=422',
    '2026-10-11T11:00:00.000Z recall failed: SyntaxError: Unexpected token p, "my private words" is not valid',
    'garbage line',
  ].join('\n');
  const s = summarizeLog(text, now);
  assert.deepEqual(s.counts, { recall: 2, capture: 1, drain: 1, failed: 1 });
  assert.equal(s.injected, 2);
  assert.equal(s.newest, Date.parse('2026-10-11T11:00:00Z'));
  assert.equal(s.ageMs, 3600 * 1000);
  assert.equal(s.last.length, 5);
  assert.ok(!s.last.join('\n').includes('private words'));
  assert.deepEqual(summarizeLog('', now).newest, null);
});

// ---- the whole diagnosis against a temp home and a fake fetch -------------------------------------
function fixture({ log = true } = {}) {
  const home = fwd(tmp('doctor-home-'));
  const dir = `${home}/.claude/scripts/shared-memory`;
  install({ srcDir: REPO_ADAPTER, dstDir: dir });
  const script = `${dir}/sm.mjs`;
  fs.mkdirSync(`${home}/.claude/projects/p1`, { recursive: true });
  fs.writeFileSync(`${home}/.claude/projects/p1/s.jsonl`, '{}\n');
  fs.writeFileSync(`${home}/.claude/settings.json`, JSON.stringify(hookSettings(fwd(process.execPath), script)));
  const state = `${home}/.claude/state/shared-memory`;
  fs.mkdirSync(state, { recursive: true });
  const now = Date.now();
  if (log) fs.writeFileSync(`${state}/hook.log`, `${new Date(now - 60000).toISOString()} recall UserPromptSubmit hs=2 ov=0 injected=1\n${new Date(now - 30000).toISOString()} capture Stop spooled 6 messages in 1 chunk(s)\n`);
  const env = { SM_STATE_DIR: state, SM_CONFIG: `${home}/.claude/shared-memory.json`, SM_HS_URL: 'http://hs.test', SM_OV_URL: 'http://ov.test', SHARED_MEMORY_HINDSIGHT_API_KEY: 'sekret-hs-value', SHARED_MEMORY_OPENVIKING_API_KEY: 'sekret-ov-value', PATH: '' };
  return { home, dir, script, state, env, now };
}
const okFetch = (calls = [], bank = { config: { store_document_text: false, recall_include_chunks: false }, overrides: { store_document_text: false } }) => async (url, opts) => {
  calls.push({ url, auth: opts?.headers?.Authorization });
  const body = url.endsWith('/config') ? bank : {};
  return { status: 200, json: async () => body };
};
const by = (rows, name) => rows.find((r) => r.check === name);
const treeHash = (root) => {
  const h = crypto.createHash('sha256');
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else h.update(p).update(fs.readFileSync(p)); } };
  walk(root);
  return h.digest('hex');
};

test('a healthy system is all PASS, the doctor writes nothing and prints no secret', async () => {
  const f = fixture();
  const before = treeHash(f.home);
  const calls = [];
  const rows = await diagnose({ env: f.env, home: f.home, fetch: okFetch(calls), now: f.now });
  assert.equal(treeHash(f.home), before, 'read-only');
  const bad = rows.filter((r) => !['PASS', 'INFO'].includes(r.result));
  assert.deepEqual(bad, []);
  const out = JSON.stringify(rows) + render(rows);
  assert.ok(!out.includes('sekret'), 'no key value is ever printed');
  assert.match(by(rows, 'env').detail, /SHARED_MEMORY_HINDSIGHT_API_KEY=set SHARED_MEMORY_OPENVIKING_API_KEY=set CAMMUT_MEMORY_TOKEN=MISSING/);
  assert.match(by(rows, 'reach:hindsight').detail, /tunnel=up/);
  assert.match(by(rows, 'hindsight-bank').detail, /store_document_text=false/);
  assert.match(by(rows, 'hook-log').detail, /recall=1 capture=1/);
  assert.ok(calls.length >= 4); // hindsight, openviking, cammut-local, hindsight bank config; the public name is not probed without cammut.publicUrl
  for (const c of calls) assert.equal(c.auth !== undefined, /hs.test|ov.test/.test(c.url), `bearer only to Hindsight/OpenViking: ${c.url}`);
});

test('failure modes are FAIL with a reason: tunnel down, text storage on, capture on, edited hook, missing keys', async () => {
  const down = fixture();
  let rows = await diagnose({ env: down.env, home: down.home, fetch: async () => { throw Object.assign(new Error('x'), { name: 'TypeError' }); }, now: down.now });
  assert.equal(by(rows, 'reach:hindsight').result, 'FAIL');
  assert.match(by(rows, 'reach:hindsight').detail, /tunnel=down/);
  assert.equal(by(rows, 'hindsight-bank').result, 'SKIP');
  assert.equal(by(rows, 'reach:cammut-public').result, 'INFO', 'no publicUrl configured: nothing is probed and no name is guessed');
  assert.match(by(rows, 'reach:cammut-public').detail, /publicUrl not set/);
  fs.writeFileSync(down.env.SM_CONFIG, JSON.stringify({ cammut: { publicUrl: 'https://cammut.example' } }));
  const urls = [];
  rows = await diagnose({ env: down.env, home: down.home, fetch: async (u) => { urls.push(u); throw Object.assign(new Error('x'), { name: 'TypeError' }); }, now: down.now });
  assert.equal(by(rows, 'reach:cammut-public').result, 'WARN');
  assert.ok(urls.includes('https://cammut.example/healthz'));

  const text = fixture();
  rows = await diagnose({ env: text.env, home: text.home, fetch: okFetch([], { config: { store_document_text: true, recall_include_chunks: true }, overrides: {} }), now: text.now });
  assert.equal(by(rows, 'hindsight-bank').result, 'FAIL');
  assert.match(by(rows, 'hindsight-bank').detail, /store_document_text=true/);

  const cap = fixture();
  fs.writeFileSync(cap.env.SM_CONFIG, JSON.stringify({ openviking: { capture: true } }));
  rows = await diagnose({ env: cap.env, home: cap.home, fetch: okFetch(), now: cap.now });
  assert.equal(by(rows, 'openviking-capture').result, 'FAIL');

  const edited = fixture();
  fs.appendFileSync(edited.script, '// local edit\n');
  rows = await diagnose({ env: edited.env, home: edited.home, fetch: okFetch(), now: edited.now });
  assert.equal(by(rows, 'hooks-registered').result, 'FAIL');
  assert.match(by(rows, 'hooks-registered').detail, /differs from the hash recorded/);

  const nokeys = fixture();
  delete nokeys.env.SHARED_MEMORY_OPENVIKING_API_KEY;
  rows = await diagnose({ env: nokeys.env, home: nokeys.home, fetch: okFetch(), now: nokeys.now });
  assert.equal(by(rows, 'env').result, 'FAIL');
  assert.match(by(rows, 'env').detail, /SHARED_MEMORY_OPENVIKING_API_KEY=MISSING/);
});

test('a hook log silent for 7 days is FAIL only while transcripts keep changing; spool age and opt-outs are reported', async () => {
  const f = fixture({ log: false });
  fs.writeFileSync(`${f.state}/hook.log`, `${new Date(f.now - 9 * 24 * 3600 * 1000).toISOString()} recall UserPromptSubmit hs=1 ov=0 injected=0\n`);
  let rows = await diagnose({ env: f.env, home: f.home, fetch: okFetch(), now: f.now });
  assert.equal(by(rows, 'hook-log').result, 'FAIL');
  fs.rmSync(`${f.home}/.claude/projects`, { recursive: true });
  rows = await diagnose({ env: f.env, home: f.home, fetch: okFetch(), now: f.now });
  assert.equal(by(rows, 'hook-log').result, 'WARN', 'no transcript activity: stale but not a failure');

  fs.mkdirSync(`${f.state}/spool`);
  fs.writeFileSync(`${f.state}/spool/${f.now - 2 * 3600 * 1000}-ab12.json`, '{}');
  fs.writeFileSync(`${f.state}/breaker.json`, JSON.stringify({ hs: f.now - 1000 }));
  rows = await diagnose({ env: f.env, home: f.home, fetch: okFetch(), now: f.now });
  assert.equal(by(rows, 'spool').result, 'WARN');
  assert.match(by(rows, 'spool').detail, /pending=1 oldest_age_s=7200 breaker_open=hs/);

  rows = await diagnose({ env: { ...f.env, SHARED_MEMORY_BYPASS: '1' }, home: f.home, fetch: okFetch(), now: f.now });
  assert.equal(by(rows, 'opt-outs').result, 'WARN');
});

// ---- phase 2: archive, retention and the PC's derived state ---------------------------------------------------------------------

const KEY1 = 'age1' + 'q'.repeat(58); const KEY2 = 'age1' + 'p'.repeat(58);
test('spool diagnostics distinguish legacy inline text from references without revealing either', async () => {
  const f = fixture();
  const dir = `${f.state}/spool`;
  fs.mkdirSync(dir);
  fs.writeFileSync(`${dir}/legacy.json`, JSON.stringify({ messages: [{ text: 'SYNTHETIC_PRIVATE_MESSAGE' }] }));
  fs.writeFileSync(`${dir}/reference.json`, JSON.stringify({ kind: 'range', file: 'SYNTHETIC_PRIVATE_PATH' }));
  fs.writeFileSync(`${dir}/unknown.json`, '{broken');
  assert.deepEqual(spoolKinds(dir), { references: 1, inlineMessages: 1, unknown: 1 });
  const rows = await diagnose({ env: f.env, home: f.home, fetch: okFetch(), now: f.now });
  const item = by(rows, 'state:spool');
  assert.equal(item.result, 'WARN');
  assert.match(item.detail, /1 transcript references, 1 legacy entries with message text, 1 unrecognized entries/);
  assert.match(item.detail, /0 failed items parked/);
  fs.mkdirSync(`${dir}/failed`);
  fs.writeFileSync(`${dir}/failed/x.json`, JSON.stringify({ kind: 'range', file: 'SYNTHETIC_PRIVATE_PATH', status: 'failed' }));
  assert.match(by(await diagnose({ env: f.env, home: f.home, fetch: okFetch(), now: f.now }), 'state:spool').detail, /1 failed items parked/);
  assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_PRIVATE_'));
});
const fp16 = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);

function archiveFixture({ status = {}, audit } = {}) {
  const f = fixture();
  fs.writeFileSync(`${f.home}/rec.txt`, `${KEY1}\n${KEY2}\n`);
  fs.writeFileSync(f.env.SM_CONFIG, JSON.stringify({ archive: { enabled: true, recipientsFile: `${f.home}/rec.txt` }, cammut: { url: 'http://cammut.test' } }));
  f.env.CAMMUT_MEMORY_TOKEN = 'cmt-sekret-write'; f.env.CAMMUT_ARCHIVE_READ_TOKEN = 'cmt-sekret-read';
  if (audit !== undefined) fs.writeFileSync(`${f.state}/restore-audit.json`, JSON.stringify(audit));
  const body = { segments: 10, replica: { last_run_at: new Date(f.now - 3600000).toISOString(), replicated: 10, unreplicated: 0, oldest_unreplicated_age_s: 0 }, recipient_changes: [], ...status };
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization });
    if (url.endsWith('/v1/archive/status')) return { status: 200, json: async () => body };
    return okFetch()(url, opts);
  };
  return { ...f, fetchFn, calls };
}

test('with the archive enabled a healthy chain stays all PASS; the Cammut token goes only to Cammut; state is listed with sizes; nothing is written', async () => {
  const goodAudit = { at: Date.now() - 5 * 86400000, ok: true, daily_fp: fp16(KEY1), recovery_fp: fp16(KEY2), recipients: [fp16(KEY1), fp16(KEY2)].sort(), segments: [] };
  const f = archiveFixture({ audit: goodAudit });
  fs.mkdirSync(`${f.state}/brief`); fs.writeFileSync(`${f.state}/brief/p.json`, 'x'.repeat(3072));
  const before = treeHash(f.home);
  const rows = await diagnose({ env: f.env, home: f.home, fetch: f.fetchFn, now: f.now });
  assert.equal(treeHash(f.home), before, 'read-only');
  assert.deepEqual(rows.filter((r) => !['PASS', 'INFO'].includes(r.result)), []);
  assert.match(by(rows, 'archive').detail, /enabled, CAMMUT_MEMORY_TOKEN=set CAMMUT_ARCHIVE_READ_TOKEN=set/);
  assert.match(by(rows, 'archive:replica').detail, /unreplicated=0/);
  assert.match(by(rows, 'archive:audit').detail, /both are current recipients/);
  assert.match(by(rows, 'state:brief').detail, /^3\.0 KiB brief cache \(disable: briefCache\.enabled=false/);
  for (const n of ['state:sessions', 'state:logs', 'state:records', 'state:outbox', 'state:spool', 'cleanup-backstop', 'installed-files', 'archive:outbox', 'archive:acked', 'archive:quarantine']) assert.ok(by(rows, n), n);
  const out = JSON.stringify(rows) + render(rows);
  assert.ok(!/sekret/.test(out), 'no token value is ever printed');
  const withToken = f.calls.filter((c) => c.auth === 'Bearer cmt-sekret-read');
  assert.deepEqual(withToken.map((c) => c.url), ['http://cammut.test/v1/archive/status'], 'the read token goes to the archive status route and nowhere else');
  assert.ok(!f.calls.some((c) => /hs.test|ov.test/.test(c.url) && /cmt-/.test(String(c.auth))));
});

test('archive failure modes are reported: stale replica, unreplicated segments, a flagged recipient change, an audit for other keys, a stuck outbox, an old unarchived transcript, a lingering quarantine', async () => {
  const stale = archiveFixture({ status: { replica: { last_run_at: null, replicated: 1, unreplicated: 4, oldest_unreplicated_age_s: 7200 } }, audit: { at: Date.now(), ok: true, daily_fp: 'a'.repeat(16), recovery_fp: 'b'.repeat(16), segments: [] } });
  let rows = await diagnose({ env: stale.env, home: stale.home, fetch: stale.fetchFn, now: stale.now });
  assert.equal(by(rows, 'archive:replica').result, 'WARN');
  assert.match(by(rows, 'archive:replica').detail, /last run never; replicated=1 unreplicated=4/);
  assert.equal(by(rows, 'archive:audit').result, 'FAIL', 'the audited keys are no longer the current recipients');

  const changed = archiveFixture({ status: { recipient_changes: [{ project: 'Cammut', pinned: 'x', now: 'y', changed_at: 'z' }] } });
  rows = await diagnose({ env: changed.env, home: changed.home, fetch: changed.fetchFn, now: changed.now });
  assert.equal(by(rows, 'archive:recipients').result, 'FAIL');
  assert.match(by(rows, 'archive:recipients').detail, /Cammut/);
  assert.equal(by(rows, 'archive:audit').result, 'WARN', 'no audit yet');

  const stuck = archiveFixture();
  fs.mkdirSync(`${stuck.state}/outbox`);
  fs.writeFileSync(`${stuck.state}/outbox/${'a'.repeat(32)}.age`, 'cipher');
  fs.writeFileSync(`${stuck.state}/outbox/${'a'.repeat(32)}.json`, JSON.stringify({ id: 'a'.repeat(32), createdAt: stuck.now - 8 * 86400000, meta: { session: 's', start: 0, end: 1 } }));
  const old = new Date(stuck.now - 12 * 86400000);
  fs.utimesSync(`${stuck.home}/.claude/projects/p1/s.jsonl`, old, old);
  fs.mkdirSync(`${stuck.state}/sessions`, { recursive: true });
  fs.writeFileSync(`${stuck.state}/sessions/s1.json`, JSON.stringify({ arch: { file: `${stuck.home}/.claude/projects/p1/s.jsonl`, cursor: 0, ranges: [] } }));
  fs.mkdirSync(`${stuck.home}/.claude/.cammut-quarantine/20260101T000000`, { recursive: true });
  fs.writeFileSync(`${stuck.home}/.claude/.cammut-quarantine/20260101T000000/ab-x.jsonl.json`, JSON.stringify({ origin: 'o', quarantinedAt: stuck.now - 5 * 86400000 }));
  fs.writeFileSync(`${stuck.home}/.claude/settings.json`, JSON.stringify({ ...JSON.parse(fs.readFileSync(`${stuck.home}/.claude/settings.json`, 'utf8')), cleanupPeriodDays: 3 }));
  rows = await diagnose({ env: stuck.env, home: stuck.home, fetch: stuck.fetchFn, now: stuck.now });
  assert.equal(by(rows, 'archive:outbox').result, 'FAIL');
  assert.equal(by(rows, 'archive:acked').result, 'WARN');
  assert.match(by(rows, 'archive:acked').detail, /age=28[78]\.\dh|age=2\d\d\.\dh/);
  assert.equal(by(rows, 'archive:quarantine').result, 'WARN');
  assert.equal(by(rows, 'cleanup-backstop').result, 'WARN');
  assert.match(by(rows, 'cleanup-backstop').detail, /cleanupPeriodDays=3/);

  const notoken = archiveFixture();
  delete notoken.env.CAMMUT_MEMORY_TOKEN; delete notoken.env.CAMMUT_ARCHIVE_READ_TOKEN;
  rows = await diagnose({ env: notoken.env, home: notoken.home, fetch: notoken.fetchFn, now: notoken.now });
  assert.equal(by(rows, 'archive').result, 'FAIL');
  assert.equal(by(rows, 'archive:replica').result, 'WARN');
});

test('the doctor notices when an installed adapter file differs from the repo or is missing, for every file of the manifest', async () => {
  const f = fixture();
  let rows = await diagnose({ env: f.env, home: f.home, fetch: okFetch(), now: f.now });
  assert.equal(by(rows, 'installed-files').result, 'PASS');
  fs.appendFileSync(`${f.dir}/common.mjs`, '// edited in place\n');
  fs.rmSync(`${f.dir}/archive.mjs`);
  rows = await diagnose({ env: f.env, home: f.home, fetch: okFetch(), now: f.now });
  assert.equal(by(rows, 'installed-files').result, 'WARN');
  assert.match(by(rows, 'installed-files').detail, /common\.mjs:differs/);
  assert.match(by(rows, 'installed-files').detail, /archive\.mjs:missing/);
});
