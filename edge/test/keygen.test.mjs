// Plain node test: node --test test/keygen.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("keygen prints the flag line and the load command, and writes a usable key", () => {
  const dir = mkdtempSync(join(tmpdir(), "keygen-"));
  try {
    const file = join(dir, "k.txt");
    const out = execFileSync(process.execPath, ["scripts/keygen.mjs", file, "edge-7"], { encoding: "utf8" });
    const lines = out.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    const m = lines[0].match(/^edge-7=([A-Za-z0-9_-]{43})$/);
    assert.ok(m, "first line is kid=base64url(32 bytes)");
    assert.equal(lines[1], `npx wrangler secret put EDGE_SIGNING_KEY < ${file}`);
    assert.equal(Buffer.from(m[1], "base64url").length, 32);

    // the file holds the PKCS8 private key matching the printed public key
    const priv = createPrivateKey({ key: Buffer.from(readFileSync(file, "utf8").trim(), "base64"), format: "der", type: "pkcs8" });
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: m[1] }, format: "jwk" });
    const sig = sign(null, Buffer.from("x"), priv);
    assert.ok(verify(null, Buffer.from("x"), pub, sig));
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    assert.throws(() => execFileSync(process.execPath, ["scripts/keygen.mjs", file], { stdio: "pipe" }), "refuses to overwrite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
