#!/usr/bin/env node
// Retention sweeper: the only code in the whole design that removes data on the PC. Read it before enabling it.
//
//   node sweep.mjs sweep [--yes] [--json] [--quiet]        dry run unless --yes
//   node sweep.mjs retention enable --days N | disable
//   node sweep.mjs quarantine list | restore --id ID | purge-now
//
// The rules, all enforced in code (spec 4.10 / 4.11):
//  * A transcript is deleted in two phases. Phase 1 RENAMES the verified file into <agent home>/.cammut-quarantine/ (same
//    volume). Phase 2 unlinks it only after graceHours AND only if preflight and the archive/replica still verify AND the
//    quarantined file is byte-identical (size, mtime, sha256) to what was verified. A file a writer kept appending to is
//    moved back. Nothing is ever removed recursively and nothing outside the quarantine directory is ever unlinked.
//  * Coverage is content-bound: every acknowledged range is re-hashed from the file in this run and must equal the sha256
//    the server stored; the ranges must cover [0,size) without a gap. Every check fails closed.
//  * Real renames/unlinks refuse (`not-reviewed`) unless SWEEPER-REVIEW.md next to this file holds
//    `reviewed-sha256: <sha256 of this file>`. A human creates that file after reading this code; any edit voids it.
//  * Candidates are only top-level transcripts: ~/.claude/projects/<project>/<uuid>.jsonl and ~/.codex/sessions/**/rollout-*.jsonl.
//    Subagent files, tool-results/, file-history/ and links are never touched (Claude Code's own cleanupPeriodDays handles them).
// Logs hold path hashes, sizes, actions and reasons; never a path or any file content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint, sessionIdOf, recipientFingerprints } from './archive.mjs';
import { loadConfig, atomicWrite, readJson, ensure, lock, canonicalPath, acquireSourceLock, cammutClient, sleep } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3600000;
const DAY = 24 * HOUR;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SHA64 = /^[0-9a-f]{64}$/;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const ms = (t) => (typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : NaN);
// a time that is not a number, or lies more than 5 minutes in the future, is never fresh
const fresh = (now, t, max) => { const a = now - ms(t); return a >= -300000 && a <= max; };

// ---- the human review gate -----------------------------------------------------------------------------------

export function isReviewed({ code = fileURLToPath(import.meta.url), review = path.join(HERE, 'SWEEPER-REVIEW.md') } = {}) {
  try {
    const want = sha(fs.readFileSync(code));
    return fs.readFileSync(review, 'utf8').split(/\r?\n/).some((l) => { const m = /^reviewed-sha256:\s*([0-9a-f]{64})\s*$/i.exec(l); return Boolean(m) && m[1].toLowerCase() === want; });
  } catch { return false; }
}

// `reviewedOverride: false` always refuses. `true` is honoured only inside the node test runner; no command here passes it.
const reviewedOK = (o = {}) => (o.reviewedOverride === false ? false : o.reviewedOverride === true && process.env.NODE_TEST_CONTEXT ? true : isReviewed());

// ---- proving that THESE BYTES are archived -------------------------------------------------------------------

// acked: [{start, end, id, src}] with src = hex sha256 of the plaintext source bytes. One streaming pass hashes every range and
// the whole file. Reasons: not-covered (gap, truncation, bytes after the last range, no ranges), content-mismatch (names the
// ranges in `mismatches`), generation-changed (the file's first-KiB fingerprint differs from `fp`).
export function verifyRanges(file, acked, { fp } = {}) {
  const reasons = new Set();
  const mismatches = [];
  let fd; let size = 0; let wholeHash = null;
  try { fd = fs.openSync(file, 'r'); size = fs.fstatSync(fd).size; } catch { return { ok: false, size: 0, wholeHash: null, mismatches, reasons: ['not-covered'] }; }
  try {
    const ranges = (Array.isArray(acked) ? acked : []).filter((r) => num(r?.start) && num(r?.end) && r.end > r.start).map((r) => ({ ...r, h: crypto.createHash('sha256') }));
    if (!ranges.length || ranges.length !== (acked || []).length) reasons.add('not-covered');
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let covered = 0;
    for (const r of sorted) { if (r.start > covered) reasons.add('not-covered'); covered = Math.max(covered, r.end); }
    if (covered !== size) reasons.add('not-covered'); // bytes after the last range, or a range beyond the end of the file (truncation)
    const whole = crypto.createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    let pos = 0;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      whole.update(chunk);
      for (const r of ranges) {
        const a = Math.max(r.start, pos); const b = Math.min(r.end, pos + n);
        if (b > a) r.h.update(chunk.subarray(a - pos, b - pos));
      }
      pos += n;
    }
    if (pos < size) reasons.add('not-covered'); // the file shrank while it was read
    wholeHash = whole.digest('hex');
    for (const r of ranges) {
      if (r.end > size) continue; // already not-covered; its hash would be partial
      if (!SHA64.test(String(r.src)) || r.h.digest('hex') !== r.src) { mismatches.push({ start: r.start, end: r.end, id: r.id }); reasons.add('content-mismatch'); }
    }
    if (fp !== undefined && fingerprint(file) !== fp) reasons.add('generation-changed');
  } finally { fs.closeSync(fd); }
  return { ok: reasons.size === 0, size, wholeHash, mismatches, reasons: [...reasons] };
}

// The fewest segments that cover [0,size) with no gap, or null. segs: [{id,start,end,...}]
export function minimalCover(segs, size) {
  const sorted = [...(segs || [])].sort((a, b) => a.start - b.start);
  const chosen = [];
  let cur = 0;
  while (cur < size) {
    let best = null;
    for (const s of sorted) if (s.start <= cur && s.end > cur && (!best || s.end > best.end)) best = s;
    if (!best) return null;
    chosen.push(best);
    cur = best.end;
  }
  return size > 0 ? chosen : null;
}

// ---- the per-file decision -----------------------------------------------------------------------------------

// Pure. c = facts gathered for one file; ctx = {now, retentionDays, quietMs}. Every check adds its own name; a missing fact refuses.
export function decideDeletion(c, ctx) {
  const r = [];
  if (c.rootOk !== true) r.push('outside-roots');
  if (c.isLink !== false) r.push('link');
  if (!(num(c.size) && c.size > 0)) r.push('empty');
  const v = c.verify;
  if (!v || v.ok !== true) {
    const named = Array.isArray(v?.reasons) ? v.reasons.filter((x) => ['not-covered', 'content-mismatch', 'generation-changed'].includes(x)) : [];
    r.push(...(named.length ? named : ['not-covered']));
  }
  if (c.headOk !== true) r.push('unverified');
  if (c.allReplicated !== true) r.push('not-replicated');
  if (c.auditedRecipients !== true) r.push('unaudited-recipients');
  if (c.spoolRefs !== 0) r.push('spool-reference');
  if (c.sessionRunning !== false) r.push('session-running');
  if (!(num(c.mtimeMs) && num(c.mtimeMs2) && ctx.now - Math.max(c.mtimeMs, c.mtimeMs2) >= ctx.quietMs)) r.push('not-quiet');
  if (!(num(c.size2) && c.size2 === c.size && num(c.mtimeMs2) && c.mtimeMs2 === c.mtimeMs)) r.push('unstable');
  if (c.handleOpen === true) r.push('handle-open'); // null = undetectable: the quiet period and the stability check are the guard
  if (!(num(c.lastActivityMs) && ctx.now - c.lastActivityMs >= ctx.retentionDays * DAY)) r.push('retention-not-elapsed');
  const reasons = [...new Set(r)];
  return { ok: reasons.length === 0, reasons };
}

// ---- global preconditions --------------------------------------------------------------------------------------

// d = {reviewed, status (server /v1/archive/status or null), audit (restore-audit.json or null), recipientFps[], dryRun ({at} or null),
// registryReadable, enabled, ignoreEnabled}. Evaluated first in every sweep, dry runs included.
export function preflight(d, now = d.now ?? Date.now()) {
  const r = [];
  if (!d.ignoreEnabled && d.enabled !== true) r.push('retention-disabled');
  if (d.reviewed !== true) r.push('not-reviewed');
  if (!d.status) r.push('server-unreachable');
  else {
    const rep = d.status.replica;
    if (!rep || rep.last_run_at == null) r.push('no-replica');
    else if (!fresh(now, rep.last_run_at, d.replicaMaxAgeMs ?? 36 * HOUR)) r.push('replica-stale');
  }
  const a = d.audit;
  if (!a || a.ok !== true) r.push('no-restore-audit');
  else {
    if (!fresh(now, a.at, d.restoreAuditMaxMs ?? 90 * DAY)) r.push('restore-audit-stale');
    const cur = new Set(d.recipientFps || []);
    const audited = new Set(a.recipients ?? [a.daily_fp, a.recovery_fp]);
    const same = cur.size === audited.size && [...audited].every((x) => cur.has(x));
    const both = Boolean(a.daily_fp) && Boolean(a.recovery_fp) && a.daily_fp !== a.recovery_fp && cur.has(a.daily_fp) && cur.has(a.recovery_fp);
    if (!same || !both) r.push('restore-audit-keys');
  }
  if (!d.dryRun || !fresh(now, d.dryRun.at, d.dryRunMaxMs ?? 7 * DAY)) r.push('dry-run-not-read');
  if (d.registryReadable !== true) r.push('registry-unreadable');
  return { ok: r.length === 0, reasons: r };
}

// ---- who is running, what is a candidate -------------------------------------------------------------------------

// The ids of the running Claude Code sessions (~/.claude/sessions/*.json). Anything unreadable, unparsable or in a schema we
// do not recognise aborts the sweep: not knowing who is running is not the same as nobody running. UNVERIFIED (spec item 7):
// the id field is accepted as sessionId, session_id, sessionID or id.
export function loadRunning(home, { optional = false } = {}) {
  const dir = path.join(home, 'sessions');
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { if (optional) return new Set(); throw new Error('registry-unreadable'); }
  const ids = new Set();
  for (const n of names) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { throw new Error('registry-unreadable'); }
    const id = j && typeof j === 'object' ? j.sessionId ?? j.session_id ?? j.sessionID ?? j.id : undefined;
    if (typeof id !== 'string' || !id) throw new Error('registry-unreadable');
    ids.add(id);
  }
  return ids;
}

const CLAUDE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const CODEX_NAME = /^rollout-.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const nameOkDefault = (agent, file) => (agent === 'codex' ? CODEX_NAME : CLAUDE_NAME).test(path.basename(file));

export function statOf(file) {
  try { const s = fs.lstatSync(file); return { size: s.size, mtimeMs: s.mtimeMs, isLink: s.isSymbolicLink() || !s.isFile() }; } catch { return null; }
}

// realpath inside <home>/projects/<project>/ (exactly one level) or <home>/sessions/** (Codex), and a .jsonl
export function inAllowedRoot(file, home, agent) {
  try {
    const root = fs.realpathSync(path.join(home, agent === 'codex' ? 'sessions' : 'projects'));
    const real = fs.realpathSync(file);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/\.jsonl$/i.test(real)) return false;
    return agent === 'codex' ? true : rel.split(path.sep).length === 2;
  } catch { return false; }
}

export function listCandidates({ claudeHome, codexHome }) {
  const out = [];
  const add = (file, agent, home) => { const s = statOf(file); if (s && !s.isLink && nameOkDefault(agent, file)) out.push({ file, agent, home }); };
  if (claudeHome) {
    const projects = path.join(claudeHome, 'projects');
    try {
      for (const p of fs.readdirSync(projects, { withFileTypes: true })) {
        if (!p.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(projects, p.name), { withFileTypes: true })) if (f.isFile()) add(path.join(projects, p.name, f.name), 'claude-code', claudeHome);
      }
    } catch { /* no projects directory */ }
  }
  if (codexHome) {
    const walk = (d) => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) add(p, 'codex', codexHome); }
    };
    walk(path.join(codexHome, 'sessions'));
  }
  return out;
}

// ---- evaluating one file -------------------------------------------------------------------------------------------

const hasAuditedRecipients = (seg, audit) => Boolean(audit?.daily_fp && audit?.recovery_fp
  && audit.daily_fp !== audit.recovery_fp && Array.isArray(seg.recipients)
  && seg.recipients.includes(audit.daily_fp) && seg.recipients.includes(audit.recovery_fp));

// d: {agent, home, now, retention, coverage(agent,session) -> server coverage|null, running:Set, spoolRefs(file), handleOpen(file),
// nameOk?, recordedSha?(id)}. `first` is the stat taken before the settle delay; the second read is taken here.
export async function evaluateFile(file, first, d) {
  const second = statOf(file);
  const agent = d.agent;
  const session = sessionIdOf(agent, file);
  const rootOk = Boolean(second) && Boolean(first) && (d.nameOk || nameOkDefault)(agent, file) && inAllowedRoot(file, d.home, agent);
  let verify = { ok: false, reasons: ['not-covered'], size: 0, wholeHash: null };
  let headOk = false; let allReplicated = false; let auditedRecipients = false; let ranges = []; let cov = null;
  if (rootOk && second && !second.isLink) {
    try { cov = await d.coverage(agent, session); } catch { cov = null; }
    if (cov && Array.isArray(cov.segs) && cov.segs.length) {
      ranges = cov.segs.map((s) => ({ start: s.start, end: s.end, id: s.id, src: s.src_sha256 }));
      verify = verifyRanges(file, ranges, { fp: cov.fp });
      const repCover = minimalCover(cov.segs.filter((s) => s.replicated === true), verify.size);
      allReplicated = repCover !== null;
      const protectedCover = minimalCover(cov.segs.filter((s) => s.replicated === true && hasAuditedRecipients(s, d.audit)), verify.size);
      auditedRecipients = protectedCover !== null;
      // the segments that protect the bytes must still be the ones the PC was told about (coverage reports the server's current sha)
      const cover = protectedCover || repCover || minimalCover(cov.segs, verify.size);
      headOk = cover !== null && cover.every((s) => SHA64.test(String(s.sha256)) && (!d.recordedSha || !d.recordedSha(s.id) || d.recordedSha(s.id) === s.sha256));
    }
  }
  const c = {
    path: file, rootOk, isLink: second ? second.isLink : true, size: first?.size, agent, verify, headOk, allReplicated, auditedRecipients,
    spoolRefs: rootOk ? d.spoolRefs(file) : 1, sessionRunning: agent === 'codex' ? false : d.running.has(session),
    handleOpen: rootOk ? d.handleOpen(file) : null,
    mtimeMs: first?.mtimeMs, mtimeMs2: second?.mtimeMs, size2: second?.size, lastActivityMs: second?.mtimeMs,
  };
  const r = d.retention;
  const decision = decideDeletion(c, { now: d.now, retentionDays: r.localRetentionDays, quietMs: (agent === 'codex' ? r.codexQuietMinutes : r.quietMinutes) * 60000 });
  return { c, decision, cov, ranges, wholeHash: verify.wholeHash, second, session };
}

// ---- phase 1: quarantine -----------------------------------------------------------------------------------------------

const QDIR = '.cammut-quarantine';
const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
const IN_USE = new Set(['EBUSY', 'EPERM', 'EXDEV', 'EACCES']);

// rec = {agent, sessionId, fp, wholeHash, ranges}; opts = {cfg, spoolRefs, home, now, expect:{size,mtimeMs}, beforeRename, renameFn, reviewedOverride}.
// Renames into <home>/.cammut-quarantine/<stamp>/<sha8>-<name> after a final re-stat; the sidecar JSON is written first.
// Honest limit: Node opens files with share-delete on Windows, so a rename can succeed while a writer keeps appending to the
// renamed file. That is why nothing is unlinked here; phase 2 detects late writes.
export async function quarantineFile(file, rec, opts = {}) {
  if (!reviewedOK(opts)) throw new Error('not-reviewed');
  const { home, now = Date.now() } = opts;
  if (!home) throw new Error('quarantine: home is required');
  if (!opts.cfg || typeof opts.spoolRefs !== 'function') return { action: 'kept', reasons: ['spool-reference'] };
  const releaseSource = acquireSourceLock(opts.cfg, file);
  if (!releaseSource) return { action: 'kept', reasons: ['capture-busy'] };
  try {
    if (opts.beforeRename) opts.beforeRename();
    let st;
    try { st = fs.lstatSync(file); } catch { return { action: 'kept', reasons: ['unstable'] }; }
    if (!st.isFile() || st.isSymbolicLink()) return { action: 'kept', reasons: ['link'] };
    if (!opts.expect || st.size !== opts.expect.size || st.mtimeMs !== opts.expect.mtimeMs) return { action: 'kept', reasons: ['unstable'] };
    const dir = path.join(home, QDIR, stamp(now));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = `${sha(file).slice(0, 8)}-${path.basename(file)}`;
    let dest = path.join(dir, base);
    for (let i = 2; fs.existsSync(dest) || fs.existsSync(`${dest}.json`); i++) dest = path.join(dir, `${i}-${base}`);
    atomicWrite(`${dest}.json`, JSON.stringify({ origin: file, size: st.size, mtimeMs: st.mtimeMs, wholeHash: rec.wholeHash, ranges: rec.ranges, agent: rec.agent, sessionId: rec.sessionId, fp: rec.fp, quarantinedAt: now }));
    try {
      // This scan and rename are synchronous under the guard capture holds from source read through enqueue.
      let refs = 1;
      try { refs = opts.spoolRefs(file); } catch { /* unknown spool: keep the source */ }
      if (refs !== 0) { fs.rmSync(`${dest}.json`, { force: true }); return { action: 'kept', reasons: ['spool-reference'] }; }
      (opts.renameFn || fs.renameSync)(file, dest);
    } catch (e) {
      fs.rmSync(`${dest}.json`, { force: true });
      if (IN_USE.has(e?.code)) return { action: 'skipped', reason: 'in-use', code: e.code };
      if (e?.code === 'ENOENT') return { action: 'kept', reasons: ['unstable'] };
      throw e;
    }
    return { action: 'quarantined', dest };
  } finally { releaseSource(); }
}

// ---- the quarantine directory ----------------------------------------------------------------------------------------------

const qroot = (home) => path.join(home, QDIR);
const ID_RE = /^\d{8}T\d{6}\/[^/\\]+$/;

function metaEntries(home) {
  const out = [];
  let stamps;
  try { stamps = fs.readdirSync(qroot(home), { withFileTypes: true }); } catch { return out; }
  for (const s of stamps) {
    if (!s.isDirectory() || !/^\d{8}T\d{6}$/.test(s.name)) continue;
    for (const n of fs.readdirSync(path.join(qroot(home), s.name))) {
      if (!n.endsWith('.json')) continue;
      const meta = readJson(path.join(qroot(home), s.name, n), null);
      if (!meta || typeof meta.origin !== 'string' || !num(meta.quarantinedAt)) continue;
      out.push({ id: `${s.name}/${n.slice(0, -5)}`, metaFile: path.join(qroot(home), s.name, n), file: path.join(qroot(home), s.name, n.slice(0, -5)), meta });
    }
  }
  return out;
}

export function quarantineList(home) {
  return metaEntries(home).map((e) => ({ id: e.id, origin: e.meta.origin, size: e.meta.size, quarantinedAt: e.meta.quarantinedAt }));
}

function entryById(home, id) {
  if (!ID_RE.test(String(id))) throw new Error('quarantine entry: bad id');
  const e = metaEntries(home).find((x) => x.id === id);
  if (!e) throw new Error('quarantine entry: not found');
  return e;
}

// put the file back at its origin, or at origin.restored-<stamp> when something is there already
function moveBack(e, now, home) {
  const rootDir = path.join(home, e.meta.agent === 'codex' ? 'sessions' : 'projects');
  const rel = path.relative(rootDir, e.meta.origin);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('quarantine entry: origin is outside the transcript root');
  let to = e.meta.origin;
  for (let i = 1; fs.existsSync(to); i++) to = `${e.meta.origin}.restored-${stamp(now)}${i > 1 ? `-${i}` : ''}`; // never overwrite anything
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(e.file, to);
  fs.rmSync(e.metaFile, { force: true });
  try { fs.rmdirSync(path.dirname(e.file)); } catch { /* not empty */ }
  return to;
}

export function quarantineRestore(home, id, now = Date.now()) {
  const e = entryById(home, id);
  return { to: moveBack(e, now, home) };
}

function hashFile(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// ---- phase 2: purge -----------------------------------------------------------------------------------------------------------

// Entries older than graceHours (all of them with force). preflightOk is the caller's FRESH preflight result;
// archiveStillVerifies(meta) re-checks the archive and the replica for the recorded ranges. Returns one result per entry examined.
export async function purgeQuarantine({ home, now = Date.now(), preflightOk, archiveStillVerifies, reviewedOverride, graceHours = 48, force = false, max = Infinity }) {
  if (!(Number.isFinite(graceHours) && graceHours >= 0)) graceHours = 48; // a nonsense value never shortens the wait
  if (!reviewedOK({ reviewedOverride })) throw new Error('not-reviewed');
  if (preflightOk !== true) return [];
  const out = [];
  for (const e of metaEntries(home)) {
    if (out.length >= max) break;
    if (!force && now - e.meta.quarantinedAt < graceHours * HOUR) continue;
    const res = { id: e.id };
    out.push(res);
    let st;
    try { st = fs.lstatSync(e.file); } catch (err) { if (err?.code === 'ENOENT') { fs.rmSync(e.metaFile, { force: true }); res.action = 'missing'; } else Object.assign(res, { action: 'kept', reason: `stat-failed:${err?.code || 'error'}` }); continue; }
    if (!SHA64.test(String(e.meta.wholeHash)) || !num(e.meta.size) || !num(e.meta.mtimeMs) || !Array.isArray(e.meta.ranges) || typeof e.meta.agent !== 'string' || typeof e.meta.sessionId !== 'string') { Object.assign(res, { action: 'kept', reason: 'bad-sidecar' }); continue; }
    if (!st.isFile() || st.isSymbolicLink()) { Object.assign(res, { action: 'kept', reason: 'not-a-file' }); continue; }
    let verified = false;
    try { verified = (await archiveStillVerifies(e.meta)) === true; } catch { verified = false; }
    if (!verified) { Object.assign(res, { action: 'kept', reason: 'archive-unverified' }); continue; }
    let same = false;
    try { same = st.size === e.meta.size && st.mtimeMs === e.meta.mtimeMs && hashFile(e.file) === e.meta.wholeHash; } catch { same = false; }
    if (!same) {
      try { Object.assign(res, { action: 'restored', to: moveBack(e, now, home) }); } catch (err) { Object.assign(res, { action: 'kept', reason: `restore-failed:${err?.code || 'error'}` }); }
      continue;
    }
    const inside = path.relative(qroot(home), e.file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) { Object.assign(res, { action: 'kept', reason: 'outside-quarantine' }); continue; }
    try {
      const again = fs.lstatSync(e.file); // narrow the window between the hash and the unlink: a late append shows here
      if (again.size !== st.size || again.mtimeMs !== st.mtimeMs) { Object.assign(res, { action: 'kept', reason: 'changed-during-purge' }); continue; }
      fs.unlinkSync(e.file); // one file, never recursive
      fs.rmSync(e.metaFile, { force: true });
      try { fs.rmdirSync(path.dirname(e.file)); } catch { /* not empty */ }
      res.action = 'purged';
    } catch (err) { Object.assign(res, { action: 'kept', reason: `unlink-failed:${err?.code || 'error'}` }); }
  }
  return out;
}

// ---- one file through the pipeline ---------------------------------------------------------------------------------------------

// d adds {apply, settle(), beforeRename, renameFn, reviewedOverride} to the evaluateFile inputs.
export async function sweepFile(file, d) {
  const first = statOf(file);
  if (!first) return { action: 'kept', reasons: ['empty'] };
  await (d.settle ? d.settle() : sleep(d.retention.settleSeconds * 1000));
  const ev = await evaluateFile(file, first, d);
  if (!ev.decision.ok) return { action: 'kept', reasons: ev.decision.reasons, size: first.size };
  if (!d.apply) return { action: 'would-quarantine', reasons: [], size: first.size };
  const q = await quarantineFile(file, { agent: d.agent, sessionId: ev.session, fp: ev.cov.fp, wholeHash: ev.wholeHash, ranges: ev.ranges }, { cfg: d.cfg, spoolRefs: d.spoolRefs, home: d.home, now: d.now, expect: ev.second, beforeRename: d.beforeRename, renameFn: d.renameFn, reviewedOverride: d.reviewedOverride });
  return { reasons: [], size: first.size, ...q };
}

// ---- the batch run --------------------------------------------------------------------------------------------------------------

const logLine = (cfg, text) => { try { ensure(cfg.stateDir); fs.appendFileSync(path.join(cfg.stateDir, 'sweep.log'), `${new Date().toISOString()} ${text}\n`); } catch { /* logging must never break a sweep */ } };

// d: {cfg, claudeHome, codexHome, now, apply, settle, status(), coverage(), audit, recipientFps, dryRun, spoolRefs, handleOpen, recordedSha,
// reviewedOverride, ignoreEnabled}. Dry run unless apply. Returns {preflight, refused?, results, listingHash}.
export async function runSweep(d) {
  const { cfg } = d;
  const ret = cfg.retention;
  const now = d.now ?? Date.now();
  let running = new Set(); let registryReadable = true;
  try { running = loadRunning(d.claudeHome); } catch { registryReadable = false; }
  let status = null;
  try { status = await d.status(); } catch { status = null; }
  const pf = preflight({ now, reviewed: reviewedOK(d), status, audit: d.audit, recipientFps: d.recipientFps, dryRun: d.dryRun, registryReadable, enabled: ret.enabled === true, ignoreEnabled: d.ignoreEnabled === true, replicaMaxAgeMs: ret.replicaMaxAgeHours * HOUR, restoreAuditMaxMs: ret.restoreAuditMaxDays * DAY }, now);
  if (d.apply && !pf.ok) return { preflight: pf, refused: pf.reasons, results: [], listingHash: null };
  const cands = listCandidates({ claudeHome: registryReadable ? d.claudeHome : null, codexHome: d.codexHome })
    .map((c) => ({ ...c, first: statOf(c.file) })).filter((c) => c.first).sort((a, b) => a.first.mtimeMs - b.first.mtimeMs);
  await (d.settle ? d.settle() : sleep(ret.settleSeconds * 1000)); // one settle delay for the whole batch
  const results = [];
  let acted = 0;
  for (const c of cands) {
    if (d.apply) { try { running = loadRunning(d.claudeHome); } catch { return { preflight: pf, refused: ['registry-unreadable'], results, listingHash: null }; } }
    const base = { file: c.file, agent: c.agent, size: c.first.size, project: path.basename(path.dirname(c.file)) };
    if (acted >= ret.maxDeletesPerRun) { results.push({ ...base, action: 'kept', reasons: ['per-run-cap'] }); continue; }
    const dd = { ...d, agent: c.agent, home: c.home, now, retention: ret, running, apply: d.apply === true };
    const ev = await evaluateFile(c.file, c.first, dd);
    if (!ev.decision.ok) { results.push({ ...base, action: 'kept', reasons: ev.decision.reasons }); continue; }
    if (!d.apply) { acted++; results.push({ ...base, action: 'would-quarantine', reasons: [] }); continue; }
    // the registry is read again right before the rename: a session that started or a registry that broke during the evaluation stops it
    try { running = loadRunning(d.claudeHome); } catch { return { preflight: pf, refused: ['registry-unreadable'], results, listingHash: null }; }
    if (c.agent === 'claude-code' && running.has(ev.session)) { results.push({ ...base, action: 'kept', reasons: ['session-running'] }); continue; }
    const q = await quarantineFile(c.file, { agent: c.agent, sessionId: ev.session, fp: ev.cov.fp, wholeHash: ev.wholeHash, ranges: ev.ranges }, { cfg, spoolRefs: d.spoolRefs, home: c.home, now, expect: ev.second, beforeRename: d.beforeRename, renameFn: d.renameFn, reviewedOverride: d.reviewedOverride });
    if (q.action === 'quarantined') acted++;
    results.push({ ...base, reasons: [], ...q });
  }
  if (d.apply) {
    const verifies = (meta) => verifyArchive(d, meta);
    let purgeBudget = Math.max(0, ret.maxDeletesPerRun - acted);
    for (const home of [d.claudeHome, d.codexHome].filter(Boolean)) {
      for (const p of await purgeQuarantine({ home, now, preflightOk: pf.ok, archiveStillVerifies: verifies, reviewedOverride: d.reviewedOverride, graceHours: Math.max(1, ret.graceHours), max: purgeBudget })) {
        results.push({ phase: 2, file: p.id, reasons: p.reason ? [p.reason] : [], ...p });
        if (p.action === 'purged') purgeBudget -= 1;
      }
    }
    for (const r of results) logLine(cfg, `${sha(String(r.file)).slice(0, 12)} ${r.size ?? 0} ${r.action} ${(r.reasons || []).join(',') || '-'}`);
  }
  const listingHash = sha(results.map((r) => `${sha(String(r.file)).slice(0, 12)}|${r.size ?? 0}|${r.action}|${(r.reasons || []).join(',')}`).sort().join('\n'));
  return { preflight: pf, results, listingHash };
}

// the server must still report the same newest generation, the same plaintext hashes, and a replica covering the recorded size
async function verifyArchive(d, meta) {
  const cov = await d.coverage(meta.agent, meta.sessionId);
  if (!cov || cov.fp !== meta.fp || !Array.isArray(cov.segs) || !Array.isArray(meta.ranges) || !meta.ranges.length) return false;
  const matches = (s, r) => s.id === r.id && s.start === r.start && s.end === r.end && s.src_sha256 === r.src;
  if (!meta.ranges.every((r) => cov.segs.some((s) => matches(s, r)))) return false;
  return minimalCover(cov.segs.filter((s) => s.replicated === true && hasAuditedRecipients(s, d.audit)
    && meta.ranges.some((r) => matches(s, r))), meta.size) !== null;
}

// ---- retention switch ------------------------------------------------------------------------------------------------------------

// `preflight` is the result of a dry-run evaluation with the enabled flag ignored; only then does the flag get written.
export async function retentionEnable({ cfgFile, days, preflight: pf, now = Date.now(), listingHash }) {
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('retention enable: days must be a whole number from 0 to 3650');
  if (!pf?.ok) return { ok: false, reasons: pf?.reasons || ['unknown'] };
  const cur = readJson(cfgFile, {});
  cur.retention = { ...(cur.retention || {}), enabled: true, enabledAt: new Date(now).toISOString(), dryRunId: listingHash, localRetentionDays: days };
  atomicWrite(cfgFile, JSON.stringify(cur, null, 2));
  return { ok: true };
}

export function retentionDisable({ cfgFile }) {
  const cur = readJson(cfgFile, {});
  cur.retention = { ...(cur.retention || {}), enabled: false };
  atomicWrite(cfgFile, JSON.stringify(cur, null, 2));
}

// ---- the real world: server, files and tools on this PC ---------------------------------------------------------------------------

function onPath(name, env = process.env) {
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) for (const x of process.platform === 'win32' ? ['.exe', ''] : ['']) { const p = path.join(dir, name + x); if (fs.existsSync(p)) return p; }
  return null;
}

// Sysinternals handle64.exe when it is installed: true = a process holds the file, false = none, null = cannot tell.
export function detectHandleOpen(file) {
  const exe = onPath('handle64') || onPath('handle');
  if (!exe) return null;
  const r = spawnSync(exe, ['-nobanner', file], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
  if (r.error || r.status === null) return null;
  const out = String(r.stdout || '');
  if (/no matching handles found/i.test(out)) return false;
  return out.toLowerCase().includes(path.basename(file).toLowerCase()) ? true : null;
}

export function spoolRefsFor(cfg) {
  return (file) => {
    const files = new Map();
    let unknown = false;
    // the live spool and spool/failed (items waiting for age pruning still point at their transcript)
    for (const sub of ['spool', path.join('spool', 'failed')]) {
      try {
        for (const n of fs.readdirSync(path.join(cfg.stateDir, sub)).filter((x) => x.endsWith('.json'))) {
          const it = readJson(path.join(cfg.stateDir, sub, n), null);
          if (!it) { unknown = true; continue; } // cannot tell what it points at: no transcript may be swept
          if (typeof it.file === 'string' && it.file) files.set(canonicalPath(it.file), (files.get(canonicalPath(it.file)) || 0) + 1);
          else if (it.kind === 'range' || it.file != null) unknown = true;
        }
      } catch (e) { if (e?.code !== 'ENOENT') unknown = true; }
    }
    return unknown ? 1 : files.get(canonicalPath(file)) || 0;
  };
}

function recordedShas(cfg) {
  const m = new Map();
  try {
    for (const n of fs.readdirSync(path.join(cfg.stateDir, 'sessions')).filter((x) => x.endsWith('.json'))) {
      const a = readJson(path.join(cfg.stateDir, 'sessions', n), null)?.arch;
      for (const r of [...(a?.ranges || []), ...Object.values(a?.sidecars || {}).flatMap((s) => s.ranges || [])]) if (r?.id && r.sha) m.set(r.id, r.sha);
    }
  } catch { /* no state */ }
  return (id) => m.get(id);
}

// The sweeper needs `archive/list` (replica status) as well as `archive/verify` (coverage): that is the read token.
function realDeps(cfg, env = process.env) {
  const token = cfg.cammut.readToken || cfg.cammut.token;
  const client = cammutClient(cfg);
  let last = 0;
  const get = async (urlPath) => {
    const wait = 70 - (Date.now() - last); // the gateway allows about 20 requests per second per token
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await client.request('GET', urlPath, { token, ms: 15000 });
    return r.ok ? r.json : null;
  };
  let fps = [];
  try { fps = recipientFingerprints(cfg.archive.recipientsFile).split(','); } catch { fps = []; }
  const home = os.homedir();
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  return {
    cfg, claudeHome: env.CLAUDE_HOME || path.join(home, '.claude'), codexHome: fs.existsSync(path.join(codex, 'sessions')) ? codex : null,
    status: () => get('/v1/archive/status'),
    coverage: (agent, session) => get(`/v1/archive/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(session)}/coverage`),
    audit: readJson(path.join(cfg.stateDir, 'restore-audit.json'), null), recipientFps: fps, dryRun: readJson(path.join(cfg.stateDir, 'dryrun.json'), null),
    spoolRefs: spoolRefsFor(cfg), handleOpen: detectHandleOpen, recordedSha: recordedShas(cfg),
  };
}

const configFile = (env = process.env) => env.SM_CONFIG || path.join(os.homedir(), '.claude', 'shared-memory.json');

// ---- commands ----------------------------------------------------------------------------------------------------------------------

export async function sweepMain(argv, deps) {
  const cfg = deps?.cfg || loadConfig();
  const d = { ...(deps || realDeps(cfg)), cfg };
  const write = d.write || ((s) => console.log(s));
  const quiet = argv.includes('--quiet');
  const apply = argv.includes('--yes');
  ensure(cfg.stateDir);
  const lockFile = path.join(cfg.stateDir, 'sweep.lock');
  if (!lock(lockFile, 30 * 60 * 1000)) { if (!quiet) write('another sweep is running'); return 0; }
  try {
    const r = await runSweep({ ...d, apply });
    if (r.refused) {
      if (!quiet) { write(`preflight: refused (${r.refused.join(', ')}); nothing was changed`); }
      return quiet ? 0 : 2;
    }
    if (quiet) return 0;
    if (argv.includes('--json')) { write(JSON.stringify(r.results.map((x) => ({ ...x, file: path.basename(String(x.file)) })), null, 2)); return 0; }
    write(r.preflight.ok ? 'preflight: ok' : `preflight: refused (${r.preflight.reasons.join(', ')}); this is a dry run, nothing was changed`);
    for (const x of r.results) write(`${path.basename(String(x.file))} (${x.project || x.agent || ''}) | ${x.size ?? 0} B | ${x.action} | ${(x.reasons || []).join(', ') || x.reason || '-'}`);
    write(`${r.results.length} file(s); listing hash ${r.listingHash}`);
    if (!apply) {
      atomicWrite(path.join(cfg.stateDir, 'dryrun.json'), JSON.stringify({ at: Date.now(), listingHash: r.listingHash }));
      write('dry run recorded; run with --yes to quarantine the files marked would-quarantine (retention must be enabled)');
    }
    return 0;
  } finally { fs.rmSync(lockFile, { force: true }); }
}

export async function main(argv, deps) {
  const [cmd, sub, ...rest] = argv;
  const cfg = deps?.cfg || loadConfig();
  if (cmd === 'sweep') return sweepMain(argv.slice(1), deps);
  const d = { ...(deps || realDeps(cfg)), cfg };
  const write = d.write || ((s) => console.log(s));
  if (cmd === 'retention' && sub === 'disable') { retentionDisable({ cfgFile: configFile() }); write('retention disabled'); return 0; }
  if (cmd === 'retention' && sub === 'enable') {
    const i = rest.indexOf('--days');
    const days = i >= 0 ? Number(rest[i + 1]) : NaN;
    if (!Number.isInteger(days)) { write('usage: retention enable --days N'); return 2; }
    const r = await runSweep({ ...d, apply: false, ignoreEnabled: true });
    const res = await retentionEnable({ cfgFile: configFile(), days, preflight: { ok: r.preflight.ok, reasons: r.preflight.reasons }, listingHash: r.listingHash });
    write(res.ok ? `retention enabled: transcripts are quarantined ${days} day(s) after they are archived, replicated and quiet (dry-run ${r.listingHash.slice(0, 12)})` : `refused: ${res.reasons.join(', ')}`);
    return res.ok ? 0 : 2;
  }
  if (cmd === 'quarantine') {
    const homes = [d.claudeHome, d.codexHome].filter(Boolean);
    const lf = path.join(ensure(cfg.stateDir), 'sweep.lock');
    if (sub !== 'list') {
      if (!lock(lf, 30 * 60 * 1000)) { write('another sweep or quarantine command is running'); return 2; }
    }
    try {
      return await quarantineCmd(sub, rest, d, homes, write);
    } finally { if (sub !== 'list') fs.rmSync(lf, { force: true }); }
  }
  write('usage: sweep.mjs sweep [--yes] [--json] [--quiet] | retention enable --days N | disable | quarantine list | restore --id ID | purge-now');
  return 2;
}

async function quarantineCmd(sub, rest, d, homes, write) {
  {
    if (sub === 'list') { for (const h of homes) for (const e of quarantineList(h)) write(`${e.id} | ${e.size} B | ${new Date(e.quarantinedAt).toISOString()}`); return 0; }
    if (sub === 'restore') {
      const i = rest.indexOf('--id');
      if (i < 0) { write('usage: quarantine restore --id ID'); return 2; }
      for (const h of homes) { try { write(`restored to ${quarantineRestore(h, rest[i + 1]).to}`); return 0; } catch (e) { if (!/not found/.test(e.message)) throw e; } }
      write('no such quarantine entry');
      return 2;
    }
    if (sub === 'purge-now') {
      const r = await runSweep({ ...d, apply: false });
      for (const h of homes) for (const p of await purgeQuarantine({ home: h, preflightOk: r.preflight.ok, archiveStillVerifies: (m) => verifyArchive(d, m), force: true, reviewedOverride: undefined })) write(`${p.id} | ${p.action}${p.reason ? ` (${p.reason})` : ''}`);
      return r.preflight.ok ? 0 : 2;
    }
  }
  write('usage: sweep.mjs sweep [--yes] [--json] [--quiet] | retention enable --days N | disable | quarantine list | restore --id ID | purge-now');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
