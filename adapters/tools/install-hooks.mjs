#!/usr/bin/env node
// Registers the shared-memory hooks (the autotrigger matrix of docs/HOOKS-AUTOTRIGGER.md) in a Claude Code settings.json.
//   node adapters/tools/install-hooks.mjs <settings.json> [--apply] [--node <node.exe>] [--script <path/to/sm.mjs>]
// Without --apply it only prints a unified diff of the "hooks" block and the backup path it would use; nothing is written.
// With --apply it copies the file to <settings.json>.bak-<time>, then rewrites it. Idempotent: a second run finds nothing to change.
// Only handlers whose command runs sm.mjs recall|capture are touched (updated in place, never duplicated); every other hook
// (notification hooks, other tools) and every other setting is kept as it is. Nothing is ever removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// [event, hook arguments, timeout in seconds]. SessionStart has no matcher, so it also fires after compaction (source=compact).
export const MATRIX = [
  ['SessionStart', 'recall', 8],
  ['UserPromptSubmit', 'recall', 8],
  ['SubagentStart', 'recall', 8],
  ['SubagentStop', 'capture', 10],
  ['Stop', 'capture', 10],
  ['PreCompact', 'capture --flush', 10],
  ['SessionEnd', 'capture --flush', 5],
];

const OURS = /sm\.mjs["']?\s+(recall|capture)\b/;
const slashes = (p) => String(p).replace(/\\/g, '/');

export function defaults() {
  const winNode = 'C:/Program Files/nodejs/node.exe';
  return {
    node: process.platform === 'win32' && fs.existsSync(winNode) ? winNode : slashes(process.execPath),
    script: slashes(path.join(os.homedir(), '.claude', 'scripts', 'shared-memory', 'sm.mjs')),
  };
}

// Pure: the settings with the matrix registered, the list of changes and warnings. The input is not modified.
export function planHooks(settings, { node, script } = defaults()) {
  const next = structuredClone(settings);
  const changes = [];
  const warnings = [];
  if (next.hooks !== undefined && (typeof next.hooks !== 'object' || next.hooks === null || Array.isArray(next.hooks))) throw new Error('"hooks" in settings.json is not an object');
  next.hooks ||= {};
  for (const [event, args, timeout] of MATRIX) {
    if (next.hooks[event] !== undefined && !Array.isArray(next.hooks[event])) throw new Error(`hooks.${event} is not an array`);
    const groups = (next.hooks[event] ||= []);
    let handled = false;
    for (const g of groups) {
      for (const h of g?.hooks || []) {
        if (h?.type !== 'command' || !OURS.test(String(h.command))) continue;
        if (handled) { warnings.push(`${event}: a second shared-memory handler exists and was left alone`); continue; }
        handled = true;
        if (event === 'SessionStart' && g.matcher && g.matcher !== '*') warnings.push(`SessionStart: the existing group has matcher "${g.matcher}", so it does not fire for every source (compact, clear); remove the matcher to re-prime after compaction`);
        // keep the user's own node/script spelling; only the arguments and the timeout are ours
        const own = String(h.command).replace(/(sm\.mjs["']?)\s+(recall|capture)\b.*$/, `$1 ${args}`);
        if (h.command !== own) { changes.push(`${event}: arguments of the existing handler set to "${args}"`); h.command = own; }
        if (h.timeout !== timeout) { changes.push(`${event}: timeout ${h.timeout ?? '(default)'} -> ${timeout}`); h.timeout = timeout; }
      }
    }
    if (!handled) { groups.push({ hooks: [{ type: 'command', command: `"${node}" "${script}" ${args}`, timeout }] }); changes.push(`${event}: added ${args}`); }
  }
  return { settings: next, changes, warnings };
}

// ---- unified diff (line based, LCS; the hooks block is a few dozen lines) ----------------------------

export function unifiedDiff(a, b, { from = 'current', to = 'proposed', context = 3 } = {}) {
  const A = a.split('\n'); const B = b.split('\n');
  const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; // [' ' | '-' | '+', text]
  for (let i = 0, j = 0; i < A.length || j < B.length;) {
    if (i < A.length && j < B.length && A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
    else if (j < B.length && (i === A.length || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(['+', B[j]]); j++; }
    else { ops.push(['-', A[i]]); i++; }
  }
  if (!ops.some(([o]) => o !== ' ')) return '';
  const near = ops.map((_, k) => ops.slice(Math.max(0, k - context), k + context + 1).some(([o]) => o !== ' '));
  const out = [`--- ${from}`, `+++ ${to}`];
  for (let k = 0; k < ops.length;) {
    if (!near[k]) { k++; continue; }
    let end = k; while (end < ops.length && near[end]) end++;
    const hunk = ops.slice(k, end);
    const before = ops.slice(0, k);
    const old = (list) => list.filter(([o]) => o !== '+').length;
    const neu = (list) => list.filter(([o]) => o !== '-').length;
    out.push(`@@ -${old(before) + 1},${old(hunk)} +${neu(before) + 1},${neu(hunk)} @@`, ...hunk.map(([o, t]) => o + t));
    k = end;
  }
  return out.join('\n');
}

// ---- file handling ---------------------------------------------------------------------------------

const indentOf = (text) => { const m = text.match(/^\{\r?\n([ \t]+)"/); return m ? m[1] : '  '; };
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

export function run(argv, { now = new Date(), out = (s) => process.stdout.write(s + '\n') } = {}) {
  const apply = argv.includes('--apply');
  const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--node' && argv[i - 1] !== '--script');
  if (!file) { out('usage: install-hooks.mjs <settings.json> [--apply] [--node <node.exe>] [--script <sm.mjs>]'); return 2; }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { out(`cannot read ${file} (the file must exist; nothing is created)`); return 2; }
  let settings;
  try { settings = JSON.parse(raw); } catch (e) { out(`${file} is not valid JSON (${e.message}); nothing was changed`); return 2; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) { out(`${file} is not a JSON object; nothing was changed`); return 2; }
  const d = defaults();
  let plan;
  try { plan = planHooks(settings, { node: slashes(opt('--node') || d.node), script: slashes(opt('--script') || d.script) }); } catch (e) { out(`${e.message}; nothing was changed`); return 2; }
  for (const w of plan.warnings) out(`warning: ${w}`);
  const show = (s) => JSON.stringify(s.hooks ?? {}, null, 2);
  const diff = unifiedDiff(show(settings), show(plan.settings), { from: `${file} "hooks" (current)`, to: `${file} "hooks" (proposed)` });
  if (!diff) { out('no changes: the shared-memory hooks are already registered as in docs/HOOKS-AUTOTRIGGER.md'); return 0; }
  const backup = `${file}.bak-${stamp(now)}`;
  out(diff);
  out('');
  for (const c of plan.changes) out(`- ${c}`);
  if (!apply) { out(`\ndry run: nothing written. With --apply the current file is copied to ${backup} and then rewritten.`); return 0; }
  fs.copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(plan.settings, null, indentOf(raw)) + (raw.endsWith('\n') ? '\n' : ''));
  fs.renameSync(tmp, file);
  out(`\napplied. Backup: ${backup}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = run(process.argv.slice(2));
