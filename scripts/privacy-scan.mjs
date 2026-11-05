// Privacy scan: finds personal data and secrets in a folder before it is published. No dependencies.
//   node scripts/privacy-scan.mjs [--root <folder>] [--deny <file>] [--strict-brand] [--skip-tests] [--self-test] [--help]
//
// Generic patterns (always on): e-mail addresses, absolute home paths that carry a user name (Windows and Unix),
// public IPv4 addresses, private key headers, and token shapes (sk-, ghp_ and other GitHub prefixes, AKIA, AIza, Slack xox).
// A line that holds the marker  privacy-scan: allow  is skipped by the generic patterns (use it for documentation examples).
//
// Optional private deny-list: a text file that names things the repository must not contain. The path comes from --deny,
// else from the environment variable ARC_PRIVACY_DENY, else .arc-harness-privacy-deny.txt in your home folder. A missing file is not an error.
// Format: two sections, one term per line, matched case-insensitively as plain text. Lines that start with # and blank lines are ignored.
//   [hard]     terms that must never appear, in a file's text or in its path. One hit fails the scan (exit 1).
//   [brand]    terms that may appear but need a decision by the owner. They are listed and counted, and fail only with --strict-brand.
// The scan prints file:line and the class of each finding. It never prints the text of a deny-list term or of a matched line:
// a deny-list finding is reported as "deny-list term 7 (hard)", where 7 is the term's number in the file (hard and brand terms count together).
//
// Exit code: 0 clean, 1 findings, 2 usage error.
// Skipped folders: .git, node_modules, _work, pristine, build. Binary files (images, archives, fonts, video) get the deny-list and key-header checks only. In them, each deny-list term is matched as UTF-8 and as UTF-16LE text, ignoring case.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules', '_work', 'pristine', 'build']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|asar|zip|xz|gz|tgz|7z|woff2?|ttf|otf|pdf|mp4|webm)$/i;
const ALLOW_MARK = 'privacy-scan: allow';

// words that stand for "your name here" and do not name a person
const PLACEHOLDER = '(?![<%{$*]|\\.\\.\\.|(?:public|default user|default|all users|user|users|username|name|you|your|me|example|runner)(?:[\\\\/\\s"\'`]|$))';
const PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => !/@(?:example\.(?:com|org|net)|invalid|localhost)$/i.test(m)],
  ['windows home path', new RegExp('[A-Za-z]:[\\\\/]+Users[\\\\/]+' + PLACEHOLDER + '[^\\\\/\\s"\'`<>|*?]+', 'gi')],
  ['unix home path', new RegExp('(?<![\\w.-])/(?:home|Users)/' + PLACEHOLDER + '[^/\\s"\'`<>|*?]+', 'g')],
  ['public IPv4 address', /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.]*\d)/g, (m) => isPublicIPv4(m)],
  ['private key header', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ['token shape', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/g],
];
const KEY_HEADER = PATTERNS.find((p) => p[0] === 'private key header');

function isPublicIPv4(s) {
  const o = s.split('.').map(Number);
  if (o.length !== 4 || o.some((x) => !(x >= 0 && x <= 255))) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false; // documentation ranges
  return true;
}

export function loadDeny(file) {
  const terms = [];
  if (!file || !fs.existsSync(file)) return { terms, file: null };
  let section = null;
  let n = 0;
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const s = /^\[(hard|brand)\]$/i.exec(line);
    if (s) { section = s[1].toLowerCase(); continue; }
    if (!section) continue;
    n++;
    terms.push({ n, kind: section, term: line.toLowerCase() });
  }
  return { terms, file };
}

// findings of one text: [{ line, cls, fail }]; the matched text is never kept
export function scanText(text, deny, { binary = false } = {}) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const low = line.toLowerCase();
    for (const d of deny.terms) if (low.includes(d.term)) out.push({ line: i + 1, cls: `deny-list term ${d.n} (${d.kind})`, kind: d.kind });
    const list = binary ? [KEY_HEADER] : PATTERNS;
    if (line.includes(ALLOW_MARK)) return;
    for (const [cls, re, accept] of list) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) if (!accept || accept(m[0])) { out.push({ line: i + 1, cls, kind: 'generic' }); break; }
    }
  });
  return out;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); } else if (e.isFile()) yield p;
  }
}

// Deny-list terms inside binary data. A term can sit there as UTF-8 (a text chunk, a tag), or as UTF-16LE (a Windows string). The buffer is
// decoded three ways (UTF-8, UTF-16LE from byte 0, UTF-16LE from byte 1), so a non-ASCII term matches and the match ignores case.
// The line is the number of line breaks before the match, plus one, in that view.
export function scanBinary(buf, deny) {
  const out = [];
  if (!deny.terms.length) return out;
  const views = [buf.toString('utf8'), buf.toString('utf16le'), buf.subarray(1).toString('utf16le')].map((t) => t.toLowerCase());
  for (const d of deny.terms) {
    for (const v of views) {
      const at = v.indexOf(d.term);
      if (at >= 0) { out.push({ line: v.slice(0, at).split('\n').length, cls: `deny-list term ${d.n} (${d.kind})`, kind: d.kind }); break; }
    }
  }
  return out;
}

export function scanFolder(root, deny) {
  const found = [];
  for (const file of walk(root)) {
    if (process.argv.includes('--skip-tests') && /(_test\.go|\.test\.[a-z]+|redact-fixtures\.json|privacy-scan\.mjs)$/.test(file)) continue;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    for (const f of scanText(rel, deny, { binary: true })) if (f.kind !== 'generic') found.push({ file: rel, ...f, line: 0 }); // the path itself
    const buf = fs.readFileSync(file);
    const binary = BINARY.test(file) || buf.subarray(0, 4096).includes(0);
    const hits = scanText(buf.toString(binary ? 'latin1' : 'utf8'), deny, { binary });
    if (binary) {
      const seen = new Set(hits.map((f) => f.cls));   // a term that the plain view found is not reported twice
      for (const f of scanBinary(buf, deny)) if (!seen.has(f.cls)) hits.push(f);
    }
    for (const f of hits) found.push({ file: rel, ...f });
  }
  return found;
}

function selfTest() {
  const bad = [];
  const expect = (label, got, want) => { if (got !== want) bad.push(`${label}: got ${got}, wanted ${want}`); };
  const classes = (t, deny = { terms: [] }) => scanText(t, deny).map((f) => f.cls).join(',');
  const win = (name) => ['C:', 'Users', name, 'file.txt'].join('\\');
  expect('windows path with a name', classes('open ' + win('alice')), 'windows home path');
  expect('windows path in JSON', classes('"' + win('alice').replace(/\\/g, '\\\\') + '"'), 'windows home path');
  expect('windows path placeholder', classes('open ' + win('<you>')), '');
  expect('windows path Public', classes('open ' + win('Public')), '');
  expect('unix path with a name', classes('cd ' + ['', 'home', 'alice', 'x'].join('/')), 'unix home path');
  expect('unix path placeholder', classes('cd ' + ['', 'home', 'user', 'x'].join('/')), '');
  expect('e-mail', classes('write to ' + ['bob', 'mail.test'].join('@')), 'email');
  expect('example e-mail', classes('write to ' + ['bob', 'example.com'].join('@')), '');
  expect('package at version', classes('react' + '@18.3.1 and @types/node'), '');
  expect('public IP', classes('host ' + [8, 8, 8, 8].join('.')), 'public IPv4 address');
  expect('private IP', classes('host ' + [192, 168, 1, 5].join('.')), '');
  expect('documentation IP', classes('host ' + [203, 0, 113, 9].join('.')), '');
  expect('version with five parts', classes('v' + [1, 2, 3, 4, 5].join('.')), '');
  expect('key header', classes(['-----BEGIN', 'RSA', 'PRIVATE KEY-----'].join(' ')), 'private key header');
  expect('sk token', classes('key ' + 'sk-' + 'a1'.repeat(15)), 'token shape');
  expect('github token', classes('key ' + 'ghp_' + 'A'.repeat(36)), 'token shape');
  expect('allow marker', classes('host ' + [8, 8, 8, 8].join('.') + ' # ' + ALLOW_MARK), '');
  const deny = { terms: [{ n: 1, kind: 'hard', term: 'zebra' }, { n: 2, kind: 'brand', term: 'okapi' }] };
  expect('deny hard', classes('A ZEBRA runs', deny), 'deny-list term 1 (hard)');
  expect('deny brand', classes('an Okapi', deny), 'deny-list term 2 (brand)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-privacy-'));
  try {
    const f = path.join(dir, 'deny.txt');
    fs.writeFileSync(f, '# comment\n[hard]\nZebra\n\n[brand]\nOkapi\n');
    const d = loadDeny(f);
    expect('deny file terms', d.terms.map((t) => `${t.n}:${t.kind}`).join(','), '1:hard,2:brand');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'zebra-notes.md'), 'nothing here\nan okapi\n');
    fs.writeFileSync(path.join(dir, 'clean.md'), 'plain text\n');
    const r = scanFolder(dir, d).filter((x) => x.file !== 'deny.txt').map((x) => `${x.file}:${x.line}:${x.cls}`).sort().join(' | ');
    expect('folder scan', r, 'sub/zebra-notes.md:0:deny-list term 1 (hard) | sub/zebra-notes.md:2:deny-list term 2 (brand)');
    // a non-ASCII term inside binary files: as UTF-8, as UTF-16LE on an even byte, and as UTF-16LE on an odd byte, in any case
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'utf8.png'), Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from('xx ZÉBRA yy', 'utf8')]));
    fs.writeFileSync(path.join(bin, 'utf16.ico'), Buffer.concat([Buffer.from([0, 1]), Buffer.from('ZÉBRA', 'utf16le')]));
    fs.writeFileSync(path.join(bin, 'utf16-odd.mp4'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('ZÉBRA', 'utf16le')]));
    fs.writeFileSync(path.join(bin, 'clean.png'), Buffer.from([0, 1, 2, 3, 90, 69, 66, 82, 65]));
    const wide = { terms: [{ n: 7, kind: 'hard', term: 'zébra' }] };
    const rb = scanFolder(bin, wide).map((x) => `${x.file}:${x.line}:${x.cls}`).sort().join(' | ');
    expect('binary scan', rb, 'utf16-odd.mp4:1:deny-list term 7 (hard) | utf16.ico:1:deny-list term 7 (hard) | utf8.png:1:deny-list term 7 (hard)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--help') || argv.includes('-h')) {
    const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(head.slice(0, head.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  if (argv.includes('--self-test')) {
    const bad = selfTest();
    for (const b of bad) console.error('SELF-TEST FAIL ' + b);
    console.log(bad.length ? 'privacy-scan self-test: FAIL' : 'privacy-scan self-test: PASS');
    process.exit(bad.length ? 1 : 0);
  }
  const root = path.resolve(opt('--root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
  if (!fs.existsSync(root)) { console.error('no such folder: ' + root); process.exit(2); }
  const denyFile = opt('--deny', process.env.ARC_PRIVACY_DENY || path.join(os.homedir(), '.arc-harness-privacy-deny.txt'));
  const deny = loadDeny(denyFile);
  const found = scanFolder(root, deny);
  const strictBrand = argv.includes('--strict-brand');
  const fails = found.filter((f) => f.kind !== 'brand' || strictBrand);
  for (const f of found) console.log(`${f.kind === 'brand' && !strictBrand ? 'note' : 'FAIL'} ${f.file}:${f.line}  ${f.cls}`);
  const count = (k) => found.filter((f) => f.kind === k).length;
  console.log(`privacy scan of ${root}: deny-list ${deny.file ? deny.terms.length + ' terms' : 'not found (generic patterns only)'}; ` +
    `${count('generic')} generic, ${count('hard')} hard, ${count('brand')} brand findings`);
  process.exit(fails.length ? 1 : 0);
}
