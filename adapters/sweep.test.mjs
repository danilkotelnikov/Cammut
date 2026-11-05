import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  decideDeletion, verifyRanges, preflight, quarantineFile, purgeQuarantine, sweepFile, evaluateFile, statOf, loadRunning,
  listCandidates, minimalCover, quarantineList, quarantineRestore, isReviewed, runSweep, retentionEnable, retentionDisable, sweepMain,
} from './sweep.mjs';
import { fingerprint } from './archive.mjs';
import { saveSession } from './common.mjs';
import { tmp } from './test-helpers.mjs';
import { spoolRefsFor } from './sweep.mjs';

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 20);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ackFor = (content, cuts) => cuts.map(([start, end], i) => ({ start, end, id: String(i).padStart(32, '0'), src: sha(Buffer.from(content).subarray(start, end)) }));

test('coverage is bound to THESE BYTES: a same-length rewrite, a rewritten middle, a truncation and an append all make the file un-deletable', () => {
  const dir = tmp();
  const f = path.join(dir, 't.jsonl');
  const content = 'aaaa\nbbbb\ncccc\n';
  fs.writeFileSync(f, content);
  const acked = ackFor(content, [[0, 5], [5, 10], [10, 15]]);
  assert.equal(verifyRanges(f, acked).ok, true);

  fs.writeFileSync(f, 'aaaa\nbXbb\ncccc\n'); // same length, middle rewritten
  let r = verifyRanges(f, acked);
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches.map((m) => m.start), [5], 'only the rewritten range mismatches, and it is named');
  assert.ok(r.reasons.includes('content-mismatch'));

  fs.writeFileSync(f, content.slice(0, 12)); // truncated
  assert.ok(verifyRanges(f, acked).reasons.includes('not-covered'));

  fs.writeFileSync(f, content + 'dddd\n'); // appended after coverage
  r = verifyRanges(f, acked);
  assert.ok(r.reasons.includes('not-covered') && r.ok === false);

  fs.writeFileSync(f, content);
  assert.ok(verifyRanges(f, acked.filter((a) => a.start !== 5)).reasons.includes('not-covered'), 'a gap in the ranges');

  const lastOnlyHonest = ackFor(content, [[0, 5], [5, 10], [10, 15]]);
  lastOnlyHonest[0].src = sha('forged'); // the FIRST range was altered, the last is fine: every range is checked
  assert.ok(verifyRanges(f, lastOnlyHonest).reasons.includes('content-mismatch'));
});

test('verifyRanges: overlapping ranges are fine, an empty list covers nothing, a different file generation is named, the whole-file hash is returned', () => {
  const dir = tmp();
  const f = path.join(dir, 't.jsonl');
  const content = 'aaaa\nbbbb\ncccc\n'.repeat(300);
  fs.writeFileSync(f, content);
  const size = Buffer.byteLength(content);
  const acked = ackFor(content, [[0, 2000], [1500, 3500], [3000, size]]);
  const ok = verifyRanges(f, acked, { fp: fingerprint(f) });
  assert.deepEqual([ok.ok, ok.size, ok.wholeHash, ok.reasons], [true, size, sha(content), []]);
  assert.ok(verifyRanges(f, []).reasons.includes('not-covered'));
  assert.ok(verifyRanges(f, acked, { fp: 'e'.repeat(64) }).reasons.includes('generation-changed'));
  const beyond = ackFor(content, [[0, size]]);
  beyond.push({ start: 10, end: size + 50, id: 'x'.repeat(32), src: sha('anything') });
  const b = verifyRanges(f, beyond);
  assert.ok(b.reasons.includes('not-covered'), 'a range that ends beyond the file means the file was truncated');
  assert.ok(verifyRanges(path.join(dir, 'missing'), acked).reasons.includes('not-covered'));
});

const good = () => ({ path: 'C:/Users/u/.claude/projects/p/a.jsonl', rootOk: true, isLink: false, size: 5000, agent: 'claude-code',
  verify: { ok: true, reasons: [] }, headOk: true, allReplicated: true, auditedRecipients: true, spoolRefs: 0, sessionRunning: false, handleOpen: false,
  mtimeMs: NOW - 5 * DAY, mtimeMs2: NOW - 5 * DAY, size2: 5000, lastActivityMs: NOW - 5 * DAY });
const ctx = { now: NOW, retentionDays: 3, quietMs: 60 * 60000 };

test('every single failed precondition refuses, and says why', () => {
  assert.deepEqual(decideDeletion(good(), ctx), { ok: true, reasons: [] });
  const cases = {
    'outside-roots': { rootOk: false }, link: { isLink: true }, empty: { size: 0 },
    'not-covered': { verify: { ok: false, reasons: ['not-covered'] } },
    'content-mismatch': { verify: { ok: false, reasons: ['content-mismatch'] } },
    'generation-changed': { verify: { ok: false, reasons: ['generation-changed'] } },
    unverified: { headOk: false }, 'not-replicated': { allReplicated: false }, 'unaudited-recipients': { auditedRecipients: false },
    'spool-reference': { spoolRefs: 1 }, 'session-running': { sessionRunning: true },
    'not-quiet': { mtimeMs: NOW - 10 * 60000, mtimeMs2: NOW - 10 * 60000 },
    unstable: { size2: 5001 }, 'handle-open': { handleOpen: true },
    'retention-not-elapsed': { lastActivityMs: NOW - 2 * DAY },
  };
  for (const [reason, patch] of Object.entries(cases)) {
    const r = decideDeletion({ ...good(), ...patch }, ctx);
    assert.equal(r.ok, false, reason);
    assert.ok(r.reasons.includes(reason), `${reason} in ${r.reasons}`);
  }
  assert.equal(decideDeletion({ ...good(), handleOpen: null }, ctx).ok, true, 'an undetectable handle does not block; the quiet period and the stability check are the guard');
  const codex = decideDeletion({ ...good(), agent: 'codex', mtimeMs: NOW - 5 * 3600000, mtimeMs2: NOW - 5 * 3600000 }, { ...ctx, quietMs: 24 * 3600000 });
  assert.ok(codex.reasons.includes('not-quiet'), 'Codex needs the 24 h quiet period');
});

test('decideDeletion fails closed: a missing or malformed input is a refusal, never a pass', () => {
  for (const key of ['rootOk', 'isLink', 'size', 'verify', 'headOk', 'allReplicated', 'auditedRecipients', 'spoolRefs', 'sessionRunning', 'mtimeMs', 'mtimeMs2', 'size2', 'lastActivityMs']) {
    const c = good(); delete c[key];
    assert.equal(decideDeletion(c, ctx).ok, false, `without ${key}`);
  }
  assert.equal(decideDeletion({ ...good(), mtimeMs: NaN, mtimeMs2: NaN }, ctx).ok, false);
  assert.equal(decideDeletion({ ...good(), verify: { ok: false, reasons: [] } }, ctx).ok, false, 'a failed verification without a named reason still refuses');
  assert.equal(decideDeletion({ ...good(), lastActivityMs: NOW - 3 * DAY }, ctx).ok, true, 'exactly the retention period is enough');
  assert.equal(decideDeletion({ ...good(), lastActivityMs: NOW - 5 * DAY }, { ...ctx, retentionDays: 0 }).ok, true, '0 days: as soon as verified and quiet');
  const several = decideDeletion({ ...good(), isLink: true, headOk: false, spoolRefs: 2 }, ctx);
  assert.deepEqual(several.reasons.sort(), ['link', 'spool-reference', 'unverified']);
});

const base = () => ({
  now: NOW, reviewed: true,
  status: { replica: { last_run_at: NOW - 3600000, replicated: 10, unreplicated: 0 } },
  audit: { at: NOW - 10 * DAY, ok: true, daily_fp: 'aaaaaaaaaaaaaaaa', recovery_fp: 'bbbbbbbbbbbbbbbb' },
  recipientFps: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'], dryRun: { at: NOW - DAY }, registryReadable: true, enabled: true,
});

test('the sweeper refuses to run without a verified replica, a fresh two-key restore audit, a read dry run and a review', () => {
  assert.deepEqual(preflight(base(), NOW), { ok: true, reasons: [] });
  const no = (patch) => preflight({ ...base(), ...patch }, NOW).reasons;
  assert.deepEqual(no({ status: { replica: null } }), ['no-replica']);
  assert.deepEqual(no({ status: { replica: { last_run_at: NOW - 40 * 3600000 } } }), ['replica-stale']);
  assert.deepEqual(no({ audit: null }), ['no-restore-audit']);
  assert.deepEqual(no({ audit: { ...base().audit, at: NOW - 100 * DAY } }), ['restore-audit-stale']);
  assert.deepEqual(no({ audit: { ...base().audit, ok: false } }), ['no-restore-audit']);
  assert.deepEqual(no({ recipientFps: ['aaaaaaaaaaaaaaaa'] }), ['restore-audit-keys'], 'the recovery key is no longer a recipient');
  assert.deepEqual(no({ recipientFps: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'] }), ['restore-audit-keys'], 'a recipient was added after the audit');
  assert.deepEqual(no({ dryRun: null }), ['dry-run-not-read']);
  assert.deepEqual(no({ dryRun: { at: NOW - 8 * DAY } }), ['dry-run-not-read']);
  assert.deepEqual(no({ registryReadable: false }), ['registry-unreadable']);
  assert.deepEqual(no({ enabled: false }), ['retention-disabled']);
  assert.deepEqual(no({ reviewed: false }), ['not-reviewed']);
});

test('preflight: an unreachable server, an RFC3339 replica time, an audited full recipient set, and several reasons at once', () => {
  assert.deepEqual(no2({ status: null }), ['server-unreachable']);
  assert.deepEqual(no2({ status: { replica: { last_run_at: new Date(NOW - 3600000).toISOString() } } }), []);
  assert.deepEqual(no2({ status: { replica: { last_run_at: new Date(NOW - 50 * 3600000).toISOString() } } }), ['replica-stale']);
  assert.deepEqual(no2({ status: { replica: { last_run_at: 'not a date' } } }), ['replica-stale'], 'an unreadable time is stale, not fresh');
  const three = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
  assert.deepEqual(no2({ audit: { ...base().audit, recipients: three }, recipientFps: three }), [], 'the audit lists the whole set it rehearsed');
  assert.deepEqual(no2({ audit: { ...base().audit, recipients: three }, recipientFps: three.slice(0, 2) }), ['restore-audit-keys']);
  assert.deepEqual(no2({ enabled: false, reviewed: false, dryRun: null, audit: null, status: { replica: null } }), ['retention-disabled', 'not-reviewed', 'no-replica', 'no-restore-audit', 'dry-run-not-read']);
  assert.deepEqual(preflight({ ...base(), enabled: false, ignoreEnabled: true }, NOW).reasons, [], 'retention enable evaluates everything except the flag it is about to set');
  assert.deepEqual(preflight({ ...base(), dryRun: { at: new Date(NOW - DAY).toISOString() } }, NOW).reasons, []);
});
function no2(patch) { return preflight({ ...base(), ...patch }, NOW).reasons; }

// ---- the pipeline ------------------------------------------------------------------------------------------

const PERIOD = { quietMinutes: 60, codexQuietMinutes: 1440, settleSeconds: 30, graceHours: 48, localRetentionDays: 3, maxDeletesPerRun: 200, replicaMaxAgeHours: 36, restoreAuditMaxDays: 90 };

// coverage the way the server reports it: the file's real bytes cut into two acknowledged ranges
function covFor(file, { replicated = true, tail = false } = {}) {
  const buf = fs.readFileSync(file);
  const n = buf.length;
  const mid = Math.max(1, n >> 1);
  const segs = [[0, mid], [mid, n]].filter(([a, b]) => b > a).map(([start, end], i) => ({ id: sha(`${file}${start}`).slice(0, 32), start, end, src_sha256: sha(buf.subarray(start, end)), sha256: sha(`cipher${i}`), replicated: Array.isArray(replicated) ? replicated[i] : replicated, recipients: base().recipientFps }));
  if (tail) segs.push({ id: sha(`${file}tail`).slice(0, 32), start: n, end: n + 10, src_sha256: sha('beyond'), sha256: sha('c'), replicated: false });
  return { fp: fingerprint(file), ranges: [[0, n]], contiguous_to: n, segments: segs.length, segs };
}

// one file through the exported pipeline with fake server answers; hooks are the injection points of the tests
async function sweepOne(f, home, hooks = {}) {
  const old = new Date(NOW - 5 * DAY);
  fs.utimesSync(f, old, old);
  const sessions = path.join(home, 'sessions');
  fs.rmSync(sessions, { recursive: true, force: true });
  fs.mkdirSync(sessions, { recursive: true });
  if (hooks.registry !== undefined) fs.writeFileSync(path.join(sessions, 'x.json'), hooks.registry);
  for (const id of hooks.running || []) fs.writeFileSync(path.join(sessions, `${id}.json`), JSON.stringify({ sessionId: id, pid: 1 }));
  return sweepFile(f, {
    cfg: { stateDir: path.join(home, 'state') },
    agent: 'claude-code', home, now: NOW, retention: PERIOD, apply: true, settle: async () => {},
    nameOk: () => true, running: loadRunning(home), spoolRefs: () => 0, handleOpen: () => null, audit: base().audit,
    coverage: async () => (hooks.coverage ? hooks.coverage(f) : covFor(f, { replicated: hooks.replicated ?? true })),
    reviewedOverride: hooks.reviewed !== false, beforeRename: hooks.beforeRename, renameFn: hooks.renameFn,
  });
}
const homeWith = () => {
  const dir = tmp();
  const home = path.join(dir, '.claude');
  fs.mkdirSync(path.join(home, 'projects', 'p'), { recursive: true });
  return { dir, home, f: path.join(home, 'projects', 'p', 'a.jsonl') };
};
const grace = (h) => NOW + h * 3600000;

test('F8: spool path aliases protect the same Windows transcript', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'spool'));
  const file = path.join(dir, 'projects', 'a.jsonl');
  const alias = file.replace(/\\/g, '/');
  fs.writeFileSync(path.join(dir, 'spool', '1.json'), JSON.stringify({ file: process.platform === 'win32' ? alias.toUpperCase() : alias }));
  assert.equal(spoolRefsFor({ stateDir: dir })(file), 1);
});

test('a failed spool item still protects its transcript from the sweeper', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'spool', 'failed'), { recursive: true });
  const file = path.join(dir, 'projects', 'a.jsonl');
  fs.writeFileSync(path.join(dir, 'spool', 'failed', '1.json'), JSON.stringify({ kind: 'range', file, status: 'failed' }));
  assert.equal(spoolRefsFor({ stateDir: dir })(file), 1);
  assert.equal(spoolRefsFor({ stateDir: dir })(path.join(dir, 'other.jsonl')), 0);
});

test('F8: every non-ENOENT spool directory error blocks deletion', (t) => {
  const dir = tmp();
  assert.equal(spoolRefsFor({ stateDir: dir })('a.jsonl'), 0, 'an absent spool is empty');
  const read = fs.readdirSync;
  for (const code of ['EACCES', 'EIO', 'ENOTDIR']) {
    t.mock.method(fs, 'readdirSync', (...args) => {
      if (args[0] === path.join(dir, 'spool')) throw Object.assign(new Error('unreadable'), { code });
      return read(...args);
    });
    assert.equal(spoolRefsFor({ stateDir: dir })('a.jsonl'), 1, code);
    t.mock.restoreAll();
  }
});

test('F8: a capture after evaluation is seen immediately before quarantine rename', async () => {
  const e = batchEnv({ files: 1 });
  const refs = spoolRefsFor(e.cfg);
  e.deps.spoolRefs = refs;
  const r = await runSweep({ ...e.deps, apply: true, beforeRename: () => {
    fs.mkdirSync(path.join(e.cfg.stateDir, 'spool'), { recursive: true });
    fs.writeFileSync(path.join(e.cfg.stateDir, 'spool', 'late.json'), JSON.stringify({ file: e.files[0] }));
  } });
  assert.equal(r.results[0].action, 'kept');
  assert.ok(r.results[0].reasons.includes('spool-reference'));
  assert.ok(fs.existsSync(e.files[0]));
});

test('F8: a source guard held by capture prevents quarantine', async () => {
  const e = batchEnv({ files: 1 });
  const canonical = process.platform === 'win32' ? path.resolve(e.files[0]).toLowerCase() : path.resolve(e.files[0]);
  const guard = path.join(e.cfg.stateDir, `source-${sha(canonical)}.lock`);
  fs.writeFileSync(guard, '');
  const r = await runSweep({ ...e.deps, apply: true });
  assert.equal(r.results[0].action, 'kept');
  assert.ok(r.results[0].reasons.includes('capture-busy'));
  assert.ok(fs.existsSync(e.files[0]) && fs.existsSync(guard));
});

test('F5: retired or unknown recipients never protect quarantine bytes', async () => {
  for (const recipients of [[], ['cccccccccccccccc', 'dddddddddddddddd'], ['aaaaaaaaaaaaaaaa']]) {
    const e = batchEnv({ files: 1 });
    const cov = covFor(e.files[0]);
    cov.segs[0].recipients = recipients;
    const r = await runSweep({ ...e.deps, coverage: async () => cov, apply: true });
    assert.equal(r.results[0].action, 'kept');
    assert.ok(r.results[0].reasons.includes('unaudited-recipients'));
    assert.ok(fs.existsSync(e.files[0]));
  }
});

test('F5: purge rechecks both audited recipients on every protecting segment', async () => {
  const e = batchEnv({ files: 1 });
  const cov = covFor(e.files[0]);
  await runSweep({ ...e.deps, coverage: async () => cov, apply: true });
  const q = quarantineList(e.home)[0];
  cov.segs[1].recipients = ['cccccccccccccccc', 'dddddddddddddddd'];
  const r = await runSweep({ ...e.deps, coverage: async () => cov, now: grace(49), status: async () => ({ replica: { last_run_at: grace(48) } }), apply: true });
  assert.equal(r.results.find((x) => x.phase === 2).action, 'kept');
  assert.ok(fs.existsSync(path.join(e.home, '.cammut-quarantine', q.id)));
});

test('F5: a complete audited alternative cover can protect bytes beside retired segments', async () => {
  const e = batchEnv({ files: 1 });
  const cov = covFor(e.files[0]);
  cov.segs.unshift({ ...cov.segs[0], id: 'f'.repeat(32), recipients: [] });
  const r = await runSweep({ ...e.deps, coverage: async () => cov, apply: true });
  assert.equal(r.results[0].action, 'quarantined');
});

test('a replica run that predates the newest segment protects only the files it covered', async () => {
  const { home, f } = homeWith();
  const g = path.join(home, 'projects', 'p', 'b.jsonl');
  fs.writeFileSync(f, 'file A, fully replicated\n');
  fs.writeFileSync(g, 'file B, its newest segment is not replicated yet\n');
  const a = await sweepOne(f, home, {});
  assert.equal(a.action, 'quarantined');
  const b = await sweepOne(g, home, { replicated: [true, false] });
  assert.equal(b.action, 'kept');
  assert.ok(b.reasons.includes('not-replicated'), 'the preflight passed (the replica run is fresh) but this file is not protected');
  assert.ok(fs.existsSync(g) && !fs.existsSync(f));
});

test('only the segments that cover the file need a replica: a superseded, unreplicated tail segment does not block', async () => {
  const segs = [{ id: 'a', start: 0, end: 10, replicated: true }, { id: 'b', start: 10, end: 20, replicated: true }, { id: 'old', start: 10, end: 14, replicated: false }];
  assert.deepEqual(minimalCover(segs, 20).map((s) => s.id), ['a', 'b']);
  assert.deepEqual(minimalCover([{ id: 'x', start: 0, end: 5 }, { id: 'y', start: 6, end: 10 }], 10), null, 'a gap has no cover');
  assert.deepEqual(minimalCover([], 5), null);
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'abcdefghij\nklmnopqrst\n');
  const r = await sweepOne(f, home, { coverage: () => { const c = covFor(f); c.segs.push({ id: 'old'.padEnd(32, '0'), start: 11, end: 14, src_sha256: sha(fs.readFileSync(f).subarray(11, 14)), sha256: sha('o'), replicated: false }); return c; } });
  assert.equal(r.action, 'quarantined', JSON.stringify(r));
});

test('a concurrent append during the sweep aborts that file; an append after quarantine sends it back', async () => {
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'one\ntwo\n');
  // (1) append between the second read and the rename: the final re-stat catches it -> 'unstable', file untouched
  const r1 = await sweepOne(f, home, { beforeRename: () => fs.appendFileSync(f, 'three\n') });
  assert.equal(r1.action, 'kept'); assert.ok(r1.reasons.includes('unstable')); assert.ok(fs.existsSync(f));
  // (2) append AFTER the rename (a writer kept its handle): phase 2 sees a changed quarantined file and restores it
  fs.writeFileSync(f, 'one\ntwo\n');
  const r2 = await sweepOne(f, home, {});
  assert.equal(r2.action, 'quarantined');
  const q = fs.readdirSync(path.join(home, '.cammut-quarantine'), { recursive: true }).find((n) => n.endsWith('a.jsonl'));
  fs.appendFileSync(path.join(home, '.cammut-quarantine', q), 'late write\n');
  const purged = await purgeQuarantine({ home, now: grace(49), preflightOk: true, archiveStillVerifies: () => true, reviewedOverride: true });
  assert.equal(purged[0].action, 'restored');
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('late write\n'), 'nothing a writer wrote after the rename is lost');
  // (3) unchanged -> purged only after the grace period
  fs.writeFileSync(f, 'one\ntwo\n');
  await sweepOne(f, home, {});
  const ok = { preflightOk: true, archiveStillVerifies: () => true, reviewedOverride: true };
  assert.equal((await purgeQuarantine({ home, now: grace(1), ...ok })).length, 0, 'inside the grace period nothing is removed');
  assert.equal((await purgeQuarantine({ home, now: grace(99), ...ok, preflightOk: false })).length, 0, 'preflight is re-checked in phase 2');
  assert.equal((await purgeQuarantine({ home, now: grace(99), ...ok, archiveStillVerifies: () => false }))[0].action, 'kept', 'the archive must still verify');
  assert.ok(fs.readdirSync(path.join(home, '.cammut-quarantine'), { recursive: true }).some((n) => n.endsWith('a.jsonl')), 'still quarantined');
  assert.equal((await purgeQuarantine({ home, now: grace(49), ...ok }))[0].action, 'purged');
  assert.ok(!fs.existsSync(f), 'the original path stays empty after the purge');
  assert.deepEqual(fs.readdirSync(path.join(home, '.cammut-quarantine'), { recursive: true }).filter((n) => n.endsWith('.jsonl') || n.endsWith('.json')), [], 'file and sidecar are gone');
});

test('a file that is open (rename fails) is skipped as in-use; a running session is never touched; an unparsable registry aborts', async () => {
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'x\n');
  for (const code of ['EBUSY', 'EPERM', 'EXDEV', 'EACCES']) {
    const err = Object.assign(new Error(code), { code });
    const r = await sweepOne(f, home, { renameFn: () => { throw err; } });
    assert.equal(r.action, 'skipped'); assert.equal(r.reason, 'in-use'); assert.ok(fs.existsSync(f), code);
  }
  assert.ok((await sweepOne(f, home, { running: [path.basename(f, '.jsonl')] })).reasons.includes('session-running'));
  assert.ok(fs.existsSync(f));
  await assert.rejects(sweepOne(f, home, { registry: 'not json {' }), /registry-unreadable/);
  assert.ok(fs.existsSync(f));
  assert.equal((await sweepOne(f, home, { registry: '{"unrelated": true}' }).catch((e) => e.message)), 'registry-unreadable', 'an entry in an unknown schema aborts too: the sweeper cannot tell who is running');
});

test('a rename error that is not "in use" is thrown, not swallowed', async () => {
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'x\n');
  await assert.rejects(sweepOne(f, home, { renameFn: () => { throw Object.assign(new Error('disk on fire'), { code: 'EIO' }); } }), /disk on fire/);
  assert.ok(fs.existsSync(f));
});

test('the real deletion path refuses without the human review file', async () => {
  const dir = tmp();
  await assert.rejects(quarantineFile(path.join(dir, 'x.jsonl'), {}, { reviewedOverride: false }), /not-reviewed/);
  await assert.rejects(purgeQuarantine({ home: dir, now: NOW, preflightOk: true, archiveStillVerifies: () => true, reviewedOverride: false }), /not-reviewed/);
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'keep me\n');
  await assert.rejects(sweepOne(f, home, { reviewed: false }), /not-reviewed/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'keep me\n');
  assert.ok(!fs.existsSync(path.join(home, '.cammut-quarantine')));
});

test('isReviewed needs a line "reviewed-sha256: <hash of sweep.mjs>" in SWEEPER-REVIEW.md next to it', () => {
  const dir = tmp();
  const code = path.join(dir, 'sweep.mjs'); const review = path.join(dir, 'SWEEPER-REVIEW.md');
  fs.writeFileSync(code, 'export const x = 1;\n');
  assert.equal(isReviewed({ code, review }), false, 'no review file');
  fs.writeFileSync(review, `# review\nreviewed-sha256: ${sha('something else')}\n`);
  assert.equal(isReviewed({ code, review }), false, 'a review of other code');
  fs.writeFileSync(review, `# review\nreviewed-sha256: ${sha(fs.readFileSync(code))}\n`);
  assert.equal(isReviewed({ code, review }), true);
  fs.appendFileSync(code, '// edited after the review\n');
  assert.equal(isReviewed({ code, review }), false, 'any edit of sweep.mjs voids the review');
  assert.equal(isReviewed(), false, 'the repo has no SWEEPER-REVIEW.md: a human creates it');
});

test('the registry reader accepts the known id fields and aborts on anything it cannot understand', () => {
  const { home } = homeWith();
  const s = path.join(home, 'sessions');
  fs.mkdirSync(s, { recursive: true });
  fs.writeFileSync(path.join(s, '1.json'), JSON.stringify({ sessionId: 'aaa', pid: 1 }));
  fs.writeFileSync(path.join(s, '2.json'), JSON.stringify({ session_id: 'bbb' }));
  fs.writeFileSync(path.join(s, '3.json'), JSON.stringify({ id: 'ccc' }));
  fs.writeFileSync(path.join(s, 'notes.txt'), 'ignored');
  assert.deepEqual([...loadRunning(home)].sort(), ['aaa', 'bbb', 'ccc']);
  fs.writeFileSync(path.join(s, '4.json'), '{"truncated":');
  assert.throws(() => loadRunning(home), /registry-unreadable/);
  fs.rmSync(s, { recursive: true });
  assert.throws(() => loadRunning(home), /registry-unreadable/, 'a missing registry directory is not "nobody is running"');
  assert.deepEqual([...loadRunning(home, { optional: true })], [], 'only agents without a registry (Codex) may skip it');
});

test('listCandidates takes top-level Claude transcripts and Codex rollouts only, never subagent files, links or other files', () => {
  const { dir, home } = homeWith();
  const uuid = '0a1b2c3d-1111-2222-3333-444455556666';
  const proj = path.join(home, 'projects', 'p');
  fs.writeFileSync(path.join(proj, `${uuid}.jsonl`), 'x\n');
  fs.writeFileSync(path.join(proj, 'notes.jsonl'), 'x\n');
  fs.writeFileSync(path.join(proj, 'readme.txt'), 'x\n');
  fs.mkdirSync(path.join(proj, uuid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, uuid, 'subagents', `${uuid}.jsonl`), 'x\n');
  fs.writeFileSync(path.join(home, 'projects', `${uuid}.jsonl`), 'x\n'); // not inside a project folder
  const codex = path.join(dir, '.codex');
  fs.mkdirSync(path.join(codex, 'sessions', '2026', '10', '11'), { recursive: true });
  fs.writeFileSync(path.join(codex, 'sessions', '2026', '10', '11', `rollout-2026-10-11T10-00-00-${uuid}.jsonl`), 'x\n');
  fs.writeFileSync(path.join(codex, 'sessions', '2026', '10', '11', 'other.jsonl'), 'x\n');
  const names = (l) => l.map((c) => path.basename(c.file)).sort();
  assert.deepEqual(names(listCandidates({ claudeHome: home, codexHome: codex })), [`${uuid}.jsonl`, `rollout-2026-10-11T10-00-00-${uuid}.jsonl`].sort());
  assert.deepEqual(listCandidates({ claudeHome: home, codexHome: codex }).map((c) => c.agent).sort(), ['claude-code', 'codex']);
  let linked = false;
  try { fs.symlinkSync(path.join(proj, `${uuid}.jsonl`), path.join(proj, '11111111-1111-1111-1111-111111111111.jsonl')); linked = true; } catch { /* no symlink right on this machine */ }
  if (linked) assert.ok(!names(listCandidates({ claudeHome: home, codexHome: null })).includes('11111111-1111-1111-1111-111111111111.jsonl'), 'links are never candidates');
});

test('quarantine list and restore put a file back, never overwriting an existing one', async () => {
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'original\n');
  assert.equal((await sweepOne(f, home, {})).action, 'quarantined');
  const list = quarantineList(home);
  assert.equal(list.length, 1);
  assert.ok(list[0].id.endsWith('a.jsonl') && list[0].size === 9 && list[0].origin === f);
  assert.ok(!fs.existsSync(f));
  assert.equal(quarantineRestore(home, list[0].id).to, f);
  assert.equal(fs.readFileSync(f, 'utf8'), 'original\n');
  assert.deepEqual(quarantineList(home), []);
  await sweepOne(f, home, {});
  fs.writeFileSync(f, 'a newer file at the same path\n');
  const again = quarantineList(home)[0];
  const r = quarantineRestore(home, again.id);
  assert.notEqual(r.to, f);
  assert.match(r.to, /\.restored-/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'a newer file at the same path\n');
  assert.equal(fs.readFileSync(r.to, 'utf8'), 'original\n');
  assert.throws(() => quarantineRestore(home, '../../etc/passwd'), /quarantine entry/);
});

test('purge removes only what the sidecar describes: a quarantined file that vanished drops its sidecar, an unknown file is never touched', async () => {
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'abc\n');
  await sweepOne(f, home, {});
  const qroot = path.join(home, '.cammut-quarantine');
  const stray = path.join(qroot, 'stray.jsonl');
  fs.writeFileSync(stray, 'someone else put this here');
  const q = quarantineList(home)[0];
  fs.rmSync(path.join(qroot, q.id));
  const ok = { preflightOk: true, archiveStillVerifies: () => true, reviewedOverride: true };
  assert.equal((await purgeQuarantine({ home, now: grace(99), ...ok }))[0].action, 'missing');
  assert.ok(fs.existsSync(stray), 'files without a sidecar are never deleted');
  assert.deepEqual(quarantineList(home), []);
});

// ---- the batch run, dry-run by default ----------------------------------------------------------------------

function batchEnv({ files = 3, reviewed = true } = {}) {
  const { dir, home } = homeWith();
  const claudeFiles = [];
  for (let i = 0; i < files; i++) {
    const f = path.join(home, 'projects', 'p', `0a1b2c3d-1111-2222-3333-44445555666${i}.jsonl`);
    fs.writeFileSync(f, `transcript ${i}\nsecond line ${i}\n`);
    fs.utimesSync(f, new Date(NOW - 5 * DAY), new Date(NOW - 5 * DAY));
    claudeFiles.push(f);
  }
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg = { stateDir, retention: { enabled: true, ...PERIOD }, archive: { recipientsFile: path.join(dir, 'r.txt') } };
  const deps = {
    cfg, claudeHome: home, codexHome: null, now: NOW, settle: async () => {}, reviewedOverride: reviewed,
    coverage: async (agent, session) => { const f = claudeFiles.find((x) => x.includes(session)); return covFor(f); },
    status: async () => base().status, spoolRefs: () => 0, handleOpen: () => null,
    audit: base().audit, recipientFps: base().recipientFps, dryRun: { at: NOW - DAY },
  };
  return { dir, home, files: claudeFiles, cfg, deps };
}

test('runSweep is a dry run by default: it decides everything and renames nothing', async () => {
  const e = batchEnv();
  const r = await runSweep({ ...e.deps, apply: false });
  assert.equal(r.results.length, 3);
  assert.ok(r.results.every((x) => x.action === 'would-quarantine'));
  assert.ok(e.files.every((f) => fs.existsSync(f)));
  assert.ok(!fs.existsSync(path.join(e.home, '.cammut-quarantine')));
  assert.match(r.listingHash, /^[0-9a-f]{64}$/);
});

test('runSweep --yes quarantines the verified files, honours the per-run cap and refuses on a failed precondition', async () => {
  const e = batchEnv({ files: 5 });
  e.cfg.retention.maxDeletesPerRun = 2;
  const r = await runSweep({ ...e.deps, apply: true });
  assert.equal(r.results.filter((x) => x.action === 'quarantined').length, 2);
  assert.equal(r.results.filter((x) => x.action === 'kept' && x.reasons.includes('per-run-cap')).length, 3);
  assert.equal(e.files.filter((f) => fs.existsSync(f)).length, 3);

  const e2 = batchEnv();
  const refused = await runSweep({ ...e2.deps, status: async () => ({ replica: null }), apply: true });
  assert.deepEqual(refused.refused, ['no-replica']);
  assert.ok(e2.files.every((f) => fs.existsSync(f)), 'nothing is renamed when a global precondition fails');
  const unrev = batchEnv({ reviewed: false });
  const r3 = await runSweep({ ...unrev.deps, apply: true });
  assert.ok(r3.refused.includes('not-reviewed'));
  assert.ok(unrev.files.every((f) => fs.existsSync(f)));
  const dry = await runSweep({ ...unrev.deps, apply: false });
  assert.ok(dry.preflight.reasons.includes('not-reviewed'), 'a dry run still reports the preflight');
  assert.ok(dry.results.length === 3, 'and still evaluates every file');
});

test('runSweep: a rewritten middle, an unreplicated segment and a running session each keep their file; the others go', async () => {
  const e = batchEnv({ files: 4 });
  const [a, b, c, d] = e.files;
  fs.writeFileSync(a, fs.readFileSync(a, 'utf8').replace('transcript', 'TRANSCRIPT')); // same length, middle rewritten (mtime reset below)
  fs.utimesSync(a, new Date(NOW - 5 * DAY), new Date(NOW - 5 * DAY));
  const cov = e.deps.coverage;
  e.deps.coverage = async (agent, session) => {
    const f = e.files.find((x) => x.includes(session));
    if (f === a) { const fresh = covFor(a); const stale = covFor(a); stale.segs[0].src_sha256 = sha('the bytes that were archived'); return stale && { ...fresh, segs: stale.segs }; }
    if (f === b) return covFor(b, { replicated: [true, false] });
    return cov(agent, session);
  };
  fs.writeFileSync(path.join(e.home, 'sessions', 's.json'), JSON.stringify({ sessionId: path.basename(c, '.jsonl') }));
  const r = await runSweep({ ...e.deps, apply: true });
  const by = (f) => r.results.find((x) => x.file === f);
  assert.ok(by(a).reasons.includes('content-mismatch'));
  assert.ok(by(b).reasons.includes('not-replicated'));
  assert.ok(by(c).reasons.includes('session-running'));
  assert.equal(by(d).action, 'quarantined');
  assert.deepEqual([a, b, c].map((f) => fs.existsSync(f)), [true, true, true]);
  assert.equal(fs.existsSync(d), false);
});

test('sweep.log carries path hashes, sizes, actions and reasons, never a path or file content', async () => {
  const e = batchEnv({ files: 2 });
  await runSweep({ ...e.deps, apply: true });
  const log = fs.readFileSync(path.join(e.cfg.stateDir, 'sweep.log'), 'utf8');
  assert.match(log, /^\S+ [0-9a-f]{12} \d+ quarantined /m);
  assert.ok(!log.includes('transcript') && !log.includes(e.dir) && !log.includes('.jsonl'));
});

test('retention enable refuses unless every precondition except the flag holds; disable clears it', async () => {
  const dir = tmp();
  const cfgFile = path.join(dir, 'shared-memory.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ openviking: { capture: false }, retention: { quietMinutes: 90 } }));
  const bad = await retentionEnable({ cfgFile, days: 3, preflight: { ok: false, reasons: ['no-replica'] }, now: NOW, listingHash: 'h'.repeat(64) });
  assert.deepEqual(bad, { ok: false, reasons: ['no-replica'] });
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).retention.enabled, undefined);
  const good2 = await retentionEnable({ cfgFile, days: 3, preflight: { ok: true, reasons: [] }, now: NOW, listingHash: 'h'.repeat(64) });
  assert.equal(good2.ok, true);
  const j = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepEqual([j.retention.enabled, j.retention.localRetentionDays, j.retention.quietMinutes, j.retention.dryRunId, j.openviking.capture], [true, 3, 90, 'h'.repeat(64), false], 'only the retention keys change');
  assert.equal(typeof j.retention.enabledAt, 'string');
  retentionDisable({ cfgFile });
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).retention.enabled, false);
  await assert.rejects(retentionEnable({ cfgFile, days: -1, preflight: { ok: true, reasons: [] }, now: NOW, listingHash: 'x' }), /days/);
});

test('sweepMain without --yes is a dry run that prints the preflight first and writes dryrun.json; --quiet never writes it', async () => {
  const e = batchEnv();
  const out = [];
  const write = (s) => out.push(s);
  const code = await sweepMain([], { ...e.deps, write });
  assert.equal(code, 0);
  assert.match(out[0], /^preflight: (ok|refused)/);
  assert.ok(out.some((l) => /would-quarantine/.test(l)));
  assert.ok(out.some((l) => /listing hash [0-9a-f]{64}/.test(l)));
  const rec = JSON.parse(fs.readFileSync(path.join(e.cfg.stateDir, 'dryrun.json'), 'utf8'));
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'listingHash']);
  fs.rmSync(path.join(e.cfg.stateDir, 'dryrun.json'));
  await sweepMain(['--quiet', '--yes'], { ...e.deps, write });
  assert.ok(!fs.existsSync(path.join(e.cfg.stateDir, 'dryrun.json')), 'an unattended run is not a dry run anyone read');
  assert.ok(!e.files.every((f) => fs.existsSync(f)), 'with everything verified the unattended --yes run does quarantine');
});

// ---- findings of the independent review (Astra, 2026-10-11) ----------------------------------------------------------------------

test('a time in the future is never fresh: replica, audit and dry-run records must lie in the past', () => {
  const future = NOW + 3 * DAY;
  assert.deepEqual(no2({ status: { replica: { last_run_at: future } } }), ['replica-stale']);
  assert.deepEqual(no2({ audit: { ...base().audit, at: future } }), ['restore-audit-stale']);
  assert.deepEqual(no2({ dryRun: { at: future } }), ['dry-run-not-read']);
  assert.deepEqual(no2({ dryRun: { at: NOW + 60000 } }), [], 'a minute of clock skew is tolerated');
});

test('restore never overwrites: when the origin and the first fallback name are taken, the next free name is used', async () => {
  const { home, f } = homeWith();
  const dir = path.dirname(f);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(f, `generation ${i}\n`);
    assert.equal((await sweepOne(f, home, {})).action, 'quarantined');
    fs.writeFileSync(f, `a live file ${i}\n`);
    const entry = quarantineList(home)[0];
    ids.push(quarantineRestore(home, entry.id, NOW).to);
  }
  assert.equal(new Set(ids).size, 3, 'three restores, three different destinations');
  assert.equal(fs.readFileSync(f, 'utf8'), 'a live file 2\n', 'the live file at the origin was never touched');
  const texts = ids.map((p) => fs.readFileSync(p, 'utf8')).sort();
  assert.deepEqual(texts, ['generation 0\n', 'generation 1\n', 'generation 2\n'], 'every quarantined generation came back, none overwrote another');
});

test('a sidecar whose origin lies outside the transcript root is refused and the quarantined file stays', async () => {
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'again\n');
  await sweepOne(f, home, {});
  const entry = quarantineList(home)[0];
  const metaFile = path.join(home, '.cammut-quarantine', `${entry.id}.json`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, origin: path.join(os.tmpdir(), 'elsewhere.jsonl') }));
  assert.throws(() => quarantineRestore(home, entry.id), /outside the transcript root/);
  assert.ok(fs.existsSync(path.join(home, '.cammut-quarantine', entry.id)));
});

test('purge refuses a sidecar that is not what the sweeper writes', async () => {
  const { home, f } = homeWith();
  fs.writeFileSync(f, 'abc\n');
  await sweepOne(f, home, {});
  const entry = quarantineList(home)[0];
  const metaFile = path.join(home, '.cammut-quarantine', `${entry.id}.json`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, wholeHash: 'not a hash' }));
  const ok = { preflightOk: true, archiveStillVerifies: () => true, reviewedOverride: true };
  assert.equal((await purgeQuarantine({ home, now: grace(99), ...ok }))[0].reason, 'bad-sidecar');
  assert.ok(fs.existsSync(path.join(home, '.cammut-quarantine', entry.id)));
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  assert.equal((await purgeQuarantine({ home, now: grace(10), ...ok, graceHours: NaN })).length, 0, 'a nonsense grace value falls back to 48 h, it never shortens the wait');
  assert.equal((await purgeQuarantine({ home, now: grace(99), ...ok }))[0].action, 'purged');
});

test('Codex rollouts need the rollout-<time>-<uuid>.jsonl name', () => {
  const dir = tmp();
  const codex = path.join(dir, '.codex');
  fs.mkdirSync(path.join(codex, 'sessions', '2026', '10'), { recursive: true });
  const uuid = '0a1b2c3d-1111-2222-3333-444455556666';
  fs.writeFileSync(path.join(codex, 'sessions', '2026', '10', 'rollout-notes.jsonl'), 'x');
  fs.writeFileSync(path.join(codex, 'sessions', '2026', '10', `rollout-2026-10-11T10-00-00-${uuid}.jsonl`), 'x');
  assert.deepEqual(listCandidates({ claudeHome: null, codexHome: codex }).map((c) => path.basename(c.file)), [`rollout-2026-10-11T10-00-00-${uuid}.jsonl`]);
});

test('runSweep: quarantine and purge never happen in the same run, and the registry is re-read before every file', async () => {
  const e = batchEnv({ files: 3 });
  e.cfg.retention.graceHours = 0;
  const r = await runSweep({ ...e.deps, apply: true });
  assert.equal(r.results.filter((x) => x.action === 'quarantined').length, 3);
  assert.equal(r.results.filter((x) => x.action === 'purged').length, 0, 'a grace of 0 hours still waits at least one hour');
  const e2 = batchEnv({ files: 2 });
  let calls = 0;
  const origCoverage = e2.deps.coverage;
  e2.deps.coverage = async (a, s) => { if (++calls === 1) fs.writeFileSync(path.join(e2.home, 'sessions', 'bad.json'), '{"x":'); return origCoverage(a, s); };
  const r2 = await runSweep({ ...e2.deps, apply: true });
  assert.deepEqual(r2.refused, ['registry-unreadable'], 'a registry that turns unreadable mid-run stops the run');
  assert.equal(e2.files.filter((f) => !fs.existsSync(f)).length, 0, 'the unreadable registry was noticed before the second file');
});

test('an unreadable spool entry blocks every transcript', async () => {
  const { spoolRefsFor } = await import('./sweep.mjs');
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'spool'));
  fs.writeFileSync(path.join(dir, 'spool', '1-a.json'), JSON.stringify({ file: 'C:/x/a.jsonl' }));
  const refs = spoolRefsFor({ stateDir: dir });
  assert.equal(refs('C:/x/a.jsonl'), 1);
  assert.equal(refs('C:/x/other.jsonl'), 0);
  fs.writeFileSync(path.join(dir, 'spool', '2-b.json'), '{"torn":');
  assert.equal(spoolRefsFor({ stateDir: dir })('C:/x/other.jsonl'), 1, 'cannot tell what it points at: nothing may be swept');
});
