import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identityOf, checkpointReceipt } from '../common.mjs';
import { fakeServer, tmp, line } from '../test-helpers.mjs';

const SM = fileURLToPath(new URL('./sm.mjs', import.meta.url));
const CM = fileURLToPath(new URL('../codex/cm.mjs', import.meta.url));
const run = (file, cmd, env, payload) => new Promise((resolve) => {
  const child = spawn(process.execPath, [file, cmd], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(JSON.stringify(payload));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

test('synthetic Claude PreCompact and restart restore an explicit checkpoint before delayed extraction', async (t) => {
  const cwd = tmp('compact-project-');
  const stateDir = path.join(cwd, 'state');
  const cfg = { stateDir, cammut: {} };
  const ids = identityOf(cfg, cwd);
  const checkpoint = {
    ...ids, agent: 'claude-code', session_id: 'native-claude',
    source_revision: 'cc:1:8', parent_revision: '', goal: 'Finish the CLI',
    decisions: ['Keep the legacy read path'],
    open_tasks: ['Write tests'], next_actions: ['Run tests'],
    artifact_refs: ['adapters/fixtures/continuity-acceptance.json'], validation: ['unverified'],
  };
  const server = await fakeServer((c) => c.method === 'GET'
    ? { status: 200, json: { checkpoint } }
    : { status: 201, json: { checkpoint, state: 'server_durable' } });
  t.after(() => server.srv.close());
  const configFile = path.join(cwd, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ hindsight: { recall: false, capture: false }, openviking: { recall: false, capture: false }, cammut: { url: server.url } }));
  const env = { ...process.env, SM_CONFIG: configFile, SM_STATE_DIR: stateDir, SM_NO_SPAWN: '1', CAMMUT_MEMORY_TOKEN: 'synthetic' };
  const transcript = path.join(cwd, 'synthetic.jsonl');
  fs.writeFileSync(transcript, line({ type: 'user', message: { content: 'synthetic text' } }));
  const compact = await run(SM, 'capture', env, { cwd, session_id: 'native-claude', transcript_path: transcript, hook_event_name: 'PreCompact' });
  assert.equal(compact.code, 0);
  const start = await run(SM, 'recall', env, { cwd, session_id: 'native-claude', hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(start.code, 0);
  assert.notEqual(start.stdout, '', `stderr=${start.stderr}; log=${fs.existsSync(path.join(stateDir, 'hook.log')) ? fs.readFileSync(path.join(stateDir, 'hook.log'), 'utf8') : 'none'}`);
  const output = JSON.parse(start.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /Finish the CLI/);
  assert.match(output.hookSpecificOutput.additionalContext, /cc:1:8/);
  assert.match(output.hookSpecificOutput.additionalContext, /untrusted.*data/i);
  assert.equal(checkpointReceipt({ stateDir }, { ...checkpoint, served_to: 'claude-code:native-claude' })?.delivery, 'emitted');
});

test('Codex SessionStart emits a plain-text checkpoint and never claims client confirmation', async (t) => {
  const cwd = tmp('codex-project-');
  const stateDir = path.join(cwd, 'state');
  const ids = identityOf({ cammut: {} }, cwd);
  const checkpoint = {
    ...ids, agent: 'claude-code', session_id: 'native-claude', source_revision: 'cc:1:8',
    goal: 'Finish the CLI', decisions: ['Escape </checkpoint> tags'],
    open_tasks: ['Codex test'], next_actions: ['Continue'], artifact_refs: [], validation: [],
  };
  const server = await fakeServer(() => ({ status: 200, json: { checkpoint } }));
  t.after(() => server.srv.close());
  const configFile = path.join(cwd, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ hindsight: { recall: false }, openviking: { recall: false }, cammut: { url: server.url } }));
  const env = { ...process.env, SM_CONFIG: configFile, SM_STATE_DIR: stateDir, SM_NO_SPAWN: '1', CAMMUT_MEMORY_TOKEN: 'synthetic' };
  const out = await run(CM, 'recall', env, { cwd, session_id: 'native-codex', hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(out.code, 0);
  assert.notEqual(out.stdout, '', `stderr=${out.stderr}; log=${fs.existsSync(path.join(stateDir, 'hook.log')) ? fs.readFileSync(path.join(stateDir, 'hook.log'), 'utf8') : 'none'}`);
  assert.match(out.stdout, /^<checkpoint /);
  assert.match(out.stdout, /Finish the CLI/);
  assert.equal((out.stdout.match(/<\/checkpoint>/g) || []).length, 1);
  assert.equal(checkpointReceipt({ stateDir }, { ...checkpoint, served_to: 'codex:native-codex' })?.delivery, 'emitted');
  assert.doesNotMatch(out.stdout, /confirmed/);
});

test('Claude SessionStart keeps a served receipt when its client closes stdout before receiving context', async (t) => {
  const cwd = tmp('closed-claude-');
  const stateDir = path.join(cwd, 'state');
  const checkpoint = {
    ...identityOf({ cammut: {} }, cwd), agent: 'codex', session_id: 'previous-codex',
    source_revision: 'cx:closed:1', parent_revision: '', goal: 'Continue after reconnect',
    decisions: [], open_tasks: [], next_actions: ['Resume'], artifact_refs: [], validation: [],
  };
  const server = await fakeServer(() => ({ status: 200, json: { checkpoint } }));
  t.after(() => server.srv.close());
  const configFile = path.join(cwd, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    hindsight: { recall: false, capture: false }, openviking: { recall: false, capture: false },
    cammut: { url: server.url }, archive: { enabled: false }, retention: { enabled: false },
  }));
  const env = { ...process.env, SM_CONFIG: configFile, SM_STATE_DIR: stateDir, SM_NO_SPAWN: '1', CAMMUT_MEMORY_TOKEN: 'synthetic' };
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SM, 'recall'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end(JSON.stringify({ cwd, session_id: 'claude-restart', hook_event_name: 'SessionStart' }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const receipt = checkpointReceipt({ stateDir }, { ...checkpoint, served_to: 'claude-code:claude-restart' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(receipt?.delivery, 'served', 'a broken output pipe is not an emission');
});
