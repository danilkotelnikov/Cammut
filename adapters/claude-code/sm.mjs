#!/usr/bin/env node
// Automatic recall and capture for the shared Hindsight + OpenViking memory (see README.md).
//   recall  (SessionStart, UserPromptSubmit, SubagentStart): inject the brief and relevant memories as additionalContext.
//   capture (Stop, PreCompact, SessionEnd):   sanitize new transcript text, spool it locally,
//                                             start a detached drain. SubagentStop: retain the subagent's final report
//                                             as a low-trust (epistemic:inferred) entry. See docs/HOOKS-AUTOTRIGGER.md.
//   drain:   deliver spooled chunks to both services; the spool survives a dead SSH tunnel.
//   status:  health, spool and breaker report (names only, never secrets).
// Every hook entry point fails open: it logs a one-line reason and exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// Installed flat (sm.mjs next to common.mjs) or in the repo (claude-code/sm.mjs, common.mjs one level up). The installed
// file must stay byte-identical to the repo file (chain-doctor compares hashes), hence a runtime lookup, not two copies.
const sibling = (name) => (fs.existsSync(new URL(`./${name}`, import.meta.url)) ? `./${name}` : `../${name}`);
const {
  loadConfig, redact, ensure, atomicWrite, readJson, log, lock, tripped, trip, untrip, retryable, breakerFile, loadSession, saveSession, sessionLockFile, acquireSourceLock, readRange, isOptedOut,
  cammutClient, briefCache, formatBrief, UNTRUSTED_MEMORY, escapeMemory, escapeAttribute,
  restoreCheckpoint, formatCheckpoint, writeHookOutput, putCheckpoint,
} = await import(sibling('common.mjs'));
const { registerArchive, archiveStep, uploadOutbox, outboxList, archiveStatus } = await import(sibling('archive.mjs'));
const { recallBody, recallWithFallback, parseMinScores } = await import(sibling('hs-recall.mjs'));
export { loadConfig, redact, isOptedOut };
const MAX_MSG = 3000;
const SUMMARY_MAX = 6000;
const CHUNK_CHARS = 6000;
const MIN_TURNS = 3;
const OV_COMMIT_EVERY = 40;
const BACKLOG_CHARS = 60000;
const MAX_READ = 8 * 1024 * 1024;
const SPOOL_MAX = 300;
const SPOOL_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

// ---- sanitizing ---------------------------------------------------------------------------

const WRAPPERS = ['system-reminder', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr', 'command-name', 'command-message', 'command-args', 'task-notification', 'ide_opened_file', 'ide_selection', 'shared-memory', 'project-brief', 'brief-update'];

export function cleanText(s) {
  let t = String(s ?? '');
  for (const w of WRAPPERS) t = t.replace(new RegExp(`<${w}\\b[^>]*>[\\s\\S]*?</${w}>`, 'g'), '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

const cap = (t, max) => {
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.67);
  return `${t.slice(0, head)}\n…[truncated]…\n${t.slice(-(max - head))}`;
};

// ---- transcript -----------------------------------------------------------------------------

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
};

export function extractMessages(jsonl) {
  const out = [];
  for (const raw of String(jsonl).split('\n')) {
    if (!raw.trim()) continue;
    let j;
    try { j = JSON.parse(raw); } catch { continue; }
    if (j.isSidechain || j.isMeta || j.isApiErrorMessage) continue;
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    const summary = j.type === 'user' && j.isCompactSummary === true;
    // redact first, then truncate, so a secret cut in half can never survive
    const text = redact(cleanText(textOf(j.message?.content)));
    if (!text || text.startsWith('[Request interrupted')) continue;
    out.push({ role: summary ? 'summary' : j.type, text: cap(text, summary ? SUMMARY_MAX : MAX_MSG), ts: j.timestamp || '' });
  }
  return out;
}

export function readIncrement(file, offset) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { text: '', offset, reset: false }; }
  const reset = size < offset;
  const start = reset ? 0 : offset;
  const len = Math.min(size - start, MAX_READ);
  if (len <= 0) return { text: '', offset: start, reset };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const nl = buf.lastIndexOf(10);
  if (nl < 0) return { text: '', offset: start, reset };
  return { text: buf.subarray(0, nl + 1).toString('utf8'), offset: start + nl + 1, reset };
}

export function splitChunks(messages, maxChars = CHUNK_CHARS) {
  const chunks = [];
  let cur = [];
  let n = 0;
  for (const m of messages) {
    if (cur.length && n + m.text.length > maxChars) { chunks.push(cur); cur = []; n = 0; }
    cur.push(m);
    n += m.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const stamp = (ts) => (ts ? ts.slice(0, 16).replace('T', ' ') : '');

export function formatChunk(messages, { project, sid }) {
  const day = stamp(messages.find((m) => m.ts)?.ts).slice(0, 10);
  const head = `Claude Code session excerpt. project: ${project}. session: ${sid.slice(0, 8)}. date: ${day}.\n`
    + '"User" is the human who owns this memory. "Assistant" is Claude; its statements are unverified claims, not facts.\n';
  const body = messages.map((m) => (m.role === 'summary'
    ? `Earlier session summary: ${m.text}`
    : `[${stamp(m.ts)}] ${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)).join('\n\n');
  return `${head}\n${body}`;
}

// ---- recall formatting -----------------------------------------------------------------------

// Hindsight ranks by relevance but never says "nothing relevant": an unrelated prompt still returns its top few
// keyword hits (measured: no semantic score at all, keyword 0.2-0.5), while genuinely relevant notes carry a
// semantic score of 0.34-0.70. Requiring a real semantic match keeps a new, unrelated project quiet.
const MIN_SEMANTIC = 0.3;
const notRelevant = (r) => r.scores != null && !(typeof r.scores.semantic === 'number' && r.scores.semantic >= MIN_SEMANTIC);

const esc = escapeMemory;
const norm = (t) => String(t).toLowerCase().replace(/\s*\|.*$/s, '').replace(/[^a-z0-9а-яё]+/g, ' ').trim().slice(0, 80);

// Cammut ranks inside one answer and normalises to the top hit (the best of a bad lot still scores 1), so its score alone cannot
// say "nothing relevant". The local floor therefore asks for a relative score and, by default, one shared word with the prompt.
const STOP = new Set(('the and for you your can are not was but all any our out use get got has its let may new now old see too who why yes one two did how what when '
  + 'where which that this with from have would could should about there their please continue next step then them into does will just like make need want also okay thanks').split(' '));
export const queryTerms = (text) => [...new Set(String(text ?? '').toLowerCase().replace(/\(project: [^)]*\)\s*$/, '').match(/[a-zа-яё0-9_.-]{3,}/g) || [])]
  .filter((w) => !STOP.has(w)).map((w) => (w.length > 6 ? w.slice(0, 6) : w.replace(/s$/, '')));

export function passesFloor(n, terms, inject = {}) {
  if (typeof n?.score !== 'number') return true; // an older server sends no ranking: nothing to judge by
  if (n.score < (inject.minScore ?? 0.55)) return false;
  if (inject.requireOverlap === false) return true;
  const words = `${n.title ?? ''} ${n.body ?? ''} ${(n.tags || []).join(' ')}`.toLowerCase().match(/[a-zа-яё0-9_.-]+/g) || [];
  return terms.some((t) => words.some((w) => w.startsWith(t)));
}

export function formatRecall({ cm = [], hs = [], ov = [], project, seen = new Set(), now = new Date(), maxHits = Infinity, maxChars = Infinity }) {
  const ids = new Set();
  const entries = [];
  for (const n of cm) {
    if (!n || typeof n !== 'object') continue;
    const id = `cm:${n.id}`;
    const body = String(n.body || '').trim();
    if (!n.id || !body || seen.has(id) || ids.has(id)) continue;
    ids.add(id);
    const when = String(n.updated_at || '').slice(0, 10);
    entries.push({ src: 'cm', id, line: `- [${esc(n.kind || 'note')}${when ? ' ' + esc(when) : ''}] **${esc(n.title || '')}** — ${esc(body.slice(0, 300))}` });
  }
  const keys = new Set();
  let hsCount = 0;
  for (const r of [...hs].sort((a, b) => (b.type === 'observation') - (a.type === 'observation'))) {
    const id = `hs:${redact(String(r.id ?? ''))}`;
    const text = redact(String(r.text || '')).trim();
    if (!text || seen.has(id) || notRelevant(r) || keys.has(norm(text))) continue;
    keys.add(norm(text));
    const when = redact(String(r.mentioned_at || r.occurred_start || '')).slice(0, 10);
    entries.push({ src: 'hs', id, line: `- [${esc(redact(String(r.type || 'fact')))}${when ? ' ' + esc(when) : ''}] ${esc(cap(text, 400))}` });
    if (++hsCount >= 8) break;
  }
  let ovCount = 0;
  for (const e of ov) {
    const uri = redact(String(e.uri ?? ''));
    const id = `ov:${uri}`;
    const text = redact(String(e.text || '')).trim();
    // directory overviews and account-root descriptions are navigation aids, not memories
    const shallow = String(e.uri).replace('viking://', '').split('/').filter(Boolean).length <= 2;
    if (!text || (e.score ?? 0) < 0.45 || seen.has(id) || e.detail === 'overview' || shallow) continue;
    entries.push({ src: 'ov', id, line: `- [${esc(redact(String(e.category || 'memory')))} ${esc(uri)}] ${esc(cap(text.replace(/\n+/g, ' '), 500))}` });
    if (++ovCount >= 4) break;
  }
  let kept = entries.slice(0, maxHits);
  if (!kept.length) return null;
  const render = (list) => {
    const lines = (src) => list.filter((e) => e.src === src).map((e) => e.line);
    return [
      `<shared-memory project="${escapeAttribute(redact(String(project)))}" retrieved="${now.toISOString().slice(0, 16)}Z">`,
      `Notes recalled from the user's long-term memory (${lines('cm').length ? 'Cammut, ' : ''}Hindsight, OpenViking). ${UNTRUSTED_MEMORY}`,
      ...(lines('cm').length ? ['Cammut notes:', ...lines('cm')] : []),
      ...(lines('hs').length ? ['Hindsight:', ...lines('hs')] : []),
      ...(lines('ov').length ? ['OpenViking:', ...lines('ov')] : []),
      '</shared-memory>',
    ].join('\n');
  };
  let text = render(kept);
  while (text.length > maxChars && kept.length > 1) text = render(kept = kept.slice(0, -1));
  if (text.length > maxChars) { // one hit left and still too long: shorten its line
    const line = kept[0].line;
    kept = [{ ...kept[0], line: `${line.slice(0, Math.max(40, line.length - (text.length - maxChars) - 1))}…` }];
    text = render(kept);
  }
  return { text, ids: kept.map((e) => e.id) };
}

// ---- guards and state --------------------------------------------------------------------------

export const projectOf = (cwd) => path.basename(String(cwd || '').replace(/[\\/]+$/, '')) || 'unknown';

// ---- http -------------------------------------------------------------------------------------

async function call(cfg, svc, method, urlPath, body, ms = cfg.requestMs) {
  const s = cfg[svc];
  try {
    const res = await fetch(s.url + urlPath, {
      method,
      headers: { Authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e?.name || 'network' };
  }
}

// ---- spool + drain ---------------------------------------------------------------------------

const spoolDir = (cfg) => path.join(cfg.stateDir, 'spool');
export const spoolFiles = (cfg) => {
  try { return fs.readdirSync(spoolDir(cfg)).filter((f) => f.endsWith('.json')).sort(); }
  catch (e) { if (e?.code === 'ENOENT') return []; throw new Error('spool-unreadable'); }
};

const failedDir = (cfg) => path.join(spoolDir(cfg), 'failed');

// Park an item that cannot be delivered. spool/failed is outside the live capacity count, still protects its transcript
// from the sweeper (spoolRefsFor reads it) and is pruned by age. Never throws: capture must not stop because of it.
function parkFailed(cfg, name, it, failure) {
  try {
    atomicWrite(path.join(ensure(failedDir(cfg)), name), JSON.stringify({ ...it, status: 'failed', failure, failedAt: Date.now() }));
    fs.rmSync(path.join(spoolDir(cfg), name), { force: true });
  } catch (e) { log(cfg, `park failed item ${String(failure)}: ${e?.name}`); }
}

function pruneFailed(cfg) {
  try {
    for (const f of fs.readdirSync(failedDir(cfg))) {
      const file = path.join(failedDir(cfg), f);
      if (Date.now() - fs.statSync(file).mtimeMs > SPOOL_MAX_AGE_MS) fs.rmSync(file, { force: true });
    }
  } catch { /* none yet */ }
}

let enqueueSeq = 0;
export function enqueue(cfg, it) {
  const dir = ensure(spoolDir(cfg));
  // the counter keeps arrival order inside one millisecond, so "oldest" in the overflow below is really the oldest
  const name = `${Date.now()}-${String(enqueueSeq++).padStart(6, '0')}-${crypto.randomBytes(4).toString('hex')}.json`;
  atomicWrite(path.join(dir, name), JSON.stringify({ done: {}, attempts: 0, createdAt: Date.now(), status: 'local_queued', ...it }));
  try {
    for (const old of spoolFiles(cfg).slice(0, -SPOOL_MAX)) {
      const item = readJson(path.join(dir, old), null);
      if (item) parkFailed(cfg, old, item, 'spool_overflow'); else fs.rmSync(path.join(dir, old), { force: true });
    }
  } catch { /* an unreadable spool is reported by the next drain; the new item is already safe */ }
  return name;
}

// A spool item is a reference {file, start, end} into the agent's own transcript: the text is read here, at send time,
// in RAM, and never written anywhere. A legacy item that still carries `messages` is delivered as it is.
function chunksOf(it) {
  if (it.kind !== 'range') return { chunks: it.messages ? [it.messages] : [], id: () => it.chunkId };
  const buf = readRange(it.file, it.start, it.end);
  if (!buf) return null;
  let msgs = extractMessages(buf.toString('utf8'));
  if (it.first) msgs = tailWithin(msgs, BACKLOG_CHARS);
  return { chunks: splitChunks(msgs), id: (i) => `${it.chunkId}-${i}` };
}

// the newest messages that fit the budget; compaction summaries are always kept
function tailWithin(msgs, budget) {
  const tail = [];
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'summary' || budget > 0) { tail.unshift(msgs[i]); budget -= msgs[i].text.length; } }
  return tail;
}

// A UUIDv5-shaped id derived from bank and chunk: a retry after a lost response reuses it, so Hindsight sees one retain.
function operationID(bank, chunkId) {
  const b = crypto.createHash('sha256').update(`${bank}\0${chunkId}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function send(cfg, it, target, messages, chunkId) {
  if (target === 'hs') {
    return call(cfg, 'hs', 'POST', `/v1/default/banks/${encodeURIComponent(cfg.hs.bank)}/memories`, {
      async: true,
      operation_id: operationID(cfg.hs.bank, chunkId),
      items: [{
        content: formatChunk(messages, { project: it.project, sid: it.sid }),
        context: `claude-code:${it.project}`,
        document_id: chunkId,
        tags: [`project:${it.project}`, 'source:claude-code'],
        timestamp: messages.find((m) => m.ts)?.ts || undefined,
        metadata: { source: 'claude-code', session: it.sid.slice(0, 8) },
      }],
    });
  }
  const session = `cc-${it.sid}`;
  if (target === 'ov') {
    return call(cfg, 'ov', 'POST', `/api/v1/sessions/${session}/messages/batch`, {
      messages: messages.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.role === 'summary' ? `[Earlier session summary] ${m.text}` : m.text,
        created_at: m.ts || undefined,
      })),
    });
  }
  return call(cfg, 'ov', 'POST', `/api/v1/sessions/${session}/commit`, {});
}

// Hindsight retain is asynchronous: HTTP 200 only means accepted. Remember the operation id per chunk and poll it on later
// drains instead of retaining again. Returns 'done', 'retry' or 'failed' (it.failure says why).
async function deliverHindsight(cfg, it, built, blocked) {
  it.sent ||= {};
  it.hsOps ||= {};
  const base = `/v1/default/banks/${encodeURIComponent(cfg.hs.bank)}`;
  const retry = () => { blocked.add('hs'); trip(cfg, 'hs'); it.attempts += 1; return 'retry'; };
  for (let i = it.sent.hs || 0; i < built.chunks.length; i++) {
    const id = operationID(cfg.hs.bank, built.id(i));
    const op = it.hsOps[i];
    if (op) {
      const r = await call(cfg, 'hs', 'GET', `${base}/operations/${encodeURIComponent(op)}`, undefined, cfg.recallMs || 3500);
      if (!r.ok) {
        if (retryable(r)) return retry();
        it.failure = `operation_status_${r.status}`;
        return 'failed';
      }
      untrip(cfg, 'hs');
      switch (r.json?.status) {
        case 'completed': it.sent.hs = i + 1; it.status = 'completed'; delete it.hsOps[i]; continue;
        case 'failed': case 'cancelled': it.failure = `operation_${r.json.status}`; return 'failed';
        case 'running': case 'processing': it.status = 'processing'; return 'retry';
        default: it.status = 'server_durable'; return 'retry';
      }
    }
    const r = await send(cfg, it, 'hs', built.chunks[i], built.id(i));
    if (!r.ok) {
      if (retryable(r)) return retry();
      log(cfg, `drain hs permanent failure status=${r.status}`);
      it.failure = `retain_${r.status}`;
      return 'failed';
    }
    untrip(cfg, 'hs');
    if (r.json?.async === false && r.json?.success === true) { it.sent.hs = i + 1; it.status = 'completed'; continue; }
    if (r.json?.operation_id && r.json.operation_id !== id) { it.failure = 'operation_id_mismatch'; return 'failed'; }
    it.hsOps[i] = id; // the seeded id is known even if the response body was empty
    it.status = 'server_durable';
    return 'retry';
  }
  return 'done';
}

// Deliver one target of one item chunk by chunk; it.sent[target] counts the chunks already delivered, so a partial
// delivery resumes at the next chunk. Returns 'done', 'retry' or 'failed' (a permanent 4xx skips that chunk).
async function deliver(cfg, it, target, svc, built, blocked) {
  if (target === 'hs') return deliverHindsight(cfg, it, built, blocked);
  it.sent ||= {};
  if (target === 'ovCommit') {
    const r = await send(cfg, it, target);
    if (r.ok) { untrip(cfg, svc); return 'done'; }
    if (retryable(r)) { blocked.add(svc); trip(cfg, svc); it.attempts += 1; return 'retry'; }
    log(cfg, `drain ${target} permanent failure status=${r.status}`);
    it.failure = `${target}_${r.status}`;
    return 'failed';
  }
  for (let i = it.sent[target] || 0; i < built.chunks.length; i++) {
    const r = await send(cfg, it, target, built.chunks[i], built.id(i));
    if (r.ok) untrip(cfg, svc);
    else if (retryable(r)) { blocked.add(svc); trip(cfg, svc); it.attempts += 1; return 'retry'; }
    else log(cfg, `drain ${target} permanent failure status=${r.status}`);
    it.sent[target] = i + 1;
  }
  return 'done';
}

export async function drain(cfg) {
  ensure(cfg.stateDir);
  const lockFile = path.join(cfg.stateDir, 'drain.lock');
  if (!lock(lockFile, 5 * 60 * 1000)) return;
  try {
    const blocked = new Set();
    // Cammut-only: items queued earlier by the default mode stay where they are (never sent to Hindsight/OpenViking, never dropped)
    for (const name of cfg.cammutOnly ? [] : spoolFiles(cfg)) {
      const file = path.join(spoolDir(cfg), name);
      const it = readJson(file, null);
      if (!it) { log(cfg, `invalid spool item ${name}`); fs.rmSync(file, { force: true }); continue; }
      if (Date.now() - it.createdAt > SPOOL_MAX_AGE_MS) { parkFailed(cfg, name, it, 'age_limit'); continue; }
      const built = chunksOf(it);
      if (!built) { log(cfg, `source gone ${String(it.sid).slice(0, 8)}`); parkFailed(cfg, name, it, 'source_gone'); continue; }
      const steps = [];
      if (cfg.hs.capture) steps.push(['hs', 'hs']);
      if (cfg.ov.capture) { steps.push(['ov', 'ov']); if (it.commit) steps.push(['ovCommit', 'ov']); }
      for (const [target, svc] of steps) {
        if (it.done[target]) continue;
        if (blocked.has(svc) || tripped(cfg, svc)) { blocked.add(svc); continue; }
        if (target === 'ovCommit' && !it.done.ov) continue;
        const outcome = await deliver(cfg, it, target, svc, built, blocked);
        if (outcome === 'done') it.done[target] = true;
        else if (outcome === 'failed') it.done[target] = 'failed';
      }
      if (steps.some(([t]) => it.done[t] === 'failed')) parkFailed(cfg, name, it, it.failure || 'delivery_failed');
      else if (steps.every(([t]) => it.done[t] === true)) fs.rmSync(file, { force: true });
      else if (it.attempts >= 50) parkFailed(cfg, name, it, 'retry_limit');
      else atomicWrite(file, JSON.stringify(it));
    }
    pruneFailed(cfg);
    await archiveWork(cfg);
  } finally { fs.rmSync(lockFile, { force: true }); atomicWrite(path.join(cfg.stateDir, 'drain.last'), String(Date.now())); }
}

// cut, seal and upload; never allowed to break the delivery above or the hook that spawned us
async function archiveWork(cfg) {
  try {
    await archiveStep(cfg);
    if (outboxList(cfg).length) await uploadOutbox(cfg);
  } catch (e) { log(cfg, `archive step failed: ${e?.name}: ${String(e?.message).slice(0, 100)}`); }
}

function spawnDrain() {
  if (process.env.SM_NO_SPAWN) return;
  try { spawn(process.execPath, [SELF, 'drain'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* next hook retries */ }
}

// the drain also carries the archive: start it on a session start when none ran for a while (idle tails are cut then)
const drainStale = (cfg) => { try { return Date.now() - fs.statSync(path.join(cfg.stateDir, 'drain.last')).mtimeMs > 5 * 60 * 1000; } catch { return true; } };

// Sweeping is driven by SessionStart/SessionEnd, at most once an hour, and only when the user enabled retention; the drain never
// sweeps and a PC nobody uses does not need to. The detached run is `sweep.mjs sweep --yes --quiet`, which refuses on its own
// unless retention is enabled, the code is reviewed and every precondition holds. An agent never registers a scheduled task.
export function sweepDue(cfg, now = Date.now()) {
  if (cfg.retention?.enabled !== true) return false;
  try { return now - fs.statSync(path.join(cfg.stateDir, 'sweep.last')).mtimeMs > 3600 * 1000; } catch { return true; }
}

export function maybeSweep(cfg) {
  if (!sweepDue(cfg)) return false;
  atomicWrite(path.join(ensure(cfg.stateDir), 'sweep.last'), String(Date.now()));
  if (process.env.SM_NO_SPAWN) return true;
  try { spawn(process.execPath, [fileURLToPath(new URL(sibling('sweep.mjs'), import.meta.url)), 'sweep', '--yes', '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* the next hook retries */ }
  return true;
}

// ---- hook entry points ----------------------------------------------------------------------

// ---- SubagentStop ----------------------------------------------------------------------------------
// The final report of a subagent is an AI claim about work nobody checked: it is stored as a low-trust, inferred journal entry
// (tag epistemic:inferred), redacted, capped, and only when it is long enough to carry something. It is sent at once with a short
// timeout and is NOT spooled (the spool holds byte ranges of transcripts, never text); if the service is down the report is lost,
// which is the right price for low-trust text. Cammut has no journal store: a note (kind finding, importance 1) is written only
// when hooks.subagentNotes is on, because core briefs would otherwise fill with agent chatter.
const SUBAGENT_REPORT_MAX = 3000;

export async function captureSubagent(cfg, p) {
  if (cfg.hooks?.subagent === false || isOptedOut(p.cwd, process.env)) return;
  if (!p.session_id || !p.agent_id || !p.agent_type || p.stop_hook_active === true) return;
  const text = redact(cleanText(p.last_assistant_message)).trim();
  if (text.length < (cfg.hooks?.subagentMinChars ?? 200)) return;
  const project = projectOf(p.cwd);
  const key = `sub-${p.session_id}`;
  const lockFile = sessionLockFile(cfg, key);
  if (!lock(lockFile, 30000)) return;
  try {
    const st = loadSession(cfg, key);
    st.done = st.done || [];
    if (st.done.includes(p.agent_id)) return;
    st.done = [...st.done, p.agent_id].slice(-50);
    saveSession(cfg, key, st);
  } finally { fs.rmSync(lockFile, { force: true }); }
  const body = cap(text, SUBAGENT_REPORT_MAX);
  const type = redact(String(p.agent_type)).slice(0, 40);
  let sent = 'none';
  if (!cfg.cammutOnly && cfg.hs.capture && cfg.hs.key && !tripped(cfg, 'hs')) {
    const docId = `cc-sub-${p.session_id}-${p.agent_id}`;
    const r = await call(cfg, 'hs', 'POST', `/v1/default/banks/${encodeURIComponent(cfg.hs.bank)}/memories`, {
      async: true,
      operation_id: operationID(cfg.hs.bank, docId),
      items: [{
        content: `Claude Code subagent final report. project: ${project}. subagent type: ${type}. date: ${new Date().toISOString().slice(0, 10)}.\n`
          + 'Written by an AI subagent; unverified and low trust: treat as a lead to check, not as a fact.\n\n' + body,
        context: `claude-code-subagent:${project}`,
        document_id: docId,
        tags: [`project:${project}`, 'source:claude-code-subagent', 'epistemic:inferred'],
        metadata: { source: 'claude-code-subagent', epistemic: 'inferred', session: String(p.session_id).slice(0, 8) },
      }],
    }, 2000);
    if (r.ok) sent = 'hs'; else if (retryable(r)) trip(cfg, 'hs');
  }
  if (cfg.hooks?.subagentNotes === true && (cfg.cammut?.token || cfg.cammutOnly)) {
    const made = await cammutClient(cfg).remember({
      project, kind: 'finding', title: `Subagent ${type} report ${new Date().toISOString().slice(0, 10)}`.slice(0, 120), body: cap(text, 1400),
      tags: ['epistemic:inferred', 'source:subagent'], importance: 1,
    });
    if (made) sent = sent === 'hs' ? 'hs+cammut' : 'cammut';
  }
  log(cfg, `capture SubagentStop type=${type.slice(0, 30)} chars=${text.length} stored=${sent}`);
}

export async function captureFor(cfg, p, flush) {
  if (p.hook_event_name === 'SubagentStop') return captureSubagent(cfg, p);
  const sid = p.session_id;
  if (!sid || typeof p.transcript_path !== 'string' || !p.transcript_path || p.agent_id || isOptedOut(p.cwd, process.env)) return;
  const releaseSource = acquireSourceLock(cfg, p.transcript_path);
  if (!releaseSource) return;
  let lockFile; let gotSession = false;
  try {
    lockFile = sessionLockFile(cfg, sid);
    gotSession = lock(lockFile, 30000);
    if (!gotSession) return;
    const st = loadSession(cfg, sid);
    if (p.hook_event_name === 'PreCompact') { st.seen = []; st.seenAt = {}; }
    const project = projectOf(p.cwd);
    let kick = false;
    if (cfg.archive?.enabled) {
      const a = registerArchive(st, { file: p.transcript_path, agent: 'claude-code', project, cwd: p.cwd });
      if (flush) a.flush = true;
      kick = flush || archiveDue(cfg, a);
    }
    const first = st.offset === undefined;
    const r = readIncrement(p.transcript_path, st.offset || 0);
    const start = r.reset ? 0 : st.offset || 0;
    let msgs = extractMessages(r.text);
    if (first) msgs = tailWithin(msgs, BACKLOG_CHARS);
    const turns = msgs.filter((m) => m.role === 'user').length;
    const chars = msgs.reduce((n, m) => n + m.text.length, 0);
    if (!msgs.length || cfg.cammutOnly) st.offset = r.offset; // Cammut-only: nothing is spooled for Hindsight/OpenViking; the raw archive (above) is the capture
    else if (flush || turns >= MIN_TURNS || chars >= CHUNK_CHARS) {
      st.ovPending = (st.ovPending || 0) + msgs.length;
      const commit = flush || st.ovPending >= OV_COMMIT_EVERY;
      // no text: the item points at the bytes of the agent's own transcript and the drain reads them when it sends
      enqueue(cfg, { kind: 'range', sid, project, file: p.transcript_path, start, end: r.offset, first, chunkId: `cc-${sid}-${start}`, commit, flush });
      if (commit) st.ovPending = 0;
      st.offset = r.offset;
      log(cfg, `capture ${p.hook_event_name} spooled ${msgs.length} messages in ${splitChunks(msgs).length} chunk(s)`);
      kick = true;
    }
    saveSession(cfg, sid, st);
    if (kick) spawnDrain();
    if (p.hook_event_name === 'SessionEnd') maybeSweep(cfg);
  } finally { try { if (gotSession) fs.rmSync(lockFile, { force: true }); } finally { releaseSource(); } }
}

// enough un-acknowledged bytes to fill a segment
function archiveDue(cfg, a) {
  try { return fs.statSync(a.file).size - (a.cursor || 0) >= cfg.archive.segmentBytes; } catch { return false; }
}

const cmdCapture = (cfg, p, flush) => captureFor(cfg, p, flush);

// undefined: not attempted (disabled, no key, Cammut-only); null: attempted and failed; array: answered
async function hsRecall(cfg, query) {
  if (cfg.cammutOnly || !cfg.hs.recall || !cfg.hs.key) return undefined;
  if (tripped(cfg, 'hs')) return null;
  // Observations first, the fact types named, and a score floor asked of the server too; a server that rejects the new
  // fields gets one plain retry. `hindsight.minScores` (config) overrides the floor: "semantic=0.3,reranker=0.002" or "" for none.
  let minScores;
  try { minScores = parseMinScores(cfg.hs.minScores); } catch { minScores = undefined; }
  const recallPath = `/v1/default/banks/${encodeURIComponent(cfg.hs.bank)}/memories/recall`;
  const r = await recallWithFallback((body) => call(cfg, 'hs', 'POST', recallPath, body, cfg.recallMs), recallBody(query, { budget: 'mid', maxTokens: 800, minScores }));
  if (!r.ok) { if (retryable(r)) trip(cfg, 'hs'); return null; }
  return r.json?.results || [];
}

async function ovRecall(cfg, query) {
  if (cfg.cammutOnly || !cfg.ov.recall || !cfg.ov.key) return undefined;
  if (tripped(cfg, 'ov')) return null;
  const r = await call(cfg, 'ov', 'POST', '/api/v1/search/search', { query, mode: 'context', max_tokens: 600, purpose: 'coding' }, cfg.recallMs);
  if (!r.ok) { if (retryable(r)) trip(cfg, 'ov'); return null; }
  return r.json?.result?.entries || [];
}

// resolve with `fallback` after ms, or when the promise fails; the timer is always cleared
const deadline = (promise, ms, fallback = null) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(fallback), ms);
  Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
});
export const withAbort = (promise, ms) => deadline(promise, ms, null);

const UNAVAILABLE = '<shared-memory unavailable="true">Shared memory unavailable this session (the memory servers did not answer in time); no recall was injected.</shared-memory>';

const BRIEF_FRESH_MS = 5 * 60 * 1000;
const HOOK_BRIEF_MS = 1500;

async function briefFor(cfg, project, session, ms = HOOK_BRIEF_MS) {
  if (cfg.cammut?.brief === false) return null;
  const cache = briefCache(cfg);
  const cached = cache.get(project);
  if (cached && cached.ageMs < BRIEF_FRESH_MS) return cached;
  const fresh = await cammutClient(cfg).brief(project, { tier: cfg.cammut?.briefTier || 'core', session, ms });
  if (fresh && !fresh.delta) {
    cache.put(project, fresh.body, fresh.version, fresh);
    return { ...fresh, ageMs: 0 };
  }
  return cached ? { ...cached, stale: true } : null;
}

function warnBrief(cfg, brief) {
  const tokens = brief.tokens ?? Math.ceil(brief.body.length / 4);
  if (tokens > (cfg.inject?.warnTokens ?? 8000)) log(cfg, `brief warning tokens=${tokens}`);
}

async function briefUpdate(cfg, project, session, st, now) {
  const held = st.brief;
  if (cfg.cammut?.brief === false || !held || held.project !== project || now - (held.checkedAt ?? 0) < (cfg.briefDeltaMinMs ?? BRIEF_FRESH_MS)) return null;
  const cached = briefCache(cfg).get(project);
  const next = cached && cached.version > held.version ? cached : await cammutClient(cfg).brief(project, { tier: 'core', sinceVersion: held.version, session, ms: HOOK_BRIEF_MS });
  return { from: held.version, next, checkedAt: now };
}

function formatBriefUpdate(from, next) {
  if (!next || next.version <= from) return null;
  if (!next.delta) return `brief changed a lot (v${from} → v${next.version}): call memory_brief`;
  const lines = next.ops.map((o) => o.op === 'remove' ? `- (${esc(o.ref)})` : `${o.op === 'add' ? '+' : '~'} ${esc(o.line)}`);
  return [`<brief-update from="${from}" to="${next.version}"${next.stale ? ' stale="true"' : ''}>`, UNTRUSTED_MEMORY, ...lines, '</brief-update>'].join('\n');
}

// ---- SubagentStart ---------------------------------------------------------------------------------
// Claude Code gives SubagentStart only agent_id and agent_type (no task text), so the task is looked up: a `prompt` field if a
// later version adds one, the subagent's own transcript (first user message), else the Agent/Task tool call in the tail of the
// main transcript whose subagent_type equals agent_type. Parallel launches of one type can be ambiguous: the latest one wins.
// UNVERIFIED against a real session: the main transcript may not hold the tool call yet when this hook runs.
const SUBAGENT_CONTEXT_MAX = 10000; // additionalContext is capped at 10,000 characters
const TAIL_BYTES = 256 * 1024;

function tailLines(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the first line is cut in the middle
    return lines.filter(Boolean);
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

export function subagentTask(p) {
  const clean = (s) => redact(cleanText(s)).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (typeof p.prompt === 'string' && p.prompt.trim()) return clean(p.prompt);
  if (typeof p.agent_transcript_path === 'string' && p.agent_transcript_path) {
    let head = '';
    try {
      const fd = fs.openSync(p.agent_transcript_path, 'r');
      try { const buf = Buffer.alloc(64 * 1024); head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8'); } finally { fs.closeSync(fd); }
    } catch { /* not there yet */ }
    for (const raw of head.split('\n')) {
      const j = parseJson(raw);
      if (j?.type === 'user' && !j.isMeta) { const t = clean(textOf(j.message?.content)); if (t) return t; }
    }
  }
  if (typeof p.transcript_path === 'string' && p.transcript_path) {
    for (const raw of tailLines(p.transcript_path).reverse()) {
      const j = parseJson(raw);
      if (j?.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
      for (const b of [...j.message.content].reverse()) {
        if (b?.type !== 'tool_use' || (b.name !== 'Agent' && b.name !== 'Task') || !b.input) continue;
        if ((b.input.subagent_type || 'general-purpose') !== (p.agent_type || 'general-purpose')) continue;
        const t = clean(`${b.input.description || ''}: ${b.input.prompt || ''}`.replace(/^: /, ''));
        if (t) return t;
      }
    }
  }
  return '';
}

async function subagentStartFor(cfg, p) {
  if (cfg.hooks?.subagent === false || !p.agent_id) return null;
  const project = projectOf(p.cwd);
  const task = subagentTask(p);
  const budget = cfg.hooks?.promptBudgetMs ?? 3000;
  const configured = !!cfg.cammut?.token || cfg.cammutOnly === true;
  const direct = { ...cfg, recallMs: Math.min(cfg.recallMs ?? 3500, budget) };
  const client = cammutClient(direct);
  const query = task ? `${cap(task, 500)} (project: ${project})` : '';
  const [brief, cmRes, hsRes, ovRes] = await Promise.all([
    deadline(briefFor(cfg, project, p.session_id), budget, null),
    query && configured && cfg.cammut?.recall !== false
      ? deadline(client.recallFull(query, project, { limit: 6, session: p.session_id, ms: Math.min(HOOK_BRIEF_MS, budget) }), budget, null) : undefined,
    query ? deadline(hsRecall(direct, query), budget, null) : undefined,
    query ? deadline(ovRecall(direct, query), budget, null) : undefined,
  ]);
  const terms = queryTerms(task);
  const cm = !cmRes || cmRes.abstained ? [] : cmRes.notes.filter((n) => n && typeof n === 'object' && passesFloor(n, terms, cfg.inject));
  const out = formatRecall({ cm, hs: hsRes || [], ov: ovRes || [], project, maxHits: cfg.inject?.maxHits ?? 3, maxChars: cfg.inject?.maxChars ?? 1500 });
  if (!brief && !out) return null;
  let briefText = '';
  if (brief) {
    warnBrief(cfg, brief);
    let body = brief.body;
    briefText = formatBrief(body, project, brief);
    const room = SUBAGENT_CONTEXT_MAX - (out ? out.text.length + 1 : 0);
    if (briefText.length > room) {
      const note = '\n…[brief cut for the subagent context; the main session holds the full brief]';
      body = body.slice(0, Math.max(0, body.length - (briefText.length - room) - note.length - 10)) + note;
      briefText = formatBrief(body, project, brief);
    }
  }
  const additionalContext = [briefText, out?.text].filter(Boolean).join('\n');
  log(cfg, `recall SubagentStart type=${String(p.agent_type).slice(0, 30)} task=${task ? 'yes' : 'no'} brief=${brief ? 'yes' : 'no'} injected=${out ? out.ids.length : 0}`);
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: additionalContext.slice(0, SUBAGENT_CONTEXT_MAX) } };
}

// The checkpoint a recall served, keyed by its output object: the caller records the emission once stdout took the bytes.
const servedCheckpoints = new WeakMap();
export const servedCheckpointOf = (out) => servedCheckpoints.get(out);

export async function recallFor(cfg, p, now = Date.now(), sessionKey = p?.session_id, agent = 'claude-code') {
  if (!p || typeof p !== 'object' || isOptedOut(p.cwd, process.env)) return null;
  const event = p.hook_event_name;
  if (event === 'SubagentStart') return subagentStartFor(cfg, p);
  if (p.agent_id) return null;
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return null;
  const project = projectOf(p.cwd);
  const sid = sessionKey;
  const st0 = sid ? loadSession(cfg, sid) : {};
  const prompt = event === 'SessionStart' ? '' : redact(cleanText(p.prompt)).trim();
  if (event === 'UserPromptSubmit' && (!prompt || prompt.startsWith('/'))) return null;
  if (event === 'SessionStart') maybeSweep(cfg);
  if (spoolFiles(cfg).length || (cfg.archive?.enabled && drainStale(cfg))) spawnDrain();
  const budget = event === 'UserPromptSubmit' ? (cfg.hooks?.promptBudgetMs ?? 3000) : HOOK_BRIEF_MS;
  const configured = !!cfg.cammut?.token || cfg.cammutOnly === true;
  // the checkpoint restore starts now and runs beside the brief; one deadline aborts its fetches and forbids its receipt
  let restoring = null;
  if (event === 'SessionStart' && p.session_id) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budget);
    timer.unref?.();
    restoring = restoreCheckpoint({ ...cfg, recallMs: budget, requestMs: budget }, { cwd: p.cwd, agent, session_id: p.session_id }, { signal: ac.signal })
      .catch(() => null).finally(() => clearTimeout(timer));
  }
  const brief = event === 'SessionStart' ? await briefFor(cfg, project, p.session_id) : null;
  const query = event === 'SessionStart' ? `${project}: current status, decisions, pending work and the user's preferences` : `${cap(prompt, 500)} (project: ${project})`;
  const recall = !brief && (event === 'SessionStart' || prompt.length >= 25 || !st0.recalled);
  const direct = { ...cfg, recallMs: Math.min(cfg.recallMs ?? 3500, budget) };
  const client = cammutClient(direct);
  const failedCm = { ok: false, notes: [], abstained: false };
  const [checkpoint, update, cmRes, hsRes, ovRes] = await Promise.all([
    // fail soft: a missing server, a bad project mapping or a slow disk never costs the session its other context
    restoring, // self-limited: its fetches abort at the same budget
    event === 'UserPromptSubmit' ? briefUpdate(cfg, project, p.session_id, st0, now) : null,
    recall && event === 'UserPromptSubmit' && configured && cfg.cammut?.recall !== false
      ? deadline(client.recallFull(query, project, { limit: 6, session: p.session_id, ms: Math.min(HOOK_BRIEF_MS, budget) }), budget, failedCm) : undefined,
    recall ? deadline(hsRecall(direct, query), budget, null) : undefined,
    recall ? deadline(ovRecall(direct, query), budget, null) : undefined,
  ]);
  // every source we asked failed: the user hears it once per session instead of silently getting nothing
  const outcomes = [];
  if (event === 'SessionStart' && configured && cfg.cammut?.brief !== false) outcomes.push(!!brief);
  if (cmRes) outcomes.push(cmRes.ok);
  for (const r of [hsRes, ovRes]) if (r !== undefined) outcomes.push(r !== null);
  const unavailable = outcomes.length > 0 && outcomes.every((ok) => !ok);
  const terms = queryTerms(prompt);
  const cm = cmRes?.abstained ? [] : (cmRes?.notes || []).filter((n) => n && typeof n === 'object' && passesFloor(n, terms, cfg.inject));
  const lockFile = sid ? sessionLockFile(cfg, sid) : null;
  if (lockFile && !lock(lockFile, 30000)) return null;
  try {
    // Reload after HTTP under the capture lock: archive cursors and newly seen ids may have changed.
    const st = sid ? loadSession(cfg, sid) : {};
    // a compaction or /clear emptied the model's context: what it was shown before is new again
    if (event === 'SessionStart' && (p.source === 'compact' || p.source === 'clear')) { st.seen = []; st.seenAt = {}; }
    if (event === 'UserPromptSubmit') st.prompts = (st.prompts || 0) + 1;
    const n = st.prompts || 0;
    const window = cfg.inject?.dedupePrompts ?? 20;
    const stored = st.seen || [];
    const seen = new Set(stored.filter((id) => st.seenAt?.[id] === undefined || n - st.seenAt[id] <= window));
    const out = formatRecall({ cm, hs: hsRes || [], ov: ovRes || [], project, seen, now: new Date(now), maxHits: cfg.inject?.maxHits ?? 3, maxChars: cfg.inject?.maxChars ?? 1500 });
    const parts = [];
    if (checkpoint) parts.push(formatCheckpoint(checkpoint.checkpoint));
    if (brief) {
      warnBrief(cfg, brief);
      parts.push(formatBrief(brief.body, project, brief));
      st.brief = { project, version: brief.version, checkedAt: now };
    } else if (update && st.brief?.project === project && st.brief.version === update.from && now - (st.brief.checkedAt ?? 0) >= (cfg.briefDeltaMinMs ?? BRIEF_FRESH_MS)) {
      const text = formatBriefUpdate(update.from, update.next);
      if (text) parts.push(text);
      st.brief.checkedAt = update.checkedAt;
      if (text && update.next.delta) st.brief.version = update.next.version;
    }
    if (out) parts.push(out.text);
    if (!parts.length && unavailable && !st.unavailableShown) { parts.push(UNAVAILABLE); st.unavailableShown = true; }
    if (recall || brief) st.recalled = true;
    if (out) {
      st.seen = [...new Set([...stored, ...out.ids])].slice(-400);
      st.seenAt = { ...Object.fromEntries(Object.entries(st.seenAt || {}).filter(([id]) => st.seen.includes(id))), ...Object.fromEntries(out.ids.map((id) => [id, n])) };
    }
    if (sid) saveSession(cfg, sid, st);
    log(cfg, `recall ${event} hs=${hsRes?.length ?? 0} ov=${ovRes?.length ?? 0} injected=${out ? out.ids.length : 0} cm=${cm.length}${cmRes?.abstained ? ' abstained' : ''}${unavailable ? ' unavailable' : ''}`);
    if (!parts.length) return null;
    const result = { hookSpecificOutput: { hookEventName: event, additionalContext: parts.join('\n') } };
    if (checkpoint) servedCheckpoints.set(result, checkpoint.checkpoint);
    return result;
  } finally { if (lockFile) fs.rmSync(lockFile, { force: true }); }
}

async function cmdRecall(cfg, p) {
  // hard stop: a prompt is never held longer than this, whatever a server or a lock does
  const out = await withAbort(recallFor(cfg, p), cfg.hooks?.promptAbortMs ?? 6000);
  if (out) await writeHookOutput(cfg, JSON.stringify(out), servedCheckpointOf(out));
}

async function cmdCheckpoint(cfg, p) {
  const entry = await putCheckpoint(cfg, { ...p, agent: 'claude-code' });
  await writeHookOutput(cfg, JSON.stringify({ state: entry.state, source_revision: entry.checkpoint.source_revision }) + '\n');
}

async function cmdBrief(cfg, flags) {
  if (isOptedOut(process.cwd(), process.env)) return;
  const at = flags.indexOf('--project');
  const project = at < 0 ? projectOf(process.cwd()) : flags[at + 1];
  if (!project || project.startsWith('--')) return;
  const brief = await briefFor(cfg, project, undefined, 2500);
  if (!brief) return;
  warnBrief(cfg, brief);
  const text = formatBrief(brief.body, project, brief);
  if (flags.includes('--write')) {
    const dir = ensure(path.join(process.cwd(), '.memory'));
    atomicWrite(path.join(dir, 'HANDOFF.md'), text + '\n');
  } else process.stdout.write(text + '\n');
}

async function cmdStatus(cfg) {
  const lines = [];
  if (cfg.cammutOnly) lines.push(`cammut-only: Hindsight and OpenViking are not contacted; cammut token=${cfg.cammut?.token ? 'set' : 'MISSING'} brief=${cfg.cammut?.brief !== false} recall=${cfg.cammut?.recall !== false}`);
  for (const [name, s] of cfg.cammutOnly ? [] : [['hindsight', cfg.hs], ['openviking', cfg.ov]]) {
    const t0 = Date.now();
    const r = await call(cfg, name === 'hindsight' ? 'hs' : 'ov', 'GET', '/health', undefined, 4000);
    lines.push(`${name}: key=${s.key ? 'set' : 'MISSING'} health=${r.ok ? 'ok' : `FAIL(${r.status || r.error})`} ${Date.now() - t0}ms capture=${s.capture} recall=${s.recall}`);
  }
  if (!cfg.cammutOnly && !cfg.ov.capture) lines.push('openviking: capture=false (raw session archives are not written)');
  const ar = archiveStatus(cfg);
  lines.push(`archive: enabled=${ar.enabled} outbox=${ar.outbox.count} segments, ${(ar.outbox.bytes / 1048576).toFixed(1)} MiB; acked ranges=${ar.ackedRanges}; oldest unarchived transcript age=${ar.oldestUnarchivedMs ? (ar.oldestUnarchivedMs / 3600000).toFixed(1) + 'h' : '-'}`);
  lines.push(`spool: ${spoolFiles(cfg).length} pending`, `breaker: ${JSON.stringify(readJson(breakerFile(cfg), {}))}`, `state: ${cfg.stateDir}`);
  console.log(lines.join('\n'));
}

function readStdin(ms = 1500) {
  return new Promise((resolve) => {
    let d = '';
    const t = setTimeout(() => resolve(d), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(d); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(d); });
  });
}

async function main(argv) {
  const cfg = loadConfig();
  const [cmd, ...flags] = argv;
  try {
    if (cmd === 'status') return await cmdStatus(cfg);
    if (cmd === 'drain') return await drain(cfg);
    if (cmd === 'brief') return await cmdBrief(cfg, flags);
    let p = {};
    try { p = JSON.parse(await readStdin()); } catch { /* manual run */ }
    if (cmd === 'recall') await cmdRecall(cfg, p);
    else if (cmd === 'checkpoint') await cmdCheckpoint(cfg, p);
    else if (cmd === 'capture') await cmdCapture(cfg, p, flags.includes('--flush'));
    else console.error('usage: sm.mjs recall|checkpoint|capture [--flush]|brief [--write] [--project X]|drain|status');
  } catch (e) {
    log(cfg, `${cmd} failed: ${e?.name}: ${String(e?.message).slice(0, 160)}`);
  }
}

// No process.exit(): on Windows it can abort inside libuv while fetch sockets are still closing,
// which turns a successful hook into exit code 127.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
  process.exitCode = 0;
}
