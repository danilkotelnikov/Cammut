#!/usr/bin/env node
// OpenViking -> Cammut migration of the curated memories. Three steps, each safe to repeat:
//
//   export --out <dir>             READ-ONLY. Copies the .md pages under viking://user/alice/memories (and viking://agent
//                                  if it exists) to <dir>, plus manifest.json. Only GET requests are sent. Prints counts.
//   map --in <dir> [--project P]   Dry run: proposes Cammut notes from the exported pages and writes <dir>/proposal.json.
//                                  Prints counts, keys and flags, never page text.
//   map --in <dir> --apply         Creates the proposed notes through Cammut REST (needs CAMMUT_URL and CAMMUT_MEMORY_TOKEN).
//   scan-directives --in <dir>     Reads Hindsight directives text on stdin (JSON list or plain text), lists every viking://
//                                  reference and the migrated note keys that replace it. Exit 1 = something needs rewriting.
//
// Environment: SM_OV_URL (default http://127.0.0.1:1933) and SHARED_MEMORY_OPENVIKING_API_KEY for export; CAMMUT_URL and
// CAMMUT_MEMORY_TOKEN for --apply. Keys are read from the environment only and never printed.
//
// Mapping:
//   preferences/**          kind=preference, epistemic=observed (the owner's curated pages), key pref.<name>
//   entities/<type>/<name>  kind=state, epistemic=inferred, key entity.<type>.<name>
//   events/yyyy/mm/dd/<n>   kind=finding, epistemic=inferred, key event.<date>.<n>
//   anything else           kind=finding (persona pages: preference), epistemic=inferred, key ov.<path>, flagged for review
//   a non-preference page that reads like a plan, budget or headcount is epistemic=speculative and flagged: it is stored
//   but never reaches the brief until a person confirms it.
// A page longer than one note (1500 characters) is split on paragraph breaks into keyed parts; nothing is cut.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { redact } from '../common.mjs';

const MAX_BODY = 1400; // Cammut notes hold 1500 characters; leave room for redaction markers
const MAX_TITLE = 120;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MEMORIES = 'viking://user/alice/memories';
const DEFAULT_ROOTS = [MEMORIES, 'viking://agent'];
const OV_URL_DEFAULT = 'http://127.0.0.1:1933';

// ---- OpenViking reader (GET only) -----------------------------------------------------------------

export function ovReader(env = process.env) {
  const base = (env.SM_OV_URL || OV_URL_DEFAULT).replace(/\/+$/, '');
  const key = env.SHARED_MEMORY_OPENVIKING_API_KEY;
  return async (pathAndQuery) => {
    if (!key) throw new Error('SHARED_MEMORY_OPENVIKING_API_KEY MISSING');
    try {
      const res = await fetch(base + pathAndQuery, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000) });
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* plain text body */ }
      return { status: res.status, text: raw, json };
    } catch (e) {
      return { status: 0, text: '', json: null, error: e?.name || 'network' };
    }
  };
}

const lsItems = (r) => (Array.isArray(r?.json?.result) ? r.json.result : []);
const isDir = (e) => e.isDir === true || e.is_dir === true;

// content/read answers {result: "<text>"}, {result: {content|text}}, {content}, {text}, or the text itself.
export function pageText(r) {
  const j = r.json;
  if (j && typeof j === 'object') {
    for (const v of [j.result, j.content, j.text, j.result?.content, j.result?.text]) if (typeof v === 'string') return v;
    return null;
  }
  return typeof r.text === 'string' ? r.text : null;
}

// A listing entry becomes a path inside the output folder, or null when it cannot be mirrored safely.
function localPath(uri) {
  const m = /^viking:\/\/(.+)$/.exec(uri);
  if (!m) return null;
  const parts = [];
  for (const raw of m[1].split('/')) {
    let seg;
    try { seg = decodeURIComponent(raw); } catch { return null; }
    if (seg === '' || seg === '.' || seg === '..' || /[\\/]/.test(seg) || seg.includes('\0')) return null;
    parts.push(seg.replace(/[<>:"|?*]/g, '_'));
  }
  return path.join('files', ...parts);
}

export async function exportTree({ ov, out, roots = DEFAULT_ROOTS, say = console.log }) {
  fs.mkdirSync(out, { recursive: true });
  const result = { files: 0, skippedDerived: 0, skippedOther: 0, refused: 0, bytes: 0, missingRoots: [] };
  const manifest = [];
  const seen = new Set();
  for (const root of roots) {
    const ls = await ov(`/api/v1/fs/ls?uri=${encodeURIComponent(root)}&recursive=true`);
    if (ls.status === 404) { result.missingRoots.push(root); continue; }
    if (ls.status < 200 || ls.status >= 300) throw new Error(`ls ${root} failed: status=${ls.status}${ls.error ? ` (${ls.error})` : ''}`);
    for (const e of lsItems(ls)) {
      const uri = String(e.uri);
      if (isDir(e) || seen.has(uri)) continue;
      seen.add(uri);
      const rel = localPath(uri);
      if (!rel) { result.refused++; continue; }
      const base = path.basename(rel);
      if (base.startsWith('.')) { result.skippedDerived++; continue; } // .abstract.md and .overview.md are generated indexes
      if (!/\.md$/i.test(base)) { result.skippedOther++; continue; }
      const r = await ov(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`);
      const text = r.status === 200 ? pageText(r) : null;
      if (text === null) throw new Error(`read failed for one page: status=${r.status}`);
      const file = path.join(out, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: 0o600 });
      manifest.push({ uri, path: rel.split(path.sep).join('/'), bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') });
      result.files++;
      result.bytes += Buffer.byteLength(text);
    }
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ exported_at: new Date().toISOString(), roots, files: manifest }, null, 2), { mode: 0o600 });
  say(`exported ${result.files} pages (${result.bytes} bytes) to ${out}; skipped ${result.skippedDerived} generated overviews, ${result.skippedOther} non-markdown, refused ${result.refused} unsafe paths; roots not found: ${result.missingRoots.length ? result.missingRoots.join(', ') : 'none'}`);
  return result;
}

// ---- mapper ---------------------------------------------------------------------------------------

const slug = (s, keep = '') => String(s).toLowerCase().replace(new RegExp(`[^a-z0-9${keep}]+`, 'g'), '-').replace(/^-+|-+$/g, '').slice(0, 50);
const stripExt = (s) => s.replace(/\.md$/i, '');
const ALIASES = [[/^0*\d*_?start_here/i, 'pref.work-style']];

const SIGNALS = [/\bplan(s|ned|ning)?\b/i, /\broadmap\b/i, /\bmilestones?\b/i, /\bbudget(s)?\b/i, /\bheadcount\b/i, /\bhir(e|es|ing)\b/i, /\bforecast\b/i,
  /\bestimate(s|d)?\b/i, /\bproposal\b/i, /\btargets?\b/i, /[$€£₽]\s?\d/, /\bnext (week|month|quarter|year)\b/i, /\bwill (hire|spend|launch|ship|raise)\b/i];

// A page that reads like a plan: two or more different planning signals.
function speculation(text) {
  const hits = SIGNALS.map((re) => re.exec(text)?.[0]?.toLowerCase()).filter(Boolean);
  return new Set(hits).size >= 2 ? [...new Set(hits)].slice(0, 4).join(', ') : '';
}

function headline(text, fallback) {
  const m = /^#\s+(.+)$/m.exec(text);
  return (m ? m[1] : fallback).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

// Parts of at most max characters: paragraph breaks first, then lines, then whitespace. join('') keeps every character.
export function splitBody(text, max = MAX_BODY) {
  if (text.length <= max) return [text];
  const cut = (chunk) => {
    if (chunk.length <= max) return [chunk];
    const window = chunk.slice(0, max);
    let at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    if (at < max * 0.3) at = max; // no break worth taking: split hard
    else at += window[at] === '\n' && window[at + 1] === '\n' ? 2 : 1;
    return [chunk.slice(0, at), ...cut(chunk.slice(at))];
  };
  const parts = [];
  let cur = '';
  for (const piece of text.split(/(?<=\n\n)/)) { // keep each paragraph's trailing blank line with it
    if ((cur + piece).length <= max) { cur += piece; continue; }
    if (cur) parts.push(cur);
    cur = '';
    const sub = cut(piece);
    cur = sub.pop();
    parts.push(...sub);
  }
  if (cur) parts.push(cur);
  return parts;
}

function classify(uri) {
  const rel = uri.replace(/^viking:\/\/user\/alice\/memories\//, '').replace(/^viking:\/\//, '');
  const segs = rel.split('/').filter(Boolean);
  const file = stripExt(segs[segs.length - 1] || '');
  const top = segs[0];
  if (top === 'preferences') {
    const alias = ALIASES.find(([re]) => re.test(file));
    return { kind: 'preference', epistemic: 'observed', curated: true, base: alias ? alias[1] : `pref.${slug(file.replace(/^\d+_/, ''))}`, name: file };
  }
  if (top === 'entities' && segs.length >= 3) {
    return { kind: 'state', epistemic: 'inferred', curated: false, base: `entity.${slug(segs[1], '_')}.${slug(segs.slice(2).map(stripExt).join('-'))}`, name: file };
  }
  if (top === 'events') {
    const date = segs.length >= 5 && /^\d{4}$/.test(segs[1]) ? `${segs[1]}-${segs[2]}-${segs[3]}` : '';
    return { kind: 'finding', epistemic: 'inferred', curated: false, base: `event.${date ? `${date}.` : ''}${slug(file)}`, name: file };
  }
  const persona = /^(identity|soul)$/i.test(file);
  return { kind: persona ? 'preference' : 'finding', epistemic: 'inferred', curated: false, review: 'page outside preferences/entities/events: review', base: `ov.${slug(segs.map(stripExt).join('-'))}`, name: file };
}

export function planNotes(files) {
  const notes = [];
  const taken = new Set();
  for (const f of files) {
    const c = classify(f.uri);
    const text = redact(f.text);
    let epistemic = c.epistemic;
    let flagged = false;
    let reason = c.review || '';
    if (!c.curated) {
      const why = speculation(text);
      if (why) { epistemic = 'speculative'; flagged = true; reason = `reads like a plan (${why})`; }
    }
    if (c.review) flagged = true;
    const parts = splitBody(text);
    const title = headline(text, c.name.replace(/[_-]+/g, ' '));
    let base = c.base.slice(0, 70);
    for (let i = 2; taken.has(base); i++) base = `${c.base.slice(0, 66)}-${i}`; // two pages with the same slug stay apart
    taken.add(base);
    parts.forEach((body, i) => {
      const key = i === 0 ? base : `${base}.${i + 1}`;
      const suffix = parts.length > 1 ? ` (${i + 1}/${parts.length})` : '';
      notes.push({ uri: f.uri, key, part: i + 1, parts: parts.length, kind: c.kind, epistemic, flagged, reason, title: title.slice(0, MAX_TITLE - suffix.length) + suffix, body });
      if (!KEY_RE.test(key)) throw new Error(`derived key is not valid for one page: ${key}`);
    });
  }
  return { notes };
}

const squash = (s) => s.replace(/\s+/g, '');

// Every source page must come back unchanged (whitespace aside) from its notes, in order.
export function losslessCheck(files, notes) {
  const failures = [];
  for (const f of files) {
    const mine = notes.filter((n) => n.uri === f.uri).sort((a, b) => a.part - b.part);
    if (squash(mine.map((n) => n.body).join('')) !== squash(redact(f.text))) failures.push(`${f.uri}: the notes do not reproduce the page`);
  }
  return { ok: failures.length === 0, failures };
}

// ---- directives -----------------------------------------------------------------------------------

const URI_RE = /viking:\/\/[^\s"'`)\]>,;]+/g;

// directivesText: a JSON list of {id,name,content|text|prompt} or plain text. Each viking:// reference is matched to the
// migrated keys of that page; replacement [] means the page was not migrated.
export function scanDirectives(directivesText, notes) {
  let items = [{ name: '(text)', content: directivesText }];
  try {
    const j = JSON.parse(directivesText);
    const list = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : Array.isArray(j?.directives) ? j.directives : null;
    if (list) items = list.map((d) => ({ name: d.name || d.title || d.id || '(unnamed)', content: [d.content, d.text, d.prompt, d.directive].filter((x) => typeof x === 'string').join('\n') }));
  } catch { /* plain text */ }
  const rows = [];
  for (const d of items) {
    for (const uri of new Set(String(d.content).match(URI_RE) || [])) {
      const clean = uri.replace(/[.]+$/, '');
      const keys = notes.filter((n) => n.uri === clean).sort((a, b) => a.part - b.part).map((n) => n.key);
      rows.push({ directive: String(d.name), uri: clean, replacement: keys });
    }
  }
  return rows;
}

// ---- apply ----------------------------------------------------------------------------------------

export async function applyPlan({ notes, url, token, project = 'general', apply = false, say = console.log }) {
  const base = String(url || '').replace(/\/+$/, '');
  const out = { created: 0, unchanged: 0, failed: 0, wouldCreate: 0 };
  const call = async (method, p, body) => {
    try {
      const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      let json = null;
      try { json = await res.json(); } catch { /* empty */ }
      return { status: res.status, json };
    } catch (e) {
      return { status: 0, json: null, error: e?.name || 'network' };
    }
  };
  const current = async (key) => {
    const r = await call('GET', `/v1/memory/history?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}`);
    return r.status === 200 ? (r.json?.notes || []).find((n) => n.status === 'active') : undefined;
  };
  if (!apply) {
    for (const n of notes) out.wouldCreate++;
    say(`dry run: ${notes.length} notes would be sent to project ${project}; add --apply to create them`);
    return out;
  }
  for (const n of notes) {
    const have = await current(n.key);
    if (have && have.body === n.body) { out.unchanged++; continue; }
    const r = await call('POST', '/v1/memory/notes', {
      project, kind: n.kind, key: n.key, title: n.title, body: n.body, epistemic: n.epistemic,
      importance: n.kind === 'preference' ? 4 : 3, tags: ['migrated-openviking'], force: true,
    });
    if (r.status === 201) out.created++;
    else { out.failed++; say(`failed ${n.key}: HTTP ${r.status}${r.json?.error ? ` ${String(r.json.error).slice(0, 120)}` : ''}${n.epistemic === 'observed' && r.status === 400 ? ' (observed notes need a token with scope memory/observe)' : ''}`); }
  }
  let verified = 0;
  for (const n of notes) if ((await current(n.key))?.body === n.body) verified++;
  say(`created ${out.created}, unchanged ${out.unchanged}, failed ${out.failed}; verified ${verified}/${notes.length} notes read back identical`);
  out.verified = verified;
  return out;
}

// ---- command line ---------------------------------------------------------------------------------

const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function loadExport(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return manifest.files.map((f) => ({ uri: f.uri, text: fs.readFileSync(path.join(dir, ...f.path.split('/')), 'utf8') }));
}

export async function run({ argv = process.argv.slice(2), env = process.env, say = console.log, stdin } = {}) {
  const [cmd] = argv;
  try {
    if (cmd === 'export') {
      const out = flag(argv, '--out');
      if (!out) { say('usage: ov-export.mjs export --out <dir>'); return 2; }
      if (!env.SHARED_MEMORY_OPENVIKING_API_KEY) { say('SHARED_MEMORY_OPENVIKING_API_KEY MISSING'); return 2; }
      await exportTree({ ov: ovReader(env), out, say });
      return 0;
    }
    if (cmd === 'map') {
      const dir = flag(argv, '--in');
      if (!dir) { say('usage: ov-export.mjs map --in <dir> [--project P] [--apply]'); return 2; }
      const project = flag(argv, '--project') || 'general';
      const apply = argv.includes('--apply');
      if (apply && (!(env.CAMMUT_URL || flag(argv, '--cammut-url')) || !env.CAMMUT_MEMORY_TOKEN)) { say('--apply needs CAMMUT_URL (or --cammut-url) and CAMMUT_MEMORY_TOKEN in the environment'); return 2; }
      const files = loadExport(dir);
      const { notes } = planNotes(files);
      const lossless = losslessCheck(files, notes);
      fs.writeFileSync(path.join(dir, 'proposal.json'), JSON.stringify({ project, notes, lossless }, null, 2), { mode: 0o600 });
      const by = {};
      for (const n of notes) by[`${n.kind}/${n.epistemic}`] = (by[`${n.kind}/${n.epistemic}`] || 0) + 1;
      say(`${files.length} pages -> ${notes.length} notes for project ${project}: ${Object.entries(by).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      for (const n of notes.filter((x) => x.flagged && x.part === 1)) say(`flagged ${n.epistemic}: ${n.key} (${n.reason}) <- ${n.uri}`);
      say(`lossless check: ${lossless.ok ? 'every page is reproduced by its notes' : `FAILED for ${lossless.failures.length} page(s)`}`);
      if (!lossless.ok) { for (const f of lossless.failures) say(f); return 1; }
      const r = await applyPlan({ notes, url: env.CAMMUT_URL || flag(argv, '--cammut-url'), token: env.CAMMUT_MEMORY_TOKEN, project, apply, say });
      return r.failed ? 1 : 0;
    }
    if (cmd === 'scan-directives') {
      const dir = flag(argv, '--in');
      if (!dir) { say('usage: ov-export.mjs scan-directives --in <dir>  (directives text on stdin)'); return 2; }
      const proposal = JSON.parse(fs.readFileSync(path.join(dir, 'proposal.json'), 'utf8'));
      const text = stdin !== undefined ? stdin : fs.readFileSync(0, 'utf8');
      const rows = scanDirectives(text, proposal.notes);
      for (const r of rows) say(`${r.directive} -> ${r.uri}\n    replace with: ${r.replacement.length ? `memory_recall / memory_brief notes with key ${r.replacement.join(', ')}` : 'NOT MIGRATED (no note carries this page)'}`);
      say(rows.length ? `${rows.length} viking:// reference(s) need rewriting before OpenViking is stopped` : 'no viking:// references found');
      return rows.length ? 1 : 0;
    }
    say('usage: ov-export.mjs export|map|scan-directives (see the header of this file)');
    return 2;
  } catch (e) {
    say(`stopped: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await run();
}
