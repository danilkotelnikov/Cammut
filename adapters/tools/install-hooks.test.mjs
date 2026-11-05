import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from '../test-helpers.mjs';
import { planHooks, unifiedDiff, MATRIX } from './install-hooks.mjs';

const TOOL = fileURLToPath(new URL('./install-hooks.mjs', import.meta.url));
const NODE = 'C:/Program Files/nodejs/node.exe';
const SM = 'C:/Users/test/.claude/scripts/shared-memory/sm.mjs';
const OPTS = ['--node', NODE, '--script', SM];
const terax = (state) => ({ hooks: [{ type: 'command', command: `[ -n "$TERAX_TERMINAL" ] && printf 'terax ${state}' || true` }] });
const sm = (args, timeout) => ({ hooks: [{ type: 'command', command: `"${NODE}" "${SM}" ${args}`, timeout }] });

// the shape of a real settings.json: the five memory hooks plus Terax notification hooks, plus unrelated settings
const fixture = () => ({
  model: 'opus', env: { A: '1' }, permissions: { allow: ['Bash(ls)'] },
  hooks: {
    Notification: [terax('attention')],
    SessionStart: [sm('recall', 8)],
    PreCompact: [sm('capture --flush', 10)],
    SessionEnd: [sm('capture --flush', 5)],
    Stop: [sm('capture', 10), terax('finished')],
    UserPromptSubmit: [sm('recall', 8), terax('working')],
  },
});
const write = (obj, dir = tmp('ih-')) => { const f = path.join(dir, 'settings.json'); fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n'); return f; };
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 15000 });
const backups = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith('settings.json.bak-'));

test('the matrix covers every event of the autotrigger table with the right command and a timeout', () => {
  assert.deepEqual(MATRIX.map(([e, a]) => `${e}:${a}`), ['SessionStart:recall', 'UserPromptSubmit:recall', 'SubagentStart:recall', 'SubagentStop:capture', 'Stop:capture', 'PreCompact:capture --flush', 'SessionEnd:capture --flush']);
  assert.ok(MATRIX.every(([, , t]) => Number.isInteger(t) && t > 0));
});

test('dry run prints a unified diff of the hooks block and the backup path, and leaves the file untouched', () => {
  const f = write(fixture());
  const before = fs.readFileSync(f);
  const r = run([f, ...OPTS]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--- .*"hooks" \(current\)$/m);
  assert.match(r.stdout, /^\+\+\+ .*"hooks" \(proposed\)$/m);
  assert.match(r.stdout, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.match(r.stdout, /^\+ +"SubagentStart": \[$/m);
  assert.match(r.stdout, /^\+ +"SubagentStop": \[$/m);
  assert.match(r.stdout, /settings\.json\.bak-\d{8}-\d{6}/, 'the backup path is named');
  assert.match(r.stdout, /dry run: nothing written/);
  assert.deepEqual(fs.readFileSync(f), before);
  assert.deepEqual(backups(f), []);
});

test('--apply backs up, registers the missing events, keeps Terax hooks and unrelated settings, and a second run changes nothing', () => {
  const orig = fixture();
  const f = write(orig);
  const before = fs.readFileSync(f);
  const r = run([f, '--apply', ...OPTS]);
  assert.equal(r.status, 0, r.stderr);
  const [bak] = backups(f);
  assert.ok(bak, 'a backup exists');
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(f), bak)), before, 'the backup is the original, byte for byte');
  assert.ok(r.stdout.includes(`Backup: ${f}.bak-`), 'the output names the backup it made');
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [event, args] of MATRIX) {
    const cmds = after.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
    assert.equal(cmds.filter((c) => c.includes('sm.mjs')).length, 1, `${event} has exactly one memory handler`);
    assert.ok(cmds.some((c) => c === `"${NODE}" "${SM}" ${args}`), event);
  }
  assert.deepEqual(after.hooks.Notification, orig.hooks.Notification);
  assert.deepEqual(after.hooks.Stop[1], terax('finished'));
  assert.deepEqual(after.hooks.UserPromptSubmit[1], terax('working'));
  assert.deepEqual([after.model, after.env, after.permissions], [orig.model, orig.env, orig.permissions]);
  const again = run([f, '--apply', ...OPTS]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /no changes/);
  assert.deepEqual(backups(f), [bak], 'no second backup');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), after);
});

test('existing memory handlers are updated in place (own node and script spelling kept), never duplicated', () => {
  const s = fixture();
  s.hooks.UserPromptSubmit[0] = { hooks: [{ type: 'command', command: '"D:/tools/node.exe" "D:/mem/sm.mjs" recall', timeout: 3 }] };
  const { settings, changes } = planHooks(s, { node: NODE, script: SM });
  const h = settings.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(h.command, '"D:/tools/node.exe" "D:/mem/sm.mjs" recall');
  assert.equal(h.timeout, 8);
  assert.ok(changes.some((c) => c.startsWith('UserPromptSubmit: timeout 3 -> 8')));
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].timeout, 3, 'the input object is not modified');
});

test('a SessionStart matcher that skips compaction is reported; a missing hooks block is created', () => {
  const s = { hooks: { SessionStart: [{ matcher: 'startup', ...sm('recall', 8) }] } };
  assert.match(planHooks(s, { node: NODE, script: SM }).warnings.join('|'), /SessionStart.*matcher "startup".*compact/);
  const fresh = planHooks({ theme: 'dark' }, { node: NODE, script: SM }).settings;
  assert.equal(Object.keys(fresh.hooks).length, MATRIX.length);
  assert.equal(fresh.theme, 'dark');
});

test('bad input writes nothing: missing file, invalid JSON, wrong hooks shape', () => {
  const dir = tmp('ih-');
  const missing = run([path.join(dir, 'nope.json'), '--apply', ...OPTS]);
  assert.equal(missing.status, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'nope.json')), 'no file is created');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ "hooks": ');
  assert.equal(run([bad, '--apply', ...OPTS]).status, 2);
  assert.equal(fs.readFileSync(bad, 'utf8'), '{ "hooks": ');
  const shape = write({ hooks: { Stop: 'x' } }, dir);
  const r = run([shape, '--apply', ...OPTS]);
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(shape, 'utf8')), { hooks: { Stop: 'x' } });
  assert.equal(run([]).status, 2);
});

test('indentation and the trailing newline of the file are kept', () => {
  const dir = tmp('ih-');
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ a: 1 }, null, 4));
  assert.equal(run([f, '--apply', ...OPTS]).status, 0);
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, /^\{\n {4}"a": 1,/);
  assert.ok(!text.endsWith('\n'));
});

test('unifiedDiff is empty for equal text and shows hunks with context for a change', () => {
  assert.equal(unifiedDiff('a\nb', 'a\nb'), '');
  const d = unifiedDiff('1\n2\n3\n4\n5\n6\n7\n8\n9', '1\n2\n3\n4\nX\n6\n7\n8\n9');
  assert.match(d, /@@ -2,7 \+2,7 @@/);
  assert.match(d, /^-5$/m);
  assert.match(d, /^\+X$/m);
  assert.ok(!/^ 1$/m.test(d), 'only 3 lines of context');
});

test('docs/HOOKS-AUTOTRIGGER.md names every registered event and the server-side autotriggers, with no address or literal host', () => {
  const doc = fs.readFileSync(new URL('../../docs/HOOKS-AUTOTRIGGER.md', import.meta.url), 'utf8');
  for (const [event] of MATRIX) assert.ok(doc.includes('`' + event), event);
  for (const name of ['state-vds-vpn-cammut', 'working-preferences', 'open-decisions', 'active-projects', 'refresh_after_consolidation', 'PostToolUse', 'cammut.only', 'SM_CAMMUT_ONLY']) assert.ok(doc.includes(name), name);
  assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(doc), 'no IP address in the document (the retired domain is guarded by deploy/no-retired-domain.test.mjs)');
});
