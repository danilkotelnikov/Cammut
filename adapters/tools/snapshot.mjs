#!/usr/bin/env node
// Baseline snapshot of both stores before the phase-1 changes: counts and sizes only, never text.
//   node adapters/tools/snapshot.mjs   ->   <state dir>/baseline-<date>.json
// Keys: SHARED_MEMORY_HINDSIGHT_API_KEY, SHARED_MEMORY_OPENVIKING_API_KEY (environment). State dir: SM_STATE_DIR or ~/.claude/state/shared-memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hs as defaultHs, shape } from './hs-client.mjs';
import { ov as defaultOv, lsItems, isDir, lsUrl } from './ov-client.mjs';

const SESSIONS = 'viking://user/alice/sessions/';
const one = async (client, p) => { const r = await client('GET', p); return { status: r.status, shape: r.status === 200 ? shape(r.json) : null }; };

export async function snapshot({ hs = defaultHs, ov = defaultOv, bank = 'alice-shared', stateDir, date = new Date() } = {}) {
  const b = `/v1/default/banks/${encodeURIComponent(bank)}`;
  const hindsight = { bank, stats: await one(hs, `${b}/stats`), tags: await one(hs, `${b}/tags`), observations_scopes: await one(hs, `${b}/observations/scopes`) };
  const ls = await ov('GET', lsUrl(SESSIONS.slice(0, -1)));
  const sessions = new Map();
  for (const e of lsItems(ls)) {
    if (!String(e.uri).startsWith(SESSIONS)) continue;
    const [id, top] = String(e.uri).slice(SESSIONS.length).split('/');
    if (!id) continue;
    const s = sessions.get(id) || { id, history_bytes: 0, history_files: 0 };
    sessions.set(id, s);
    if (top === 'history' && !isDir(e)) { s.history_bytes += Number(e.size) || 0; s.history_files += 1; }
  }
  const openviking = { memories: await one(ov, '/api/v1/stats/memories'), sessions_listing_status: ls.status, sessions: [...sessions.values()] };
  const dir = stateDir || process.env.SM_STATE_DIR || path.join(os.homedir(), '.claude', 'state', 'shared-memory');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `baseline-${date.toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: date.toISOString(), hindsight, openviking }, null, 2), { mode: 0o600 });
  const nums = Object.entries(hindsight.stats.shape || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ');
  const summary = `hindsight ${nums || `stats status=${hindsight.stats.status}`}; openviking sessions=${sessions.size} history_bytes=${openviking.sessions.reduce((n, s) => n + s.history_bytes, 0)} memories_status=${openviking.memories.status}`;
  return { file, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const k of ['SHARED_MEMORY_HINDSIGHT_API_KEY', 'SHARED_MEMORY_OPENVIKING_API_KEY']) console.log(`${k}=${process.env[k] ? 'set' : 'MISSING'}`);
  if (!process.env.SHARED_MEMORY_HINDSIGHT_API_KEY || !process.env.SHARED_MEMORY_OPENVIKING_API_KEY) process.exitCode = 2;
  else { const r = await snapshot(); console.log(`${path.basename(r.file)} written (${r.summary})`); }
}
