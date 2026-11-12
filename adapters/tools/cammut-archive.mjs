#!/usr/bin/env node
// The user's tool for the encrypted raw archive. Run it yourself in a terminal.
//   backfill [--dry-run] [--agent claude-code|codex] [--max-mb N] [--since YYYY-MM-DD]   archive the existing transcripts
//   status                                  server totals, local outbox, oldest unarchived transcript, last sweep
//   fetch   --session ID [--agent A] [--out DIR]                          download the ciphertext of one session
//   decrypt --session ID --identity FILE [--out FILE | --grep RE] [--force]
//   restore --session ID --identity FILE [--strip-thinking]              rebuild ~/.claude/projects/.../<id>.jsonl
//   audit   [--sample N] --identity FILE --recovery-identity FILE        rehearse recovery with BOTH keys
//   pins                                    recipient sets the server flagged as changed
//   doctor                                  checks, a real round trip, and what the PC keeps
//   sweep [--yes] | retention enable --days N | disable | quarantine list|restore --id X|purge-now   (adapters/sweep.mjs)
// Keys: this tool never reads, prints or stores a private key. `age` reads the identity file you name and asks for its
// passphrase itself (once per segment, because every segment is a separate age file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// installed flat (next to common.mjs) or in the repo (adapters/tools/, siblings one level up)
const sib = (n) => (fs.existsSync(new URL(`./${n}`, import.meta.url)) ? `./${n}` : `../${n}`);
const { loadConfig, cammutClient, sleep, readJson, atomicWrite, sessionsDir } = await import(sib('common.mjs'));
const A = await import(sib('archive.mjs'));
const S = await import(sib('sweep.mjs'));
const { sealSegment, planSegments, fingerprint, sessionIdOf, projectName, recipientFingerprints, sha256Hex, putSegment, outboxStats, archiveStatus, ageEncrypt } = A;

const MiB = 1048576;
const fmt = (n) => (n < 1024 ? `${n} B` : n < MiB ? `${(n / 1024).toFixed(1)} KiB` : `${(n / MiB).toFixed(1)} MiB`);
const ID = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const out = (io) => io.write || ((s) => console.log(s));

// ---- age and the server ----------------------------------------------------------------------------------------------------

export const realAge = {
  decrypt(cipher, identity) {
    const r = spawnSync('age', ['-d', '-i', identity], { input: cipher, stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 512 * MiB, windowsHide: false });
    if (r.error) throw new Error(`age could not run: ${r.error.code || r.error.name}`);
    if (r.status !== 0) throw new Error(`age could not decrypt (exit ${r.status})`);
    return r.stdout;
  },
  version() {
    const r = spawnSync('age', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? String(r.stdout).trim() : null;
  },
  // a plain identity file reveals its public key; a passphrase-locked one does not (null)
  publicKey(identity) {
    const r = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const k = String(r.stdout || '').trim();
    return r.status === 0 && /^age1\S+$/.test(k) ? k : null;
  },
  encryptRecipient(buf, recipient) {
    const r = spawnSync('age', ['-r', recipient], { input: buf, timeout: 20000, maxBuffer: MiB, windowsHide: true });
    if (r.error || r.status !== 0) throw new Error('age could not encrypt the recipient challenge');
    return r.stdout;
  },
};

// A private breaker per run: a foreground tool must not be locked out by the hooks' 45 s breaker, nor lock them out.
async function withClient(cfg, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cammut-archive-'));
  try {
    const priv = { ...cfg, stateDir: dir };
    const base = cammutClient(priv);
    const readTok = cfg.cammut.readToken || cfg.cammut.token;
    return await fn({
      put: base,
      get: { request: (m, p, o = {}) => base.request(m, p, { token: readTok, ...o }) },
      readTok,
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

let lastCall = 0;
async function paced(spacingMs) {
  const wait = spacingMs - (Date.now() - lastCall); // the gateway allows about 20 requests per second per token
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

const listRows = async (c, query) => {
  const params = new URLSearchParams(query);
  const rows = []; const cursors = new Set(); const ids = new Set();
  for (;;) {
    const r = await c.get.request('GET', `/v1/archive/segments?${params}`);
    if (r.status === 403) throw new Error('the read token lacks archive/list: set CAMMUT_ARCHIVE_READ_TOKEN (see the user steps)');
    if (!r.ok) throw new Error(`listing segments failed (status ${r.status || r.error})`);
    const page = r.json;
    if (!Array.isArray(page?.segments) || typeof page.truncated !== 'boolean') throw new Error('listing is incomplete: invalid pagination response');
    for (const row of page.segments) {
      if (ids.has(row.id)) throw new Error('listing is incomplete: duplicate segment across cursor pages');
      ids.add(row.id); rows.push(row);
    }
    if (!page.truncated) {
      if (page.next_cursor !== null) throw new Error('listing is incomplete: unexpected next_cursor');
      return rows;
    }
    const next = page.next_cursor;
    if (!page.segments.length || typeof next !== 'string' || !next || cursors.has(next)) throw new Error('listing is incomplete: missing or repeating cursor');
    cursors.add(next); params.set('cursor', next);
  }
};

// the ciphertext of one segment, with its stored metadata; the hash must match what the server announced
async function getSegment(c, id, expected) {
  if (!ID.test(String(id))) throw new Error('segment id from the server is not 32 hex characters');
  const r = await c.get.request('GET', `/v1/archive/segments/${id}`, { raw: true, ms: 120000 });
  if (!r.ok) throw new Error(`segment ${id.slice(0, 8)}: download failed (status ${r.status || r.error})`);
  const announced = r.headers['x-content-sha256'];
  if (sha256Hex(r.buf) !== announced) throw new Error(`segment ${id.slice(0, 8)}: the downloaded bytes do not match the announced sha256`);
  if (expected && announced !== expected.sha256) throw new Error(`segment ${id.slice(0, 8)}: the downloaded sha256 differs from the selected coverage`);
  let meta = {};
  try { meta = JSON.parse(Buffer.from(String(r.headers['x-archive-meta']), 'base64url').toString('utf8')); } catch { /* checked by the caller */ }
  if (expected && (meta.relpath || '') !== (expected.relpath || '')) throw new Error(`segment ${id.slice(0, 8)}: stored relpath differs from the selected coverage`);
  if (expected) for (const k of ['agent', 'session_id', 'kind', 'fp', 'src_start', 'src_end', 'src_sha256', 'codec', 'plain_bytes']) {
    if (k === 'src_sha256' && expected[k] === undefined) continue; // listing omits it; complete coverage supplies it for the restore chain
    if (meta[k] !== expected[k]) throw new Error(`segment ${id.slice(0, 8)}: stored ${k} differs from the selected coverage`);
  }
  return { id, cipher: r.buf, meta, sha: announced };
}

// ---- backfill --------------------------------------------------------------------------------------------------------------------

// the first record that names a working directory gives the project (Claude: cwd; Codex: session_meta payload.cwd)
function projectFromFile(agent, file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const l of buf.subarray(0, n).toString('utf8').split('\n')) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        const cwd = agent === 'codex' ? j?.payload?.cwd : j?.cwd;
        if (typeof cwd === 'string' && cwd) return projectName(cwd);
      }
    } finally { fs.closeSync(fd); }
  } catch { /* fall through */ }
  return agent === 'codex' ? 'unknown' : projectName(path.basename(path.dirname(file)).split('-').pop());
}

function gapsOf(ranges, size) {
  const gaps = [];
  let cur = 0;
  for (const [a, b] of ranges) { if (a > cur) gaps.push([cur, Math.min(a, size)]); cur = Math.max(cur, b); }
  if (cur < size) gaps.push([cur, size]);
  return gaps.filter(([a, b]) => b > a);
}

export async function backfill(cfg, o = {}) {
  const write = out(o);
  const roots = o.roots || { claudeHome: path.join(os.homedir(), '.claude'), codexHome: path.join(os.homedir(), '.codex') };
  const since = o.since ? Date.parse(o.since) : 0;
  if (o.since && Number.isNaN(since)) throw new Error('--since must be YYYY-MM-DD');
  const budget = o.maxMb ? o.maxMb * MiB : Infinity;
  const spacing = o.spacingMs ?? 55;
  const encrypt = cfg.encrypt ?? ageEncrypt;
  let recipients = '';
  if (!o.dryRun) recipients = recipientFingerprints(cfg.archive.recipientsFile); // refuses a missing file or a secret key line
  const cands = S.listCandidates(roots).filter((c) => !o.agent || c.agent === o.agent)
    .map((c) => ({ ...c, st: fs.statSync(c.file) })).filter((c) => c.st.mtimeMs >= since)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const res = { files: 0, segments: 0, uploaded: 0, uploadedBytes: 0, skippedCovered: 0, failed: 0, changed: 0, retry: false };
  let spent = 0;
  await withClient(cfg, async (c) => {
    for (const cand of cands) {
      if (res.retry || spent >= budget) break;
      res.files += 1;
      const agent = cand.agent;
      const session = sessionIdOf(agent, cand.file);
      const fp = fingerprint(cand.file);
      await paced(spacing);
      const cov = await c.put.request('GET', `/v1/archive/sessions/${agent}/${encodeURIComponent(session)}/coverage`);
      if (!cov.ok) { res.retry = true; break; }
      const gaps = gapsOf(cov.json?.fp === fp ? cov.json.ranges || [] : [], cand.st.size);
      if (!gaps.length) { res.skippedCovered += 1; continue; }
      const project = projectFromFile(agent, cand.file);
      const cuts = [];
      for (const [a, b] of gaps) {
        const bytes = readSlice(cand.file, a, b);
        if (!bytes) continue;
        for (const cut of planSegments({ text: bytes, base: a, cursor: a, segmentBytes: cfg.archive.segmentBytes, flush: true })) cuts.push(cut);
      }
      spent += cuts.reduce((n, x) => n + x.end - x.start, 0);
      res.segments += cuts.length;
      if (o.dryRun) continue;
      let next = 0;
      const worker = async () => {
        while (!res.retry) {
          const cut = cuts[next++];
          if (!cut) return;
          const raw = readSlice(cand.file, cut.start, cut.end);
          if (!raw) continue;
          const meta = { agent, project, session, kind: 'transcript', relpath: '', fp, start: cut.start, end: cut.end, recipients };
          const seg = sealSegment({ meta, rawBytes: raw, recipientsFile: cfg.archive.recipientsFile, encrypt, doRedact: cfg.archive.redact !== false });
          await paced(spacing);
          const r = await putSegment(c.put, seg, seg.cipher);
          if (r.status === 200 || r.status === 201) { res.uploaded += 1; res.uploadedBytes += seg.cipher.length; }
          else if (r.status === 409) res.changed += 1;
          else if (r.status === 0 || r.status === 429 || (r.status >= 500 && r.status !== 507 && r.status !== 413)) res.retry = true;
          else res.failed += 1;
        }
      };
      await Promise.all([worker(), worker()]);
    }
  });
  write(`files=${res.files} segments=${res.segments} uploaded MiB=${(res.uploadedBytes / MiB).toFixed(1)} skipped(covered)=${res.skippedCovered}${res.changed ? ` changed=${res.changed}` : ''}${res.failed ? ` failed=${res.failed}` : ''}${res.retry ? ' INTERRUPTED: run it again, it resumes' : ''}${o.dryRun ? ' (dry run: nothing was uploaded)' : ''}`);
  return res;
}

function readSlice(file, start, end) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (fs.fstatSync(fd).size < end) return null;
    const buf = Buffer.alloc(end - start);
    let got = 0;
    while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, start + got); if (n <= 0) return null; got += n; }
    return buf;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// ---- status ----------------------------------------------------------------------------------------------------------------------

export async function status(cfg, o = {}) {
  const write = out(o);
  const res = { server: null };
  const r = await withClient(cfg, (c) => c.get.request('GET', '/v1/archive/status'));
  if (r.ok) {
    const s = r.json;
    res.server = s;
    write(`server: segments=${s.segments} cipher=${fmt(s.cipher_bytes)} sessions=${s.sessions} free=${fmt(s.free_bytes)} of quota ${fmt(s.max_bytes)}`);
    write(`replica: last run ${s.replica?.last_run_at || 'never'}, replicated=${s.replica?.replicated} unreplicated=${s.replica?.unreplicated} oldest unreplicated age=${Math.round((s.replica?.oldest_unreplicated_age_s || 0) / 3600)}h`);
    for (const ch of s.recipient_changes || []) write(`RECIPIENT CHANGE flagged for project ${ch.project} at ${ch.changed_at}; acknowledge on the VDS with: cammut archive pins ack -project ${ch.project}`);
  } else write(`server: not reachable or not allowed (status ${r.status || r.error}); the read token needs archive/list`);
  const box = outboxStats(cfg);
  write(`outbox: ${box.count} segments, ${fmt(box.bytes)}, failed ${box.failed}`);
  const a = archiveStatus(cfg);
  let unswept = 0;
  try {
    for (const n of fs.readdirSync(sessionsDir(cfg)).filter((x) => x.endsWith('.json'))) {
      const arch = readJson(path.join(sessionsDir(cfg), n), null)?.arch;
      if (arch?.file && fs.existsSync(arch.file)) unswept += (arch.ranges || []).reduce((s, x) => s + x.end - x.start, 0);
    }
  } catch { /* no sessions */ }
  write(`acked ranges=${a.ackedRanges}; acknowledged but not yet swept: ${fmt(unswept)}; oldest unarchived transcript age=${a.oldestUnarchivedMs ? `${(a.oldestUnarchivedMs / 3600000).toFixed(1)}h` : '-'}`);
  let last = 'never';
  try { const lines = fs.readFileSync(path.join(cfg.stateDir, 'sweep.log'), 'utf8').trim().split('\n'); last = lines.at(-1).split(' ')[0]; } catch { /* no log */ }
  write(`last sweep: ${last}`);
  const home = o.roots?.claudeHome || path.join(os.homedir(), '.claude');
  write(`quarantine: ${S.quarantineList(home).length} entries`);
  return res;
}

// ---- fetch, decrypt, restore -------------------------------------------------------------------------------------------------------

// the segments of the newest file generation of a session, as the minimal chain that covers it
async function chainOf(c, session, agent, listed) {
  const rows = (listed || await listRows(c, `session=${encodeURIComponent(session)}&limit=1000${agent ? `&agent=${encodeURIComponent(agent)}` : ''}`))
    .filter((r) => r.kind === 'transcript' && r.session_id === session && (!agent || r.agent === agent));
  if (!rows.length) throw new Error('no transcript segments for that session');
  const newest = [...rows].sort((a, b) => b.stored_at - a.stored_at)[0];
  const r = await c.get.request('GET', `/v1/archive/sessions/${encodeURIComponent(newest.agent)}/${encodeURIComponent(session)}/coverage`);
  if (!r.ok) throw new Error(`complete coverage failed (status ${r.status || r.error})`);
  const cov = r.json;
  if (cov?.fp !== newest.fp || !SHA.test(cov.fp) || !Array.isArray(cov.segs) || !Array.isArray(cov.ranges) || cov.segments !== cov.segs.length || !cov.segs.length) throw new Error('complete coverage is inconsistent with the selected generation');
  for (const ref of cov.segs) if (!ID.test(String(ref.id)) || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || !SHA.test(ref.src_sha256) || !SHA.test(ref.sha256)) throw new Error('complete coverage contains an invalid segment');
  let size = cov.segs.reduce((n, ref) => Math.max(n, ref.end), 0);
  for (const range of cov.ranges) {
    if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[1] <= range[0]) throw new Error('complete coverage contains an invalid extent');
    size = Math.max(size, range[1]);
  }
  const chain = S.minimalCover(cov.segs, size);
  if (!chain) throw new Error('the archived ranges of that session have a gap; run backfill or restore from another copy');
  const byId = new Map(rows.map((row) => [row.id, row]));
  return chain.map((ref) => {
    const row = byId.get(ref.id);
    if (!row || row.agent !== newest.agent || row.fp !== cov.fp || row.src_start !== ref.start || row.src_end !== ref.end || row.sha256 !== ref.sha256) throw new Error('listing is incomplete or disagrees with the complete coverage');
    return { ...row, start: ref.start, end: ref.end, src_sha256: ref.src_sha256 };
  });
}

export async function fetchSession(cfg, o) {
  const write = out(o);
  if (!o.session) throw new Error('fetch: --session is required');
  const dir = path.resolve(o.out || `cammut-archive-${o.session.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  return withClient(cfg, async (c) => {
    const rows = await listRows(c, `session=${encodeURIComponent(o.session)}&limit=1000${o.agent ? `&agent=${encodeURIComponent(o.agent)}` : ''}`);
    for (const r of rows) if (!ID.test(String(r.id))) throw new Error('segment id from the server is not 32 hex characters');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let n = 0;
    for (const r of rows) {
      const g = await getSegment(c, r.id, r);
      fs.writeFileSync(path.join(dir, `${g.id}.age`), g.cipher, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, `${g.id}.meta.json`), JSON.stringify(g.meta), { mode: 0o600 });
      n += 1;
    }
    write(`fetched ${n} segments (${rows.length} listed) into ${dir}`);
    return { segments: n, dir };
  });
}

// decrypt one segment, decompress it, and check the authenticated inner header against the stored (outer) metadata
function openSegment(g, age, identity) {
  const m = g.meta;
  let compressed;
  try { compressed = age.decrypt(g.cipher, identity); } catch (e) { throw new Error(`segment ${g.id.slice(0, 8)}: ${String(e.message).slice(0, 120)}`); }
  let text;
  try { text = (m.codec === 'br' ? zlib.brotliDecompressSync(compressed) : zlib.zstdDecompressSync(compressed)).toString('utf8'); } catch { throw new Error(`segment ${g.id.slice(0, 8)}: the decrypted payload does not decompress`); }
  const nl = text.indexOf('\n');
  let h;
  try { h = JSON.parse(text.slice(0, nl)); } catch { throw new Error(`segment ${g.id.slice(0, 8)}: the inner header is not JSON`); }
  const want = { v: 1, agent: m.agent, session: m.session_id, kind: m.kind, relpath: m.relpath || '', fp: m.fp, src: m.src_sha256, start: m.src_start, end: m.src_end };
  for (const [k, v] of Object.entries(want)) if (h[k] !== v) throw new Error(`segment ${g.id.slice(0, 8)}: the encrypted header disagrees with the stored ${k}`);
  return text.slice(nl + 1).split('\n').filter(Boolean);
}

async function sessionLines(cfg, o, c) {
  const chain = await chainOf(c, o.session, o.agent);
  const lines = [];
  let end = 0;
  for (const r of chain) {
    if (r.start < end) (o.write || ((s) => console.log(s)))(`note: segment ${r.id.slice(0, 8)} overlaps the previous one by ${end - r.start} bytes; a few lines may repeat`);
    lines.push(...openSegment(await getSegment(c, r.id, r), o.age || realAge, o.identity));
    end = r.end;
  }
  return { lines, segments: chain.length, agent: chain[0].agent };
}

export async function decryptSession(cfg, o) {
  const write = out(o);
  if (!o.session || !o.identity) throw new Error('decrypt: --session and --identity are required');
  const target = o.grep ? null : path.resolve(o.out || `${o.session}.jsonl`);
  if (target && fs.existsSync(target) && !o.force) throw new Error(`${target} already exists; use another --out`);
  return withClient(cfg, async (c) => {
    const r = await sessionLines(cfg, { ...o, write }, c);
    if (o.grep) {
      const re = new RegExp(o.grep);
      for (const l of r.lines) if (re.test(l)) write(l);
      write(`segments=${r.segments} lines=${r.lines.length}`);
    } else {
      const body = `${r.lines.join('\n')}\n`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { mode: 0o600, flag: o.force ? 'w' : 'wx' });
      write(`segments=${r.segments} lines=${r.lines.length} bytes=${Buffer.byteLength(body)} -> ${target}`);
    }
    return { segments: r.segments, lines: r.lines.length };
  });
}

const stripThinking = (l) => {
  let j; try { j = JSON.parse(l); } catch { return l; }
  const c = j?.message?.content;
  if (Array.isArray(c)) j.message.content = c.filter((b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
  return JSON.stringify(j);
};

export async function restoreSession(cfg, o) {
  const write = out(o);
  if (!o.session || !o.identity) throw new Error('restore: --session and --identity are required');
  const home = o.home || os.homedir();
  return withClient(cfg, async (c) => {
    const r = await sessionLines(cfg, { ...o, write }, c);
    if (r.agent !== 'claude-code') throw new Error('restore rebuilds Claude Code transcripts only; use decrypt for a Codex rollout');
    let cwd = null;
    for (const l of r.lines) { try { const j = JSON.parse(l); if (typeof j?.cwd === 'string') { cwd = j.cwd; break; } } catch { /* next */ } }
    if (!cwd) throw new Error('the archived session has no record with a working directory, so the project folder cannot be named');
    const file = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${o.session}.jsonl`);
    if (fs.existsSync(file)) throw new Error(`${file} already exists; it is never overwritten`);
    const lines = o.stripThinking ? r.lines.map(stripThinking) : r.lines;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    write(`restored ${lines.length} lines to ${file}`);
    write('UNVERIFIED: whether `claude --resume` accepts this file is not proven (thinking-block signatures and redaction may make the API refuse it; --strip-thinking removes the blocks). The content is the redacted archive, not the original.');
    return { file, lines: lines.length };
  });
}

// ---- audit ---------------------------------------------------------------------------------------------------------------------------

// Locked identities cannot disclose their public key. Prove it by decrypting a fresh challenge
// encrypted to ONE recipient; decrypting the shared archive cannot identify which key succeeded.
function identityFingerprint(age, identity, keys) {
  const known = age.publicKey?.(identity);
  if (known) return sha256Hex(Buffer.from(known)).slice(0, 16);
  if (!age.encryptRecipient) return null;
  const matched = [];
  for (const key of new Set(keys)) {
    const challenge = crypto.randomBytes(32);
    const cipher = age.encryptRecipient(challenge, key);
    try {
      if (Buffer.from(age.decrypt(cipher, identity)).equals(challenge)) matched.push(sha256Hex(Buffer.from(key)).slice(0, 16));
    } catch { /* not this recipient; never report challenge or identity contents */ }
  }
  return matched.length === 1 ? matched[0] : null;
}

export async function audit(cfg, o) {
  const write = out(o);
  const age = o.age || realAge;
  const sample = o.sample ?? 3;
  const rec = { at: Date.now(), ok: false, segments: [], daily_fp: null, recovery_fp: null, recipients: [] };
  const save = () => atomicWrite(path.join(cfg.stateDir, 'restore-audit.json'), JSON.stringify(rec));
  let fps;
  try { fps = recipientFingerprints(cfg.archive.recipientsFile).split(','); } catch (e) { write(`audit failed: ${e.message}`); save(); return { ok: false }; }
  rec.recipients = [...fps].sort();
  const keys = fs.readFileSync(cfg.archive.recipientsFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!o.identity) throw new Error('audit: --identity is required');
  const res = await withClient(cfg, async (c) => {
    const rows = await listRows(c, 'limit=1000');
    if (!rows.length) { write('audit failed: the archive holds no segments'); return false; }
    const recent = rows.filter((r) => r.stored_at * 1000 >= Date.now() - 30 * 86400000);
    if (!recent.length) { write('audit failed: no segment from the last 30 days; a rehearsal must cover the current chain'); return false; }
    const pick = (arr) => arr[crypto.randomInt(arr.length)];
    const chosen = [pick(recent)];
    const rest = rows.filter((r) => r.id !== chosen[0].id);
    while (chosen.length < Math.min(sample, rows.length) && rest.length) chosen.push(rest.splice(crypto.randomInt(rest.length), 1)[0]);
    rec.segments = chosen.map((r) => r.id);
    const checked = new Set();
    for (const row of chosen.filter((r) => r.kind === 'transcript')) {
      const key = `${row.agent}/${row.session_id}`;
      if (!checked.has(key)) { await chainOf(c, row.session_id, row.agent, rows); checked.add(key); }
    }
    const segs = [];
    for (const r of chosen) segs.push(await getSegment(c, r.id, r));
    const tryKey = (name, identity) => {
      let ok = 0; let bad = 0;
      for (const g of segs) { try { openSegment(g, age, identity); ok += 1; } catch (e) { bad += 1; write(`${name}: ${e.message}`); } }
      write(`${name}: ok ${ok} bad ${bad}`);
      return bad === 0 && ok === segs.length;
    };
    const dailyOk = tryKey('daily', o.identity);
    const recoveryOk = o.recoveryIdentity ? tryKey('recovery', o.recoveryIdentity) : false;
    if (!o.recoveryIdentity) write('recovery: not audited (no --recovery-identity); the sweeper will keep refusing');
    const d = identityFingerprint(age, o.identity, keys);
    const r = o.recoveryIdentity ? identityFingerprint(age, o.recoveryIdentity, keys) : null;
    rec.daily_fp = d; rec.recovery_fp = r;
    const mapped = Boolean(d) && Boolean(r) && d !== r && fps.includes(d) && fps.includes(r);
    if (!mapped && o.recoveryIdentity) write('audit failed: could not tie two DIFFERENT keys to current recipients');
    return dailyOk && recoveryOk && mapped;
  }).catch((e) => { write(`audit failed: ${String(e.message).slice(0, 120)}`); return false; });
  rec.ok = res === true;
  save();
  write(rec.ok ? 'audit ok: both keys decrypt real segments; restore-audit.json written' : 'audit NOT ok: restore-audit.json records ok:false, so the sweeper keeps refusing');
  return { ok: rec.ok };
}

// ---- pins ----------------------------------------------------------------------------------------------------------------------------

export async function pins(cfg, o = {}) {
  const write = out(o);
  const r = await withClient(cfg, (c) => c.get.request('GET', '/v1/archive/status'));
  if (!r.ok) { write(`pins: server answered ${r.status || r.error}`); return { ok: false }; }
  const ch = r.json.recipient_changes || [];
  if (!ch.length) write('no recipient change flagged');
  for (const x of ch) write(`${x.project}: pinned ${x.pinned} now ${x.now} (changed ${x.changed_at}); acknowledge on the VDS: cammut archive pins ack -project ${x.project}`);
  return { ok: true, changes: ch.length };
}

// ---- doctor ----------------------------------------------------------------------------------------------------------------------------

const dirSize = (d) => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } } catch { /* absent */ } return n; };
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

export async function doctor(cfg, o = {}) {
  const write = out(o);
  const age = o.age || realAge;
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const rows = [];
  const add = (check, result, detail) => { rows.push({ check, result, detail }); write(`${check.padEnd(16)} | ${result.padEnd(4)} | ${detail}`); };
  const ver = age.version();
  add('age', ver ? 'PASS' : 'FAIL', ver ? `age ${ver}` : 'the age CLI is not on PATH (winget install --id FiloSottile.age)');
  let recipientsOk = false;
  try { const f = recipientFingerprints(cfg.archive.recipientsFile); recipientsOk = true; add('recipients', 'PASS', `${f.split(',').length} public keys (fingerprints ${f})`); } catch (e) { add('recipients', 'FAIL', e.message); }
  add('zstd', typeof zlib.zstdCompressSync === 'function' ? 'PASS' : 'WARN', typeof zlib.zstdCompressSync === 'function' ? 'zlib.zstdCompressSync present' : 'absent: brotli is used instead');
  const wname = cfg.cammut.tokenEnv || 'CAMMUT_MEMORY_TOKEN'; const rname = cfg.cammut.readTokenEnv || 'CAMMUT_ARCHIVE_READ_TOKEN';
  const wset = Boolean(env[wname]); const rset = Boolean(env[rname]);
  add('tokens', !wset ? 'FAIL' : rset ? 'PASS' : 'WARN', `${wname}=${wset ? 'set' : 'MISSING'} ${rname}=${rset ? 'set' : 'MISSING'}${rset ? '' : ' (needed for status, audit, fetch and the sweeper)'}`);
  const st = await withClient(cfg, (c) => c.get.request('GET', '/v1/archive/status'));
  add('server', st.ok ? 'PASS' : st.status === 403 ? 'WARN' : 'FAIL', st.ok ? `reachable, ${st.json.segments} segments` : st.status === 403 ? 'reachable, but the token lacks archive/list' : `unreachable (${st.status || st.error})`);
  if (!ver || !recipientsOk || !wset) add('self-test', 'SKIP', 'needs age, a trusted recipients file and the archive token');
  else {
    // a 1 KiB segment sealed with the real age, uploaded, checked with HEAD; fixed id, so repeating it creates nothing new
    const raw = Buffer.from(`${JSON.stringify({ type: 'user', cwd: 'doctor-selftest', message: { content: 'self-test' } })}\n`.padEnd(1024, ' ').slice(0, 1023) + '\n');
    const meta = { agent: 'claude-code', project: 'doctor-selftest', session: 'doctor-selftest', kind: 'transcript', relpath: '', fp: sha256Hex(Buffer.from('doctor-selftest')), start: 0, end: raw.length, recipients: recipientsOk ? recipientFingerprints(cfg.archive.recipientsFile) : '' };
    try {
      const seg = sealSegment({ meta, rawBytes: raw, recipientsFile: cfg.archive.recipientsFile, encrypt: cfg.encrypt ?? ageEncrypt, doRedact: true });
      const r = await withClient(cfg, async (c) => {
        const put = await putSegment(c.put, seg, seg.cipher);
        if (put.status !== 200 && put.status !== 201) return { fail: `PUT answered ${put.status || put.error}` };
        const head = await c.put.request('HEAD', `/v1/archive/segments/${seg.id}`);
        if (head.status !== 200) return { fail: `HEAD answered ${head.status || head.error}` };
        return head.headers['x-content-sha256'] === put.json.sha256 ? { ok: true } : { fail: 'HEAD sha256 differs from the stored one' };
      });
      add('self-test', r.ok ? 'PASS' : 'FAIL', r.ok ? 'sealed with age, uploaded, HEAD sha256 matches' : r.fail);
    } catch (e) { add('self-test', 'FAIL', String(e.message).slice(0, 120)); }
  }
  try { const run = S.loadRunning(path.join(home, '.claude')); add('registry', 'PASS', `~/.claude/sessions readable, ${run.size} running`); } catch { add('registry', 'FAIL', '~/.claude/sessions is missing or not readable (the sweeper would abort)'); }
  const rt = cfg.retention;
  add('retention', 'INFO', `enabled=${rt.enabled} localRetentionDays=${rt.localRetentionDays} reviewed=${S.isReviewed()} (enable it only with: sweep.mjs retention enable --days N)`);
  const a = archiveStatus(cfg);
  const days = a.oldestUnarchivedMs / 86400000;
  add('unarchived', days > 10 ? 'WARN' : 'PASS', a.oldestUnarchivedMs ? `oldest unarchived transcript is ${days.toFixed(1)} days old${days > 10 ? '; Claude Code\'s own cleanup may delete it' : ''}` : 'every tracked transcript is archived');
  const cp = readJson(path.join(home, '.claude', 'settings.json'), {}).cleanupPeriodDays;
  add('cleanupPeriod', typeof cp === 'number' && cp < 7 ? 'WARN' : 'INFO', `cleanupPeriodDays=${cp ?? 'not set (default 30)'}; keep it at 30: it is the backstop for what the sweeper does not touch`);
  const sd = cfg.stateDir;
  const sess = dirSize(path.join(sd, 'sessions'));
  add('state:brief', 'INFO', `${fmt(dirSize(path.join(sd, 'brief')))} derived brief cache (disable: briefCache.enabled=false)`);
  add('state:sessions', 'INFO', `${fmt(sess)} offsets, fingerprints and acknowledged ranges (pruned 3 days after a transcript is gone)`);
  add('state:logs', 'INFO', `${fmt(fileSize(path.join(sd, 'hook.log')) + fileSize(path.join(sd, 'hook.log.1')) + fileSize(path.join(sd, 'sweep.log')))} hook.log and sweep.log (counts, ids and hashes only)`);
  add('state:records', 'INFO', `${fmt(fileSize(path.join(sd, 'dryrun.json')) + fileSize(path.join(sd, 'restore-audit.json')))} dryrun.json and restore-audit.json`);
  add('state:outbox', 'INFO', `${fmt(dirSize(path.join(sd, 'outbox')))} ciphertext until acknowledged (cap ${fmt(cfg.archive.outboxMaxBytes)})`);
  add('state:spool', 'INFO', `${fmt(dirSize(path.join(sd, 'spool')))} references only, no text`);
  return rows;
}

// ---- command line ---------------------------------------------------------------------------------------------------------------------------

const USAGE = `usage: cammut-archive.mjs <command>
  backfill [--dry-run] [--agent claude-code|codex] [--max-mb N] [--since YYYY-MM-DD]
  status | pins | doctor
  fetch   --session ID [--agent A] [--out DIR]
  decrypt --session ID --identity FILE [--out FILE | --grep RE] [--force]
  restore --session ID --identity FILE [--strip-thinking]
  audit   [--sample N] --identity FILE --recovery-identity FILE
  sweep [--yes] | retention enable --days N | retention disable | quarantine list|restore --id X|purge-now`;

function flagsOf(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) f[k] = true; else { f[k] = v; i++; }
  }
  return f;
}

export async function main(argv, io = {}) {
  const write = out(io);
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { write(USAGE); return cmd ? 0 : 2; }
  if (!['backfill', 'status', 'pins', 'doctor', 'fetch', 'decrypt', 'restore', 'audit', 'sweep', 'retention', 'quarantine'].includes(cmd)) { write(USAGE); return 2; }
  const cfg = io.cfg || loadConfig();
  const f = flagsOf(rest);
  try {
    if (cmd === 'sweep' || cmd === 'retention' || cmd === 'quarantine') return await S.main(argv, io.sweepDeps);
    if (cmd === 'backfill') { const r = await backfill(cfg, { write, dryRun: f.dryRun === true, agent: f.agent, maxMb: f.maxMb ? Number(f.maxMb) : undefined, since: f.since }); return r.failed || r.retry ? 1 : 0; }
    if (cmd === 'status') { await status(cfg, { write }); return 0; }
    if (cmd === 'pins') return (await pins(cfg, { write })).ok ? 0 : 1;
    if (cmd === 'doctor') return (await doctor(cfg, { write })).some((r) => r.result === 'FAIL') ? 1 : 0;
    if (cmd === 'fetch') { await fetchSession(cfg, { write, session: f.session, agent: f.agent, out: f.out }); return 0; }
    if (cmd === 'decrypt') { await decryptSession(cfg, { write, session: f.session, agent: f.agent, identity: f.identity, out: f.out, grep: typeof f.grep === 'string' ? f.grep : undefined, force: f.force === true }); return 0; }
    if (cmd === 'restore') { await restoreSession(cfg, { write, session: f.session, agent: f.agent, identity: f.identity, stripThinking: f.stripThinking === true }); return 0; }
    if (cmd === 'audit') return (await audit(cfg, { write, sample: f.sample ? Number(f.sample) : 3, identity: f.identity, recoveryIdentity: f.recoveryIdentity })).ok ? 0 : 1;
  } catch (e) {
    write(`error: ${String(e.message).slice(0, 300)}`);
    return 1;
  }
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
