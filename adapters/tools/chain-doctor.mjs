#!/usr/bin/env node
// Read-only diagnosis of the memory chain on the PC: registered hooks and their hashes, node, environment variables
// (set|MISSING only), reachability of every service, the Hindsight bank override, OpenViking capture, spool and breaker,
// hook.log freshness, opt-outs. It never writes anything and never prints a secret or any conversation text.
//   node adapters/tools/chain-doctor.mjs [--json]      exit 1 when any check is FAIL
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archiveStatus } from '../archive.mjs';
import { quarantineList } from '../sweep.mjs';
import { install } from '../install.mjs';
import { DEFAULT_CAMMUT_URL } from '../common.mjs';

export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const EXPECT = {
  SessionStart: { args: 'recall', minTimeout: 8 },
  UserPromptSubmit: { args: 'recall', minTimeout: 8 },
  Stop: { args: 'capture', minTimeout: 10 },
  PreCompact: { args: 'capture --flush' },
  SessionEnd: { args: 'capture --flush' },
};

// split a command line on whitespace outside double quotes (backslashes are literal: Windows paths)
export function tokenize(cmd) {
  const out = [];
  let cur = ''; let quoted = false; let has = false;
  for (const ch of String(cmd)) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

// settings: parsed settings.json; installed: parsed .installed.json (or null); fsx: {exists(p), sha(p)}.
export function checkHooks(settings, installed, fsx = { exists: fs.existsSync, sha: sha256 }) {
  const problems = []; const warnings = []; const hooks = [];
  for (const [event, want] of Object.entries(EXPECT)) {
    const found = (settings?.hooks?.[event] || []).flatMap((e) => e.hooks || []).filter((h) => h.type === 'command' && /sm\.mjs/.test(String(h.command)));
    if (!found.length) { problems.push(`${event}: no sm.mjs hook registered`); continue; }
    for (const h of found) {
      const tok = tokenize(h.command);
      const i = tok.findIndex((x) => /sm\.mjs$/.test(x));
      if (i < 0) { problems.push(`${event}: cannot find sm.mjs in the command`); continue; }
      const script = tok[i]; const node = i > 0 ? tok[0] : 'node'; const args = tok.slice(i + 1).join(' ');
      hooks.push({ event, script, node, args, timeout: h.timeout });
      if (args !== want.args) problems.push(`${event}: runs "sm.mjs ${args}", expected "sm.mjs ${want.args}"`);
      if (want.minTimeout && typeof h.timeout === 'number' && h.timeout < want.minTimeout) problems.push(`${event}: timeout ${h.timeout}s is below ${want.minTimeout}s`);
      if (!fsx.exists(script)) { problems.push(`${event}: ${script} does not exist`); continue; }
      const recorded = installed?.files?.[path.basename(script)];
      if (!installed) warnings.push('no .installed.json next to the hook script: it was not installed by adapters/install.mjs');
      else if (!recorded) warnings.push(`${path.basename(script)} is not in .installed.json`);
      else if (fsx.sha(script) !== recorded) problems.push(`${event}: ${path.basename(script)} differs from the hash recorded by install.mjs (edited in place?)`);
    }
  }
  return { problems, warnings: [...new Set(warnings)], hooks };
}

export function summarizeLog(text, now = Date.now()) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
    if (m && !Number.isNaN(Date.parse(m[1]))) rows.push({ ts: Date.parse(m[1]), msg: m[2] });
  }
  const counts = { recall: 0, capture: 0, drain: 0, failed: 0 };
  let injected = 0;
  for (const r of rows) {
    if (now - r.ts > 24 * 3600 * 1000) continue;
    const first = r.msg.split(' ')[0];
    if (first in counts && first !== 'failed') counts[first] += 1;
    if (/^\S+ failed:/.test(r.msg)) counts.failed += 1;
    injected += Number(/injected=(\d+)/.exec(r.msg)?.[1] || 0);
  }
  const newest = rows.reduce((a, r) => Math.max(a, r.ts), 0) || null;
  // a failure line may quote an error message; keep only the error name
  const last = rows.slice(-5).map((r) => `${new Date(r.ts).toISOString()} ${r.msg.replace(/^(\S+ failed: \w+).*$/, '$1').slice(0, 120)}`);
  return { last, counts, injected, newest, ageMs: newest === null ? null : now - newest };
}

const row = (check, result, detail) => ({ check, result, detail });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const lookPath = (name, env) => {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) for (const x of exts) if (fs.existsSync(path.join(dir, name + x))) return path.join(dir, name + x);
  return null;
};

function transcriptsChangedSince(projectsDir, since) {
  let n = 0;
  try {
    for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(projectsDir, d.name))) {
        if (!f.endsWith('.jsonl') || ++n > 20000) continue;
        if (fs.statSync(path.join(projectsDir, d.name, f)).mtimeMs >= since) return true;
      }
    }
  } catch { /* no projects dir */ }
  return false;
}

async function probe(fetchFn, url, key) {
  const t0 = Date.now();
  try {
    const res = await fetchFn(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(3000) });
    return { up: true, status: res.status, ms: Date.now() - t0, res };
  } catch (e) {
    return { up: false, status: 0, ms: Date.now() - t0, error: e?.name || 'network' };
  }
}

export async function diagnose({ env = process.env, home = os.homedir(), fetch: fetchFn = globalThis.fetch, now = Date.now(), loadInstalledConfig } = {}) {
  const rows = [];
  const claude = path.join(home, '.claude');
  const settings = readJson(path.join(claude, 'settings.json'), null);

  // 1 hooks-registered, 2 node-path
  let scriptPath = null;
  if (!settings) rows.push(row('hooks-registered', 'FAIL', `${path.join(claude, 'settings.json')} missing or unreadable`));
  else {
    const dirOf = (h) => path.dirname(h.script);
    const first = checkHooks(settings, null, { exists: fs.existsSync, sha: sha256 }).hooks[0];
    const installed = first ? readJson(path.join(dirOf(first), '.installed.json'), null) : null;
    const r = checkHooks(settings, installed);
    scriptPath = r.hooks[0]?.script || null;
    const repoCopy = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'claude-code', 'sm.mjs');
    if (scriptPath && fs.existsSync(scriptPath) && fs.existsSync(repoCopy) && sha256(scriptPath) !== sha256(repoCopy)) r.warnings.push('installed sm.mjs differs from the repo copy (run: node adapters/install.mjs)');
    const detail = [...r.problems, ...r.warnings].join('; ') || `${r.hooks.length} hooks registered, hashes match .installed.json`;
    rows.push(row('hooks-registered', r.problems.length ? 'FAIL' : r.warnings.length ? 'WARN' : 'PASS', detail));
    const nodes = [...new Set(r.hooks.map((h) => h.node))];
    const bad = nodes.filter((n) => (/[\\/]/.test(n) ? !fs.existsSync(n) : !lookPath(n, env)));
    rows.push(row('node-path', !nodes.length || bad.length ? 'FAIL' : 'PASS', nodes.length ? (bad.length ? `not found: ${bad.join(', ')}` : nodes.join(', ')) : 'no hooks'));
  }

  // 3 env: names and set|MISSING only
  const need = ['SHARED_MEMORY_HINDSIGHT_API_KEY', 'SHARED_MEMORY_OPENVIKING_API_KEY'];
  const status = (k) => `${k}=${env[k] ? 'set' : 'MISSING'}`;
  rows.push(row('env', need.some((k) => !env[k]) ? 'FAIL' : 'PASS', [...need, 'CAMMUT_MEMORY_TOKEN'].map(status).join(' ') + (env.CAMMUT_MEMORY_TOKEN ? '' : ' (not needed before plan 2)')));

  // effective configuration of the INSTALLED adapter
  const cfgFile = env.SM_CONFIG || path.join(claude, 'shared-memory.json');
  const file = readJson(cfgFile, {});
  let cfg = null;
  if (scriptPath && fs.existsSync(scriptPath)) {
    try { cfg = await (loadInstalledConfig ? loadInstalledConfig(scriptPath, env) : import(pathToFileURL(scriptPath).href).then((m) => m.loadConfig(env))); } catch { cfg = null; }
  }
  const hsUrl = cfg?.hs?.url || env.SM_HS_URL || file.hindsight?.url || 'http://127.0.0.1:8888';
  const ovUrl = cfg?.ov?.url || env.SM_OV_URL || file.openviking?.url || 'http://127.0.0.1:1933';
  const bank = cfg?.hs?.bank || file.hindsight?.bank || 'alice-shared';
  const stateDir = cfg?.stateDir || env.SM_STATE_DIR || path.join(claude, 'state', 'shared-memory');

  // 4 reach: keys go only to Hindsight and OpenViking, never to Cammut or the public name
  const targets = [
    ['hindsight', `${hsUrl}/health`, env.SHARED_MEMORY_HINDSIGHT_API_KEY, 'FAIL'],
    ['openviking', `${ovUrl}/health`, env.SHARED_MEMORY_OPENVIKING_API_KEY, 'FAIL'],
    ['cammut-local', `${file.cammut?.url || DEFAULT_CAMMUT_URL}/healthz`, null, 'WARN'],
    // No public name is assumed: probe it only when the user configured one.
    ['cammut-public', file.cammut?.publicUrl ? `${String(file.cammut.publicUrl).replace(/\/+$/, '')}/healthz` : null, null, 'WARN'],
  ];
  const up = {};
  for (const [name, url, key, downResult] of targets) {
    if (!url) { rows.push(row(`reach:${name}`, 'INFO', 'cammut.publicUrl not set in shared-memory.json; not probed')); continue; }
    const p = await probe(fetchFn, url, key);
    up[name] = p.up && p.status >= 200 && p.status < 500;
    rows.push(row(`reach:${name}`, up[name] ? 'PASS' : downResult, `tunnel=${up[name] ? 'up' : 'down'} ${p.up ? `status=${p.status}` : `error=${p.error}`} ${p.ms}ms`));
  }

  // 5 hindsight-bank
  if (!up.hindsight || !env.SHARED_MEMORY_HINDSIGHT_API_KEY) rows.push(row('hindsight-bank', 'SKIP', 'Hindsight not reachable or key missing'));
  else {
    const p = await probe(fetchFn, `${hsUrl}/v1/default/banks/${encodeURIComponent(bank)}/config`, env.SHARED_MEMORY_HINDSIGHT_API_KEY);
    let j = null;
    try { j = await p.res.json(); } catch { /* not json */ }
    const c = j?.config || {};
    const detail = `bank=${bank} store_document_text=${c.store_document_text} recall_include_chunks=${c.recall_include_chunks} overrides=${Object.keys(j?.overrides || {}).sort().join(',') || '(none)'}`;
    rows.push(row('hindsight-bank', p.status !== 200 ? 'FAIL' : c.store_document_text === false ? (c.recall_include_chunks === false ? 'PASS' : 'WARN') : 'FAIL', p.status !== 200 ? `status=${p.status}` : detail));
  }

  // 6 openviking-capture: from the installed adapter's own loadConfig
  rows.push(cfg ? row('openviking-capture', cfg.ov.capture === false ? 'PASS' : 'FAIL', `capture=${cfg.ov.capture}${cfg.ov.capture ? ' (raw session archives are written)' : ''}`) : row('openviking-capture', 'WARN', 'could not load the installed adapter to read its configuration'));

  // 7 spool + breaker
  const spoolDir = path.join(stateDir, 'spool');
  let files = [];
  try { files = fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).sort(); } catch { /* none */ }
  const oldest = files.length ? now - (Number(files[0].split('-')[0]) || now) : 0;
  const breaker = readJson(path.join(stateDir, 'breaker.json'), {});
  const open = Object.entries(breaker).filter(([, t]) => now - t < 45000).map(([k]) => k);
  rows.push(row('spool', oldest > 7 * 24 * 3600 * 1000 ? 'FAIL' : files.length && oldest > 3600 * 1000 ? 'WARN' : 'PASS', `pending=${files.length} oldest_age_s=${Math.round(oldest / 1000)} breaker_open=${open.join(',') || 'none'}`));

  // 8 hook-log
  let logText = '';
  try { logText = fs.readFileSync(path.join(stateDir, 'hook.log'), 'utf8'); } catch { /* none */ }
  const s = summarizeLog(logText, now);
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const active = transcriptsChangedSince(path.join(claude, 'projects'), midnight.getTime());
  const stale = s.ageMs === null || s.ageMs > 7 * 24 * 3600 * 1000;
  rows.push(row('hook-log', stale && active ? 'FAIL' : stale ? 'WARN' : 'PASS', `24h recall=${s.counts.recall} capture=${s.counts.capture} drain=${s.counts.drain} failed=${s.counts.failed} injected=${s.injected}; newest=${s.newest ? new Date(s.newest).toISOString() : 'none'}${stale && active ? '; transcripts changed today but the hooks have not run for 7 days' : ''}`));
  for (const l of s.last) rows.push(row('hook-log:last', 'INFO', l));

  // 9 archive and retention (phase 2): everything below is read-only, fingerprints, counts and sizes only
  rows.push(...await archiveChecks({ cfg, env, stateDir, claude, home, now, fetchFn, scriptDir: scriptPath ? path.dirname(scriptPath) : null }));

  // 10 opt-outs
  rows.push(row('opt-outs', env.SHARED_MEMORY_BYPASS ? 'WARN' : 'PASS', `SHARED_MEMORY_BYPASS ${env.SHARED_MEMORY_BYPASS ? `is set (=${env.SHARED_MEMORY_BYPASS === '1' ? '1' : 'other'}) in this environment` : 'is not set'}`));
  return rows;
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);
const sizeOfTree = (d) => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? sizeOfTree(p) : fs.statSync(p).size; } } catch { /* absent */ } return n; };
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const hrs = (ms) => `${(ms / 3600000).toFixed(1)}h`;

// Legacy queue items embed messages; current items reference transcript byte ranges.
// Only classify their shape: never report any message body or source path.
export function spoolKinds(dir) {
  const counts = { references: 0, inlineMessages: 0, unknown: 0 };
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return counts; }
  for (const file of files) {
    const item = readJson(path.join(dir, file), null);
    if (!item || typeof item !== 'object' || Array.isArray(item)) counts.unknown++;
    else if (Object.hasOwn(item, 'messages')) counts.inlineMessages++;
    else if (item.kind === 'range' && typeof item.file === 'string') counts.references++;
    else counts.unknown++;
  }
  return counts;
}

async function archiveChecks({ cfg, env, stateDir, claude, home, now, fetchFn, scriptDir }) {
  const rows = [];
  const adapters = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (scriptDir) {
    const res = install({ srcDir: adapters, dstDir: scriptDir, check: true });
    const bad = res.filter((r) => r.status !== 'unchanged');
    rows.push(row('installed-files', bad.length ? 'WARN' : 'PASS', bad.length ? `${bad.map((r) => `${r.name}:${r.status}`).join(', ')} (run: node adapters/install.mjs)` : `${res.length} installed files match the repo`));
  }
  const ar = cfg?.archive;
  const acfg = { ...(cfg || {}), stateDir };
  if (!ar?.enabled) rows.push(row('archive', 'PASS', 'disabled (archive.enabled is not true): transcripts stay on the PC and nothing is uploaded'));
  else {
    const wTok = env[cfg.cammut.tokenEnv]; const rTok = env[cfg.cammut.readTokenEnv];
    rows.push(row('archive', wTok ? 'PASS' : 'FAIL', `enabled, ${cfg.cammut.tokenEnv}=${wTok ? 'set' : 'MISSING'} ${cfg.cammut.readTokenEnv}=${rTok ? 'set' : 'MISSING'}, recipients file ${fs.existsSync(ar.recipientsFile) ? 'present' : 'MISSING'}`));
    const a = archiveStatus(acfg, now);
    const oldestBox = (() => { try { return Math.max(0, ...fs.readdirSync(path.join(stateDir, 'outbox')).filter((f) => f.endsWith('.json')).map((f) => now - (readJson(path.join(stateDir, 'outbox', f), {}).createdAt || now))); } catch { return 0; } })();
    rows.push(row('archive:outbox', a.outbox.failed || oldestBox > 7 * 86400000 ? 'FAIL' : oldestBox > 86400000 ? 'WARN' : 'PASS', `${a.outbox.count} segments, ${fmtSize(a.outbox.bytes)}, failed=${a.outbox.failed}, oldest=${hrs(oldestBox)}`));
    rows.push(row('archive:acked', a.oldestUnarchivedMs > 10 * 86400000 ? 'WARN' : 'PASS', `acked ranges=${a.ackedRanges}; oldest unarchived transcript age=${a.oldestUnarchivedMs ? hrs(a.oldestUnarchivedMs) : '-'}${a.oldestUnarchivedMs > 10 * 86400000 ? " (Claude Code's own cleanup could delete it during a long outage)" : ''}`));
    const tok = rTok || wTok;
    if (!tok) rows.push(row('archive:replica', 'WARN', 'no token set, cannot read the server status'));
    else {
      let st = null; let code = 0;
      try {
        const res = await fetchFn(`${cfg.cammut.url}/v1/archive/status`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(4000) });
        code = res.status;
        if (res.status === 200) st = await res.json();
      } catch { code = 0; }
      if (!st) rows.push(row('archive:replica', 'WARN', code === 403 ? 'the token lacks archive/list, so the replica status cannot be read' : `server status unavailable (${code || 'unreachable'})`));
      else {
        const last = st.replica?.last_run_at ? Date.parse(st.replica.last_run_at) : NaN;
        const age = Number.isNaN(last) ? null : now - last;
        rows.push(row('archive:replica', age === null || age > 36 * 3600000 || st.replica.unreplicated > 0 ? 'WARN' : 'PASS', `last run ${age === null ? 'never' : `${hrs(age)} ago`}; replicated=${st.replica?.replicated} unreplicated=${st.replica?.unreplicated}; oldest unreplicated age=${Math.round((st.replica?.oldest_unreplicated_age_s || 0) / 3600)}h`));
        const ch = st.recipient_changes || [];
        rows.push(row('archive:recipients', ch.length ? 'FAIL' : 'PASS', ch.length ? `recipient set changed for ${ch.map((c) => c.project).join(', ')}; acknowledge on the server: cammut archive pins ack -project NAME` : 'no recipient change flagged by the server'));
      }
    }
  }
  // the restore rehearsal and the keys it recorded
  const audit = readJson(path.join(stateDir, 'restore-audit.json'), null);
  if (ar?.enabled || audit) {
    let fps = [];
    try { fps = fs.readFileSync(ar?.recipientsFile || '', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('age1')).map((l) => crypto.createHash('sha256').update(l).digest('hex').slice(0, 16)); } catch { /* no file */ }
    if (!audit || audit.ok !== true) rows.push(row('archive:audit', 'WARN', 'no successful two-key restore audit yet (needed before the sweeper can be enabled): run cammut-archive.mjs audit'));
    else {
      const age = now - (typeof audit.at === 'number' ? audit.at : Date.parse(audit.at));
      const keysOk = audit.daily_fp && audit.recovery_fp && fps.includes(audit.daily_fp) && fps.includes(audit.recovery_fp) && (!audit.recipients || (audit.recipients.length === fps.length && audit.recipients.every((x) => fps.includes(x))));
      rows.push(row('archive:audit', !keysOk ? 'FAIL' : age > 90 * 86400000 ? 'WARN' : 'PASS', `audited ${Math.round(age / 86400000)} days ago; daily=${audit.daily_fp} recovery=${audit.recovery_fp}; ${keysOk ? 'both are current recipients' : 'the recipients file changed since: repeat the audit'}`));
    }
  }
  // quarantine
  let q = [];
  for (const h of [claude, path.join(home, '.codex')]) q = q.concat(quarantineList(h));
  const oldestQ = q.length ? now - Math.min(...q.map((e) => e.quarantinedAt)) : 0;
  rows.push(row('archive:quarantine', oldestQ > 3 * 86400000 ? 'WARN' : 'PASS', `${q.length} entries${q.length ? `, oldest ${hrs(oldestQ)}${oldestQ > 3 * 86400000 ? ' (the grace period is 48 h: phase 2 is not purging; check the sweep preconditions)' : ''}` : ''}`));
  // what the PC keeps (derived state, all small): size and whether it can be switched off
  rows.push(row('state:brief', 'INFO', `${fmtSize(sizeOfTree(path.join(stateDir, 'brief')))} brief cache (disable: briefCache.enabled=false; without it a dead Cammut yields no injected brief)`));
  rows.push(row('state:sessions', 'INFO', `${fmtSize(sizeOfTree(path.join(stateDir, 'sessions')))} offsets, fingerprints, acknowledged ranges`));
  rows.push(row('state:logs', 'INFO', `${fmtSize(sizeOf(path.join(stateDir, 'hook.log')) + sizeOf(path.join(stateDir, 'hook.log.1')) + sizeOf(path.join(stateDir, 'sweep.log')))} hook.log and sweep.log (counts, ids, hashes)`));
  rows.push(row('state:records', 'INFO', `${fmtSize(sizeOf(path.join(stateDir, 'dryrun.json')) + sizeOf(path.join(stateDir, 'restore-audit.json')))} dryrun.json and restore-audit.json`));
  rows.push(row('state:outbox', 'INFO', `${fmtSize(sizeOfTree(path.join(stateDir, 'outbox')))} ciphertext until acknowledged`));
  const spool = spoolKinds(path.join(stateDir, 'spool'));
  let failed = 0;
  try { failed = fs.readdirSync(path.join(stateDir, 'spool', 'failed')).filter((f) => f.endsWith('.json')).length; } catch { /* none */ }
  rows.push(row('state:spool', spool.inlineMessages || spool.unknown || failed ? 'WARN' : 'INFO',
    `${fmtSize(sizeOfTree(path.join(stateDir, 'spool')))} pending: ${spool.references} transcript references, ${spool.inlineMessages} legacy entries with message text, ${spool.unknown} unrecognized entries; ${failed} failed items parked in spool/failed (pruned after 14 days)`));
  const cp = readJson(path.join(claude, 'settings.json'), {}).cleanupPeriodDays;
  rows.push(row('cleanup-backstop', typeof cp === 'number' && cp < 7 ? 'WARN' : 'INFO', `cleanupPeriodDays=${cp ?? 'not set (default 30)'}; keep it at 30: it is the backstop for what the sweeper does not touch${typeof cp === 'number' && cp < 7 ? '; below 7 days it can delete an un-uploaded transcript' : ''}`));
  return rows;
}

export const render = (rows) => {
  const w = Math.max(...rows.map((r) => r.check.length));
  return rows.map((r) => `${r.check.padEnd(w)} | ${r.result.padEnd(4)} | ${r.detail}`).join('\n');
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rows = await diagnose();
  console.log(process.argv.includes('--json') ? JSON.stringify(rows, null, 2) : render(rows));
  process.exitCode = rows.some((r) => r.result === 'FAIL') ? 1 : 0;
}
