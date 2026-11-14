// Deterministic pull request diff budget gate for Macroscope analysis ($10/request cap at ~$0.06/KB).
// Usage:
//   node .github/scripts/pr-budget.mjs --pr <num> --repo <owner/name> [--max-bytes 160000] [--max-usd 10]
//   node .github/scripts/pr-budget.mjs --base <ref> [--head <ref>] [--max-bytes 160000]
//   node .github/scripts/pr-budget.mjs --self-test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const USD_PER_KB = 0.06;
export const DEFAULT_MAX_USD = 10.0;
export const DEFAULT_MAX_BYTES = 160_000;

function runQuiet(cmd, args, cwd = process.cwd()) {
  const r = spawnSync(cmd, args, {
    cwd,
    timeout: 60_000,
    windowsHide: true,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr?.toString('utf8') || ''}`);
  }
  return r.stdout;
}

export function evaluateDiffBudget(diffBytes, { maxBytes = DEFAULT_MAX_BYTES, maxUsd = DEFAULT_MAX_USD } = {}) {
  if (!Number.isInteger(diffBytes) || diffBytes < 0) {
    return { ok: false, state: 'fail_invalid_input', diff_bytes: diffBytes, diff_kb: null, estimated_macroscope_usd: null, max_bytes: maxBytes, cap_usd: maxUsd };
  }
  const diffKb1000 = diffBytes / 1000;
  const diffKb1024 = diffBytes / 1024;
  const estUsd = Number((diffKb1000 * USD_PER_KB).toFixed(4));
  const ok = diffBytes <= maxBytes && estUsd <= maxUsd;
  return {
    ok,
    state: ok ? 'pass' : 'fail_pr_budget',
    diff_bytes: diffBytes,
    diff_kb: Number(diffKb1024.toFixed(2)),
    diff_decimal_kb: Number(diffKb1000.toFixed(2)),
    estimated_macroscope_usd: estUsd,
    max_bytes: maxBytes,
    cap_usd: maxUsd,
  };
}

export function measureDiffBytes({ file, bytes, pr, repo, base, head = 'HEAD', cwd = process.cwd() } = {}) {
  if (bytes !== undefined) return Number(bytes);
  if (file) return fs.statSync(file).size;
  if (pr && repo) return runQuiet('gh', ['pr', 'diff', String(pr), '-R', repo], cwd).length;
  const targetBase = base || 'origin/main';
  return runQuiet('git', ['diff', '--binary', `${targetBase}...${head}`], cwd).length;
}

export function selfTest() {
  assert.equal(evaluateDiffBudget(120_000).state, 'pass');
  assert.equal(evaluateDiffBudget(DEFAULT_MAX_BYTES).state, 'pass');
  assert.equal(evaluateDiffBudget(180_000).state, 'fail_pr_budget');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-budget-'));
  try {
    const f = path.join(tmp, 'small.patch');
    fs.writeFileSync(f, 'x'.repeat(512));
    assert.equal(measureDiffBytes({ file: f }), 512);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('pr-budget self-test: PASS');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--self-test')) {
    selfTest();
    process.exit(0);
  }
  const diffBytes = measureDiffBytes({
    file: arg('--file'),
    bytes: arg('--bytes'),
    pr: arg('--pr'),
    repo: arg('--repo'),
    base: arg('--base'),
    head: arg('--head') || 'HEAD',
  });
  const res = evaluateDiffBudget(diffBytes, {
    maxBytes: arg('--max-bytes') ? Number(arg('--max-bytes')) : DEFAULT_MAX_BYTES,
    maxUsd: arg('--max-usd') ? Number(arg('--max-usd')) : DEFAULT_MAX_USD,
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
