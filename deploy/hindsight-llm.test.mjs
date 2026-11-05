// Tests the real deploy/hindsight-llm (Python 3) against a fake docker and a fake curl, in a temp directory that stands in for the VDS
// (HLLM_ROOT). Nothing here touches a real container, network or secret: every key below is an obvious fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fwd = (p) => p.replace(/\\/g, '/');
const SCRIPT = fwd(path.join(here, 'hindsight-llm'));
const PY = process.env.SM_PYTHON || ['python3', 'python', 'py'].find((c) => spawnSync(c, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' }).stdout?.trim() === '3');
const t = (name, fn) => test(name, { skip: !PY && 'python3 not available' }, fn);
const posix = process.platform !== 'win32';

const GC_KEY = 'FAKE-GENERALCOMPUTE-KEY-0000000000000000';
const BEARER = 'FAKE-HINDSIGHT-BEARER-1111111111111111';
const KEY1 = 'FAKE-NEW-LLM-KEY-aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY2 = 'FAKE-OTHER-LLM-KEY-bbbbbbbbbbbbbbbbbbbbbbb';
const GC_URL = 'https://api.generalcompute.com/v1';
const URL_A = 'https://llm.example.test/v1';

// ---- the fake: one script plays docker and curl; state lives in FAKE_DIR. Serialised with toString() so it is real, checked code.
async function fake() {
  const fs = await import('node:fs');
  const [, , tool, ...argv] = process.argv;
  const D = process.env.FAKE_DIR;
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(`${D}/${f}`, 'utf8')); } catch { return d; } };
  const wj = (f, v) => fs.writeFileSync(`${D}/${f}`, JSON.stringify(v));
  const note = (o) => fs.appendFileSync(`${D}/calls.log`, JSON.stringify({ tool, ...o }) + '\n');
  const dotenv = (p) => Object.fromEntries([...fs.readFileSync(p, 'utf8').matchAll(/^(\w+)='?(.*?)'?$/gm)].map((m) => [m[1], m[2]]));
  const c = rj('container.json', null);
  if (tool === 'docker') {
    note({ argv });
    if (argv[0] === 'inspect') {
      if (!c) { console.error('No such object'); process.exit(1); }
      console.log(argv[2].includes('Config.Env') ? JSON.stringify(Object.entries(c.env).map(([k, v]) => `${k}=${v}`)) : c.image);
      process.exit(0);
    }
    const files = []; const envs = [];
    argv.forEach((a, i) => { if (a === '-f') files.push(argv[i + 1]); if (a === '--env-file') envs.push(argv[i + 1]); });
    const env = { ...rj('base.json', {}) };
    const hasOverride = files.includes('compose.llm.yaml');
    if (hasOverride && !process.env.FAKE_IGNORE_OVERRIDE) {
      const vars = Object.assign({}, ...envs.map(dotenv));
      for (const m of fs.readFileSync('compose.llm.yaml', 'utf8').matchAll(/^ {6}(\w+): "(.*)"$/gm)) {
        let v = m[2];
        const r = v.match(/^\$\{(\w+):\?[^}]*\}$/);
        if (r) { if (!vars[r[1]]) { console.error('required variable is missing'); process.exit(1); } v = vars[r[1]]; }
        env[m[1]] = v;
      }
    }
    if (argv.includes('config')) { console.log(JSON.stringify({ services: { hindsight: { environment: env } } })); process.exit(0); }
    if (argv.includes('up')) {
      const n = rj('ups', 0) + 1; wj('ups', n);
      if (process.env.FAKE_UP_FAIL_FROM && n >= Number(process.env.FAKE_UP_FAIL_FROM)) { console.error('up failed'); process.exit(1); }
      wj('container.json', { env, image: 'sha256:cafe' });
      wj(`up-${n}.json`, { override: hasOverride ? fs.readFileSync('compose.llm.yaml', 'utf8') : null, envfiles: envs.map((p) => fs.readFileSync(p, 'utf8')) });
    }
    process.exit(0);
  }
  // curl: the whole request arrives as a config on stdin
  const cfg = fs.readFileSync(0, 'utf8');
  const get = (k) => (cfg.match(new RegExp(`^${k} = "(.*)"$`, 'm')) || [])[1];
  const un = (s) => s && s.replace(/\\(.)/g, '$1');
  const url = new URL(un(get('url'))); const method = un(get('request')); const raw = get('data');
  const token = (cfg.match(/^header = "Authorization: Bearer (.*)"$/m) || [])[1];
  note({ argv, method, path: url.pathname, data: raw ? JSON.parse(un(raw)) : null, auth: token === process.env.FAKE_BEARER ? 'ok' : 'bad' });
  const reply = (code, body) => { process.stdout.write((body === undefined ? '' : JSON.stringify(body)) + '\n' + code); process.exit(0); };
  if (!c) process.exit(7);
  if (token !== process.env.FAKE_BEARER) reply(401, { detail: 'unauthorized' });
  const model = c.env.HINDSIGHT_API_LLM_MODEL || '';
  const banks = rj('banks.json', { live: {}, deleted: [] });
  const p = url.pathname; let m;
  if (p === '/health') reply(model.includes('healthfail') ? 503 : 200, { status: 'healthy' });
  if (method === 'POST' && (m = p.match(/^\/v1\/default\/banks\/[^/]+\/health\/llm$/))) {
    if (process.env.FAKE_PROBE === '404') reply(404, { detail: 'disabled' });
    const retainOk = !model.includes('probefail');
    reply(200, { bank_id: 'x', operations: [{ operation: 'retain', ok: retainOk, status: retainOk ? 'connected' : 'unreachable' }, { operation: 'reflect', ok: true, status: 'connected' }] });
  }
  if (method === 'PUT' && (m = p.match(/^\/v1\/default\/banks\/([^/]+)$/))) { banks.live[m[1]] = { facts: [] }; wj('banks.json', banks); reply(200, { bank_id: m[1] }); }
  if (method === 'DELETE' && (m = p.match(/^\/v1\/default\/banks\/([^/]+)$/))) {
    if (process.env.FAKE_DELETE_FAIL) reply(500, { detail: 'no' });
    delete banks.live[m[1]]; banks.deleted.push(m[1]); wj('banks.json', banks); reply(200, { success: true });
  }
  if (method === 'POST' && (m = p.match(/^\/v1\/default\/banks\/([^/]+)\/memories$/))) {
    if (!banks.live[m[1]]) reply(404, {});
    if (model.includes('retainfail')) reply(500, { detail: 'llm error' });
    banks.live[m[1]].facts.push(JSON.parse(un(raw)).items[0].content); wj('banks.json', banks); reply(200, { success: true, async: false });
  }
  if (method === 'POST' && (m = p.match(/^\/v1\/default\/banks\/([^/]+)\/memories\/recall$/))) {
    reply(200, { results: model.includes('norecall') ? [] : (banks.live[m[1]]?.facts || []).map((f) => ({ text: f })) });
  }
  reply(404, {});
}

const q = (s) => `'${fwd(s)}'`;
const tmp = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'hllm-')));
const BASE_ENV = {
  HINDSIGHT_API_LLM_PROVIDER: 'openai', HINDSIGHT_API_LLM_BASE_URL: GC_URL, HINDSIGHT_API_LLM_MODEL: 'minimax-m2.7',
  HINDSIGHT_API_LLM_API_KEY: GC_KEY, HINDSIGHT_API_LLM_MAX_CONCURRENT: '2', HINDSIGHT_API_LLM_TIMEOUT: '120', HINDSIGHT_API_LLM_MAX_RETRIES: '1',
};

function sandbox({ bearer = true, running = true, baseExtra = {} } = {}) {
  const root = tmp();
  const dirs = ['opt/shared-memory/deployment', 'root/private', 'var/backups/memory', 'var/lock', 'fake'];
  for (const d of dirs) fs.mkdirSync(`${root}/${d}`, { recursive: true });
  for (const f of ['compose.yaml', 'compose.4gb.yaml']) fs.writeFileSync(`${root}/opt/shared-memory/deployment/${f}`, `# ${f}\nservices: {}\n`);
  fs.writeFileSync(`${root}/root/private/shared-memory.env`, `GENERALCOMPUTE_API_KEY=${GC_KEY}\n${bearer ? `HINDSIGHT_API_KEY=${BEARER}\n` : ''}`);
  const env0 = { ...BASE_ENV, ...baseExtra };
  fs.writeFileSync(`${root}/fake/base.json`, JSON.stringify(env0));
  if (running) fs.writeFileSync(`${root}/fake/container.json`, JSON.stringify({ env: env0, image: 'sha256:aaaa' }));
  fs.writeFileSync(`${root}/fake/fake.mjs`, `const run = ${fake.toString()};\nawait run();\n`);
  const env = {
    ...process.env, HLLM_ROOT: root, FAKE_DIR: `${root}/fake`, FAKE_BEARER: BEARER,
    HLLM_DOCKER: `${q(process.execPath)} ${q(`${root}/fake/fake.mjs`)} docker`, HLLM_CURL: `${q(process.execPath)} ${q(`${root}/fake/fake.mjs`)} curl`,
    HLLM_HEALTH_WAIT: '1', HLLM_POLL: '0.05',
  };
  for (const k of ['FAKE_PROBE', 'FAKE_UP_FAIL_FROM', 'FAKE_IGNORE_OVERRIDE', 'FAKE_DELETE_FAIL']) delete env[k];
  const run = (args, { input = '', extra = {} } = {}) => spawnSync(PY, ['-I', SCRIPT, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' });
  const f = (p) => `${root}/${p}`;
  const P = { override: f('opt/shared-memory/deployment/compose.llm.yaml'), keyfile: f('root/private/hindsight-llm.env'), log: f('var/log/hindsight-llm.log'), hist: f('var/lib/hindsight-llm/history') };
  const calls = () => (fs.existsSync(f('fake/calls.log')) ? fs.readFileSync(f('fake/calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const jr = (n, d) => { try { return JSON.parse(fs.readFileSync(f(`fake/${n}`), 'utf8')); } catch { return d; } };
  const container = () => jr('container.json', null);
  // what the calls were, in order, without bank-name noise
  const seq = () => calls().map((c) => (c.tool === 'curl' ? `${c.method} ${c.path.replace(/llm-canary-\d+/, 'llm-canary-N')}` : c.argv[0] === 'inspect' ? `inspect ${c.argv[2].includes('Config.Env') ? 'env' : 'image'}` : `compose ${c.argv.includes('config') ? 'config' : c.argv.includes('up') ? 'up' : c.argv.join(' ')}`));
  // every file outside fake/, as relative path -> content; used to prove "nothing changed"
  const tree = () => {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (p === f('fake') || p.endsWith('.lock')) continue; e.isDirectory() ? walk(p) : (out[p.slice(root.length)] = fs.readFileSync(p, 'utf8')); } };
    walk(root);
    return out;
  };
  const snaps = () => (fs.existsSync(P.hist) ? fs.readdirSync(P.hist).sort() : []);
  return { root, run, calls, seq, tree, container, jr, P, f, env, snaps, up: (n) => jr(`up-${n}.json`, null) };
}

const OVERRIDE_A = (extra = {}) => ['# Generated by hindsight-llm. Do not edit by hand: use hindsight-llm set / rollback.', 'services:', '  hindsight:', '    environment:',
  `      HINDSIGHT_API_LLM_PROVIDER: "${extra.provider ?? 'openai'}"`, `      HINDSIGHT_API_LLM_BASE_URL: "${extra.url ?? URL_A}"`, `      HINDSIGHT_API_LLM_MODEL: "${extra.model ?? 'model-a'}"`,
  '      HINDSIGHT_API_LLM_API_KEY: "${HINDSIGHT_LLM_API_KEY:?missing /root/private/hindsight-llm.env}"',
  `      HINDSIGHT_API_LLM_MAX_CONCURRENT: "${extra.conc ?? '2'}"`, `      HINDSIGHT_API_LLM_TIMEOUT: "${extra.timeout ?? '120'}"`, `      HINDSIGHT_API_LLM_MAX_RETRIES: "${extra.retries ?? '1'}"`, ''].join('\n');
const SET_A = ['set', '--provider', 'openai', '--model', 'model-a', '--base-url', URL_A, '--key-stdin', '--yes'];
const noLeak = (r, ...keys) => { for (const k of keys) assert.ok(!(r.stdout + r.stderr).includes(k), 'a key appeared in the output'); };

t('the script is valid Python', () => {
  const r = spawnSync(PY, ['-I', '-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

t('presets lists the seven built-in presets', () => {
  const r = sandbox().run(['presets']);
  assert.equal(r.status, 0, r.stderr);
  for (const n of ['general-compute', 'openai', 'anthropic', 'openrouter', 'deepseek', 'groq', 'custom']) assert.match(r.stdout, new RegExp(`^${n} `, 'm'));
  assert.match(r.stdout, /general-compute\s+openai\s+https:\/\/api\.generalcompute\.com\/v1\s+minimax-m2\.7/);
});

t('show reads the running container, prints the key only as set (length N) and flags per-operation overrides', () => {
  const s = sandbox({ baseExtra: { HINDSIGHT_API_RETAIN_LLM_MODEL: 'other', HINDSIGHT_API_LLM_DEFAULT_HEADERS: 'X-Secret: LEAKME' } });
  const r = s.run(['show']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /provider\s+: openai/);
  assert.match(r.stdout, /base_url\s+: https:\/\/api\.generalcompute\.com\/v1/);
  assert.match(r.stdout, /model\s+: minimax-m2\.7/);
  assert.match(r.stdout, /timeout\s+: 120/);
  assert.match(r.stdout, /max_concurrent\s*: 2/);
  assert.match(r.stdout, new RegExp(`api_key\\s+: set \\(length ${GC_KEY.length}\\)`));
  assert.match(r.stdout, /per-operation LLM overrides: HINDSIGHT_API_RETAIN_LLM_MODEL/);
  assert.match(r.stdout, /other LLM variables: HINDSIGHT_API_LLM_DEFAULT_HEADERS \(values not shown\)/);
  noLeak(r, GC_KEY, 'LEAKME');
});

t('show falls back to compose config when the container is not running', () => {
  const s = sandbox({ running: false });
  const r = s.run(['show']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /compose config \(container not running\)/);
  noLeak(r, GC_KEY);
});

t('dry run changes nothing, prints the plan with the key masked, and only reads from docker', () => {
  const s = sandbox();
  const before = s.tree();
  const r = s.run(SET_A.filter((x) => x !== '--yes'), { input: KEY1 + '\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.tree(), before, 'no file was created or changed');
  assert.deepEqual(s.seq(), ['inspect env'], 'only the read-only inspect ran');
  assert.match(r.stdout, /DRY RUN: nothing was changed/);
  assert.match(r.stdout, /model\s+minimax-m2\.7\s+->\s+model-a/);
  assert.match(r.stdout, new RegExp(`length ${KEY1.length}`));
  assert.match(r.stdout, /HINDSIGHT_LLM_API_KEY='\*\*\*\*'/);
  assert.ok(r.stdout.includes(OVERRIDE_A().trim().split('\n').slice(-3).join('\n    ').split('\n')[0].slice(0, 20)));
  assert.match(r.stdout, /docker compose -p shared-memory-pilot -f compose\.yaml -f compose\.4gb\.yaml -f compose\.llm\.yaml --env-file .*shared-memory\.env --env-file .*hindsight-llm\.env up -d --no-deps hindsight/);
  noLeak(r, KEY1, GC_KEY);
});

t('presets resolve defaults, explicit flags override them, and the plan names them', () => {
  const s = sandbox();
  const r = s.run(['set', '--preset', 'general-compute', '--model', 'other-model', '--key-stdin'], { input: KEY1 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /provider\s+openai\s+\(unchanged\)/);
  assert.match(r.stdout, /base_url\s+https:\/\/api\.generalcompute\.com\/v1\s+\(unchanged\)/);
  assert.match(r.stdout, /model\s+minimax-m2\.7\s+->\s+other-model/);
  const a = s.run(['set', '--preset', 'anthropic', '--model', 'claude-x', '--key-stdin'], { input: KEY1 });
  assert.match(a.stdout, /provider\s+openai\s+->\s+anthropic/);
  assert.match(a.stdout, /base_url\s+https:\/\/api\.generalcompute\.com\/v1\s+->\s+\(provider default\)/);
  assert.match(a.stdout, /HINDSIGHT_API_LLM_BASE_URL: ""/);
});

const BAD = [
  ['http without the flag', { '--base-url': 'http://10.0.0.5:11434/v1' }],
  ['http to a public host even with the flag', { '--base-url': 'http://example.com/v1', '--allow-insecure-url': true }],
  ['user info in the URL', { '--base-url': 'https://user:hunter2@llm.example.test/v1' }],
  ['another scheme', { '--base-url': 'ftp://llm.example.test/v1' }],
  ['whitespace in the URL', { '--base-url': 'https://llm.example.test/v1 x' }],
  ['a "$" in the URL (compose interpolation)', { '--base-url': 'https://llm.example.test/$v1' }],
  ['whitespace in the model', { '--model': 'a b' }],
  ['a control character in the model', { '--model': 'a\x07b' }],
  ['a newline in the model', { '--model': 'a\nb' }],
  ['a quote in the model', { '--model': 'a"b' }],
  ['a "$" in the model', { '--model': 'a$b' }],
  ['an upper-case provider', { '--provider': 'OpenAI' }],
  ['an unknown provider', { '--provider': 'nonesuch' }],
  ['timeout 0', { '--timeout': '0' }],
  ['a non-numeric timeout', { '--timeout': 'abc' }],
  ['too many concurrent calls', { '--max-concurrent': '100' }],
  ['a negative retry count', { '--max-retries': '-1' }],
  ['an unknown preset', { '--preset': 'nope' }],
  ['preset custom without its three values', { '--preset': 'custom', '--base-url': null }],
];
const flagsToArgs = (o) => Object.entries(o).filter(([, v]) => v !== null).flatMap(([k, v]) => (v === true ? [k] : v.startsWith('-') ? [`${k}=${v}`] : [k, v]));
for (const [name, over] of BAD) {
  t(`validation refuses ${name} (exit 2, nothing changed, nothing echoed)`, () => {
    const s = sandbox();
    const before = s.tree();
    const r = s.run(['set', ...flagsToArgs({ '--provider': 'openai', '--model': 'model-a', '--base-url': URL_A, '--key-stdin': true, '--yes': true, ...over })], { input: KEY1 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.deepEqual(s.tree(), before);
    assert.ok(!s.seq().some((x) => x.startsWith('compose')), 'docker compose never ran');
    noLeak(r, KEY1, 'hunter2');
  });
}

t('an unlisted provider needs --provider-unlisted and then warns; an http base URL on a private address is accepted with its flag', () => {
  const s = sandbox();
  const dry = (a, input = KEY1) => s.run(['set', '--model', 'm1', '--key-stdin', ...a], { input });
  assert.equal(dry(['--provider', 'weird']).status, 2);
  const u = dry(['--provider', 'weird', '--provider-unlisted']);
  assert.equal(u.status, 0, u.stderr);
  assert.match(u.stderr, /not in the known list/);
  for (const url of ['http://10.0.0.5:11434/v1', 'http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://host.docker.internal:11434/v1']) {
    const r = dry(['--provider', 'ollama', '--base-url', url, '--allow-insecure-url']);
    assert.equal(r.status, 0, `${url}: ${r.stderr}`);
    assert.match(r.stderr, /plain http base URL/);
  }
});

t('key rules: stdin or file only, exactly one source, no spaces/quotes/short keys, nothing echoed', () => {
  const s = sandbox();
  const base = ['set', '--provider', 'openai', '--model', 'model-a'];
  for (const k of ['', 'short', 'has a space-aaaaaaaa', "has'quote-aaaaaaaaaa", 'tab\tinside-aaaaaaaa']) {
    const r = s.run([...base, '--key-stdin'], { input: k });
    assert.equal(r.status, 2, JSON.stringify(k));
    assert.match(r.stderr, /^error: key: must be 8-4096 printable ASCII/);
    if (k.length > 5) noLeak(r, k);
  }
  assert.equal(s.run(base).status, 2, 'no key source');
  assert.equal(s.run([...base, '--key-stdin', '--keep-key'], { input: KEY1 }).status, 2, 'two key sources');
  const kf = `${s.root}/k.txt`;
  fs.writeFileSync(kf, KEY1 + '\r\n');
  assert.equal(s.run([...base, '--key-file', kf]).status, 0, 'key file with CRLF accepted');
  assert.equal(s.run([...base, '--key-file', `${s.root}/missing`]).status, 2);
  const r = s.run([...base, '--key-stdin', `--api-key=${KEY1}`]);
  assert.equal(r.status, 2);
  noLeak(r, KEY1);
});

t('apply: snapshot, key file, override, config check, recreate only hindsight, health, canary; exact files, exact call sequence', () => {
  const s = sandbox();
  const r = s.run(SET_A, { input: KEY1 + '\n' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(s.P.override, 'utf8'), OVERRIDE_A());
  assert.equal(fs.readFileSync(s.P.keyfile, 'utf8'), `# Written by hindsight-llm (mode 0600). Read only through compose.llm.yaml.\nHINDSIGHT_LLM_API_KEY='${KEY1}'\n`);
  assert.deepEqual(s.seq(), ['inspect env', 'inspect image', 'compose config', 'compose up', 'GET /health', 'POST /v1/default/banks/alice-shared/health/llm',
    'PUT /v1/default/banks/llm-canary-N', 'POST /v1/default/banks/llm-canary-N/memories', 'POST /v1/default/banks/llm-canary-N/memories/recall', 'DELETE /v1/default/banks/llm-canary-N']);
  const up = s.calls().find((c) => c.tool === 'docker' && c.argv.includes('up')).argv;
  assert.deepEqual(up, ['compose', '-p', 'shared-memory-pilot', '-f', 'compose.yaml', '-f', 'compose.4gb.yaml', '-f', 'compose.llm.yaml',
    '--env-file', `${s.root}/root/private/shared-memory.env`, '--env-file', s.P.keyfile, 'up', '-d', '--no-deps', 'hindsight']);
  assert.deepEqual(s.container().env, { ...BASE_ENV, HINDSIGHT_API_LLM_BASE_URL: URL_A, HINDSIGHT_API_LLM_MODEL: 'model-a', HINDSIGHT_API_LLM_API_KEY: KEY1 });
  const [snap] = s.snaps();
  const meta = JSON.parse(fs.readFileSync(`${s.P.hist}/${snap}/meta.json`, 'utf8'));
  assert.equal(meta.had_override, false); assert.equal(meta.had_key_file, false); assert.equal(meta.image_id, 'sha256:aaaa');
  assert.equal(meta.provider, 'openai'); assert.equal(meta.model, 'minimax-m2.7'); assert.equal(meta.base_url_host, 'api.generalcompute.com');
  assert.match(r.stdout, /DONE: hindsight now uses provider=openai model=model-a host=llm\.example\.test/);
  // no temp files left behind, and the canary used the bearer from the env file
  assert.deepEqual(fs.readdirSync(`${s.root}/root/private`).sort(), ['hindsight-llm.env', 'shared-memory.env']);
  assert.deepEqual(fs.readdirSync(`${s.root}/opt/shared-memory/deployment`).sort(), ['compose.4gb.yaml', 'compose.llm.yaml', 'compose.yaml']);
  assert.ok(s.calls().filter((c) => c.tool === 'curl').every((c) => c.auth === 'ok'));
  const canary = s.calls().filter((c) => c.tool === 'curl');
  assert.equal(canary.find((c) => c.path.endsWith('/memories')).data.async, false, 'retain is synchronous');
  // show now reports the new settings
  assert.match(s.run(['show']).stdout, /model\s+: model-a/);
});

t('apply: modes (key file 0600, snapshot dirs 0700, snapshot key copy 0600)', (ctx) => {
  if (!posix) return ctx.skip('no POSIX modes on this platform');
  const s = sandbox();
  s.run(SET_A, { input: KEY1 });
  s.run(['set', '--provider', 'openai', '--model', 'model-b', '--base-url', URL_A, '--key-stdin', '--yes'], { input: KEY2 });
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  assert.equal(mode(s.P.keyfile), '600');
  assert.equal(mode(s.P.hist), '700');
  const second = s.snaps()[1];
  assert.equal(mode(`${s.P.hist}/${second}`), '700');
  assert.equal(mode(`${s.P.hist}/${second}/hindsight-llm.env`), '600');
  assert.equal(fs.readFileSync(`${s.P.hist}/${second}/hindsight-llm.env`, 'utf8').includes(KEY1), true, 'the previous key is copied for rollback');
});

t('a key never reaches the log, the recorded docker/curl argv, stdout/stderr or any file other than the two allowed copies', () => {
  const s = sandbox();
  const r = s.run(SET_A, { input: KEY1 });
  s.run(['set', '--provider', 'openai', '--model', 'retainfail', '--base-url', URL_A, '--key-stdin', '--yes'], { input: KEY2 });
  noLeak(r, KEY1, GC_KEY, BEARER);
  const calls = JSON.stringify(s.calls());
  for (const k of [KEY1, KEY2, GC_KEY, BEARER]) assert.ok(!calls.includes(k), 'argv/requests recorded by the fakes carry no key');
  const log = fs.readFileSync(s.P.log, 'utf8');
  for (const k of [KEY1, KEY2, GC_KEY, BEARER]) assert.ok(!log.includes(k));
  assert.match(log, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ cmd="set" provider="openai" model="model-a" host="llm\.example\.test"$/m);
  assert.match(log, /outcome="ok"/);
  assert.match(log, /outcome="rolled back"/);
  const allowed = new Set(['/root/private/hindsight-llm.env', '/root/private/shared-memory.env']);
  for (const [p, body] of Object.entries(s.tree())) {
    const isCopy = /^\/var\/lib\/hindsight-llm\/history\/[^/]+\/hindsight-llm\.env$/.test(p);
    if (allowed.has(p) || isCopy) continue;
    for (const k of [KEY1, KEY2, BEARER]) assert.ok(!body.includes(k), `${p} must not hold a key`);
  }
});

t('a failing canary rolls back automatically and restores the exact previous files, then exits 1', () => {
  const s = sandbox();
  assert.equal(s.run(SET_A, { input: KEY1 }).status, 0);
  const keep = { override: fs.readFileSync(s.P.override, 'utf8'), keyfile: fs.readFileSync(s.P.keyfile, 'utf8') };
  const r = s.run(['set', '--provider', 'openai', '--model', 'retainfail', '--base-url', URL_A, '--key-stdin', '--yes'], { input: KEY2 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /FAILED: canary: synchronous retain failed/);
  assert.match(r.stderr, /rolled back/);
  assert.equal(fs.readFileSync(s.P.override, 'utf8'), keep.override);
  assert.equal(fs.readFileSync(s.P.keyfile, 'utf8'), keep.keyfile);
  assert.deepEqual(s.up(3).override, OVERRIDE_A(), 'the restore recreated hindsight with the previous override');
  assert.equal(s.container().env.HINDSIGHT_API_LLM_MODEL, 'model-a');
  assert.equal(s.container().env.HINDSIGHT_API_LLM_API_KEY, KEY1);
  assert.equal(s.jr('banks.json').live && Object.keys(s.jr('banks.json').live).length, 0, 'no scratch bank left');
  noLeak(r, KEY1, KEY2);
});

t('a failure on the very first switch rolls back to "no override, no key file" and the original container settings', () => {
  const s = sandbox();
  const r = s.run(['set', '--provider', 'openai', '--model', 'norecall', '--base-url', URL_A, '--key-stdin', '--yes'], { input: KEY1 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /recall returned no fact/);
  assert.ok(!fs.existsSync(s.P.override) && !fs.existsSync(s.P.keyfile));
  assert.deepEqual(s.container().env, BASE_ENV);
  const lastUp = s.up(2);
  assert.equal(lastUp.override, null, 'recreated without compose.llm.yaml');
  assert.equal(lastUp.envfiles.length, 1);
  assert.deepEqual(Object.keys(s.jr('banks.json').live), [], 'the scratch bank was deleted on failure too');
});

for (const [name, model, extra, re] of [
  ['the health endpoint never turns 200', 'healthfail', {}, /health check .* did not return 200/],
  ['the probe reports a broken operation', 'probefail', {}, /probe failed for retain \(unreachable\)/],
  ['the compose override is not applied by docker compose config', 'model-a', { FAKE_IGNORE_OVERRIDE: '1' }, /compose does not apply the override for: .*MODEL/],
]) {
  t(`rollback also covers: ${name}`, () => {
    const s = sandbox();
    const r = s.run(['set', '--provider', 'openai', '--model', model, '--base-url', URL_A, '--key-stdin', '--yes'], { input: KEY1, extra });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, re);
    assert.ok(!fs.existsSync(s.P.override) && !fs.existsSync(s.P.keyfile));
    assert.equal(s.container().env.HINDSIGHT_API_LLM_MODEL, 'minimax-m2.7');
    assert.deepEqual(Object.keys(s.jr('banks.json', { live: {} }).live), []);
  });
}

t('an unavailable probe (HTTP 404, Hindsight leaves it off by default) is skipped with a note; the round trip still decides', () => {
  const s = sandbox();
  const r = s.run(SET_A, { input: KEY1, extra: { FAKE_PROBE: '404' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /canary: probe unavailable \(HTTP 404/);
  assert.match(r.stdout, /round trip ok/);
});

t('if the rollback itself fails the tool exits 4 and prints the manual commands loudly', () => {
  const s = sandbox();
  const r = s.run(['set', '--provider', 'openai', '--model', 'retainfail', '--base-url', URL_A, '--key-stdin', '--yes'], { input: KEY1, extra: { FAKE_UP_FAIL_FROM: '2' } });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stderr, /!!! ROLLBACK FAILED/);
  assert.match(r.stderr, /manual recovery/);
  assert.match(r.stderr, new RegExp(`rm -f ${s.P.override.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.stderr, /cd .*deployment && docker compose -p shared-memory-pilot -f compose\.yaml -f compose\.4gb\.yaml -f compose\.llm\.yaml .* up -d --no-deps hindsight/);
  assert.match(r.stderr, new RegExp(`snapshot: ${s.P.hist}/\\d{8}T\\d{6}Z`));
  assert.match(fs.readFileSync(s.P.log, 'utf8'), /outcome="ROLLBACK FAILED"/);
  noLeak(r, KEY1);
});

t('the scratch bank is deleted when the round trip passes and when it fails; a delete failure is reported loudly', () => {
  const s = sandbox();
  assert.equal(s.run(SET_A, { input: KEY1 }).status, 0);
  assert.equal(s.jr('banks.json').deleted.length, 1);
  assert.match(s.jr('banks.json').deleted[0], /^llm-canary-\d+$/);
  const s2 = sandbox();
  s2.run(['set', '--provider', 'openai', '--model', 'norecall', '--base-url', URL_A, '--key-stdin', '--yes'], { input: KEY1 });
  assert.ok(s2.jr('banks.json').deleted.every((b) => /^llm-canary-\d+$/.test(b)) && s2.jr('banks.json').deleted.length >= 1);
  const s3 = sandbox();
  const r = s3.run(SET_A, { input: KEY1, extra: { FAKE_DELETE_FAIL: '1' } });
  assert.match(r.stderr, /WARNING: scratch bank llm-canary-\d+ was NOT deleted/);
  assert.equal(s3.calls().filter((c) => c.method === 'DELETE').length, 2, 'deletion is retried once');
});

t('--keep-key reuses the existing key file untouched, or the running container key when there is no file', () => {
  const s = sandbox();
  s.run(SET_A, { input: KEY1 });
  const keyfile = fs.readFileSync(s.P.keyfile, 'utf8');
  const r = s.run(['set', '--provider', 'openai', '--model', 'model-b', '--base-url', URL_A, '--keep-key', '--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(s.P.keyfile, 'utf8'), keyfile, 'key file byte-identical');
  assert.equal(s.container().env.HINDSIGHT_API_LLM_API_KEY, KEY1);
  assert.match(r.stdout, /kept \(existing key\)/);
  const f = sandbox();
  const first = f.run(['set', '--preset', 'general-compute', '--timeout', '90', '--keep-key', '--yes']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(fs.readFileSync(f.P.keyfile, 'utf8').includes(GC_KEY), true, 'the container key moved into the dedicated key file');
  assert.equal(f.container().env.HINDSIGHT_API_LLM_TIMEOUT, '90');
  assert.equal(f.container().env.HINDSIGHT_API_LLM_MAX_CONCURRENT, '2', 'unspecified values keep their current setting');
  noLeak(first, GC_KEY);
  const none = sandbox({ running: false });
  assert.equal(none.run(['set', '--preset', 'general-compute', '--keep-key']).status, 2, 'nothing to keep');
});

t('the generated override is exact and carries only HINDSIGHT_API_LLM_* for the hindsight service, with the key as a reference', () => {
  const s = sandbox();
  const r = s.run(['set', '--preset', 'anthropic', '--model', 'claude-test', '--timeout', '200', '--max-concurrent', '4', '--max-retries', '0', '--key-stdin', '--yes'], { input: KEY1 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(s.P.override, 'utf8');
  assert.equal(text, OVERRIDE_A({ provider: 'anthropic', url: '', model: 'claude-test', conc: '4', timeout: '200', retries: '0' }));
  const lines = text.split('\n').filter((l) => l.startsWith('      '));
  assert.equal(lines.length, 7);
  assert.ok(lines.every((l) => /^ {6}HINDSIGHT_API_LLM_[A-Z_]+: ".*"$/.test(l)));
  assert.ok(!text.includes(KEY1) && text.includes('${HINDSIGHT_LLM_API_KEY:?'));
  assert.equal(s.container().env.HINDSIGHT_API_LLM_BASE_URL, '');
});

t('rollback restores the previous snapshot, a second rollback undoes it, --to picks a snapshot, history lists them without keys', () => {
  const s = sandbox();
  s.run(SET_A, { input: KEY1 });
  const aOverride = fs.readFileSync(s.P.override, 'utf8');
  const aKey = fs.readFileSync(s.P.keyfile, 'utf8');
  s.run(['set', '--provider', 'anthropic', '--model', 'model-b', '--key-stdin', '--yes'], { input: KEY2 });
  assert.equal(s.container().env.HINDSIGHT_API_LLM_PROVIDER, 'anthropic');
  const r = s.run(['rollback']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(s.P.override, 'utf8'), aOverride);
  assert.equal(fs.readFileSync(s.P.keyfile, 'utf8'), aKey);
  assert.equal(s.container().env.HINDSIGHT_API_LLM_API_KEY, KEY1);
  assert.match(r.stdout, /rollback done, service healthy/);
  const again = s.run(['rollback']);
  assert.equal(again.status, 0);
  assert.equal(s.container().env.HINDSIGHT_API_LLM_PROVIDER, 'anthropic', 'rollback again undoes the rollback');
  const first = s.snaps()[0];
  const base = s.run(['rollback', '--to', first]);
  assert.equal(base.status, 0, base.stderr);
  assert.ok(!fs.existsSync(s.P.override) && !fs.existsSync(s.P.keyfile), 'back to the original compose.yaml settings');
  assert.deepEqual(s.container().env, BASE_ENV);
  const h = s.run(['history']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /\d{8}T\d{6}Z\s+openai\s+minimax-m2\.7\s+api\.generalcompute\.com/);
  assert.match(h.stdout, /\d{8}T\d{6}Z(-\d+)?\s+openai\s+model-a\s+llm\.example\.test/);
  noLeak(h, KEY1, KEY2, GC_KEY);
  assert.equal(s.run(['rollback', '--to', '20200101T000000Z']).status, 2, 'unknown stamp');
  assert.equal(sandbox().run(['rollback']).status, 2, 'no snapshots yet');
  assert.match(fs.readFileSync(s.P.log, 'utf8'), /cmd="rollback" outcome="ok"/);
});

t('test runs the probe and the scratch-bank round trip without changing anything; a failure exits 1 and still deletes the scratch bank', () => {
  const s = sandbox();
  const before = s.tree();
  const r = s.run(['test']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /TEST PASSED/);
  assert.deepEqual(s.tree(), { ...before, '/var/log/hindsight-llm.log': s.tree()['/var/log/hindsight-llm.log'] });
  assert.ok(!s.seq().some((x) => x === 'compose up'));
  assert.equal(s.jr('banks.json').deleted.length, 1);
  const bad = sandbox({ baseExtra: { HINDSIGHT_API_LLM_MODEL: 'norecall' } });
  const f = bad.run(['test']);
  assert.equal(f.status, 1);
  assert.match(f.stderr, /TEST FAILED/);
  assert.equal(bad.jr('banks.json').deleted.length, 1);
});

t('apply is refused without the Hindsight API key, before anything is written or recreated', () => {
  const s = sandbox({ bearer: false });
  const before = s.tree();
  const r = s.run(SET_A, { input: KEY1 });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /HINDSIGHT_API_KEY not found/);
  assert.deepEqual(s.tree(), { ...before, '/var/log/hindsight-llm.log': s.tree()['/var/log/hindsight-llm.log'] });
  assert.ok(!s.seq().includes('compose up'));
});

// a second process that holds a flock (fcntl, or msvcrt on Windows) until it is killed
function holder(file) {
  const code = 'import sys,os,time\ntry:\n import fcntl\nexcept ImportError:\n fcntl=None\n import msvcrt\nfd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT)\nfcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB) if fcntl else msvcrt.locking(fd,msvcrt.LK_NBLCK,1)\nprint("held",flush=True)\ntime.sleep(60)\n';
  const p = spawn(PY, ['-I', '-c', code, file], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => { p.stdout.once('data', () => resolve(p)); p.once('error', reject); p.once('exit', () => reject(new Error('holder exited'))); });
}

for (const [name, lock, re] of [['another hindsight-llm run', (s) => s.f('var/lock/hindsight-llm.lock'), /another hindsight-llm run is running/], ['the nightly mem-backup', (s) => s.f('var/backups/memory/.mem-backup.lock'), /mem-backup is running/]]) {
  t(`a held lock (${name}) refuses set, test and rollback with exit 3 and changes nothing`, async () => {
    const s = sandbox();
    const h = await holder(lock(s));
    try {
      const before = s.tree();
      const r = s.run(SET_A, { input: KEY1 });
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.match(r.stderr, re);
      assert.equal(s.run(['test']).status, 3);
      assert.equal(s.run(['rollback']).status, 3);
      const after = s.tree();
      delete after['/var/log/hindsight-llm.log'];
      assert.deepEqual(after, before);
      assert.ok(!s.seq().includes('compose up'));
      assert.equal(s.run(['show']).status, 0, 'read-only commands do not need the locks');
    } finally {
      h.kill();
    }
  });
}

t('the lock is released when a run ends, so two runs in a row both work', () => {
  const s = sandbox();
  assert.equal(s.run(SET_A, { input: KEY1 }).status, 0);
  assert.equal(s.run(['test']).status, 0);
});
