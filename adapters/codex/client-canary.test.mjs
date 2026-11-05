import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { canaryEnvironment, canaryConfig, canaryArguments, completedCanaryTurn, verifyCanaryEvidence, runCanary, runCanaryProcess } from './client-canary.mjs';

test('client canary environment does not inherit provider credentials or user configuration', () => {
  const root = path.resolve('synthetic-root');
  const env = canaryEnvironment(root, 'http://127.0.0.1:12345', {
    Path: 'synthetic-path', SystemRoot: 'synthetic-system', OPENAI_API_KEY: 'do-not-inherit',
    ANTHROPIC_API_KEY: 'do-not-inherit', GEMINI_API_KEY: 'do-not-inherit', CODEX_HOME: 'real-home',
    SM_CONFIG: 'real-memory-config', HTTPS_PROXY: 'http://external.example', CUSTOM_SECRET: 'do-not-inherit',
  });
  assert.equal(env.Path, path.dirname(process.execPath) + path.delimiter + 'synthetic-path');
  assert.equal(env.SystemRoot, 'synthetic-system');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CUSTOM_SECRET']) assert.equal(env[key], undefined);
  assert.equal(env.CODEX_HOME, path.join(root, 'home', '.codex'));
  assert.equal(env.SM_CONFIG, path.join(root, 'memory.json'));
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:12345');
  assert.equal(env.CAMMUT_MEMORY_TOKEN, 'synthetic-canary-only');
  const duplicate = canaryEnvironment(root, 'http://127.0.0.1:12345', { Path: 'one', PATH: 'two' });
  assert.equal(Object.keys(duplicate).filter((key) => key.toUpperCase() === 'PATH').length, 1);
});

test('client canary provider config only accepts its own loopback listener', () => {
  for (const endpoint of ['https://provider.example', 'http://localhost:1234', 'http://127.0.0.1:1234/other', 'http://user:pass@127.0.0.1:1234/', 'http://127.0.0.1:1234/?key=x']) {
    assert.throws(() => canaryConfig(endpoint), /loopback/);
  }
  const config = canaryConfig('http://127.0.0.1:1234');
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:1234\/v1"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /enabled = false/);
  assert.match(canaryConfig('http://127.0.0.1:1234', '"node" "cm.mjs" recall'), /\[\[hooks\.SessionStart\.hooks\]\]/);
});

test('client canary does not report a killed timeout as successful process exit', async () => {
  const result = await runCanaryProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], process.cwd(), {}, 100);
  assert.notEqual(result.code, 0);
});
test('client canary closes unused stdin for noninteractive clients', async () => {
  const result = await runCanaryProcess(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("EOF"))'], process.cwd(), {}, 5000);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'EOF');
});
test('client canary does not disable the hooks it intends to qualify', () => {
  const args = canaryArguments();
  for (const flag of ['--ignore-rules', '--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(!args.includes(flag));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});

test('client canary requires a completed assistant item and a successful turn', () => {
  const started = { type: 'turn.started' };
  const assistant = { type: 'item.completed', item: { type: 'agent_message', text: 'CAMMUT_CANARY_OK' } };
  const completed = { type: 'turn.completed' };
  assert.equal(completedCanaryTurn([started, assistant, completed]), true);
  for (const events of [
    [assistant], [completed], [{ type: 'error', message: 'CAMMUT_CANARY_OK' }, completed],
    [{ type: 'item.completed', item: { type: 'error', text: 'CAMMUT_CANARY_OK' } }, completed],
    [assistant, { type: 'turn.failed' }, completed], [assistant, { type: 'error' }, completed],
    [started, completed, assistant], [started, assistant, completed, started],
  ]) assert.equal(completedCanaryTurn(events), false);
  assert.equal(completedCanaryTurn([started, assistant, { type: 'turn.failed' }, completed]), false);
  assert.equal(completedCanaryTurn([started, assistant, { type: 'error' }, completed]), false);
});

test('client canary requires every independent transport evidence gate', () => {
  const evidence = {
    client_exit_code: 0, checkpoint_requests: 1, model_requests: 1, checkpoint_in_provider_input: true,
    checkpoint_emission_recorded: true, completion_observed: true, hook_launch: { phase: 'exited', code: 0 },
  };
  assert.equal(verifyCanaryEvidence(evidence), true);
  for (const field of Object.keys(evidence)) {
    const missing = { ...evidence }; delete missing[field];
    assert.equal(verifyCanaryEvidence(missing), false, field);
  }
  for (const change of [
    { client_exit_code: 1 }, { client_exit_code: 'timeout' }, { checkpoint_requests: 0 }, { model_requests: 0 },
    { checkpoint_in_provider_input: false }, { checkpoint_emission_recorded: false }, { completion_observed: false },
    { hook_launch: { phase: 'entered', code: 0 } }, { hook_launch: { phase: 'exited', code: 1 } },
  ]) assert.equal(verifyCanaryEvidence({ ...evidence, ...change }), false);
});

test('installed Codex injects a synthetic checkpoint into a loopback provider request', {
  skip: !process.env.SM_CODEX_CANARY_BIN,
  timeout: 60000,
}, async () => {
  const result = await runCanary(process.env.SM_CODEX_CANARY_BIN);
  assert.equal(result.verified, true, JSON.stringify(result));
});
