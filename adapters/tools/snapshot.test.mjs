import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { snapshot } from './snapshot.mjs';
import { makeClient, shape } from './hs-client.mjs';
import { fakeServer, tmp } from '../test-helpers.mjs';

test('shape keeps numbers and lengths and drops every string', () => {
  assert.deepEqual(shape({ total_nodes: 5, note: 'RAWTEXT', tags: [{ tag: 'a' }, { tag: 'b' }], nested: { ok: true, s: 'x' } }), { total_nodes: 5, note: { chars: 7 }, tags: { len: 2 }, nested: { ok: true, s: { chars: 1 } } });
});

test('snapshot writes counts and archive sizes only, never text', async () => {
  const hsSrv = await fakeServer((c) => {
    if (c.url.endsWith('/stats')) return { status: 200, json: { total_nodes: 1289, total_documents: 43, last_note: 'RAWTEXT-hs' } };
    if (c.url.endsWith('/tags')) return { status: 200, json: { items: [{ tag: 'project:RAWTEXT' }], total: 1 } };
    if (c.url.endsWith('/observations/scopes')) return { status: 404, json: {} };
    return { status: 404, json: {} };
  });
  const ovSrv = await fakeServer((c) => {
    if (c.url.startsWith('/api/v1/stats/memories')) return { status: 200, json: { result: { total: 20 } } };
    if (c.url.startsWith('/api/v1/fs/ls')) return { status: 200, json: { result: [
      { uri: 'viking://user/alice/sessions/cc-1/history', size: 0, isDir: true },
      { uri: 'viking://user/alice/sessions/cc-1/history/archive_001/messages.jsonl', size: 8000, content: 'RAWTEXT-ov' },
      { uri: 'viking://user/alice/sessions/cc-1/history/archive_001/memory_diff.json', size: 300 },
      { uri: 'viking://user/alice/sessions/mcp-store-2/messages.jsonl', size: 0 },
    ] } };
    return { status: 404, json: {} };
  });
  const mk = (url, keyEnv) => makeClient({ urlEnv: 'X', urlDefault: url, keyEnv, env: { [keyEnv]: 'test-key' } });
  const dir = tmp();
  const r = await snapshot({
    hs: mk(hsSrv.url, 'SHARED_MEMORY_HINDSIGHT_API_KEY'), ov: mk(ovSrv.url, 'SHARED_MEMORY_OPENVIKING_API_KEY'),
    stateDir: dir, date: new Date('2026-10-11T12:00:00Z'),
  });
  assert.equal(path.basename(r.file), 'baseline-2026-10-11.json');
  const text = fs.readFileSync(r.file, 'utf8');
  assert.ok(!text.includes('RAWTEXT'), 'no content may be written');
  const j = JSON.parse(text);
  assert.equal(j.hindsight.stats.status, 200);
  assert.equal(j.hindsight.stats.shape.total_nodes, 1289);
  assert.equal(j.hindsight.observations_scopes.status, 404);
  assert.deepEqual(j.openviking.sessions, [
    { id: 'cc-1', history_bytes: 8300, history_files: 2 },
    { id: 'mcp-store-2', history_bytes: 0, history_files: 0 },
  ]);
  assert.match(r.summary, /total_nodes=1289 total_documents=43/);
  hsSrv.srv.close(); ovSrv.srv.close();
});
