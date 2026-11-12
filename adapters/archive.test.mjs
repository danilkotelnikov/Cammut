import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  segmentId, redactJsonLine, buildPlain, sealSegment, planSegments, fingerprint, sha256Hex, rangeSha256,
  recipientFingerprints, outboxPut, outboxList, outboxDrop, outboxStats, ackRecord, ageEncrypt, wireMeta, sessionIdOf, projectName,
} from './archive.mjs';
import { redact } from './common.mjs';
import { tmp } from './test-helpers.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./archive-id-fixtures.json', import.meta.url), 'utf8'));

test('F2: own prototype-named keys survive a byte-equal redacted segment round trip', () => {
  const line = '{"__proto__":{"note":"KEEP","constructor":{"toString":"KEEP"}},"constructor":"KEEP","toString":[{"__proto__":"KEEP"}]}';
  assert.ok(Buffer.from(redactJsonLine(line)).equals(Buffer.from(line)));
  const raw = Buffer.from(`${line}\n`);
  const meta = { agent: 'claude-code', session: 's1', kind: 'transcript', fp: 'f'.repeat(64), start: 0, end: raw.length };
  const seg = sealSegment({ meta, rawBytes: raw, encrypt: (buf) => buf });
  const plain = seg.meta.codec === 'zstd' ? zlib.zstdDecompressSync(seg.cipher) : zlib.brotliDecompressSync(seg.cipher);
  assert.ok(plain.subarray(plain.indexOf(10) + 1).equals(raw));
});

test('segment ids match the shared fixtures (the Go test reads the same file)', () => {
  assert.ok(fx.length >= 6);
  for (const { meta, id } of fx) assert.equal(segmentId(meta), id);
  assert.equal(new Set(fx.map((f) => f.id)).size, fx.length, 'six different metas give six different ids');
});

test('redactJsonLine redacts inside string values only, keeps the JSON valid and strips image payloads', () => {
  const secret = 'sk-' + 'A1b2'.repeat(8);
  const line = JSON.stringify({ type: 'user', message: { content: [
    { type: 'text', text: `password: hunter2hunter2 and ${secret}` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD'.repeat(1000) } },
  ] }, uuid: 'u-1' });
  const out = redactJsonLine(line, redact);
  const j = JSON.parse(out);
  assert.equal(j.uuid, 'u-1');
  assert.ok(!out.includes('hunter2') && !out.includes(secret));
  assert.match(j.message.content[1].source.data, /^\[stripped 4000 bytes sha256:[0-9a-f]{16}\]$/);
  assert.equal(redactJsonLine('   ', redact), null);
  assert.ok(!redactJsonLine('not json password: hunter2hunter2', redact).includes('hunter2'));
});

test('redactJsonLine redacts nested arrays and keys stay untouched; a secret split by a JSON escape is still found', () => {
  const line = JSON.stringify({ a: [{ b: ['x', 'token=abcdefgh12345678'] }], 'sk-key-name': 1, n: 3, t: true, z: null, multi: 'line one\nAuthorization: Bearer abcdefghijklmnop1234567890' });
  const j = JSON.parse(redactJsonLine(line, redact));
  assert.equal(j.a[0].b[0], 'x');
  assert.match(j.a[0].b[1], /REDACTED/);
  assert.equal(j['sk-key-name'], 1);
  assert.equal(j.n, 3);
  assert.equal(j.z, null);
  assert.match(j.multi, /Bearer \[REDACTED\]/, 'the parsed value is redacted, not the escaped text');
});

test('a sealed segment round-trips through compression, carries an authenticated inner header and a stable id', () => {
  const meta = { agent: 'claude-code', project: 'Cammut', session: 's1', kind: 'transcript', relpath: '', fp: 'f'.repeat(64), start: 0, end: 40 };
  const rawText = '{"a":1}\n{"b":"password: hunter2hunter2"}\n';
  const fakeEncrypt = (buf) => Buffer.concat([Buffer.from('age-encryption.org/v1\nFAKE\n'), Buffer.from(buf.toString('base64'))]);
  const seg = sealSegment({ meta, rawBytes: Buffer.from(rawText, 'utf8'), recipientsFile: 'unused', encrypt: fakeEncrypt, redact, doRedact: true });
  assert.equal(seg.id, segmentId(meta));
  const want = crypto.createHash('sha256').update(rawText).digest('hex');
  assert.equal(seg.meta.srcSha256, want, 'the content binding is the hash of the plaintext source bytes, taken before redaction');
  assert.match(seg.sha256, /^[0-9a-f]{64}$/);
  const inner = Buffer.from(seg.cipher.toString('utf8').split('FAKE\n')[1], 'base64');
  const plain = (seg.meta.codec === 'zstd' ? zlib.zstdDecompressSync(inner) : zlib.brotliDecompressSync(inner)).toString('utf8').split('\n');
  assert.deepEqual(JSON.parse(plain[0]), { v: 1, agent: 'claude-code', session: 's1', kind: 'transcript', relpath: '', fp: 'f'.repeat(64), src: want, start: 0, end: 40 });
  assert.equal(plain.slice(1, 3).join('\n').includes('hunter2'), false);
  assert.equal(JSON.parse(plain[1]).a, 1);
  assert.ok(!seg.cipher.toString('utf8').includes('hunter2'));
  assert.equal(seg.meta.plainBytes, Buffer.byteLength(plain.join('\n')), 'plain_bytes is the size before compression');
  const raw = sealSegment({ meta, rawBytes: Buffer.from(rawText, 'utf8'), encrypt: fakeEncrypt, redact, doRedact: false });
  const inner2 = Buffer.from(raw.cipher.toString('utf8').split('FAKE\n')[1], 'base64');
  assert.ok((raw.meta.codec === 'zstd' ? zlib.zstdDecompressSync(inner2) : zlib.brotliDecompressSync(inner2)).toString('utf8').includes('hunter2hunter2'), 'archive.redact=false keeps the text');
  assert.equal(raw.meta.srcSha256, want);
});

test('buildPlain compresses with zstd when Node has it and with brotli otherwise, and both decode back', () => {
  const meta = { agent: 'a', session: 's', kind: 'transcript', relpath: '', fp: 'f'.repeat(64), srcSha256: 'e'.repeat(64), start: 0, end: 3 };
  const z = buildPlain({ meta, lines: ['{"x":1}'], codec: 'zstd' });
  assert.equal(zlib.zstdDecompressSync(z).toString().split('\n')[1], '{"x":1}');
  const b = buildPlain({ meta, lines: ['{"x":1}'], codec: 'br' });
  assert.equal(zlib.brotliDecompressSync(b).toString().split('\n')[1], '{"x":1}');
});

test('planSegments cuts at the size target, holds the tail back until flush or idleness, and never cuts mid-line', () => {
  const text = Array.from({ length: 10 }, (_, i) => `{"i":${i},"pad":"${'x'.repeat(90)}"}\n`).join('');
  const opts = { segmentBytes: 400, flushIdleMs: 600000, now: 1000, lastActivityMs: 900, flush: false };
  const cuts = planSegments({ text, cursor: 0, ...opts });
  assert.ok(cuts.length >= 2);
  for (const c of cuts) assert.equal(text[c.end - 1], '\n');
  assert.equal(cuts[0].start, 0);
  assert.equal(cuts[1].start, cuts[0].end);
  const tailStart = cuts.at(-1).end;
  assert.ok(tailStart < text.length, 'a short tail waits');
  const flushed = planSegments({ text, cursor: tailStart, ...opts, flush: true });
  assert.equal(flushed.at(-1).end, text.length);
  const idle = planSegments({ text, cursor: tailStart, ...opts, now: 900 + 600001 });
  assert.equal(idle.at(-1).end, text.length);
});

test('planSegments counts bytes, not characters, ignores an unfinished last line and honours a base offset', () => {
  const l1 = '{"t":"привет"}\n'; // 2 bytes per Cyrillic letter
  const text = l1 + l1 + '{"unfinished":';
  const bytes = Buffer.from(text);
  const cuts = planSegments({ text: bytes, cursor: 0, segmentBytes: 10, flushIdleMs: 0, now: 5, lastActivityMs: 0, flush: true });
  assert.deepEqual(cuts, [{ start: 0, end: Buffer.byteLength(l1) }, { start: Buffer.byteLength(l1), end: 2 * Buffer.byteLength(l1) }], 'one line per segment, the unfinished line is never included');
  const shifted = planSegments({ text: bytes.subarray(Buffer.byteLength(l1)), base: Buffer.byteLength(l1), cursor: Buffer.byteLength(l1), segmentBytes: 10, flushIdleMs: 0, now: 5, lastActivityMs: 0, flush: true });
  assert.equal(shifted[0].start, Buffer.byteLength(l1));
  assert.deepEqual(planSegments({ text: '', cursor: 0, segmentBytes: 10, flushIdleMs: 0, now: 5, lastActivityMs: 0, flush: true }), []);
});

test('fingerprint is a generation hint over the first KiB, rangeSha256 streams exactly the requested bytes', () => {
  const dir = tmp();
  const f = path.join(dir, 't.jsonl');
  const short = Buffer.from('short file\n');
  fs.writeFileSync(f, short);
  assert.equal(fingerprint(f), sha256Hex(short), 'a file shorter than 1 KiB is hashed whole');
  const big = Buffer.alloc(5000, 'abcdefghij\n');
  fs.writeFileSync(f, big);
  assert.equal(fingerprint(f), sha256Hex(big.subarray(0, 1024)));
  fs.appendFileSync(f, 'tail');
  assert.equal(fingerprint(f), sha256Hex(big.subarray(0, 1024)), 'appending does not change the generation');
  assert.equal(rangeSha256(f, 100, 4200), sha256Hex(fs.readFileSync(f).subarray(100, 4200)));
  assert.equal(rangeSha256(f, 0, 999999), null, 'a range beyond the end of the file has no hash');
  assert.equal(fingerprint(path.join(dir, 'missing')), null);
});

test('recipientFingerprints is the sorted list of 16-hex hashes of the public keys and refuses a secret key line', () => {
  const dir = tmp();
  const f = path.join(dir, 'r.txt');
  const k1 = 'age1' + 'q'.repeat(58); const k2 = 'age1' + 'p'.repeat(58);
  fs.writeFileSync(f, `# daily\n${k1}\n\n  ${k2}  \r\n`);
  const want = [k1, k2].map((k) => sha256Hex(Buffer.from(k)).slice(0, 16)).sort().join(',');
  assert.equal(recipientFingerprints(f), want);
  assert.match(want, /^[0-9a-f]{16},[0-9a-f]{16}$/);
  fs.writeFileSync(f, `${k1}\nAGE-SECRET-KEY-1${'Q'.repeat(58)}\n`);
  assert.throws(() => recipientFingerprints(f), (e) => /secret key/i.test(e.message) && !e.message.includes('QQQQ'));
  fs.writeFileSync(f, '# nothing\n');
  assert.throws(() => recipientFingerprints(f), /no recipients/);
  assert.throws(() => recipientFingerprints(path.join(dir, 'absent')), /recipients file/);
});

const cfgOf = (dir, max = 1 << 20) => ({ stateDir: dir, archive: { outboxMaxBytes: max } });
const fakeSeg = (n, bytes = 100) => ({ id: String(n).padStart(32, '0'), cipher: Buffer.alloc(bytes, 1), sha256: sha256Hex(Buffer.alloc(bytes, 1)), meta: { agent: 'claude-code', project: 'P', session: 's1', kind: 'transcript', relpath: '', fp: 'a'.repeat(64), srcSha256: 'c'.repeat(64), codec: 'zstd', plainBytes: 5, start: n * 10, end: n * 10 + 10 } });

test('the outbox stores ciphertext plus metadata, lists in range order, drops both files and stops at the cap', () => {
  const dir = tmp();
  const cfg = cfgOf(dir, 350);
  assert.equal(outboxPut(cfg, fakeSeg(2)), true);
  assert.equal(outboxPut(cfg, fakeSeg(1)), true);
  assert.equal(outboxPut(cfg, fakeSeg(1)), true, 'putting the same id again is a no-op');
  assert.equal(outboxPut(cfg, fakeSeg(3)), true);
  assert.equal(outboxPut(cfg, fakeSeg(4)), false, 'over the cap: no new segment, the source stays where it is');
  assert.deepEqual(outboxList(cfg).map((e) => e.meta.start), [10, 20, 30]);
  const stats = outboxStats(cfg);
  assert.deepEqual([stats.count, stats.bytes, stats.failed], [3, 300, 0]);
  assert.ok(stats.oldestMs >= 0);
  assert.ok(fs.readFileSync(path.join(dir, 'outbox', fakeSeg(1).id + '.age')).equals(Buffer.alloc(100, 1)));
  outboxDrop(cfg, fakeSeg(2).id);
  assert.deepEqual(outboxList(cfg).map((e) => e.meta.start), [10, 30]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'outbox')).sort(), [fakeSeg(1).id + '.age', fakeSeg(1).id + '.json', fakeSeg(3).id + '.age', fakeSeg(3).id + '.json'].sort());
  assert.deepEqual(outboxList(cfgOf(tmp())), [], 'no outbox directory yet');
});

test('wireMeta maps the PC names to the server names and never carries text', () => {
  const m = wireMeta(fakeSeg(1).meta);
  assert.deepEqual(Object.keys(m).sort(), ['agent', 'codec', 'fp', 'kind', 'plain_bytes', 'project', 'relpath', 'session_id', 'src_end', 'src_sha256', 'src_start'].sort());
  assert.equal(m.session_id, 's1');
  assert.equal(m.src_start, 10);
});

test('ackRecord stores the server sha and advances the cursor over contiguous ranges only', () => {
  const state = { arch: { cursor: 0, ranges: [], changed: [] } };
  ackRecord(state, fakeSeg(1), 'sha-b'); // 10..20 first: there is a hole at 0..10
  assert.equal(state.arch.cursor, 0);
  ackRecord(state, fakeSeg(0), 'sha-a');
  assert.equal(state.arch.cursor, 20);
  assert.deepEqual(state.arch.ranges.map((r) => [r.start, r.end, r.sha, r.src]), [[0, 10, 'sha-a', 'c'.repeat(64)], [10, 20, 'sha-b', 'c'.repeat(64)]]);
  ackRecord(state, fakeSeg(0), 'sha-a2'); // an idempotent re-ack replaces, never duplicates
  assert.equal(state.arch.ranges.length, 2);
  assert.equal(state.arch.ranges[0].sha, 'sha-a2');
  state.arch.changed.push({ start: 20, end: 30 }); // a range the server refused as changed is skipped, never acknowledged
  ackRecord(state, fakeSeg(3), 'sha-d');
  assert.equal(state.arch.cursor, 40);
  assert.ok(!state.arch.ranges.some((r) => r.start === 20));
});

test('sessionIdOf and projectName derive stable, server-valid names from paths', () => {
  assert.equal(sessionIdOf('claude-code', 'C:\\Users\\u\\.claude\\projects\\C--x\\0a1b2c3d-1111-2222-3333-444455556666.jsonl'), '0a1b2c3d-1111-2222-3333-444455556666');
  assert.equal(sessionIdOf('codex', '/h/.codex/sessions/2026/10/11/rollout-2026-10-11T10-00-00-0a1b2c3d-1111-2222-3333-444455556666.jsonl'), '0a1b2c3d-1111-2222-3333-444455556666');
  assert.match(sessionIdOf('codex', '/h/rollout-odd name!.jsonl'), /^[A-Za-z0-9_-]{1,80}$/);
  assert.equal(projectName('C:/Users/you/Documents/Cammut'), 'Cammut');
  assert.equal(projectName('/x/my project (2)'), 'my_project__2_');
  assert.equal(projectName(''), 'unknown');
  assert.equal(projectName('/x/' + 'a'.repeat(100)).length, 64);
});

test('ageEncrypt pipes the buffer through the age binary, binary-safe, and fails with a short message that never echoes input', () => {
  const code = 'process.stdin.pipe(process.stdout)';
  const opts = { bin: process.execPath, args0: ['-e', code, '--'] };
  const buf = Buffer.from([0, 255, 1, 2, 254, 10, 13, 0]);
  assert.ok(ageEncrypt(buf, 'recipients.txt', opts).equals(buf));
  const bad = { bin: process.execPath, args0: ['-e', "process.stderr.write('SECRETINPUT'); process.exit(3)", '--'] };
  assert.throws(() => ageEncrypt(Buffer.from('SECRETINPUT'), 'r.txt', bad), (e) => /age/.test(e.message) && /3/.test(e.message) && !e.message.includes('SECRETINPUT'));
  assert.throws(() => ageEncrypt(buf, 'r.txt', { bin: 'age-binary-that-does-not-exist-xyz' }), /age/);
});
