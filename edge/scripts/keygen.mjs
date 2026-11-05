#!/usr/bin/env node
// Makes an Ed25519 key pair for the edge pass.
//   node scripts/keygen.mjs [private-key-file] [kid]      (default ./edge-signing-key.txt, edge-1)
// Writes the private key (PKCS8, base64) to the file with mode 600, refuses to overwrite.
// Prints only two lines: the public key in Cammut's flag format, and the command that loads the private key.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const file = process.argv[2] ?? "./edge-signing-key.txt";
const kid = process.argv[3] ?? "edge-1";

if (!/^[A-Za-z0-9._-]+$/.test(kid)) {
  console.error("kid may only contain letters, digits, dot, dash and underscore");
  process.exit(2);
}
if (existsSync(file)) {
  console.error(`${file} already exists; choose another path or delete it first`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(file, privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
const raw = publicKey.export({ format: "jwk" }).x; // base64url of the raw 32 bytes

console.log(`${kid}=${raw}`);
console.log(`npx wrangler secret put EDGE_SIGNING_KEY < ${file}`);
