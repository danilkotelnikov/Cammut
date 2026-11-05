#!/usr/bin/env node
// Copies the files of MANIFEST (never the tests) from the repo into the one flat directory Claude Code hooks run from.
//   node adapters/install.mjs [--force] [--check]
// A file the user edited in place (installed hash differs from both the repo copy and the hash this tool wrote last)
// is never overwritten without --force. Nothing is ever deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readOr = (f) => { try { return fs.readFileSync(f); } catch { return null; } };

// {from: path under adapters/, to: path under the install directory}. Each task that adds a file adds its entry.
// The installed layout is flat (sm.mjs next to common.mjs and archive.mjs); the repo layout is not, so the entry points
// that live in subdirectories resolve their siblings both ways.
export const MANIFEST = [
  { from: 'claude-code/sm.mjs', to: 'sm.mjs' },
  { from: 'common.mjs', to: 'common.mjs' },
  { from: 'hs-recall.mjs', to: 'hs-recall.mjs' },
  { from: 'archive.mjs', to: 'archive.mjs' },
  { from: 'sweep.mjs', to: 'sweep.mjs' },
  { from: 'tools/cammut-archive.mjs', to: 'cammut-archive.mjs' },
  { from: 'codex/cm.mjs', to: 'codex/cm.mjs' },
  { from: 'codex/README.md', to: 'codex/README.md' },
  // created by a human reviewer after reading sweep.mjs; absent until then, and then the sweeper only dry-runs
  { from: 'SWEEPER-REVIEW.md', to: 'SWEEPER-REVIEW.md', optional: true },
  { from: 'claude-code/README.md', to: 'README.md' },
];

// Hashes of the files as installed by hand on 2026-10-11 (before this installer existed). Such a file has no manifest
// entry but was never edited, so the first install may replace it.
export const LEGACY = {
  'sm.mjs': 'da4ee63da0b8a072baa9b9816c87423501a6ba0fa673e670a80f3c782563d18e',
  'README.md': 'e65f4ecc780a20995cc924876cbc9f2201cd35f607cd76dc970d39efd5830b1f',
};

export function install({ srcDir, dstDir, manifest = MANIFEST, force = false, check = false, legacy = LEGACY }) {
  const manifestFile = path.join(dstDir, '.installed.json');
  let prev = { files: {} };
  try { prev = { files: {}, ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')) }; } catch { /* first install */ }
  const files = { ...prev.files };
  const results = [];
  if (!check) fs.mkdirSync(dstDir, { recursive: true });
  for (const { from, to: name, optional } of manifest) {
    let repo;
    try { repo = fs.readFileSync(path.join(srcDir, from)); } catch { if (optional) continue; throw new Error(`install manifest: ${from} is missing from ${srcDir}`); }
    const dst = path.join(dstDir, name);
    const cur = readOr(dst);
    const R = sha(repo);
    const I = cur && sha(cur);
    let status;
    if (cur === null) status = check ? 'missing' : 'installed';
    else if (R === I) status = 'unchanged';
    else if (check) status = 'differs';
    else if (I === prev.files[name] || I === legacy[name] || force) status = 'updated';
    else status = 'skipped';
    results.push({ name, status, repoBytes: repo.length, installedBytes: cur ? cur.length : 0, repoLines: repo.toString('utf8').split('\n').length, installedLines: cur ? cur.toString('utf8').split('\n').length : 0 });
    if (check || status === 'skipped') continue;
    if (status !== 'unchanged') {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = `${dst}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, repo, { mode: 0o600 });
      fs.renameSync(tmp, dst);
    }
    files[name] = R;
  }
  if (!check) {
    let from = 'unknown';
    try { from = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: srcDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown'; } catch { /* not a checkout */ }
    const tmp = `${manifestFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ files, from, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, manifestFile);
  }
  return results;
}

const label = (r) => (r.status === 'skipped'
  ? `SKIPPED (locally modified; use --force) [repo ${r.repoBytes} B/${r.repoLines} lines, installed ${r.installedBytes} B/${r.installedLines} lines]`
  : r.status);

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dstDir = process.env.SM_INSTALL_DIR || path.join(os.homedir(), '.claude', 'scripts', 'shared-memory');
  const check = args.includes('--check');
  const results = install({ srcDir: here, dstDir, force: args.includes('--force'), check });
  for (const r of results) console.log(`${r.name}: ${label(r)}`);
  console.log(`target: ${dstDir}`);
  process.exitCode = check && results.some((r) => r.status !== 'unchanged') ? 1 : 0;
}
