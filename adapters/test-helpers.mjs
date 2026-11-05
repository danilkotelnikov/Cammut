// Shared helpers for the adapter tests: a fake HTTP server, temp dirs, JSONL line builders. Synthetic data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

export const tmp = (prefix = 'sm-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const line = (o) => JSON.stringify(o) + '\n';

// handler(call, n) -> {status, json?, buf?, headers?, hang?} | undefined (undefined = 200 {}).
// call = {method, url, auth, headers, body (parsed JSON or null), raw (Buffer)}
export const fakeServer = (handler) => new Promise((resolve) => {
  const calls = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let parsed = null;
      try { parsed = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { parsed = null; }
      const call = { method: req.method, url: req.url, auth: req.headers.authorization, headers: req.headers, body: parsed, raw };
      calls.push(call);
      const r = handler(call, calls.length) || { status: 200, json: {} };
      if (r.hang) return;
      if (r.buf) { res.writeHead(r.status, { 'content-type': 'application/octet-stream', ...r.headers }); res.end(r.buf); return; }
      res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(r.json ?? {}));
    });
  });
  srv.unref(); // a failing test must not keep the process alive
  srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` }));
});

// stands in for the age CLI in tests: the two header lines the server checks, then the input base64-encoded
export const fakeEncrypt = (buf) => Buffer.concat([Buffer.from('age-encryption.org/v1\nFAKE\n'), Buffer.from(buf.toString('base64'))]);
