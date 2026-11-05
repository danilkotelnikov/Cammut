import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeServer, tmp } from '../test-helpers.mjs';
import { summarize, run } from './memory-calibrate.mjs';

// Synthetic queries only. The file the real run reads holds the owner's own query text; the tool must never print it.
const QUERIES = [
  { q: 'where does the build cache live', expect: ['k.cache'] },
  { q: 'how are test files named', expect: ['k.naming'] },
  { q: 'recipe for tomato soup', expect: [] },
  { q: 'who painted the Mona Lisa', expect: [] },
  { q: 'weather in Lisbon', expect: [] },
];

const answers = {
  'where does the build cache live': { notes: [{ id: 'a', key: 'k.cache', score: 1 }] },
  'how are test files named': { notes: [{ id: 'b', key: 'k.other', score: 1 }, { id: 'c', key: 'k.naming', score: 0.5 }] },
  'recipe for tomato soup': { notes: [], abstained: 'below_threshold' },
  'who painted the Mona Lisa': { notes: [{ id: 'z', key: 'k.noise', score: 1 }] },
  'weather in Lisbon': { notes: [], abstained: 'below_threshold' },
};

test('summarize counts answers, abstentions, expected notes found and off-topic leaks without keeping any text', () => {
  const rows = QUERIES.map((q) => ({ expect: q.expect, notes: answers[q.q].notes, abstained: answers[q.q].abstained || '' }));
  const s = summarize(rows);
  assert.deepEqual(
    [s.queries, s.onTopic, s.offTopic, s.onTopicAnswered, s.onTopicAbstained, s.expectedFound, s.expectedTotal, s.offTopicAbstained, s.offTopicLeaked],
    [5, 2, 3, 2, 0, 2, 2, 2, 1],
  );
  assert.deepEqual(s.leakedQueries, [4]);
  assert.equal(s.returned, 4);
  assert.equal(s.relevantReturned, 2);
  assert.deepEqual(s.hitCounts, { 0: 2, 1: 2, 2: 1 });
});

test('the tool asks Cammut for every query, prints counts only and exits 1 when an off-topic query leaked', async () => {
  const srv = await fakeServer((c) => ({ status: 200, json: answers[c.body.query] || { notes: [] } }));
  const dir = tmp('cal-');
  const file = path.join(dir, 'queries.json');
  fs.writeFileSync(file, JSON.stringify(QUERIES));
  const say = [];
  const code = await run({ argv: ['--queries', file, '--project', 'general'], env: { CAMMUT_URL: srv.url, CAMMUT_MEMORY_TOKEN: 'cmt_TESTONLY' }, say: (m) => say.push(m) });
  assert.equal(code, 1);
  assert.equal(srv.calls.length, 5);
  assert.ok(srv.calls.every((c) => c.url === '/v1/memory/recall' && c.auth === 'Bearer cmt_TESTONLY' && c.body.project === 'general'));
  const text = say.join('\n');
  for (const secret of ['tomato', 'Lisbon', 'Mona', 'build cache', 'cmt_TESTONLY', 'k.cache']) assert.ok(!text.includes(secret), `printed ${secret}`);
  assert.match(text, /off-topic: abstained=2 leaked=1 \(query #4\)/);
  assert.match(text, /on-topic: answered=2 abstained=0, expected notes found 2\/2/);
  srv.srv.close();
});

test('exit 0 when nothing leaked and every expected note came back; exit 2 without a token or a file', async () => {
  const srv = await fakeServer((c) => ({ status: 200, json: c.body.query === 'a' ? { notes: [{ id: '1', key: 'k' }] } : { notes: [], abstained: 'below_threshold' } }));
  const dir = tmp('cal-');
  const file = path.join(dir, 'q.json');
  fs.writeFileSync(file, JSON.stringify([{ q: 'a', expect: ['k'] }, { q: 'b', expect: [] }]));
  assert.equal(await run({ argv: ['--queries', file, '--project', 'p'], env: { CAMMUT_URL: srv.url, CAMMUT_MEMORY_TOKEN: 't' }, say: () => {} }), 0);
  assert.equal(await run({ argv: ['--queries', file, '--project', 'p'], env: { CAMMUT_URL: srv.url }, say: () => {} }), 2);
  assert.equal(await run({ argv: ['--project', 'p'], env: { CAMMUT_URL: srv.url, CAMMUT_MEMORY_TOKEN: 't' }, say: () => {} }), 2);
  srv.srv.close();
});
