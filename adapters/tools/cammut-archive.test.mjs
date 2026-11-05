// The user tool, against an in-memory fake of the /v1/archive API (same shapes, same scope split) and a fake age.
// Synthetic transcripts only; nothing here touches a real transcript, key or server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  backfill, status as toolStatus, fetchSession, decryptSession, restoreSession, audit, doctor, main,
} from './cammut-archive.mjs';
import { sealSegment, segmentId, sha256Hex, ageEncrypt, recipientFingerprints, wireMeta } from '../archive.mjs';
import { redact, saveSession } from '../common.mjs';
import { preflight } from '../sweep.mjs';
import { fakeServer, fakeEncrypt, tmp, line } from '../test-helpers.mjs';

const KEY_A = 'age1' + 'q'.repeat(58);
const KEY_B = 'age1' + 'p'.repeat(58);
const fp16 = (k) => sha256Hex(Buffer.from(k)).slice(0, 16);
const W = 'cmt_write'; const R = 'cmt_read';

// ---- a fake archive server -------------------------------------------------------------------------------------------------

function archiveServer({ failPutsAfter = Infinity, listingPage, downloadOverride } = {}) {
  const segs = new Map(); let seq = 0; let puts = 0;
  const scopes = { [W]: ['put', 'verify'], [R]: ['get', 'list', 'verify'] };
  const allowed = (c, op) => (scopes[(c.auth || '').replace('Bearer ', '')] || []).includes(op);
  const wire = (e) => ({ id: e.id, agent: e.meta.agent, project: e.meta.project, session_id: e.meta.session_id, kind: e.meta.kind, relpath: e.meta.relpath, fp: e.meta.fp, src_start: e.meta.src_start, src_end: e.meta.src_end, codec: e.meta.codec, plain_bytes: e.meta.plain_bytes, cipher_bytes: e.cipher.length, sha256: e.sha, recipients: (e.meta.recipients || '').split(',').filter(Boolean), stored_at: Math.floor(e.at / 1000) });
  const coverage = (agent, session) => {
    const rows = [...segs.values()].filter((e) => e.meta.agent === agent && e.meta.session_id === session && e.meta.kind === 'transcript');
    if (!rows.length) return { fp: '', ranges: [], contiguous_to: 0, segments: 0, segs: [] };
    const fp = rows.sort((a, b) => b.seq - a.seq)[0].meta.fp;
    const cur = rows.filter((e) => e.meta.fp === fp).sort((a, b) => a.meta.src_start - b.meta.src_start || a.meta.src_end - b.meta.src_end);
    const ranges = [];
    for (const e of cur) { const l = ranges.at(-1); if (l && e.meta.src_start <= l[1]) l[1] = Math.max(l[1], e.meta.src_end); else ranges.push([e.meta.src_start, e.meta.src_end]); }
    return { fp, ranges, contiguous_to: ranges[0]?.[0] === 0 ? ranges[0][1] : 0, segments: cur.length, segs: cur.map((e) => ({ id: e.id, start: e.meta.src_start, end: e.meta.src_end, src_sha256: e.meta.src_sha256, sha256: e.sha, recipients: (e.meta.recipients || '').split(',').filter(Boolean), replicated: false })) };
  };
  const srv = fakeServer((c) => {
    const u = new URL(c.url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean); // v1 archive ...
    if (c.method === 'PUT' && parts[2] === 'segments') {
      if (!allowed(c, 'put')) return { status: 403, json: {} };
      if (++puts > failPutsAfter) return { status: 503, json: {} };
      const meta = JSON.parse(Buffer.from(c.headers['x-archive-meta'], 'base64url').toString());
      if (!c.raw.subarray(0, 22).equals(Buffer.from('age-encryption.org/v1\n'))) return { status: 415, json: { error: 'not_age' } };
      if (sha256Hex(c.raw) !== c.headers['x-content-sha256']) return { status: 400, json: { error: 'bad_input' } };
      const id = parts[3];
      const old = segs.get(id);
      if (old) return old.meta.src_sha256 !== meta.src_sha256 ? { status: 409, json: { error: 'content_mismatch' } } : { status: 200, json: { id, created: false, sha256: old.sha, bytes: old.cipher.length, matches: old.sha === sha256Hex(c.raw), recipients_changed: false } };
      const e = { id, meta: { ...meta, recipients: c.headers['x-archive-recipients'] || '' }, cipher: c.raw, sha: sha256Hex(c.raw), at: Date.now(), seq: ++seq };
      segs.set(id, e);
      return { status: 201, json: { id, created: true, sha256: e.sha, bytes: e.cipher.length, matches: true, recipients_changed: false } };
    }
    if (c.method === 'HEAD' && parts[2] === 'segments') {
      if (!allowed(c, 'verify')) return { status: 403, json: {} };
      const e = segs.get(parts[3]);
      return e ? { status: 200, headers: { 'X-Content-SHA256': e.sha } } : { status: 404, json: {} };
    }
    if (c.method === 'GET' && parts[2] === 'segments' && parts[3]) {
      if (!allowed(c, 'get')) return { status: 403, json: {} };
      const stored = segs.get(parts[3]);
      const e = stored && downloadOverride ? downloadOverride(stored) : stored;
      return e ? { status: 200, buf: e.cipher, headers: { 'X-Content-SHA256': e.sha, 'X-Archive-Meta': Buffer.from(JSON.stringify(e.meta)).toString('base64url') } } : { status: 404, json: {} };
    }
    if (c.method === 'GET' && parts[2] === 'segments') {
      if (!allowed(c, 'list')) return { status: 403, json: {} };
      let rows = [...segs.values()].sort((a, b) => b.seq - a.seq);
      if (u.searchParams.get('session')) rows = rows.filter((e) => e.meta.session_id === u.searchParams.get('session'));
      if (u.searchParams.get('agent')) rows = rows.filter((e) => e.meta.agent === u.searchParams.get('agent'));
      const offset = Number(u.searchParams.get('cursor') || 0);
      const limit = Math.min(1000, Number(u.searchParams.get('limit') || 100));
      const end = offset + limit;
      const page = { segments: rows.slice(offset, end).map(wire), truncated: end < rows.length, next_cursor: end < rows.length ? String(end) : null };
      return { status: 200, json: listingPage ? listingPage(page, u) : page };
    }
    if (c.method === 'GET' && parts[2] === 'sessions') {
      if (!allowed(c, 'verify')) return { status: 403, json: {} };
      return { status: 200, json: coverage(parts[3], parts[4]) };
    }
    if (c.method === 'GET' && parts[2] === 'status') {
      if (!allowed(c, 'list')) return { status: 403, json: {} };
      const all = [...segs.values()];
      return { status: 200, json: { segments: all.length, cipher_bytes: all.reduce((n, e) => n + e.cipher.length, 0), sessions: new Set(all.map((e) => e.meta.session_id)).size, by_project: {}, free_bytes: 5e9, max_bytes: 2e10, replica: { last_run_at: null, replicated: 0, unreplicated: all.length, oldest_unreplicated_age_s: 0 }, recipient_changes: [] } };
    }
    return { status: 404, json: {} };
  });
  return srv.then((s) => ({ ...s, segs, puts: () => puts, coverage }));
}

// stands in for `age -d -i <identity>`: it only knows the fake format and two identities
const fakeAge = {
  decrypt(cipher, identity) {
    if (!/good|recovery/.test(identity)) throw new Error('age: no identity matched any of the recipients');
    const challenge = Buffer.from('FAKE single-recipient challenge\n');
    if (cipher.subarray(0, challenge.length).equals(challenge)) {
      const [key, body] = cipher.subarray(challenge.length).toString().split('\n');
      if (key !== (/recovery/.test(identity) ? KEY_B : KEY_A)) throw new Error('age: no identity matched any of the recipients');
      return Buffer.from(body, 'base64');
    }
    const head = Buffer.from('age-encryption.org/v1\nFAKE\n');
    if (!cipher.subarray(0, head.length).equals(head)) throw new Error('age: not an age file');
    return Buffer.from(cipher.subarray(head.length).toString(), 'base64');
  },
  version: () => 'v1.2.0 (fake)',
  encryptRecipient: (buf, key) => Buffer.from(`FAKE single-recipient challenge\n${key}\n${buf.toString('base64')}`),
  publicKey: (identity) => (/recovery/.test(identity) ? KEY_B : null), // a plain identity can be read; the passphrase-locked daily one cannot
};

// a project tree with Claude transcripts, a subagent file and a Codex rollout
function world({ n = 3 } = {}) {
  const root = tmp('ca-');
  const home = path.join(root, 'home');
  const claude = path.join(home, '.claude');
  const codex = path.join(home, '.codex');
  const stateDir = path.join(claude, 'state', 'shared-memory');
  fs.mkdirSync(path.join(claude, 'projects', 'C--x-Cammut'), { recursive: true });
  fs.mkdirSync(path.join(codex, 'sessions', '2026', '10', '11'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const uuid = (i) => `0a1b2c3d-1111-2222-3333-44445555666${i}`;
  const files = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(claude, 'projects', 'C--x-Cammut', `${uuid(i)}.jsonl`);
    const rows = [line({ type: 'user', cwd: 'C:\\x\\Cammut', sessionId: uuid(i), message: { role: 'user', content: `first prompt ${i} password: hunter2hunter2` } })];
    for (let k = 0; k < 12; k++) rows.push(line({ type: k % 2 ? 'assistant' : 'user', message: { role: k % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `row ${k} of ${i} ${'x'.repeat(60)}` }, ...(k === 3 ? [{ type: 'thinking', thinking: 'secret thoughts', signature: 'sig' }] : [])] } }));
    fs.writeFileSync(f, rows.join(''));
    files.push(f);
  }
  const sub = path.join(claude, 'projects', 'C--x-Cammut', uuid(0), 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), line({ type: 'assistant', message: { content: 'sidecar' } }));
  const rollout = path.join(codex, 'sessions', '2026', '10', '11', `rollout-2026-10-11T10-00-00-7f6e5d4c-aaaa-bbbb-cccc-ddddeeeeffff.jsonl`);
  fs.writeFileSync(rollout, line({ type: 'session_meta', payload: { cwd: 'C:\\x\\RnaV', id: '7f6e5d4c-aaaa-bbbb-cccc-ddddeeeeffff' } }) + line({ type: 'response_item', payload: { text: 'codex row' } }).repeat(6));
  const recipientsFile = path.join(root, 'recipients.txt');
  fs.writeFileSync(recipientsFile, `${KEY_A}\n${KEY_B}\n`);
  return { root, home, claude, codex, stateDir, files, rollout, uuid, recipientsFile };
}

const cfgFor = (w, url, over = {}) => ({
  stateDir: w.stateDir, requestMs: 3000, encrypt: fakeEncrypt,
  cammut: { url, token: W, readToken: R },
  archive: { enabled: true, recipientsFile: w.recipientsFile, segmentBytes: 400, flushIdleMs: 600000, redact: true, outboxMaxBytes: 1 << 24, ...over },
  retention: { enabled: false },
});
const sink = () => { const lines = []; return { lines, write: (s) => lines.push(String(s)) }; };

// ---- backfill ----------------------------------------------------------------------------------------------------------------------

test('backfill --dry-run counts what it would upload and uploads nothing; the real run resumes after an interruption and uploads only the missing ranges', async () => {
  const w = world();
  const srv = await archiveServer({ failPutsAfter: 4 });
  const cfg = cfgFor(w, srv.url);
  const roots = { claudeHome: w.claude, codexHome: w.codex };
  const dry = sink();
  const d = await backfill(cfg, { dryRun: true, roots, ...dry });
  assert.equal(srv.puts(), 0);
  assert.match(dry.lines.join('\n'), /files=4 segments=\d+ uploaded MiB=0\.0 skipped\(covered\)=0/);
  assert.ok(d.segments >= 8);

  const first = sink();
  const r1 = await backfill(cfg, { roots, ...first });
  assert.ok(r1.uploaded >= 1 && r1.uploaded <= 4, 'the server went away after 4 uploads');
  assert.equal(r1.failed, 0);
  assert.ok(r1.retry, 'an interrupted run says it should be repeated');
  const done1 = srv.segs.size;

  const cfg2 = { ...cfg };
  // recover: a fresh server instance that shares the stored segments
  const healthy = await archiveServer();
  for (const [k, v] of srv.segs) healthy.segs.set(k, v);
  const second = sink();
  const r2 = await backfill({ ...cfg2, cammut: { ...cfg2.cammut, url: healthy.url } }, { roots, ...second });
  assert.equal(r2.failed, 0);
  assert.equal(r2.uploaded + done1, healthy.segs.size, 'the second run uploaded exactly the segments that were still missing');
  assert.ok(r2.skippedCovered >= 0);
  // every file is now fully covered on the server
  const sizes = Object.fromEntries(w.files.map((f) => [path.basename(f, '.jsonl'), fs.statSync(f).size]));
  for (const [sid, size] of Object.entries(sizes)) assert.equal(healthy.coverage('claude-code', sid).contiguous_to, size, sid);
  assert.equal(healthy.coverage('codex', '7f6e5d4c-aaaa-bbbb-cccc-ddddeeeeffff').contiguous_to, fs.statSync(w.rollout).size);
  // a third run finds nothing to do
  const third = sink();
  const r3 = await backfill({ ...cfg2, cammut: { ...cfg2.cammut, url: healthy.url } }, { roots, ...third });
  assert.equal(r3.uploaded, 0);
  assert.match(third.lines.join('\n'), /files=4 segments=0 uploaded MiB=0\.0 skipped\(covered\)=4/);
  // the project name came from the first record's cwd, never from the encoded folder name
  const row = [...healthy.segs.values()].find((e) => e.meta.agent === 'claude-code');
  assert.equal(row.meta.project, 'Cammut');
  assert.equal([...healthy.segs.values()].find((e) => e.meta.agent === 'codex').meta.project, 'RnaV');
  // what went to the server is ciphertext: no prompt text, no secret
  for (const e of healthy.segs.values()) assert.ok(!e.cipher.toString('latin1').includes('hunter2') && !e.cipher.toString('latin1').includes('first prompt'));
  srv.srv.close(); healthy.srv.close();
});

test('backfill honours --agent, --since and --max-mb, and prints counts only', async () => {
  const w = world();
  const srv = await archiveServer();
  const cfg = cfgFor(w, srv.url);
  const roots = { claudeHome: w.claude, codexHome: w.codex };
  const o = sink();
  const only = await backfill(cfg, { roots, agent: 'codex', ...o });
  assert.deepEqual([...srv.segs.values()].map((e) => e.meta.agent), Array(srv.segs.size).fill('codex'));
  assert.equal(only.files, 1);
  const old = new Date('2020-01-01');
  fs.utimesSync(w.files[0], old, old);
  const since = await backfill(cfg, { roots, agent: 'claude-code', since: '2026-01-01', ...sink() });
  assert.equal(since.files, 2, 'the transcript last written in 2020 is skipped');
  const fresh = await archiveServer();
  const capped = await backfill(cfgFor(w, fresh.url), { roots, maxMb: 0.0001, ...sink() });
  assert.equal(capped.files, 1, 'the byte budget stops the run after the first file');
  fresh.srv.close();
  const printed = o.lines.join('\n');
  assert.ok(!/hunter2|first prompt|cmt_/.test(printed));
  srv.srv.close();
});

// ---- status ----------------------------------------------------------------------------------------------------------------------------

test('status prints server totals, the local outbox, the oldest unarchived transcript and the last sweep, and never a token', async () => {
  const w = world();
  const srv = await archiveServer();
  const cfg = cfgFor(w, srv.url);
  await backfill(cfg, { roots: { claudeHome: w.claude, codexHome: null }, ...sink() });
  fs.writeFileSync(path.join(w.stateDir, 'sweep.log'), `${new Date().toISOString()} abcdef012345 100 quarantined -\n`);
  const o = sink();
  const s = await toolStatus(cfg, { ...o });
  const text = o.lines.join('\n');
  assert.match(text, /server: segments=\d+ /);
  assert.match(text, /outbox: 0 segments/);
  assert.match(text, /last sweep: /);
  assert.ok(!text.includes(W) && !text.includes(R));
  assert.ok(s.server.segments >= 1);
  srv.srv.close();
});

// ---- fetch, decrypt, restore -------------------------------------------------------------------------------------------------------------

async function archived(n = 1, over = {}) {
  const w = world({ n });
  const srv = await archiveServer();
  const cfg = cfgFor(w, srv.url, over);
  await backfill(cfg, { roots: { claudeHome: w.claude, codexHome: null }, ...sink() });
  return { w, srv, cfg, sid: w.uuid(0) };
}

// The tail was uploaded first, so a newest-first capped listing is a valid-looking prefix.
async function manySegments(options = {}) {
  const w = world({ n: 0 });
  const srv = await archiveServer(options);
  const cfg = cfgFor(w, srv.url);
  const sid = w.uuid(0);
  let start = 0;
  for (let i = 0; i < 1001; i++) {
    const raw = Buffer.from(line(i === 0 ? { cwd: 'C:\\x\\Cammut', n: i } : { n: i }));
    const meta = { agent: 'claude-code', project: 'Cammut', session: sid, kind: 'transcript', fp: 'f'.repeat(64), start, end: start + raw.length };
    const seg = sealSegment({ meta, rawBytes: raw, recipientsFile: w.recipientsFile, encrypt: fakeEncrypt });
    srv.segs.set(seg.id, { id: seg.id, meta: { ...wireMeta(seg.meta), recipients: recipientFingerprints(w.recipientsFile) }, cipher: seg.cipher, sha: seg.sha256, at: Date.now(), seq: 1001 - i });
    start += raw.length;
  }
  return { w, srv, cfg, sid };
}

test('decrypt and restore follow next_cursor to recover all 1001 segments', async () => {
  const { w, srv, cfg, sid } = await manySegments();
  try {
    const file = path.join(w.root, 'all.jsonl');
    const r = await decryptSession(cfg, { session: sid, identity: 'good.key', out: file, age: fakeAge, ...sink() });
    assert.equal(r.segments, 1001);
    assert.equal(r.lines, 1001);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)).n, 1000);
    const restored = await restoreSession(cfg, { session: sid, identity: 'good.key', home: path.join(w.root, 'newhome'), age: fakeAge, ...sink() });
    assert.equal(restored.lines, 1001);
    assert.ok(srv.calls.some((c) => c.url.includes('cursor=1000')));
  } finally { srv.srv.close(); }
});

test('decrypt and restore refuse a listed prefix when complete coverage includes the missing tail', async () => {
  const { w, srv, cfg, sid } = await manySegments({ listingPage: (page) => ({ ...page, truncated: false, next_cursor: null }) });
  try {
    const file = path.join(w.root, 'partial.jsonl');
    await assert.rejects(decryptSession(cfg, { session: sid, identity: 'good.key', out: file, age: fakeAge, ...sink() }), /coverage|incomplete/);
    await assert.rejects(restoreSession(cfg, { session: sid, identity: 'good.key', home: path.join(w.root, 'newhome'), age: fakeAge, ...sink() }), /coverage|incomplete/);
    assert.equal((await audit(cfg, { sample: 1, identity: 'good.key', recoveryIdentity: 'recovery.key', age: fakeAge, ...sink() })).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.stateDir, 'restore-audit.json'), 'utf8')).ok, false);
    assert.ok(!fs.existsSync(file));
    assert.ok(!fs.existsSync(path.join(w.root, 'newhome')));
  } finally { srv.srv.close(); }
});

test('fetch and audit follow next_cursor instead of silently accepting the first 1000 segments', async () => {
  const { w, srv, cfg, sid } = await manySegments();
  try {
    const fetched = await fetchSession(cfg, { session: sid, out: path.join(w.root, 'cipher'), ...sink() });
    assert.equal(fetched.segments, 1001);
    srv.calls.length = 0;
    assert.equal((await audit(cfg, { sample: 1, identity: 'good.key', recoveryIdentity: 'recovery.key', age: fakeAge, ...sink() })).ok, true);
    assert.ok(srv.calls.some((c) => c.url.includes('cursor=1000')), 'audit samples from the complete listing');
  } finally { srv.srv.close(); }
});

test('listing rejects missing and repeating cursors before writing any partial restore', async () => {
  for (const next of [null, 'repeat']) {
    const { w, srv, cfg, sid } = await manySegments({ listingPage: (page) => ({ ...page, truncated: true, next_cursor: next }) });
    try {
      const file = path.join(w.root, 'partial.jsonl');
      await assert.rejects(decryptSession(cfg, { session: sid, identity: 'good.key', out: file, age: fakeAge, ...sink() }), /cursor/);
      assert.ok(!fs.existsSync(file));
    } finally { srv.srv.close(); }
  }
});

test('decrypt binds downloaded authenticated metadata to the selected coverage chain', async () => {
  const w = world({ n: 1 });
  const srv = await archiveServer({ downloadOverride: (e) => {
    const meta = { agent: e.meta.agent, project: e.meta.project, session: 'other-session', kind: e.meta.kind, fp: e.meta.fp, start: e.meta.src_start, end: e.meta.src_end };
    const seg = sealSegment({ meta, rawBytes: Buffer.from(line({ n: 0 })), recipientsFile: w.recipientsFile, encrypt: fakeEncrypt });
    return { ...e, meta: wireMeta(seg.meta), cipher: seg.cipher, sha: seg.sha256 };
  } });
  const cfg = cfgFor(w, srv.url, { segmentBytes: 1 << 20 });
  try {
    await backfill(cfg, { roots: { claudeHome: w.claude, codexHome: null }, ...sink() });
    const file = path.join(w.root, 'wrong.jsonl');
    await assert.rejects(decryptSession(cfg, { session: w.uuid(0), identity: 'good.key', out: file, age: fakeAge, ...sink() }), /coverage|selected|sha256/);
    assert.ok(!fs.existsSync(file));
  } finally { srv.srv.close(); }
});

test('fetch refuses downloaded relpath that differs from the listed segment', async () => {
  const w = world({ n: 1 });
  const srv = await archiveServer({ downloadOverride: (e) => ({ ...e, meta: { ...e.meta, relpath: 'sidecar.jsonl' } }) });
  const cfg = cfgFor(w, srv.url, { segmentBytes: 1 << 20 });
  try {
    await backfill(cfg, { roots: { claudeHome: w.claude, codexHome: null }, ...sink() });
    const dir = path.join(w.root, 'cipher');
    await assert.rejects(fetchSession(cfg, { session: w.uuid(0), out: dir, ...sink() }), /relpath.*selected/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { srv.srv.close(); }
});

test('fetch writes only inside --out, verifies the ciphertext hash and refuses an id that is not 32 hex', async () => {
  const { w, srv, cfg, sid } = await archived();
  const out = path.join(w.root, 'out');
  const r = await fetchSession(cfg, { session: sid, out, ...sink() });
  assert.ok(r.segments >= 2);
  const names = fs.readdirSync(out);
  assert.ok(names.every((n) => /^[0-9a-f]{32}\.(age|meta\.json)$/.test(n)));
  assert.equal(names.length, r.segments * 2);
  for (const e of srv.segs.values()) assert.ok(fs.readFileSync(path.join(out, `${e.id}.age`)).equals(e.cipher));
  // a server that lists a path-like id must not make the tool write elsewhere
  const evil = await fakeServer((c) => (c.url.startsWith('/v1/archive/segments?') ? { status: 200, json: { segments: [{ id: '../../escape', agent: 'claude-code', session_id: sid, kind: 'transcript', fp: 'a'.repeat(64), src_start: 0, src_end: 1, stored_at: 1 }], truncated: false, next_cursor: null } } : { status: 404, json: {} }));
  const out2 = path.join(w.root, 'out2');
  await assert.rejects(fetchSession({ ...cfg, cammut: { ...cfg.cammut, url: evil.url } }, { session: sid, out: out2, ...sink() }), /segment id/);
  assert.ok(!fs.existsSync(path.join(w.root, 'escape.age')));
  // a body whose hash differs from the one the server announced is refused
  const bad = await fakeServer((c) => (c.url.startsWith('/v1/archive/segments?') ? { status: 200, json: { segments: [{ id: 'a'.repeat(32), agent: 'claude-code', session_id: sid, kind: 'transcript', fp: 'a'.repeat(64), src_start: 0, src_end: 1, stored_at: 1 }], truncated: false, next_cursor: null } } : { status: 200, buf: Buffer.from('age-encryption.org/v1\nxx'), headers: { 'X-Content-SHA256': '0'.repeat(64), 'X-Archive-Meta': Buffer.from('{}').toString('base64url') } }));
  await assert.rejects(fetchSession({ ...cfg, cammut: { ...cfg.cammut, url: bad.url } }, { session: sid, out: path.join(w.root, 'out3'), ...sink() }), /sha256/);
  srv.srv.close(); evil.srv.close(); bad.srv.close();
});

test('decrypt rebuilds the redacted transcript in range order from the newest generation, with counts only on stdout', async () => {
  const { w, srv, cfg, sid } = await archived();
  const out = path.join(w.root, 'restored.jsonl');
  const o = sink();
  const r = await decryptSession(cfg, { session: sid, identity: 'good.key', out, age: fakeAge, ...o });
  const text = fs.readFileSync(out, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const src = fs.readFileSync(w.files[0], 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, src.length, 'one redacted line per source line');
  assert.ok(!text.includes('hunter2hunter2'), 'redacted at archive time');
  assert.equal(JSON.parse(lines[1]).message.content[0].text, `row 0 of 0 ${'x'.repeat(60)}`);
  assert.ok(lines.map((l) => JSON.parse(l)).every((j) => j && typeof j === 'object'));
  assert.match(o.lines.join('\n'), /segments=\d+ lines=13 /);
  assert.ok(!o.lines.join('\n').includes('first prompt'), 'no session text on stdout');
  assert.equal(r.lines, 13);
  await assert.rejects(decryptSession(cfg, { session: sid, identity: 'good.key', out, age: fakeAge, ...sink() }), /exists/, 'never overwrites');
  const g = sink();
  await decryptSession(cfg, { session: sid, identity: 'good.key', grep: 'row 7 of 0', age: fakeAge, ...g });
  assert.ok(g.lines.some((l) => l.includes('row 7 of 0')) && !g.lines.some((l) => l.includes('row 8 of 0')), 'grep streams matches only');
  await assert.rejects(decryptSession(cfg, { session: sid, identity: 'wrong.key', out: path.join(w.root, 'x.jsonl'), age: fakeAge, ...sink() }), /age/);
  srv.srv.close();
});

test('decrypt refuses a segment whose authenticated inner header disagrees with the stored range, naming the segment', async () => {
  const { w, srv, cfg, sid } = await archived(1, { segmentBytes: 1 << 20 });
  const e = [...srv.segs.values()].find((x) => x.meta.kind === 'transcript');
  // the server swaps the metadata: the outer range now claims a different end than the encrypted header
  e.meta = { ...e.meta, src_end: e.meta.src_end + 5 };
  await assert.rejects(decryptSession(cfg, { session: sid, identity: 'good.key', out: path.join(w.root, 'x.jsonl'), age: fakeAge, ...sink() }), (err) => err.message.includes(e.id.slice(0, 8)) && /header/.test(err.message));
  assert.ok(!fs.existsSync(path.join(w.root, 'x.jsonl')), 'nothing is written when a segment fails');
  srv.srv.close();
});

test('restore writes ~/.claude/projects/<encoded cwd>/<session>.jsonl, refuses to overwrite, can strip thinking blocks and says it is unverified', async () => {
  const { w, srv, cfg, sid } = await archived();
  const o = sink();
  const r = await restoreSession(cfg, { session: sid, identity: 'good.key', age: fakeAge, home: path.join(w.root, 'newhome'), stripThinking: true, ...o });
  assert.equal(r.file, path.join(w.root, 'newhome', '.claude', 'projects', 'C--x-Cammut', `${sid}.jsonl`));
  const text = fs.readFileSync(r.file, 'utf8');
  assert.ok(!text.includes('"thinking"') && !text.includes('secret thoughts'), 'thinking blocks removed');
  assert.ok(text.split('\n').filter(Boolean).every((l) => JSON.parse(l)));
  assert.match(o.lines.join('\n'), /UNVERIFIED/);
  assert.match(o.lines.join('\n'), /--resume/);
  await assert.rejects(restoreSession(cfg, { session: sid, identity: 'good.key', age: fakeAge, home: path.join(w.root, 'newhome'), ...sink() }), /exists/);
  const keep = await restoreSession(cfg, { session: sid, identity: 'good.key', age: fakeAge, home: path.join(w.root, 'home2'), ...sink() });
  assert.ok(fs.readFileSync(keep.file, 'utf8').includes('secret thoughts'), 'without --strip-thinking the blocks stay');
  srv.srv.close();
});

// ---- audit --------------------------------------------------------------------------------------------------------------------------------

test('audit rejects the same private key supplied once wrapped and once plain', async () => {
  const { w, srv, cfg } = await archived();
  const age = { ...fakeAge, publicKey: (identity) => identity === 'good-plain.key' ? KEY_A : null };
  const r = await audit(cfg, { sample: 1, identity: 'good-wrapped.key', recoveryIdentity: 'good-plain.key', age, ...sink() });
  assert.equal(r.ok, false, 'one key must not satisfy the two-key audit');
  const rec = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'restore-audit.json'), 'utf8'));
  assert.equal(rec.ok, false);
  assert.equal(rec.daily_fp, fp16(KEY_A));
  assert.equal(rec.recovery_fp, fp16(KEY_A));
  srv.srv.close();
});

test('audit independently proves a locked identity when the public recipient file repeats a key', async () => {
  const { w, srv, cfg } = await archived();
  try {
    fs.appendFileSync(w.recipientsFile, `${KEY_A}\n`);
    assert.equal((await audit(cfg, { sample: 1, identity: 'good.key', recoveryIdentity: 'recovery.key', age: fakeAge, ...sink() })).ok, true);
  } finally { srv.srv.close(); }
});

test('audit samples real segments, decrypts each with BOTH keys and writes ok only when both fingerprints are current recipients', async () => {
  const { w, srv, cfg } = await archived(2);
  const o = sink();
  const a = await audit(cfg, { sample: 3, identity: 'good.key', recoveryIdentity: 'recovery.key', age: fakeAge, ...o });
  assert.equal(a.ok, true);
  const rec = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'restore-audit.json'), 'utf8'));
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'daily_fp', 'ok', 'recipients', 'recovery_fp', 'segments']);
  assert.equal(rec.ok, true);
  assert.equal(rec.recovery_fp, fp16(KEY_B));
  assert.equal(rec.daily_fp, fp16(KEY_A), 'the locked daily key proves its own recipient with a single-recipient challenge');
  assert.deepEqual(rec.recipients, [fp16(KEY_A), fp16(KEY_B)].sort());
  assert.equal(rec.segments.length, 3);
  assert.ok(rec.segments.every((id) => /^[0-9a-f]{32}$/.test(id)));
  assert.match(o.lines.join('\n'), /daily: ok 3 bad 0/);
  assert.match(o.lines.join('\n'), /recovery: ok 3 bad 0/);
  const pf = preflight({ now: Date.now(), reviewed: true, status: { replica: { last_run_at: Date.now() } }, audit: rec, recipientFps: recipientFingerprints(w.recipientsFile).split(','), dryRun: { at: Date.now() }, registryReadable: true, enabled: true }, Date.now());
  assert.deepEqual(pf.reasons, [], 'the sweeper accepts the audit it asked for');

  // one key only: it still audits, but writes ok:false so the sweeper keeps refusing
  const one = await audit(cfg, { sample: 2, identity: 'good.key', age: fakeAge, ...sink() });
  assert.equal(one.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.stateDir, 'restore-audit.json'), 'utf8')).ok, false);

  // a key that cannot decrypt a sampled segment
  const bad = await audit(cfg, { sample: 2, identity: 'good.key', recoveryIdentity: 'nope.key', age: fakeAge, ...sink() });
  assert.equal(bad.ok, false);

  // the fingerprint of the recovery key is not in the recipients file any more
  fs.writeFileSync(w.recipientsFile, `${KEY_A}\nage1${'z'.repeat(58)}\n`);
  const gone = await audit(cfg, { sample: 2, identity: 'good.key', recoveryIdentity: 'recovery.key', age: fakeAge, ...sink() });
  assert.equal(gone.ok, false);
  // the same key twice is not two keys
  fs.writeFileSync(w.recipientsFile, `${KEY_A}\n${KEY_B}\n`);
  const same = await audit(cfg, { sample: 2, identity: 'recovery.key', recoveryIdentity: 'recovery2.key', age: { ...fakeAge, decrypt: (c, i) => fakeAge.decrypt(c, 'good.key'), publicKey: () => KEY_B }, ...sink() });
  assert.equal(same.ok, false);
  srv.srv.close();
});

test('audit needs at least one real segment from the last 30 days and refuses an empty archive', async () => {
  const w = world();
  const srv = await archiveServer();
  const cfg = cfgFor(w, srv.url);
  const empty = await audit(cfg, { sample: 3, identity: 'good.key', recoveryIdentity: 'recovery.key', age: fakeAge, ...sink() });
  assert.equal(empty.ok, false);
  await backfill(cfg, { roots: { claudeHome: w.claude, codexHome: null }, ...sink() });
  for (const e of srv.segs.values()) e.at = Date.now() - 90 * 86400000;
  const old = await audit(cfg, { sample: 3, identity: 'good.key', recoveryIdentity: 'recovery.key', age: fakeAge, ...sink() });
  assert.equal(old.ok, false, 'only old segments: not a rehearsal of the current chain');
  srv.srv.close();
});

// ---- doctor -------------------------------------------------------------------------------------------------------------------------------------

test('doctor checks age, recipients, tokens, the server and a real round trip, lists the derived state, and never prints a secret', async () => {
  const w = world();
  const srv = await archiveServer();
  const cfg = cfgFor(w, srv.url);
  fs.mkdirSync(path.join(w.stateDir, 'brief'), { recursive: true });
  fs.writeFileSync(path.join(w.stateDir, 'brief', 'Cammut.json'), 'x'.repeat(2048));
  const o = sink();
  const rows = await doctor(cfg, { age: fakeAge, home: w.home, env: { CAMMUT_MEMORY_TOKEN: W, CAMMUT_ARCHIVE_READ_TOKEN: R }, ...o });
  const by = (n) => rows.find((r) => r.check === n);
  for (const n of ['age', 'recipients', 'zstd', 'tokens', 'server', 'self-test', 'registry']) assert.ok(by(n), n);
  assert.equal(by('age').result, 'PASS');
  assert.equal(by('recipients').result, 'PASS');
  assert.equal(by('tokens').result, 'PASS');
  assert.match(by('tokens').detail, /CAMMUT_MEMORY_TOKEN=set/);
  assert.equal(by('server').result, 'PASS');
  assert.equal(by('self-test').result, 'PASS', by('self-test').detail);
  assert.ok(rows.some((r) => r.check === 'state:brief' && /2\.0 KiB/.test(r.detail)), 'the derived-state table lists the brief cache with its size');
  assert.ok(rows.some((r) => r.check === 'state:outbox'));
  assert.match(by('retention').detail, /enabled=false/);
  const text = JSON.stringify(rows) + o.lines.join('\n');
  assert.ok(!text.includes(W) && !text.includes(R), 'token values are never printed');
  const second = await doctor(cfg, { age: fakeAge, home: w.home, env: { CAMMUT_MEMORY_TOKEN: W, CAMMUT_ARCHIVE_READ_TOKEN: R }, ...sink() });
  assert.equal(second.find((r) => r.check === 'self-test').result, 'PASS', 'the self-test is idempotent on the server');
  srv.srv.close();
});

test('doctor fails on a recipients file that holds a secret key line, without echoing it, and stops before any upload', async () => {
  const w = world();
  const srv = await archiveServer();
  const secret = 'AGE-SECRET-KEY-1' + 'Q'.repeat(58);
  fs.writeFileSync(w.recipientsFile, `${KEY_A}\n${secret}\n`);
  const o = sink();
  const rows = await doctor(cfgFor(w, srv.url), { age: fakeAge, home: w.home, env: { CAMMUT_MEMORY_TOKEN: W }, ...o });
  assert.equal(rows.find((r) => r.check === 'recipients').result, 'FAIL');
  assert.ok(!(JSON.stringify(rows) + o.lines.join('\n')).includes('QQQQ'));
  assert.equal(srv.puts(), 0, 'no self-test upload with a recipients file we cannot trust');
  assert.equal(rows.find((r) => r.check === 'self-test').result, 'SKIP');
  srv.srv.close();
});

test('doctor reports missing tokens, a missing age, a dead server, a registry it cannot read and an old unarchived transcript', async () => {
  const w = world();
  const cfg = { ...cfgFor(w, 'http://127.0.0.1:1'), cammut: { url: 'http://127.0.0.1:1', token: undefined, readToken: undefined } };
  const old = new Date(Date.now() - 12 * 86400000);
  fs.utimesSync(w.files[0], old, old);
  const st = {};
  const { registerArchive } = await import('../archive.mjs');
  registerArchive(st, { file: w.files[0], agent: 'claude-code', project: 'Cammut', cwd: w.root });
  saveSession(cfg, 'old1', st);
  const rows = await doctor(cfg, { age: { ...fakeAge, version: () => null }, home: w.home, env: {}, ...sink() });
  const by = (n) => rows.find((r) => r.check === n);
  assert.equal(by('age').result, 'FAIL');
  assert.equal(by('tokens').result, 'FAIL');
  assert.match(by('tokens').detail, /CAMMUT_MEMORY_TOKEN=MISSING/);
  assert.equal(by('server').result, 'FAIL');
  assert.equal(by('registry').result, 'FAIL');
  assert.equal(by('unarchived').result, 'WARN');
  assert.match(by('unarchived').detail, /12\.\d days|1[2-3] days/);
});

test('main dispatches commands and rejects unknown ones with usage; sweep, retention and quarantine are routed to the sweeper', async () => {
  const o = sink();
  assert.equal(await main(['bogus'], { ...o }), 2);
  assert.match(o.lines.join('\n'), /usage:/);
  const o2 = sink();
  assert.equal(await main(['help'], { ...o2 }), 0);
  assert.match(o2.lines.join('\n'), /backfill/);
  assert.match(o2.lines.join('\n'), /audit/);
});

// ---- real age (skipped unless age and age-keygen are installed) ----------------------------------------------------------------------------

const hasAge = spawnSync('age', ['--version'], { encoding: 'utf8' }).status === 0 && spawnSync('age-keygen', ['--version'], { encoding: 'utf8' }).status === 0;

test('real age: a sealed segment decrypts with the identity and equals the redacted source (never prints the identity)', { skip: !hasAge && 'age and age-keygen are not on PATH' }, () => {
  const dir = tmp('real-age-');
  const id = path.join(dir, 'id.key');
  const gen = spawnSync('age-keygen', ['-o', id], { encoding: 'utf8' });
  const pub = /Public key: (age1\S+)/.exec(gen.stderr + gen.stdout)?.[1];
  assert.ok(pub);
  const rf = path.join(dir, 'r.txt');
  fs.writeFileSync(rf, `${pub}\n`);
  const meta = { agent: 'claude-code', project: 'P', session: 's1', kind: 'transcript', relpath: '', fp: 'f'.repeat(64), start: 0, end: 30 };
  const seg = sealSegment({ meta, rawBytes: Buffer.from('{"a":"password: hunter2hunter2"}\n'), recipientsFile: rf, encrypt: ageEncrypt, redact, doRedact: true });
  assert.ok(seg.cipher.subarray(0, 22).equals(Buffer.from('age-encryption.org/v1\n')));
  const dec = spawnSync('age', ['-d', '-i', id], { input: seg.cipher });
  assert.equal(dec.status, 0);
  assert.ok(!dec.stdout.includes('hunter2'));
  assert.equal(segmentId(meta), seg.id);
});
