// Codex parity for the autotrigger matrix. Codex documents SubagentStart/SubagentStop; their payload fields are UNVERIFIED here
// (synthetic payloads in the Claude Code shape). Fake servers and synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recallFor, captureFor } from './cm.mjs';
import { fakeServer, tmp } from '../test-helpers.mjs';
import { loadSession } from '../common.mjs';

process.env.SM_NO_SPAWN = '1';
const SID = '7f6e5d4c-aaaa-bbbb-cccc-ddddeeeeffff';
const cfgFor = (dir, url) => ({
  stateDir: dir, requestMs: 2000, recallMs: 1500,
  cammut: { url, token: 'cmt_test', brief: true, recall: true, briefTier: 'core', briefCache: true }, briefCache: { enabled: true },
  hs: { url: 'http://127.0.0.1:1', bank: 'b', key: 'k', capture: false, recall: false }, ov: { url: 'http://127.0.0.1:1', key: 'k', capture: false, recall: false },
  archive: { enabled: true, recipientsFile: path.join(dir, 'r.txt'), segmentBytes: 200, flushIdleMs: 0, redact: true, outboxMaxBytes: 1 << 22 },
});

test('codex: SubagentStart prints the brief and the recall for the task as plain developer context', async (t) => {
  const cm = await fakeServer((c) => (c.url.startsWith('/v1/memory/recall')
    ? { status: 200, json: { notes: [{ id: 'n1', kind: 'howto', title: 'Gate', body: 'bash dev/gate.sh runs the go tests', score: 1, updated_at: '2026-10-11T00:00:00Z' }] } }
    : { status: 200, json: { project: 'Cammut', version: 3, body: '# brief v3', stale: false } }));
  t.after(() => cm.srv.close());
  const text = await recallFor(cfgFor(tmp(), cm.url), { hook_event_name: 'SubagentStart', cwd: 'C:/x/Cammut', session_id: SID, agent_id: 'a1', agent_type: 'explorer', prompt: 'find how the go tests run' });
  assert.match(text, /<project-brief project="Cammut"/);
  assert.match(text, /Gate/);
});

test('codex: SubagentStop stores nothing of its own (the rollout archive carries it) and registers no session', async () => {
  const dir = tmp();
  const cfg = cfgFor(dir, 'http://127.0.0.1:1');
  const rollout = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(rollout, 'x\n');
  const ok = await captureFor(cfg, { hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'a1', agent_type: 'explorer', transcript_path: rollout, cwd: 'C:/x/RnaV', last_assistant_message: 'r'.repeat(400) }, false);
  assert.equal(ok, false);
  assert.deepEqual(loadSession(cfg, `cx-${SID}`), {});
});
