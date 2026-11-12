import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The retired public name must not come back as a literal anywhere outside the historical docs/superpowers/ records.
// The word is built from pieces so that this file does not contain it either.
const retired = ['tiffany', 'flops'].join('');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['.git', 'node_modules', '.superpowers', 'dist']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (path.relative(root, p).split(path.sep).join('/') === 'docs/superpowers') continue;
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('no source, test, fixture, example or doc outside docs/superpowers names the retired domain', () => {
  const hits = [];
  for (const f of walk(root)) {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue; // binary
    if (buf.toString('utf8').toLowerCase().includes(retired)) hits.push(path.relative(root, f));
  }
  assert.deepEqual(hits, []);
});

test('compose reads the public origin from an environment variable', () => {
  const compose = fs.readFileSync(path.join(root, 'deploy', 'compose.yaml'), 'utf8');
  assert.match(compose, /-site-origin\s+- \$\{CAMMUT_SITE_ORIGIN:\?[^}]+\}/);
});
