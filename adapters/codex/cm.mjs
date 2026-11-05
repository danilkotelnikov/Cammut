#!/usr/bin/env node
// Codex CLI hook entry point: Cammut brief/recall and rollout archive capture (plan 5 adds ingest).
//   cm.mjs recall               SessionStart/UserPromptSubmit: plain stdout becomes developer context.
//   cm.mjs capture [--flush]      Stop, PreCompact (--flush), SessionEnd (--flush; Codex gives it 1 s, so this only records
//                                 the rollout and starts the shared drain)
// The hook JSON on stdin carries session_id, transcript_path (nullable), cwd and hook_event_name. The rollout is
// ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl; when transcript_path is null it is found by that name.
// The drain (sm.mjs drain) cuts, encrypts and uploads it exactly like a Claude Code transcript, as agent 'codex'.
// Fails open: it logs one line and exits 0. Opt-outs: SHARED_MEMORY_BYPASS=1, a .no-memory marker, archive.enabled=false.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, ensure, lock, log, loadSession, saveSession, sessionLockFile, isOptedOut, putCheckpoint, writeHookOutput } from '../common.mjs';
import { registerArchive, projectName } from '../archive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const UUIDISH = /^[0-9A-Za-z_-]{8,80}$/;

// the rollout of a session: the hook's own path when it names an existing file, else a scan by file name
export function locateRollout(payload, codexHome = path.join(os.homedir(), '.codex')) {
  const p = payload.transcript_path;
  if (typeof p === 'string' && p && fs.existsSync(p)) return { file: p, via: 'given' };
  const sid = String(payload.session_id || '');
  if (!UUIDISH.test(sid)) return null;
  const tail = `-${sid}.jsonl`;
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 5) { const r = walk(full, depth + 1); if (r) return r; }
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith(tail)) return full;
    }
    return null;
  };
  const f = walk(path.join(codexHome, 'sessions'), 0);
  return f ? { file: f, via: 'scan' } : null;
}

function spawnDrain() {
  if (process.env.SM_NO_SPAWN) return;
  const sm = [path.join(here, '..', 'sm.mjs'), path.join(here, '..', 'claude-code', 'sm.mjs')].find((x) => fs.existsSync(x));
  if (!sm) return;
  try { spawn(process.execPath, [sm, 'drain'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* the next hook retries */ }
}

export async function captureFor(cfg, p, flush, codexHome) {
  // a subagent's work is already in the session rollout the archive carries; no separate entry
  if (p?.hook_event_name === 'SubagentStop') return false;
  const sid = p?.session_id;
  if (typeof sid !== 'string' || !sid || isOptedOut(p.cwd, process.env) || !cfg.archive?.enabled) return false;
  const event = p.hook_event_name || 'unknown';
  const found = locateRollout(p, codexHome);
  log(cfg, `capture codex ${event} transcript_path=${p.transcript_path ? 'given' : 'null'} located=${found ? 'yes' : 'no'}${found ? ` via=${found.via}` : ''}`);
  if (!found) return false;
  const key = `cx-${sid}`;
  const lockFile = sessionLockFile(cfg, key);
  if (!lock(lockFile, 30000)) return false;
  try {
    const st = loadSession(cfg, key);
    const a = registerArchive(st, { file: found.file, agent: 'codex', project: projectName(p.cwd), cwd: p.cwd });
    if (flush) a.flush = true;
    saveSession(cfg, key, st);
  } finally { fs.rmSync(lockFile, { force: true }); }
  spawnDrain();
  return true;
}

async function recallWithCheckpoint(cfg, p) {
  const sm = fs.existsSync(new URL('../sm.mjs', import.meta.url)) ? '../sm.mjs' : '../claude-code/sm.mjs';
  const { recallFor: sharedRecall, servedCheckpointOf, withAbort } = await import(sm);
  // hard stop, as for Claude Code: a hook never holds a prompt longer than this
  const out = await withAbort(sharedRecall(cfg, p, Date.now(), p?.session_id ? `cx-${p.session_id}` : undefined, 'codex'), cfg.hooks?.promptAbortMs ?? 6000);
  return { text: out?.hookSpecificOutput.additionalContext || null, checkpoint: out ? servedCheckpointOf(out) : undefined };
}

export async function recallFor(cfg, p) {
  return (await recallWithCheckpoint(cfg, p)).text;
}

function readStdin(ms = 800) {
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
  try {
    ensure(cfg.stateDir);
    if (!['capture', 'recall', 'checkpoint'].includes(argv[0])) { console.error('usage: cm.mjs recall|checkpoint|capture [--flush]'); return; }
    let p = {};
    try { p = JSON.parse(await readStdin()); } catch { /* manual run */ }
    if (p && typeof p === 'object') {
      if (argv[0] === 'capture') await captureFor(cfg, p, argv.includes('--flush'));
      else if (argv[0] === 'checkpoint') {
        const entry = await putCheckpoint(cfg, { ...p, agent: 'codex' });
        await writeHookOutput(cfg, JSON.stringify({ state: entry.state, source_revision: entry.checkpoint.source_revision }) + '\n');
      } else {
        const { text, checkpoint } = await recallWithCheckpoint(cfg, p);
        if (text) await writeHookOutput(cfg, text + '\n', checkpoint);
      }
    }
  } catch (e) {
    log(cfg, `cm ${argv[0]} failed: ${e?.name}: ${String(e?.message).slice(0, 160)}`);
  }
}

// No process.exit(): see sm.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
  process.exitCode = 0;
}
