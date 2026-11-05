#!/usr/bin/env node
// OpenViking: delete the raw session archives (viking://user/alice/sessions/<id>/history) after a one-session proof.
//   (no flags)                 dry run: sessions, archive sizes, memory count, proof status
//   --test-one <id> --yes      delete the history of ONE mcp-store-* session, compare memory counts, write the proof
//   --yes                      delete the history of every session; refused unless a passing proof younger than 7 days exists
// Only URIs of the exact form viking://user/alice/sessions/<id>/history are ever deleted. Prints ids, sizes and counts, never content.
// Key: SHARED_MEMORY_OPENVIKING_API_KEY (environment). State dir: SM_STATE_DIR or ~/.claude/state/shared-memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ov as defaultOv, lsItems, isDir, lsUrl } from './ov-client.mjs';

const ROOT = 'viking://user/alice/';
const SESSIONS = `${ROOT}sessions/`;
const MEMORIES = `${ROOT}memories`;
const PROOF_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const DELETABLE = /^viking:\/\/user\/alice\/sessions\/[A-Za-z0-9][A-Za-z0-9._-]*\/history$/;

export const deletable = (uri) => DELETABLE.test(String(uri)) && !/(^|\/)\.\.?(\/|$)/.test(String(uri));

// Per-session archive sizes from a recursive listing of the sessions tree; anything that is not under <id>/history is ignored.
export function plan(entries) {
  const byId = new Map();
  for (const e of entries) {
    const uri = String(e.uri);
    if (!uri.startsWith(SESSIONS)) continue;
    const [id, top] = uri.slice(SESSIONS.length).split('/');
    if (!id || top !== 'history') continue;
    const s = byId.get(id) || { id, history_uri: `${SESSIONS}${id}/history`, history_bytes: 0, files: 0 };
    byId.set(id, s);
    if (!isDir(e)) { s.history_bytes += Number(e.size) || 0; s.files += 1; }
  }
  return [...byId.values()];
}

// The proof: the memory counts did not move and the archive is really gone (and there was one to remove).
export function verdict(before, after) {
  return before.historyExists === true && after.historyExists === false
    && before.memories === after.memories
    && Number.isFinite(before.memoryFiles) && before.memoryFiles === after.memoryFiles;
}

const totalOf = (json) => {
  for (const o of [json?.result, json]) {
    if (!o || typeof o !== 'object') continue;
    for (const k of ['total', 'total_memories', 'memories', 'count']) if (typeof o[k] === 'number') return o[k];
  }
  return null;
};

const must = (r, what) => { if (r.status < 200 || r.status >= 300) throw new Error(`${what} failed: status=${r.status}${r.error ? ` (${r.error})` : ''}`); return r; };

async function state(ov, id) {
  const stats = must(await ov('GET', '/api/v1/stats/memories'), 'stats/memories');
  const mem = await ov('GET', lsUrl(MEMORIES));
  const ses = await ov('GET', lsUrl(`${SESSIONS}${id}`, false));
  if (ses.status !== 404) must(ses, 'ls session');
  return {
    memories: totalOf(stats.json),
    memoryFiles: mem.status === 200 ? lsItems(mem).filter((e) => !isDir(e)).length : NaN,
    historyExists: ses.status === 200 && lsItems(ses).some((e) => e.uri === `${SESSIONS}${id}/history`),
  };
}

async function purge(ov, uri) {
  if (!deletable(uri)) throw new Error(`refusing to delete ${uri}: not a session history URI`);
  must(await ov('DELETE', `/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=true&wait=true`, undefined, 120000), `delete ${uri}`);
}

const table = (say, rows) => {
  say('session                          | history_bytes | files');
  for (const r of rows) say(`${r.id.padEnd(32)} | ${String(r.history_bytes).padStart(13)} | ${r.files}`);
};

export async function run({ ov = defaultOv, argv = [], say = console.log, stateDir, now = Date.now } = {}) {
  const dir = stateDir || process.env.SM_STATE_DIR || path.join(os.homedir(), '.claude', 'state', 'shared-memory');
  const proofFile = path.join(dir, 'ov-purge-proof.json');
  const yes = argv.includes('--yes');
  const t = argv.indexOf('--test-one');
  const testId = t >= 0 ? argv[t + 1] : null;
  try {
    if (t >= 0 && !/^mcp-store-[A-Za-z0-9._-]+$/.test(testId || '')) { say('--test-one needs a session id that starts with mcp-store-'); return 1; }
    const sessions = plan(lsItems(must(await ov('GET', lsUrl(SESSIONS.slice(0, -1))), 'ls sessions')));
    const total = totalOf(must(await ov('GET', '/api/v1/stats/memories'), 'stats/memories').json);
    let proof = null;
    try { proof = JSON.parse(fs.readFileSync(proofFile, 'utf8')); } catch { /* none yet */ }
    const proofAge = proof ? now() - Date.parse(proof.at) : NaN;
    const proofOk = !!proof && proof.pass === true && proofAge >= 0 && proofAge < PROOF_MAX_AGE_MS;

    if (testId) {
      const target = sessions.find((s) => s.id === testId);
      if (!target) { say(`session ${testId} has no history directory; nothing to test`); return 1; }
      say(`will delete: ${target.history_uri} (${target.history_bytes} bytes in ${target.files} files)`);
      if (!yes) { say('dry run; add --yes to delete this one directory'); return 1; }
      const before = await state(ov, testId);
      await purge(ov, target.history_uri);
      const after = await state(ov, testId);
      const pass = verdict(before, after);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(proofFile, JSON.stringify({ id: testId, before, after, pass, at: new Date(now()).toISOString() }, null, 2), { mode: 0o600 });
      say(`${pass ? 'PASS' : 'FAIL'} memories ${before.memories} -> ${after.memories} (files ${before.memoryFiles} -> ${after.memoryFiles}, history_exists ${before.historyExists} -> ${after.historyExists})`);
      say(`proof written: ${proofFile}`);
      if (before.memories === null) say('WARNING: the memory total could not be read from /api/v1/stats/memories; the proof rests on the memory file count');
      return pass ? 0 : 1;
    }

    table(say, sessions);
    say(`memories total=${total}`);
    say(proof ? `proof: session=${proof.id} pass=${proof.pass} at=${proof.at}${proofOk ? '' : ' (not usable)'}` : 'proof: no proof yet (run --test-one <mcp-store-id> --yes first)');
    if (!yes) { say(`dry run; ${sessions.length} history directories would be deleted with --yes (after a passing proof)`); return 0; }

    if (!proofOk) { say(proof && proof.pass === true ? 'refusing: the proof is older than 7 days; repeat --test-one' : 'refusing: no passing one-session proof'); return 1; }
    if (!sessions.length) { say('nothing to delete'); return 0; }
    say(`verification done: proof session=${proof.id} memories ${proof.before.memories} -> ${proof.after.memories}`);
    say(`will delete ${sessions.length} history directories (${sessions.reduce((n, s) => n + s.history_bytes, 0)} bytes)`);
    const before = await state(ov, sessions[0].id);
    for (const s of sessions) { await purge(ov, s.history_uri); say(`deleted ${s.history_uri}`); }
    const after = await state(ov, sessions[0].id);
    const left = plan(lsItems(must(await ov('GET', lsUrl(SESSIONS.slice(0, -1))), 'ls sessions')));
    const same = before.memories === after.memories && before.memoryFiles === after.memoryFiles;
    say(`memories total=${before.memories} -> ${after.memories} (files ${before.memoryFiles} -> ${after.memoryFiles}); history directories left=${left.length}`);
    say(same && !left.length ? 'DONE' : 'FAIL: counts changed or archives remain');
    return same && !left.length ? 0 : 1;
  } catch (e) {
    say(`stopped: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const key = process.env.SHARED_MEMORY_OPENVIKING_API_KEY ? 'set' : 'MISSING';
  console.log(`SHARED_MEMORY_OPENVIKING_API_KEY=${key}`);
  process.exitCode = key === 'MISSING' ? 2 : await run({ argv: process.argv.slice(2) });
}
