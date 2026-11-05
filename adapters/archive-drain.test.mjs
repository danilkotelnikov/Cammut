// The drain's archive step: cutting from the cursor, sealing into the ciphertext outbox, the acknowledged upload and its
// failure modes. Temp directories and fake servers only; the transcripts are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  registerArchive, archiveStep, uploadOutbox, archiveStatus, outboxList, outboxPatch, fingerprint, sha256Hex, segmentId,
} from './archive.mjs';
import { saveSession, loadSession, sessionsDir } from './common.mjs';
import { fakeServer, fakeEncrypt, tmp, line } from './test-helpers.mjs';

const KEY = 'age1' + 'q'.repeat(58);
const ROWS = Array.from({ length: 7 }, (_, i) => line({ type: i % 2 ? 'assistant' : 'user', message: { role: i % 2 ? 'assistant' : 'user', content: `row ${i} ${'x'.repeat(70)}` } }));
const CONTENT = ROWS.join('');
const SID = '0a1b2c3d-1111-2222-3333-444455556666';

// a project dir, a transcript, a registered session state and a cfg whose Cammut is `url`
function setup({ content = CONTENT, url = 'http://127.0.0.1:1', over = {}, cwdMarker = false } = {}) {
  const root = tmp('arch-');
  const stateDir = path.join(root, 'state');
  const proj = path.join(root, 'work', 'Cammut');
  fs.mkdirSync(proj, { recursive: true });
  if (cwdMarker) fs.writeFileSync(path.join(proj, '.no-memory'), '');
  const tdir = path.join(root, 'projects', 'p1');
  fs.mkdirSync(tdir, { recursive: true });
  const file = path.join(tdir, `${SID}.jsonl`);
  fs.writeFileSync(file, content);
  const recipientsFile = path.join(root, 'recipients.txt');
  fs.writeFileSync(recipientsFile, `${KEY}\n`);
  const cfg = {
    stateDir, requestMs: 2000, encrypt: fakeEncrypt,
    cammut: { url, token: 'cmt_t' },
    archive: { enabled: true, recipientsFile, segmentBytes: 250, flushIdleMs: 600000, redact: true, outboxMaxBytes: 1 << 20, ...over },
  };
  const st = {};
  registerArchive(st, { file, agent: 'claude-code', project: 'Cammut', cwd: proj });
  saveSession(cfg, 'sess1', st);
  return { root, cfg, file, proj, tdir, state: () => loadSession(cfg, 'sess1') };
}

const acceptAll = () => fakeServer((c) => (c.method === 'PUT' ? { status: 201, json: { created: true, sha256: c.headers['x-content-sha256'], bytes: c.raw.length, recipients_changed: false } } : { status: 404, json: {} }));

test('archiveStep cuts from the cursor into the ciphertext outbox, never re-queues an id, and holds the tail until flush', async () => {
  const s = setup();
  const r1 = await archiveStep(s.cfg, { now: Date.now() });
  assert.ok(r1.sealed >= 2);
  const e = outboxList(s.cfg);
  assert.equal(e.length, r1.sealed);
  const size = fs.statSync(s.file).size;
  assert.ok(e.at(-1).meta.end < size, 'the short tail waits');
  assert.equal(e[0].meta.start, 0);
  for (let i = 1; i < e.length; i++) assert.equal(e[i].meta.start, e[i - 1].meta.end);
  for (const x of e) {
    assert.match(x.id, /^[0-9a-f]{32}$/);
    assert.equal(x.id, segmentId(x.meta));
    assert.equal(x.meta.fp, fingerprint(s.file));
    assert.equal(x.meta.session, SID);
    assert.equal(x.meta.project, 'Cammut');
    assert.equal(sha256Hex(fs.readFileSync(x.file)), x.sha256);
    assert.ok(!fs.readFileSync(x.file, 'latin1').includes('row 0'), 'ciphertext only');
  }
  assert.equal((await archiveStep(s.cfg, { now: Date.now() })).sealed, 0, 'ids already queued are skipped');
  const st = s.state(); st.arch.flush = true; saveSession(s.cfg, 'sess1', st);
  const r3 = await archiveStep(s.cfg, { now: Date.now() });
  assert.equal(r3.sealed, 1);
  assert.equal(outboxList(s.cfg).at(-1).meta.end, size);
  assert.equal(s.state().arch.flush, false, 'the flush request is consumed once everything is queued');
});

test('the idle rule cuts the tail without a flush', async () => {
  const s = setup();
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  assert.equal(outboxList(s.cfg).at(-1).meta.end, fs.statSync(s.file).size);
});

test('uploadOutbox sends the wire metadata, the ciphertext sha and the recipient fingerprints; the server sha is what gets recorded', async () => {
  const cm = await acceptAll();
  const s = setup({ url: cm.url });
  s.cfg.archive.enabled = true;
  const st0 = s.state(); st0.arch.flush = true; saveSession(s.cfg, 'sess1', st0);
  await archiveStep(s.cfg, { now: Date.now() });
  const queued = outboxList(s.cfg);
  const r = await uploadOutbox(s.cfg);
  assert.equal(r.acked, queued.length);
  assert.deepEqual(outboxList(s.cfg), []);
  const put = cm.calls[0];
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, `/v1/archive/segments/${queued[0].id}`);
  assert.equal(put.headers['x-content-sha256'], queued[0].sha256);
  assert.equal(sha256Hex(put.raw), queued[0].sha256);
  const m = JSON.parse(Buffer.from(put.headers['x-archive-meta'], 'base64url').toString());
  assert.deepEqual([m.agent, m.project, m.session_id, m.kind, m.src_start, m.src_end, m.codec], ['claude-code', 'Cammut', SID, 'transcript', 0, queued[0].meta.end, queued[0].meta.codec]);
  assert.match(m.src_sha256, /^[0-9a-f]{64}$/);
  assert.match(put.headers['x-archive-recipients'], /^[0-9a-f]{16}$/);
  assert.equal(put.auth, 'Bearer cmt_t');
  const st = s.state();
  assert.equal(st.arch.cursor, fs.statSync(s.file).size);
  assert.ok(st.arch.ranges.length === queued.length && st.arch.ranges.every((x) => /^[0-9a-f]{32}$/.test(x.id) && /^[0-9a-f]{64}$/.test(x.src) && x.sha));
  cm.srv.close();
});

test('a 200 created:false answer (the server kept an earlier copy) is an acknowledgement with the SERVER sha', async () => {
  const other = 'e'.repeat(64);
  const cm = await fakeServer(() => ({ status: 200, json: { created: false, sha256: other, matches: false } }));
  const s = setup({ url: cm.url });
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  await uploadOutbox(s.cfg);
  const st = s.state();
  assert.ok(st.arch.ranges.length >= 1 && st.arch.ranges.every((r) => r.sha === other));
  assert.deepEqual(outboxList(s.cfg), []);
  cm.srv.close();
});

test('409 content_mismatch: the range changed since it was archived, it is marked changed, never acknowledged, and the cursor moves past it', async () => {
  let n = 0;
  const cm = await fakeServer((c) => (++n === 2 ? { status: 409, json: { error: 'content_mismatch' } } : { status: 201, json: { created: true, sha256: c.headers['x-content-sha256'] } }));
  const s = setup({ url: cm.url });
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  const q = outboxList(s.cfg);
  assert.ok(q.length >= 3);
  const r = await uploadOutbox(s.cfg);
  assert.equal(r.changed, 1);
  const st = s.state();
  assert.deepEqual(st.arch.changed, [{ start: q[1].meta.start, end: q[1].meta.end }]);
  assert.ok(!st.arch.ranges.some((x) => x.id === q[1].id), 'a refused range is never recorded as archived');
  assert.equal(st.arch.cursor, fs.statSync(s.file).size);
  assert.deepEqual(outboxList(s.cfg), [], 'the entry is dropped: retrying would only be refused again');
  cm.srv.close();
});

test('another 4xx keeps the segment, counts attempts and marks it failed after 5; it is never dropped and never retried again', async () => {
  const cm = await fakeServer(() => ({ status: 415, json: { error: 'not_age' } }));
  const s = setup({ url: cm.url });
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  const total = outboxList(s.cfg).length;
  for (let i = 0; i < 5; i++) await uploadOutbox(s.cfg);
  const list = outboxList(s.cfg);
  assert.equal(list.length, total, 'nothing is dropped');
  assert.ok(list.every((e) => e.failed === true && e.attempts >= 5));
  const calls = cm.calls.length;
  await uploadOutbox(s.cfg);
  assert.equal(cm.calls.length, calls, 'failed segments are not retried');
  assert.equal(s.state().arch.ranges.length, 0);
  assert.equal(archiveStatus(s.cfg, Date.now()).outbox.failed, total);
  cm.srv.close();
});

test('429 and 5xx stop the pass, keep every segment, count no attempt and open the breaker', async () => {
  const cm = await fakeServer(() => ({ status: 503, json: {} }));
  const s = setup({ url: cm.url });
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  const total = outboxList(s.cfg).length;
  const r = await uploadOutbox(s.cfg);
  assert.equal(r.retry, true);
  assert.equal(cm.calls.length, 1, 'the pass stops at the first retryable failure');
  assert.equal(outboxList(s.cfg).length, total);
  assert.ok(outboxList(s.cfg).every((e) => e.attempts === 0 && !e.failed));
  const again = await uploadOutbox(s.cfg);
  assert.equal(again.retry, true);
  assert.equal(cm.calls.length, 1, 'the breaker keeps the next drain from calling a server that just failed');
  cm.srv.close();
});

test('F7: rewritten generations retain pending ciphertext, upload oldest first and isolate late acknowledgements', async () => {
  const cm = await acceptAll();
  const s = setup({ url: cm.url });
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  const oldQueue = outboxList(s.cfg);
  const oldFp = fingerprint(s.file);
  fs.writeFileSync(s.file, line({ type: 'user', message: { role: 'user', content: 'a completely different file ' + 'z'.repeat(1200) } }) + CONTENT);
  assert.notEqual(fingerprint(s.file), oldFp);
  const r = await archiveStep(s.cfg, { now: Date.now() + 700000 });
  assert.ok(r.sealed >= 1);
  const q = outboxList(s.cfg);
  assert.ok(oldQueue.every((o) => q.some((e) => e.id === o.id)), 'every pending old-generation ciphertext survives');
  for (const old of oldQueue) assert.ok(fs.existsSync(old.file));
  assert.equal(s.state().arch.fp, fingerprint(s.file));
  assert.equal(s.state().arch.cursor, 0);
  const uploads = [];
  await uploadOutbox(s.cfg, { client: { request: async (method, url, opts) => {
    const meta = JSON.parse(Buffer.from(opts.headers['X-Archive-Meta'], 'base64url').toString());
    uploads.push(meta.fp);
    if (meta.fp === oldFp) {
      assert.equal(s.state().arch.cursor, 0, 'old acknowledgements never advance the current generation');
      assert.equal(s.state().arch.ranges.length, 0);
    }
    return { status: 201, json: { sha256: opts.headers['X-Content-SHA256'] } };
  } } });
  assert.deepEqual(uploads.slice(0, oldQueue.length), oldQueue.map(() => oldFp));
  assert.equal(s.state().arch.cursor, fs.statSync(s.file).size);
  assert.ok(s.state().arch.ranges.every((r) => !oldQueue.some((o) => o.id === r.id)));
  assert.equal(outboxList(s.cfg).length, 0);
  cm.srv.close();
});

test('a truncated file also resets the cursor', async () => {
  const s = setup();
  const st = s.state(); st.arch.cursor = 99999; st.arch.fp = fingerprint(s.file); saveSession(s.cfg, 'sess1', st);
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  assert.equal(s.state().arch.cursor, 0);
  assert.ok(outboxList(s.cfg).length >= 1);
});

test('F7: pending generation order survives equal creation timestamps', async () => {
  const s = setup();
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  const oldFp = fingerprint(s.file);
  for (let i = 0; ; i++) {
    fs.writeFileSync(s.file, line({ type: 'user', message: { content: `different ${i} ` + 'z'.repeat(1200) } }) + CONTENT);
    if (fingerprint(s.file) < oldFp) break; // ensure a fingerprint sort would put the new generation first
  }
  await archiveStep(s.cfg, { now: Date.now() + 700000 });
  for (const e of outboxList(s.cfg)) outboxPatch(s.cfg, e.id, { createdAt: 1 });
  const uploaded = [];
  await uploadOutbox(s.cfg, { client: { request: async (method, url, opts) => {
    uploaded.push(JSON.parse(Buffer.from(opts.headers['X-Archive-Meta'], 'base64url').toString()).fp);
    return { status: 201, json: { sha256: opts.headers['X-Content-SHA256'] } };
  } } });
  const firstNew = uploaded.findIndex((fp) => fp !== oldFp);
  assert.ok(firstNew > 0 && uploaded.slice(firstNew).every((fp) => fp !== oldFp));
});

test('nothing is archived when the archive is disabled, when .no-memory covers the session, or when the transcript is gone', async () => {
  const off = setup({ over: { enabled: false } });
  assert.equal((await archiveStep(off.cfg, { now: Date.now() + 700000 })).sealed, 0);
  const marked = setup({ cwdMarker: true });
  assert.equal((await archiveStep(marked.cfg, { now: Date.now() + 700000 })).sealed, 0);
  const gone = setup();
  fs.rmSync(gone.file);
  assert.equal((await archiveStep(gone.cfg, { now: Date.now() + 700000 })).sealed, 0);
  assert.deepEqual(outboxList(off.cfg).concat(outboxList(marked.cfg), outboxList(gone.cfg)), []);
});

test('SHARED_MEMORY_BYPASS in the drain environment also stops sealing', async () => {
  const s = setup();
  const old = process.env.SHARED_MEMORY_BYPASS;
  process.env.SHARED_MEMORY_BYPASS = '1';
  try { assert.equal((await archiveStep(s.cfg, { now: Date.now() + 700000 })).sealed, 0); } finally { if (old === undefined) delete process.env.SHARED_MEMORY_BYPASS; else process.env.SHARED_MEMORY_BYPASS = old; }
});

test('subagent files are archived whole as sidecars, only after a flush or ten idle minutes, and their acks are kept apart', async () => {
  const cm = await acceptAll();
  const s = setup({ url: cm.url });
  const sub = path.join(s.tdir, SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const sc = line({ type: 'assistant', message: { content: 'sidecar row ' + 'y'.repeat(50) } }).repeat(2);
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), sc);
  fs.mkdirSync(path.join(s.tdir, SID, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(s.tdir, SID, 'tool-results', 'big.txt'), 'x'.repeat(5000));
  await archiveStep(s.cfg, { now: Date.now() });
  assert.ok(outboxList(s.cfg).every((e) => e.meta.kind === 'transcript'), 'a live session\'s sidecars wait');
  const st = s.state(); st.arch.flush = true; saveSession(s.cfg, 'sess1', st);
  await archiveStep(s.cfg, { now: Date.now() });
  const car = outboxList(s.cfg).filter((e) => e.meta.kind === 'sidecar');
  assert.deepEqual(car.map((e) => [e.meta.relpath, e.meta.start, e.meta.end]), [['subagents/agent-a1.jsonl', 0, Buffer.byteLength(sc)]]);
  assert.ok(!outboxList(s.cfg).some((e) => /tool-results|big\.txt/.test(JSON.stringify(e.meta))), 'tool-results and file-history are not archived');
  await uploadOutbox(s.cfg);
  const after = s.state();
  assert.equal(after.arch.sidecars['subagents/agent-a1.jsonl'].cursor, Buffer.byteLength(sc));
  assert.equal(after.arch.cursor, fs.statSync(s.file).size);
  cm.srv.close();
});

test('the outbox cap stops sealing and leaves the source alone', async () => {
  const s = setup({ over: { outboxMaxBytes: 700 } });
  const before = fs.readFileSync(s.file);
  const r = await archiveStep(s.cfg, { now: Date.now() + 700000 });
  assert.equal(r.capped, true);
  assert.ok(outboxList(s.cfg).length >= 1 && outboxList(s.cfg).length < 7);
  assert.ok(fs.readFileSync(s.file).equals(before));
});

test('a failing encryptor leaves no segment, no state change, and an error that never carries session text', async () => {
  const s = setup();
  s.cfg.encrypt = () => { throw new Error('age exited with status 1'); };
  const r = await archiveStep(s.cfg, { now: Date.now() + 700000 });
  assert.equal(r.sealed, 0);
  assert.ok(r.errors >= 1);
  assert.deepEqual(outboxList(s.cfg), []);
  const log = fs.readFileSync(path.join(s.cfg.stateDir, 'hook.log'), 'utf8');
  assert.match(log, /archive seal failed/);
  assert.ok(!log.includes('row 0'));
});

test('session states of vanished transcripts are pruned after three days, younger ones stay', async () => {
  const s = setup();
  fs.rmSync(s.file);
  await archiveStep(s.cfg, { now: Date.now() });
  assert.ok(fs.existsSync(path.join(sessionsDir(s.cfg), 'sess1.json')), 'a fresh state stays');
  const f = path.join(sessionsDir(s.cfg), 'sess1.json');
  const old = new Date(Date.now() - 4 * 86400000);
  fs.utimesSync(f, old, old);
  const r = await archiveStep(s.cfg, { now: Date.now() });
  assert.equal(r.pruned, 1);
  assert.ok(!fs.existsSync(f));
});

test('archiveStatus reports the outbox, the acknowledged ranges and the age of the oldest unarchived transcript', async () => {
  const cm = await acceptAll();
  const s = setup({ url: cm.url });
  const old = new Date(Date.now() - 3 * 3600000);
  fs.utimesSync(s.file, old, old);
  await archiveStep(s.cfg, { now: Date.now() });
  const a = archiveStatus(s.cfg, Date.now());
  assert.equal(a.enabled, true);
  assert.ok(a.outbox.count >= 1 && a.outbox.bytes > 0);
  assert.equal(a.ackedRanges, 0);
  assert.ok(a.oldestUnarchivedMs >= 3 * 3600000 - 1000);
  await uploadOutbox(s.cfg);
  const b = archiveStatus(s.cfg, Date.now());
  assert.ok(b.ackedRanges >= 1);
  cm.srv.close();
});
