#!/usr/bin/env node
// Optional real-client transport check, not a model-understanding or compaction test.
// Nothing runs on import. The generated diagnostic wrapper only invokes cm.mjs recall.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identityOf, redact } from '../common.mjs';

const CM = fileURLToPath(new URL('./cm.mjs', import.meta.url));
const supportedVersion = 'codex-cli 0.159.3';
const safeEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE']);

export function canaryEnvironment(root, proxy, parent = process.env) {
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => safeEnvironment.has(key.toUpperCase())));
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  for (const key of Object.keys(env)) if (key !== pathKey && key.toUpperCase() === 'PATH') delete env[key];
  env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
  const home = path.join(root, 'home');
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-git-config'),
    SM_CONFIG: path.join(root, 'memory.json'), SM_STATE_DIR: path.join(root, 'memory-state'), SM_NO_SPAWN: '1',
    CAMMUT_MEMORY_TOKEN: 'synthetic-canary-only',
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost,::1',
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: '127.0.0.1,localhost,::1',
  });
  return env;
}

export function canaryConfig(endpoint, hookCommand) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('canary provider must be its own loopback HTTP listener');
  }
  return [
    'model = "gpt-5.4"', 'model_provider = "cammut_canary"', 'approval_policy = "never"',
    'sandbox_mode = "read-only"', 'web_search = "disabled"', 'check_for_update_on_startup = false',
    '[features]', 'hooks = true', '[analytics]', 'enabled = false',
    '[model_providers.cammut_canary]', 'name = "Cammut synthetic loopback"',
    `base_url = ${JSON.stringify(url.origin + '/v1')}`, 'wire_api = "responses"', 'requires_openai_auth = false',
    'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 5000', '',
    ...(hookCommand ? ['[[hooks.SessionStart]]', '[[hooks.SessionStart.hooks]]', 'type = "command"', `command = ${JSON.stringify(hookCommand)}`, 'timeout = 10', ''] : []),
  ].join('\n');
}

export const runCanaryProcess = (binary, args, cwd, env, timeout = 35000) => new Promise((resolve) => {
  const child = execFile(binary, args, { cwd, env, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ code: error ? (error.code ?? (error.killed ? 'timeout' : 'process_error')) : 0, stdout, stderr, killed: Boolean(error?.killed) });
  });
  child.stdin?.end();
});
export const canaryArguments = () => [
  'exec', '--dangerously-bypass-hook-trust', '--sandbox', 'read-only', '--json',
  '--skip-git-repo-check', 'Reply with the supplied synthetic provider response. Do not call tools, inspect files or use the network.',
];
export function completedCanaryTurn(events) {
  const started = events.findIndex((event) => event.type === 'turn.started');
  const assistant = events.findIndex((event) => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text === 'CAMMUT_CANARY_OK');
  const completed = events.findIndex((event) => event.type === 'turn.completed');
  return started >= 0 && assistant > started && completed > assistant
    && events.filter((event) => event.type === 'turn.started').length === 1
    && events.filter((event) => event.type === 'turn.completed').length === 1
    && !events.some((event) => event.type === 'turn.failed' || event.type === 'error');
}
export function verifyCanaryEvidence(evidence) {
  return evidence.client_exit_code === 0 && evidence.checkpoint_requests > 0 && evidence.model_requests > 0
    && evidence.checkpoint_in_provider_input === true && evidence.checkpoint_emission_recorded === true
    && evidence.completion_observed === true && evidence.hook_launch?.phase === 'exited' && evidence.hook_launch.code === 0;
}
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function responseStream(res, marker) {
  const item = { id: 'msg_canary', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: marker, annotations: [] }] };
  const response = { id: 'resp_canary', object: 'response', created_at: 1, model: 'gpt-5.4', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: marker },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: marker },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

export async function runCanary(binary) {
  if (!path.isAbsolute(binary) || !fs.statSync(binary).isFile()) throw new Error('provide an absolute installed Codex binary path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cammut-codex-client-'));
  const workspace = path.join(root, 'project');
  const observed = { checkpoint_requests: 0, model_requests: 0, checkpoint_in_provider_input: false, blocked_proxy_requests: 0, unmatched_requests: [] };
  const deny = http.createServer((_req, res) => { observed.blocked_proxy_requests++; json(res, 403, { error: 'canary outbound request denied' }); });
  deny.on('connect', (_req, socket) => { observed.blocked_proxy_requests++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  let provider;
  let preserveRoot = false;
  const cleanup = { temporary_files: 'pending', process_tree_exit: 'not-certified' };
  const run = async (...args) => {
    const result = await runCanaryProcess(...args);
    preserveRoot ||= result.killed;
    return result;
  };
  try {
    const proxy = await listen(deny);
    const env = canaryEnvironment(root, proxy);
    for (const dir of [workspace, env.CODEX_HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
    const version = await run(binary, ['--version'], workspace, env, 5000);
    if (version.code !== 0 || version.stdout.trim() !== supportedVersion) throw new Error('installed Codex version is not qualified for this canary');
    const git = await run('git', ['init', '--quiet', workspace], workspace, env, 5000);
    if (git.code !== 0) throw new Error('cannot create disposable Git root for isolated config discovery');
    const checkpoint = {
      ...identityOf({}, workspace), agent: 'claude-code', session_id: 'synthetic-author',
      source_revision: 'synthetic:1', parent_revision: '',
      goal: `Cammut checkpoint ${crypto.randomBytes(12).toString('hex')}`,
      decisions: ['Synthetic transport test only'], open_tasks: [], next_actions: ['No tools or file changes'],
      artifact_refs: [], validation: ['Not a real-model or forced-compaction check'],
    };
    provider = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/memory/checkpoints') {
        observed.checkpoint_requests++;
        if (url.searchParams.get('project_id') !== checkpoint.project_id || url.searchParams.get('workspace_id') !== checkpoint.workspace_id) {
          return json(res, 400, { error: 'synthetic scope mismatch' });
        }
        return json(res, 200, { checkpoint });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { data: [{ id: 'gpt-5.4', object: 'model' }] });
      if (req.method !== 'POST' || url.pathname !== '/v1/responses') {
        if (observed.unmatched_requests.length < 12) observed.unmatched_requests.push(`${req.method} ${url.pathname}`);
        return json(res, 404, { error: 'not a canary endpoint' });
      }
      observed.model_requests++;
      try {
        let bytes = Buffer.alloc(0);
        for await (const chunk of req) {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > 1024 * 1024) throw new Error('synthetic request too large');
        }
        const encoding = req.headers['content-encoding'];
        if (encoding === 'gzip') bytes = zlib.gunzipSync(bytes, { maxOutputLength: 2 * 1024 * 1024 });
        else if (encoding === 'zstd') bytes = zlib.zstdDecompressSync(bytes, { maxOutputLength: 2 * 1024 * 1024 });
        else if (encoding && encoding !== 'identity') throw new Error('unsupported synthetic content encoding');
        const body = JSON.parse(bytes.toString('utf8'));
        observed.checkpoint_in_provider_input ||= JSON.stringify(body.input).includes(checkpoint.goal);
        responseStream(res, observed.checkpoint_in_provider_input ? 'CAMMUT_CANARY_OK' : 'CAMMUT_CHECKPOINT_MISSING');
      } catch {
        json(res, 400, { error: 'invalid synthetic provider request' });
      }
    });
    const endpoint = await listen(provider);
    const launchMarker = path.join(root, 'hook-launch.json');
    const runner = path.join(root, 'hook-runner.mjs');
    fs.writeFileSync(runner, [
      "import fs from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const marker = ${JSON.stringify(launchMarker)};`,
      "fs.writeFileSync(marker, JSON.stringify({ phase: 'entered' }));",
      "let input = ''; for await (const chunk of process.stdin) input += chunk;",
      `const result = spawnSync(process.execPath, [${JSON.stringify(CM)}, 'recall'], { input, env: process.env, timeout: 9000, maxBuffer: 1024 * 1024, windowsHide: true });`,
      "fs.writeFileSync(marker, JSON.stringify({ phase: 'exited', code: result.status, error: result.error?.code, stderr: String(result.stderr || '').slice(0, 800) }));",
      "if (result.stdout) process.stdout.write(result.stdout);",
      "process.exitCode = typeof result.status === 'number' ? result.status : 1;",
      '',
    ].join('\n'));
    const executable = path.basename(process.execPath);
    if (!/^[A-Za-z0-9_.-]+$/.test(executable)) throw new Error('unsupported Node executable name for command hook');
    const command = `${executable} "${runner}"`;
    fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), canaryConfig(endpoint, command));
    fs.writeFileSync(env.SM_CONFIG, JSON.stringify({
      cammut: { url: endpoint }, hindsight: { recall: false, capture: false }, openviking: { recall: false, capture: false },
      archive: { enabled: false }, retention: { enabled: false },
    }));
    const features = await run(binary, ['features', 'list'], workspace, env, 5000);
    const result = await run(binary, canaryArguments(), workspace, env);
    const receiptDir = path.join(env.SM_STATE_DIR, 'checkpoints', checkpoint.project_id, checkpoint.workspace_id);
    const receiptNames = fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).filter((name) => name.startsWith('receipt-')) : [];
    const emitted = receiptNames.some((name) => JSON.parse(fs.readFileSync(path.join(receiptDir, name), 'utf8')).delivery === 'emitted');
    const events = result.stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const completed = completedCanaryTurn(events);
    const launch = fs.existsSync(launchMarker) ? JSON.parse(fs.readFileSync(launchMarker, 'utf8')) : null;
    preserveRoot ||= launch?.error === 'ETIMEDOUT' || launch?.phase === 'entered';
    if (launch) launch.stderr = redact(launch.stderr || '');
    const verified = verifyCanaryEvidence({
      ...observed, client_exit_code: result.code, checkpoint_emission_recorded: emitted, completion_observed: completed, hook_launch: launch,
    });
    return {
      version: version.stdout.trim(), ...observed, client_exit_code: result.code,
      hooks_feature: features.stdout.split('\n').find((line) => /^hooks\s/.test(line)) || 'unknown',
      completion_observed: completed, checkpoint_emission_recorded: emitted,
      hook_launch: launch,
      hook_state_created: fs.existsSync(env.SM_STATE_DIR),
      hook_diagnostic: verified ? null : redact(fs.existsSync(path.join(env.SM_STATE_DIR, 'hook.log'))
        ? fs.readFileSync(path.join(env.SM_STATE_DIR, 'hook.log'), 'utf8') : '').slice(0, 1200),
      event_types: events.map((event) => event.type).slice(0, 20),
      client_messages: verified ? [] : events.filter((event) => event.item).slice(0, 6).map(({ item }) => ({
        type: item.type, text: redact(item.text || item.message || '').slice(0, 800),
      })),
      diagnostic: verified ? null : redact(result.stderr).slice(0, 1600),
      verified,
      unexpected_requests_absent: observed.blocked_proxy_requests === 0 && observed.unmatched_requests.length === 0,
      cleanup,
      scope: 'installed-client transport injection using a synthetic loopback provider; not model understanding or forced compaction',
      network_boundary: 'explicit loopback endpoints, credential-free child environment and deny proxy; not OS-level egress certification',
    };
  } finally {
    if (provider?.listening) await close(provider);
    if (deny.listening) await close(deny);
    if (preserveRoot) {
      Object.assign(cleanup, { temporary_files: 'preserved-after-process-kill', path: root });
    } else {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        cleanup.temporary_files = 'removed';
      } catch (error) {
        Object.assign(cleanup, { temporary_files: 'incomplete', path: root, error: error.code });
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--codex-bin') {
    console.error('usage: node adapters/codex/client-canary.mjs --run --codex-bin <absolute installed codex binary>');
    process.exitCode = 2;
  } else {
    try {
      const result = await runCanary(args[2]);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.verified ? 0 : 1;
    } catch (error) {
      console.error(redact(error.message));
      process.exitCode = 1;
    }
  }
}
