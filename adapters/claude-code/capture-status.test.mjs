import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { enqueue, drain, spoolFiles } from './sm.mjs';
import { fakeServer, tmp, line } from '../test-helpers.mjs';

const cfgFor = (dir, url) => ({
  stateDir: dir,
  requestMs: 500,
  hs: { url, bank: 'test-bank', key: 'synthetic', capture: true },
  ov: { capture: false },
});

const captured = (dir) => {
  const file = path.join(dir, 'synthetic.jsonl');
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'synthetic project state' } }));
  return { kind: 'range', sid: 'session-1', project: 'P', file, start: 0, end: fs.statSync(file).size, chunkId: 'cc-session-1-0' };
};

const pending = (cfg) => JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'spool', spoolFiles(cfg)[0]), 'utf8'));

test('HTTP acceptance keeps a recoverable reference until the matching operation completes', async (t) => {
  let status = 'pending';
  const hs = await fakeServer((call) => call.method === 'POST'
    ? { status: 202, json: { operation_id: call.body.operation_id, async: true } }
    : { status: 200, json: { status } });
  t.after(() => hs.srv.close());
  const cfg = cfgFor(tmp(), hs.url);
  enqueue(cfg, captured(cfg.stateDir));
  await drain(cfg);
  assert.equal(spoolFiles(cfg).length, 1);
  assert.equal(pending(cfg).status, 'server_durable');
  const operationId = hs.calls[0].body.operation_id;
  assert.match(operationId, /^[0-9a-f-]{36}$/);
  status = 'running';
  await drain(cfg);
  assert.equal(pending(cfg).status, 'processing');
  status = 'processing'; // tolerate older Hindsight status names too
  await drain(cfg);
  assert.equal(pending(cfg).status, 'processing');
  status = 'completed';
  await drain(cfg);
  assert.equal(spoolFiles(cfg).length, 0);
  assert.equal(hs.calls.filter((call) => call.method === 'POST').length, 1, 'polling must not enqueue another retain');
  assert.ok(hs.calls.some((call) => call.url.endsWith(`/operations/${operationId}`)));
});

test('lost HTTP acceptance retries the same operation id, never discarding its reference', async (t) => {
  let submissions = 0;
  const hs = await fakeServer((call) => {
    if (call.method === 'POST') {
      submissions++;
      return submissions === 1 ? { status: 503, json: {} } : { status: 202, json: { operation_id: call.body.operation_id } };
    }
    return { status: 200, json: { status: 'completed' } };
  });
  t.after(() => hs.srv.close());
  const cfg = cfgFor(tmp(), hs.url);
  enqueue(cfg, captured(cfg.stateDir));
  await drain(cfg);
  assert.equal(pending(cfg).status, 'local_queued');
  fs.rmSync(path.join(cfg.stateDir, 'breaker.json'));
  await drain(cfg);
  await drain(cfg);
  assert.equal(spoolFiles(cfg).length, 0);
  const ids = hs.calls.filter((call) => call.method === 'POST').map((call) => call.body.operation_id);
  assert.deepEqual(ids, [ids[0], ids[0]]);
});

test('permanent rejection and failed operation are parked in spool/failed, not deleted or resubmitted', async (t) => {
  let response = 422;
  const hs = await fakeServer((call) => call.method === 'POST'
    ? { status: response, json: response === 422 ? { error: 'synthetic invalid' } : { operation_id: call.body.operation_id } }
    : { status: 200, json: { status: 'failed' } });
  t.after(() => hs.srv.close());
  const cfg = cfgFor(tmp(), hs.url);
  const failedDir = path.join(cfg.stateDir, 'spool', 'failed');
  const parked = () => fs.existsSync(failedDir) ? fs.readdirSync(failedDir).map((f) => JSON.parse(fs.readFileSync(path.join(failedDir, f), 'utf8'))) : [];
  enqueue(cfg, captured(cfg.stateDir));
  await drain(cfg);
  assert.equal(spoolFiles(cfg).length, 0);
  assert.deepEqual(parked().map((it) => it.status), ['failed']);
  await drain(cfg);
  assert.equal(hs.calls.length, 1, 'a failed capture is not silently resubmitted');
  response = 202; // the server accepts, then reports the operation failed
  const second = captured(cfg.stateDir);
  second.chunkId = 'cc-session-2-0';
  enqueue(cfg, second);
  await drain(cfg);
  await drain(cfg);
  assert.equal(spoolFiles(cfg).length, 0);
  assert.equal(parked().length, 2);
  assert.ok(parked().every((it) => it.status === 'failed'));
});
