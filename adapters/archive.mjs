// The PC side of the encrypted raw archive: segment ids, string-level redaction, segment building and sealing,
// the ciphertext outbox, acknowledgement bookkeeping, and (below) the drain steps that cut, upload and acknowledge.
// Dependency-free (Node 24). The only external program is the `age` CLI, and only through an injected `encrypt`.
// Nothing here prints a token, a key or any session text; the outbox holds ciphertext and metadata only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  redact, ensure, atomicWrite, readJson, log, readRange, updateSession, sessionsDir, cammutClient, retryable, isOptedOut,
} from './common.mjs';

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// hex(sha256(agent \0 session \0 kind \0 relpath \0 fp \0 start \0 end))[:32]; internal/archive.SegmentID computes the same
// (adapters/archive-id-fixtures.json is asserted by both sides).
export const segmentId = (m) => sha256Hex(Buffer.from([m.agent, m.session, m.kind, m.relpath || '', m.fp, String(m.start), String(m.end)].join('\0'))).slice(0, 32);

// ---- file fingerprints and content binding --------------------------------------------------------

// hex sha256 of the first 1024 bytes (the whole file when shorter): which generation of the file this is. A hint, not the proof.
export function fingerprint(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    return sha256Hex(buf.subarray(0, n));
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// sha256 of bytes [start,end) read in 1 MiB steps; null when the file is gone or shorter than end
export function rangeSha256(file, start, end) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (fs.fstatSync(fd).size < end) return null;
    const h = crypto.createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    for (let pos = start; pos < end;) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n <= 0) return null;
      h.update(buf.subarray(0, n));
      pos += n;
    }
    return h.digest('hex');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// ---- recipients ------------------------------------------------------------------------------------

// sorted, comma-joined first 16 hex of sha256(line) for every public key line; the same values go to X-Archive-Recipients
// and restore-audit.json. A secret key line is an error and is never echoed.
export function recipientFingerprints(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error('recipients file is missing or unreadable'); }
  const fps = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.includes('AGE-SECRET-KEY-')) throw new Error('the recipients file contains a secret key line; it must hold public keys only');
    if (!/^age1[0-9a-z]{50,}$/.test(line)) throw new Error('the recipients file has a line that is not an age1... public key (content not shown)');
    fps.push(sha256Hex(Buffer.from(line)).slice(0, 16));
  }
  if (!fps.length) throw new Error('no recipients in the recipients file');
  return [...new Set(fps)].sort().join(',');
}

// ---- names -----------------------------------------------------------------------------------------

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const baseOf = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || '';

// the archive's session id comes from the transcript's own file name, so the PC and the sweeper derive the same one
export function sessionIdOf(agent, file) {
  const stem = baseOf(file).replace(/\.jsonl$/i, '');
  const id = agent === 'codex' && UUID_TAIL.test(stem) ? stem.match(UUID_TAIL)[1] : stem;
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

export const projectName = (cwd) => baseOf(cwd).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';

// ---- redaction at string level -------------------------------------------------------------------------

const stub = (data) => `[stripped ${data.length} bytes sha256:${sha256Hex(Buffer.from(data)).slice(0, 16)}]`;

function walk(v, r) {
  if (typeof v === 'string') return r(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, r));
  if (v && typeof v === 'object') {
    const o = Object.create(null);
    const image = v.type === 'base64' && typeof v.data === 'string'; // the `source` of an image or document block
    for (const [k, x] of Object.entries(v)) o[k] = image && k === 'data' ? stub(x) : walk(x, r);
    return o;
  }
  return v;
}

// One transcript line: every string value goes through `redactFn`, so the JSON stays valid; base64 payloads become stubs.
// null for an empty line; a line that is not JSON is redacted as a whole string.
export function redactJsonLine(line, redactFn = redact) {
  if (!String(line).trim()) return null;
  let v;
  try { v = JSON.parse(line); } catch { return redactFn(String(line)); }
  return JSON.stringify(walk(v, redactFn));
}

// ---- building and sealing a segment ---------------------------------------------------------------------

export const CODEC = typeof zlib.zstdCompressSync === 'function' ? 'zstd' : 'br';

const compress = (buf, codec) => (codec === 'zstd'
  ? zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 6 } })
  : zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }));

// the header lives INSIDE the encrypted payload so a server cannot swap the metadata
const plainText = (meta, lines) => {
  const header = { v: 1, agent: meta.agent, session: meta.session, kind: meta.kind, relpath: meta.relpath || '', fp: meta.fp, src: meta.srcSha256, start: meta.start, end: meta.end };
  return `${JSON.stringify(header)}\n${lines.length ? `${lines.join('\n')}\n` : ''}`;
};

export const buildPlain = ({ meta, lines, codec = CODEC }) => compress(Buffer.from(plainText(meta, lines), 'utf8'), codec);

// `encrypt(buf, recipientsFile) -> Buffer` is injected; the real one is ageEncrypt.
export function sealSegment({ meta, rawBytes, recipientsFile, encrypt = ageEncrypt, redact: redactFn = redact, doRedact = true }) {
  const srcSha256 = sha256Hex(rawBytes); // the content binding: the exact source bytes, before redaction
  const lines = [];
  for (const l of rawBytes.toString('utf8').split('\n')) {
    const out = doRedact ? redactJsonLine(l, redactFn) : (l.trim() ? l : null);
    if (out !== null) lines.push(out);
  }
  const full = { ...meta, srcSha256, relpath: meta.relpath || '' };
  const text = Buffer.from(plainText(full, lines), 'utf8');
  const cipher = encrypt(compress(text, CODEC), recipientsFile);
  return { id: segmentId(full), cipher, sha256: sha256Hex(cipher), meta: { ...full, codec: CODEC, plainBytes: text.length } };
}

// `age -R recipients` over stdin/stdout. The error never carries the input or the process output.
export function ageEncrypt(buf, recipientsFile, { bin = 'age', args0 = [] } = {}) {
  const r = spawnSync(bin, [...args0, '-R', recipientsFile], { input: buf, timeout: 20000, maxBuffer: 256 << 20, windowsHide: true });
  if (r.error) throw new Error(`age could not run: ${r.error.code || r.error.name}`);
  if (r.status !== 0) throw new Error(`age exited with status ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}`);
  return r.stdout;
}

// the X-Archive-Meta JSON the server expects (recipients travel in their own header)
export const wireMeta = (m) => ({
  agent: m.agent, project: m.project, session_id: m.session, kind: m.kind, relpath: m.relpath || '', fp: m.fp,
  src_sha256: m.srcSha256, codec: m.codec, src_start: m.start, src_end: m.end, plain_bytes: m.plainBytes,
});

// ---- cutting -----------------------------------------------------------------------------------------

// Cut points [{start,end}] (absolute byte offsets) at line ends. `text` is a string or Buffer that starts at file offset `base`.
// Rule: cut whenever segmentBytes have accumulated; the rest is cut only on `flush` or after flushIdleMs without activity.
// An unfinished last line is never included. ponytail: a single line longer than the caller's read window is never cut.
export function planSegments({ text, cursor = 0, base = 0, segmentBytes, lastActivityMs = 0, flushIdleMs = 600000, now = Date.now(), flush = false }) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  const out = [];
  let segStart = cursor;
  let i = cursor - base;
  for (;;) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    i = nl + 1;
    if (base + i - segStart >= segmentBytes) { out.push({ start: segStart, end: base + i }); segStart = base + i; }
  }
  if (base + i > segStart && (flush || now - lastActivityMs >= flushIdleMs)) out.push({ start: segStart, end: base + i });
  return out;
}

// ---- the ciphertext outbox ---------------------------------------------------------------------------------

export const outboxDir = (cfg) => path.join(cfg.stateDir, 'outbox');

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

function usedBytes(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.age')) n += sizeOf(path.join(dir, f)); } catch { /* none yet */ }
  return n;
}

// false when the cap would be exceeded: no new segment is created and the source stays where it is
export function outboxPut(cfg, seg) {
  const dir = ensure(outboxDir(cfg));
  const age = path.join(dir, `${seg.id}.age`);
  const meta = path.join(dir, `${seg.id}.json`);
  if (fs.existsSync(age) && fs.existsSync(meta)) return true;
  if (usedBytes(dir) + seg.cipher.length > (cfg.archive?.outboxMaxBytes ?? 536870912)) return false;
  atomicWrite(age, seg.cipher);
  atomicWrite(meta, JSON.stringify({ id: seg.id, sha256: seg.sha256, meta: seg.meta, attempts: 0, createdAt: Date.now() }));
  return true;
}

// entries in range order; an entry is complete only when both files exist (the .json is written last)
export function outboxList(cfg) {
  const dir = outboxDir(cfg);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names.filter((x) => x.endsWith('.json'))) {
    const e = readJson(path.join(dir, f), null);
    const file = path.join(dir, `${f.slice(0, -5)}.age`);
    if (e?.id && fs.existsSync(file)) out.push({ ...e, file });
  }
  for (const f of names.filter((x) => x.endsWith('.age') && !names.includes(`${x.slice(0, -4)}.json`))) {
    try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 600000) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* raced */ } // a crash between the two writes
  }
  // Keep each pending generation together, oldest first, before ordering its byte ranges.
  const generation = (e) => JSON.stringify([e.meta.agent, e.meta.session, e.meta.kind, e.meta.relpath, e.meta.fp]);
  const born = new Map();
  const states = new Map(); const current = new Set();
  for (const e of out) born.set(generation(e), Math.min(born.get(generation(e)) ?? Infinity, e.createdAt || 0));
  for (const e of out) {
    if (!e.meta.stateKey) continue;
    if (!states.has(e.meta.stateKey)) states.set(e.meta.stateKey, readJson(statePath(cfg, e.meta.stateKey), null)?.arch);
    const a = states.get(e.meta.stateKey);
    const fp = e.meta.kind === 'sidecar' ? a?.sidecars?.[e.meta.relpath]?.fp : a?.fp;
    if (fp === e.meta.fp) current.add(generation(e));
  }
  return out.sort((a, b) => (a.meta.session < b.meta.session ? -1 : a.meta.session > b.meta.session ? 1 : 0)
    || Number(current.has(generation(a))) - Number(current.has(generation(b)))
    || born.get(generation(a)) - born.get(generation(b))
    || generation(a).localeCompare(generation(b)) || a.meta.start - b.meta.start || a.meta.end - b.meta.end);
}

export function outboxDrop(cfg, id) {
  for (const ext of ['.json', '.age']) fs.rmSync(path.join(outboxDir(cfg), `${id}${ext}`), { force: true });
}

// merge fields (attempts, failed, ...) into an entry's metadata
export function outboxPatch(cfg, id, patch) {
  const f = path.join(outboxDir(cfg), `${id}.json`);
  const e = readJson(f, null);
  if (e) atomicWrite(f, JSON.stringify({ ...e, ...patch }));
}

export function outboxStats(cfg) {
  const list = outboxList(cfg);
  const oldest = list.reduce((a, e) => Math.min(a, e.createdAt || Date.now()), Date.now());
  return { count: list.length, bytes: list.reduce((n, e) => n + sizeOf(e.file), 0), failed: list.filter((e) => e.failed).length, oldestMs: list.length ? Date.now() - oldest : 0 };
}

// ---- acknowledgement ---------------------------------------------------------------------------------------

// move the cursor over every acknowledged or refused-as-changed range that starts at or before it
export function advanceCursor(a) {
  for (let moved = true; moved;) {
    moved = false;
    for (const r of [...a.ranges, ...(a.changed || [])]) if (r.start <= a.cursor && r.end > a.cursor) { a.cursor = r.end; moved = true; }
  }
  return a.cursor;
}

// Record `seg` as archived with the SERVER-reported sha. The cursor advances over contiguous ranges only. The sweeper
// never trusts these records: it recomputes every `src` from the file and compares with the server's own coverage.
export function ackRecord(state, seg, serverSha) {
  const a = (state.arch ||= { cursor: 0, ranges: [], changed: [] });
  a.ranges ||= [];
  a.changed ||= [];
  const rec = { start: seg.meta.start, end: seg.meta.end, id: seg.id, sha: serverSha, src: seg.meta.srcSha256 };
  const i = a.ranges.findIndex((r) => r.id === seg.id);
  if (i >= 0) a.ranges[i] = rec; else a.ranges.push(rec);
  a.ranges.sort((x, y) => x.start - y.start || x.end - y.end);
  advanceCursor(a);
  return a;
}

// ---- the drain's archive step ----------------------------------------------------------------------------------
// State per session (sessions/<key>.json -> arch): {file, agent, project, cwd, sid, fp, cursor, ranges:[{start,end,id,sha,src}],
// changed:[{start,end}], flush, sidecars:{<relpath>:{fp,cursor,ranges,changed}}}. The cursor moves only when the server acknowledged
// a contiguous range, so a dead Cammut loses nothing: the file stays, the outbox keeps ciphertext, the next drain continues.

const MAX_WINDOW = 8 * 1024 * 1024;
const SIDECAR_IDLE_MS = 600000;
const MAX_ATTEMPTS = 5;
const PRUNE_AFTER_MS = 3 * 86400000;

const freshRec = () => ({ cursor: 0, ranges: [], changed: [] });

// called by the capture hook under the session lock; a different transcript file starts a clean slate
export function registerArchive(st, { file, agent, project, cwd }) {
  let a = st.arch;
  if (!a || (a.file && a.file !== file)) a = st.arch = freshRec();
  a.ranges ||= [];
  a.changed ||= [];
  Object.assign(a, { file, agent, project, cwd, sid: sessionIdOf(agent, file) });
  return a;
}

const recOf = (a, src) => (src.kind === 'sidecar' ? ((a.sidecars ||= {})[src.relpath] ||= freshRec()) : a);

const sessionKeys = (cfg) => { try { return fs.readdirSync(sessionsDir(cfg)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };
const statePath = (cfg, key) => path.join(sessionsDir(cfg), `${key}.json`);

// the main transcript plus, once it is flushed or idle, its subagent files (whole files, never tool-results/ or file-history/)
function sourcesOf(a, flush, idle) {
  const list = [{ kind: 'transcript', relpath: '', file: a.file }];
  if (a.agent === 'claude-code' && (flush || idle)) {
    const dir = path.join(path.dirname(a.file), path.basename(a.file).replace(/\.jsonl$/i, ''), 'subagents');
    try { for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) list.push({ kind: 'sidecar', relpath: `subagents/${n}`, file: path.join(dir, n) }); } catch { /* none */ }
  }
  return list;
}

// Cut, redact, compress, encrypt and queue what the server has not acknowledged yet. Returns counts only.
export async function archiveStep(cfg, { now = Date.now(), encrypt = cfg.encrypt ?? ageEncrypt } = {}) {
  const res = { sealed: 0, errors: 0, capped: false, pruned: 0 };
  if (!cfg.archive?.enabled) return res;
  let recipients = '';
  try { recipients = recipientFingerprints(cfg.archive.recipientsFile); } catch { /* a real age run fails first without the file */ }
  const queued = new Set(outboxList(cfg).map((e) => e.id));
  for (const key of sessionKeys(cfg)) {
    const st = readJson(statePath(cfg, key), null);
    const a = st?.arch;
    if (!a?.file) continue;
    let stat;
    try { stat = fs.statSync(a.file); } catch {
      try { if (now - fs.statSync(statePath(cfg, key)).mtimeMs > PRUNE_AFTER_MS) { fs.rmSync(statePath(cfg, key), { force: true }); res.pruned += 1; } } catch { /* raced */ }
      continue;
    }
    if (isOptedOut(a.cwd)) continue;
    const flush = a.flush === true;
    let planned = true;
    for (const src of sourcesOf(a, flush, now - stat.mtimeMs >= SIDECAR_IDLE_MS)) {
      if (res.capped) { planned = false; break; }
      if (!(await archiveSource(cfg, key, a, src, { now, flush, encrypt, recipients, queued, res }))) planned = false;
    }
    if (flush && planned) await updateSession(cfg, key, (cur) => { if (cur.arch) cur.arch.flush = false; });
  }
  if (res.sealed || res.errors || res.pruned) log(cfg, `archive step sealed=${res.sealed} errors=${res.errors} pruned=${res.pruned}${res.capped ? ' outbox-full' : ''}`);
  return res;
}

// true when everything up to the end of the file's complete lines is planned or queued
async function archiveSource(cfg, key, a, src, ctx) {
  const { res } = ctx;
  let size; let mtimeMs;
  try { ({ size, mtimeMs } = fs.statSync(src.file)); } catch { return true; }
  const fp = fingerprint(src.file);
  if (!fp) return true;
  let rec = recOf(a, src);
  if ((rec.fp && rec.fp !== fp) || rec.cursor > size) { // a rewritten or truncated file: a new generation starts from zero
    // The outbox may be the only remaining copy of the old generation. Only an upload receipt can remove it.
    await updateSession(cfg, key, (cur) => { Object.assign(recOf(cur.arch, src), { cursor: 0, ranges: [], changed: [], fp }); });
    rec = { ...freshRec(), fp };
  } else if (!rec.fp) {
    await updateSession(cfg, key, (cur) => { recOf(cur.arch, src).fp = fp; });
  }
  if (rec.cursor >= size) return true;
  const len = Math.min(size - rec.cursor, MAX_WINDOW);
  const buf = readRange(src.file, rec.cursor, rec.cursor + len);
  if (!buf) return true;
  const cuts = planSegments({ text: buf, base: rec.cursor, cursor: rec.cursor, segmentBytes: cfg.archive.segmentBytes, lastActivityMs: mtimeMs, flushIdleMs: cfg.archive.flushIdleMs, now: ctx.now, flush: ctx.flush || src.kind === 'sidecar' });
  for (const c of cuts) {
    const meta = { agent: a.agent, project: a.project, session: a.sid, kind: src.kind, relpath: src.relpath, fp, start: c.start, end: c.end, stateKey: key, recipients: ctx.recipients };
    const id = segmentId(meta);
    if (ctx.queued.has(id) || rec.ranges.some((r) => r.id === id)) continue;
    const raw = readRange(src.file, c.start, c.end);
    if (!raw) return false;
    let seg;
    try {
      seg = sealSegment({ meta, rawBytes: raw, recipientsFile: cfg.archive.recipientsFile, encrypt: ctx.encrypt, redact, doRedact: cfg.archive.redact !== false });
    } catch (e) { // the message names the failing tool, never the session text
      res.errors += 1;
      log(cfg, `archive seal failed: ${String(e?.message).slice(0, 100)}`);
      return false;
    }
    if (!outboxPut(cfg, seg)) { res.capped = true; return false; }
    ctx.queued.add(seg.id);
    res.sealed += 1;
  }
  const lastEnd = cuts.length ? cuts.at(-1).end : rec.cursor;
  const lineEnd = rec.cursor + buf.lastIndexOf(10) + 1; // end of the window's complete lines
  return len === size - rec.cursor && lastEnd >= lineEnd;
}

const b64url = (s) => Buffer.from(s).toString('base64url');
const SHA = /^[0-9a-f]{64}$/;

// PUT one sealed segment ({id, sha256, meta}; body = its ciphertext). Used by the drain, backfill and the doctor's self-test.
export function putSegment(client, e, body, ms = 60000) {
  const headers = { 'X-Archive-Meta': b64url(JSON.stringify(wireMeta(e.meta))), 'X-Content-SHA256': e.sha256, 'Content-Type': 'application/octet-stream' };
  if (e.meta.recipients) headers['X-Archive-Recipients'] = e.meta.recipients;
  return client.request('PUT', `/v1/archive/segments/${e.id}`, { headers, body, ms });
}

// Record the acknowledgement (or the refusal) in the session state; false when the state is locked so the entry stays
// in the outbox and the idempotent upload is repeated next time.
async function settle(cfg, e, serverSha, kind) {
  if (!fs.existsSync(statePath(cfg, e.meta.stateKey))) return true; // the session state was pruned: nothing to update
  const ok = await updateSession(cfg, e.meta.stateKey, (st) => {
    const a = st.arch;
    if (!a) return;
    const rec = recOf(a, { kind: e.meta.kind, relpath: e.meta.relpath });
    if (rec.fp !== e.meta.fp) return; // a late answer for an older generation of the file: not recorded
    if (kind === 'ack') ackRecord({ arch: rec }, { id: e.id, meta: e.meta }, serverSha);
    else {
      rec.changed ||= [];
      if (!rec.changed.some((r) => r.start === e.meta.start && r.end === e.meta.end)) rec.changed.push({ start: e.meta.start, end: e.meta.end });
      advanceCursor(rec);
    }
  });
  return ok !== false;
}

// PUT every queued segment. 200/201 acknowledge with the server-reported sha; 409 content_mismatch marks the range changed;
// 429/5xx/network stop the pass and keep everything; any other 4xx counts an attempt and marks the entry failed after 5.
export async function uploadOutbox(cfg, { client = cammutClient(cfg) } = {}) {
  const out = { acked: 0, changed: 0, failed: 0, retry: false };
  for (const e of outboxList(cfg)) {
    if (e.failed) continue;
    let body;
    try { body = fs.readFileSync(e.file); } catch { continue; }
    const r = await putSegment(client, e, body);
    if (r.status === 200 || r.status === 201) {
      const sha = r.json?.sha256;
      if (!SHA.test(String(sha))) {
        const attempts = (e.attempts || 0) + 1;
        outboxPatch(cfg, e.id, { attempts, failed: attempts >= MAX_ATTEMPTS });
        log(cfg, `archive upload ${e.id.slice(0, 8)} was answered without a sha`);
        continue;
      }
      if (!(await settle(cfg, e, sha, 'ack'))) continue;
      outboxDrop(cfg, e.id);
      out.acked += 1;
      if (r.json?.recipients_changed) log(cfg, `archive: the server flags a changed recipient set for ${e.meta.project}`);
    } else if (r.status === 409) {
      if (!(await settle(cfg, e, null, 'changed'))) continue;
      outboxDrop(cfg, e.id);
      out.changed += 1;
      log(cfg, `archive: range ${e.meta.start}-${e.meta.end} of ${e.meta.session.slice(0, 8)} changed since it was archived; the file stays un-deletable`);
    } else if (retryable(r) && r.status !== 507 && r.status !== 413) {
      out.retry = true;
      break;
    } else {
      const attempts = (e.attempts || 0) + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      outboxPatch(cfg, e.id, { attempts, failed, lastStatus: r.status });
      if (failed) { out.failed += 1; log(cfg, `archive upload ${e.id.slice(0, 8)} failed for good: status ${r.status}`); }
    }
  }
  if (out.acked || out.changed || out.failed) log(cfg, `archive upload acked=${out.acked} changed=${out.changed} failed=${out.failed}`);
  return out;
}

// what `sm.mjs status` and the chain doctor print: counts, sizes and ages only
export function archiveStatus(cfg, now = Date.now()) {
  const box = outboxStats(cfg);
  let ackedRanges = 0;
  let oldest = 0;
  for (const key of sessionKeys(cfg)) {
    const a = readJson(statePath(cfg, key), null)?.arch;
    if (!a?.file) continue;
    ackedRanges += (a.ranges?.length || 0) + Object.values(a.sidecars || {}).reduce((n, r) => n + (r.ranges?.length || 0), 0);
    try {
      const s = fs.statSync(a.file);
      if (a.cursor < s.size) oldest = Math.max(oldest, now - s.mtimeMs);
    } catch { /* gone */ }
  }
  return { enabled: cfg.archive?.enabled === true, outbox: { count: box.count, bytes: box.bytes, failed: box.failed }, ackedRanges, oldestUnarchivedMs: oldest };
}
