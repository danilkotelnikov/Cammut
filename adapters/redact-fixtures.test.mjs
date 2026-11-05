// The JavaScript half of the redaction agreement: internal/memory/redact_test.go reads the same file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redact } from './common.mjs';

const fx = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./redact-fixtures.json', import.meta.url)), 'utf8'));

test('redact agrees with the shared fixtures', () => {
  assert.ok(fx.cases.length >= 20 && fx.prose.length >= 3);
  for (const c of fx.cases) {
    const out = redact(c.in);
    assert.ok(out.includes(c.mustContain), `not redacted: ${c.in} -> ${out}`);
    for (const bad of c.mustNotContain) assert.ok(!out.includes(bad), `secret survived: ${bad} in ${out}`);
  }
  for (const p of fx.prose) assert.equal(redact(p), p);
});
