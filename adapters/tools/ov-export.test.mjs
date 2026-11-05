import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeServer, tmp } from '../test-helpers.mjs';
import { exportTree, planNotes, splitBody, losslessCheck, scanDirectives, applyPlan, run, ovReader } from './ov-export.mjs';

// Synthetic pages only. The long preference page is longer than one Cammut note (1500 characters) on purpose.
const U = 'viking://user/alice/memories/';
const para = (i) => `Section ${i}. ${'Write short answers and state the result first. '.repeat(6).trim()}\n- point ${i}a: lead with the outcome\n- point ${i}b: name the file and the line`;
const LONG = `# How the owner wants work done\n\n${[1, 2, 3, 4, 5, 6].map(para).join('\n\n')}\n`;
const PAGES = {
  [`${U}preferences/alice/00_START_HERE_how_alice_wants_work_done.md`]: LONG,
  [`${U}preferences/alice/writing_voice.md`]: '# Writing voice\n\nPlain sentences. No filler. Numbers with units.\n',
  [`${U}entities/software_project/cammut.md`]: '# Cammut\n\nA Go MCP gateway with shared project memory.\n',
  [`${U}events/2026/10/10/hiring-plan.md`]: '# Hiring plan\n\nPlan: hire three engineers next quarter. Budget $120k. Headcount target 5. Roadmap milestone in March.\n',
  [`${U}entities/software_project/.overview.md`]: '# Entities Overview\n\n- cammut\n',
};
const entriesFor = (pages) => {
  const out = [];
  const dirs = new Set();
  for (const uri of Object.keys(pages)) {
    const parts = uri.split('/');
    for (let i = 4; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    out.push({ uri, size: pages[uri].length, isDir: false });
  }
  for (const d of dirs) out.push({ uri: d, size: 0, isDir: true });
  return out;
};

const fakeOv = (pages = PAGES, extra = []) => fakeServer((c) => {
  const u = new URL(c.url, 'http://x');
  if (u.pathname === '/api/v1/fs/ls') {
    const base = u.searchParams.get('uri');
    if (base !== 'viking://user/alice/memories') return { status: 404, json: { status: 'error' } };
    return { status: 200, json: { status: 'ok', result: [...entriesFor(pages), ...extra] } };
  }
  if (u.pathname === '/api/v1/content/read') {
    const text = pages[u.searchParams.get('uri')];
    return text === undefined ? { status: 404, json: {} } : { status: 200, json: { status: 'ok', result: text } };
  }
  return { status: 400, json: {} };
});

const reader = (srv) => ovReader({ SM_OV_URL: srv.url, SHARED_MEMORY_OPENVIKING_API_KEY: 'ovk_TESTONLY' });

test('export is read-only, mirrors the tree, skips derived overviews and tolerates a missing root', async () => {
  const srv = await fakeOv();
  const out = tmp('ov-out-');
  const say = [];
  const r = await exportTree({ ov: reader(srv), out, roots: ['viking://user/alice/memories', 'viking://agent'], say: (m) => say.push(m) });
  assert.equal(r.files, 4);
  assert.equal(r.skippedDerived, 1);
  assert.deepEqual(r.missingRoots, ['viking://agent']);
  assert.ok(srv.calls.every((c) => c.method === 'GET'), 'only GET requests');
  assert.ok(srv.calls.every((c) => c.auth === 'Bearer ovk_TESTONLY'));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 4);
  const mirrored = manifest.files.find((f) => f.uri.endsWith('cammut.md'));
  assert.equal(fs.readFileSync(path.join(out, mirrored.path), 'utf8'), PAGES[`${U}entities/software_project/cammut.md`]);
  assert.ok(!say.join('\n').includes('ovk_TESTONLY') && !say.join('\n').includes('Go MCP gateway'), 'counts only on stdout, never the key or page text');
  srv.srv.close();
});

test('export refuses a listing entry that would leave the output folder', async () => {
  const srv = await fakeOv(PAGES, [{ uri: 'viking://user/alice/memories/../../escape.md', size: 3, isDir: false }, { uri: 'viking://user/alice/memories/a%2f..%2fb.md', size: 3, isDir: false }]);
  const out = tmp('ov-out-');
  const r = await exportTree({ ov: reader(srv), out, roots: ['viking://user/alice/memories'], say: () => {} });
  assert.equal(r.files, 4);
  assert.equal(r.refused, 2);
  assert.ok(!fs.existsSync(path.join(out, '..', 'escape.md')));
  srv.srv.close();
});

const files = () => Object.entries(PAGES).filter(([u]) => !u.includes('/.')).map(([uri, text]) => ({ uri, text }));

test('the mapper turns preferences into observed preference notes with stable keys and the owner start page into pref.work-style', () => {
  const { notes } = planNotes(files());
  const start = notes.filter((n) => n.uri.endsWith('00_START_HERE_how_alice_wants_work_done.md'));
  assert.ok(start.length >= 2, 'a page longer than one note is split, not cut');
  assert.deepEqual(start.map((n) => n.key).slice(0, 2), ['pref.work-style', 'pref.work-style.2']);
  assert.ok(start.every((n) => n.kind === 'preference' && n.epistemic === 'observed' && n.flagged === false));
  assert.ok(start.every((n) => n.body.length <= 1500 && n.title.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(n.key)));
  const voice = notes.find((n) => n.key === 'pref.writing-voice');
  assert.equal(voice.kind, 'preference');
  assert.equal(voice.epistemic, 'observed');
  assert.equal(new Set(notes.map((n) => n.key)).size, notes.length, 'keys are unique');
});

test('entity pages become state notes, assistant-written plans and budgets become flagged speculative notes', () => {
  const { notes } = planNotes(files());
  const ent = notes.find((n) => n.key === 'entity.software_project.cammut');
  assert.deepEqual([ent.kind, ent.epistemic, ent.flagged], ['state', 'inferred', false]);
  const plan = notes.find((n) => n.uri.endsWith('hiring-plan.md'));
  assert.deepEqual([plan.epistemic, plan.flagged], ['speculative', true]);
  assert.match(plan.reason, /plan|budget|headcount/i);
  const pref = planNotes([{ uri: `${U}preferences/alice/budget_habits.md`, text: '# Budget habits\n\nPlan the budget in a spreadsheet; headcount stays small.\n' }]).notes[0];
  assert.deepEqual([pref.epistemic, pref.flagged], ['observed', false], 'a curated preference is never reclassified by its words');
});

test('the migration of a long preference page is lossless and the check catches a lost paragraph', () => {
  const src = files().filter((f) => f.uri.endsWith('00_START_HERE_how_alice_wants_work_done.md'));
  const { notes } = planNotes(src);
  assert.deepEqual(losslessCheck(src, notes), { ok: true, failures: [] });
  const damaged = notes.slice(0, -1);
  const bad = losslessCheck(src, damaged);
  assert.equal(bad.ok, false);
  assert.match(bad.failures[0], /00_START_HERE/);
});

test('splitBody keeps every character, prefers paragraph breaks and splits an oversized paragraph on whitespace', () => {
  const text = `${'a '.repeat(900).trim()}\n\nshort`;
  const parts = splitBody(text, 1400);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 1400));
  assert.equal(parts.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  assert.deepEqual(splitBody('tiny', 1400), ['tiny']);
});

const DIRECTIVES = JSON.stringify([
  { id: 'd1', name: 'Alice writing voice and report format (primary)', content: 'Read viking://user/alice/memories/preferences/alice/00_START_HERE_how_alice_wants_work_done.md before writing. Also viking://user/alice/memories/entities/software_project/cammut.md.' },
  { id: 'd2', name: 'No references here', content: 'Keep answers short.' },
]);

test('directive scan lists each viking:// reference, the migrated keys that replace it, and flags unmapped ones', () => {
  const { notes } = planNotes(files());
  const rows = scanDirectives(DIRECTIVES, notes);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].directive, 'Alice writing voice and report format (primary)');
  assert.ok(rows[0].replacement.includes('pref.work-style') && rows[0].replacement.includes('pref.work-style.2'));
  assert.deepEqual(rows[1].replacement, ['entity.software_project.cammut']);
  const unmapped = scanDirectives('see viking://user/alice/memories/preferences/alice/nope.md for details', notes);
  assert.deepEqual(unmapped.map((r) => r.replacement), [[]]);
  assert.deepEqual(scanDirectives('nothing to rewrite', notes), []);
  assert.deepEqual(scanDirectives('[]', notes), []);
});

// ---- apply ---------------------------------------------------------------------------------------------

const fakeCammut = (existing = {}) => fakeServer((c) => {
  const u = new URL(c.url, 'http://x');
  if (c.method === 'GET' && u.pathname === '/v1/memory/history') {
    const key = u.searchParams.get('key');
    return existing[key] ? { status: 200, json: { notes: [{ id: 'old', status: 'active', body: existing[key] }] } } : { status: 404, json: { error: 'no note' } };
  }
  if (c.method === 'POST' && u.pathname === '/v1/memory/notes') {
    if (c.body.epistemic === 'observed' && c.headers['x-test-deny-observed']) return { status: 400, json: { error: 'only a person may write observed' } };
    existing[c.body.key] = c.body.body;
    return { status: 201, json: { id: `n-${c.body.key}`, key: c.body.key, epistemic: c.body.epistemic } };
  }
  return { status: 404, json: {} };
});

test('apply is a dry run unless asked, then posts every note once with its epistemic status and skips unchanged ones', async () => {
  const { notes } = planNotes(files());
  const cm = await fakeCammut();
  const say = [];
  const dry = await applyPlan({ notes, url: cm.url, token: 'cmt_TESTONLY', project: 'general', apply: false, say: (m) => say.push(m) });
  assert.equal(cm.calls.length, 0, 'a dry run touches nothing');
  assert.equal(dry.created, 0);
  const done = await applyPlan({ notes, url: cm.url, token: 'cmt_TESTONLY', project: 'general', apply: true, say: (m) => say.push(m) });
  const posts = cm.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, notes.length);
  assert.equal(done.created, notes.length);
  assert.ok(posts.every((c) => c.auth === 'Bearer cmt_TESTONLY' && c.body.project === 'general' && c.body.force === true));
  assert.ok(posts.some((c) => c.body.epistemic === 'speculative') && posts.some((c) => c.body.epistemic === 'observed'));
  assert.ok(!say.join('\n').includes('cmt_TESTONLY'));
  assert.ok(!say.join('\n').includes('Plain sentences'), 'note text is never printed');
  cm.srv.close();
  const same = await fakeCammut(Object.fromEntries(notes.map((n) => [n.key, n.body])));
  const again = await applyPlan({ notes, url: same.url, token: 'cmt_X', project: 'general', apply: true, say: () => {} });
  assert.deepEqual([again.created, again.unchanged], [0, notes.length]);
  assert.equal(same.calls.filter((c) => c.method === 'POST').length, 0, 'a second run creates nothing');
  same.srv.close();
});

test('the CLI maps a folder to proposal.json without touching the network, and apply needs --apply', async () => {
  const srv = await fakeOv();
  const out = tmp('ov-cli-');
  const say = [];
  const env = { SM_OV_URL: srv.url, SHARED_MEMORY_OPENVIKING_API_KEY: 'ovk_TESTONLY' };
  assert.equal(await run({ argv: ['export', '--out', out], env, say: (m) => say.push(m) }), 0);
  const before = srv.calls.length;
  assert.equal(await run({ argv: ['map', '--in', out], env: {}, say: (m) => say.push(m) }), 0);
  assert.equal(srv.calls.length, before, 'map reads the local folder only');
  const proposal = JSON.parse(fs.readFileSync(path.join(out, 'proposal.json'), 'utf8'));
  assert.ok(proposal.notes.length >= 5 && proposal.lossless.ok === true);
  assert.ok(say.some((m) => /speculative/.test(m) && /flagged/.test(m)));
  assert.equal(await run({ argv: ['map', '--in', out, '--apply'], env: {}, say: () => {} }), 2, 'apply without a token env is refused');
  const cm = await fakeCammut();
  assert.equal(await run({ argv: ['map', '--in', out, '--apply', '--project', 'general'], env: { CAMMUT_URL: cm.url, CAMMUT_MEMORY_TOKEN: 'cmt_TESTONLY' }, say: () => {} }), 0);
  assert.equal(cm.calls.filter((c) => c.method === 'POST').length, proposal.notes.length);
  assert.equal(await run({ argv: ['scan-directives', '--in', out], env: {}, say: (m) => say.push(m), stdin: DIRECTIVES }), 1, 'exit 1 = something needs rewriting');
  assert.ok(say.some((m) => /pref\.work-style/.test(m)));
  srv.srv.close();
  cm.srv.close();
});
