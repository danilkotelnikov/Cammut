#!/usr/bin/env node
// Hindsight: stop keeping raw document text.
//   verify        scratch-bank proof: does the bank override keep original_text and chunk_text out? (deletes the bank)
//   apply --yes   set the override on the real bank (default) and show the resulting override keys
// Prints statuses, booleans and lengths only, never document or fact text. Key: SHARED_MEMORY_HINDSIGHT_API_KEY (env).
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hs as defaultHs } from './hs-client.mjs';

const SETTINGS = { store_document_text: false, recall_include_chunks: false };
const ok = (r) => r && r.status >= 200 && r.status < 300;
const blank = (v) => v === null || v === undefined || v === '';

// true when any string under a "text"/"chunk_text" key, at any depth, is non-empty
const hasText = (v) => {
  if (!v || typeof v !== 'object') return false;
  return Object.entries(v).some(([k, x]) => ((k === 'text' || k === 'chunk_text') && typeof x === 'string' && x !== '') || hasText(x));
};

// the chunk list may come as a bare array, {items}, or {chunks}
const chunkList = (j) => (Array.isArray(j) ? j : j?.items ?? j?.chunks ?? []);

// An unreadable answer (5xx, transport failure) never counts as proof that nothing is stored; 404 means no such document.
export function evaluate({ patch, doc, chunks, recall }) {
  const gone = (r) => r.status === 404;
  const r = {
    config_patch_accepted: ok(patch),
    original_text_empty: gone(doc) || (doc.status === 200 && blank(doc.json?.original_text)),
    chunks_empty: gone(chunks) || (chunks.status === 200 && chunkList(chunks.json).every((c) => blank(c?.chunk_text))),
    recall_has_no_chunks: recall.status === 200 && !hasText(recall.json?.chunks),
    facts_extracted: recall.status === 200 && (recall.json?.results || []).length > 0,
  };
  return { ...r, pass: Object.values(r).every(Boolean) };
}

const bankPath = (b) => `/v1/default/banks/${encodeURIComponent(b)}`;

// The documented body is {"updates": {...}}; the flat form is tried only if the server rejects it.
async function patchConfig(hs, bank) {
  let r = await hs('PATCH', `${bankPath(bank)}/config`, { updates: SETTINGS });
  if (ok(r)) return { r, form: 'updates' };
  const flat = await hs('PATCH', `${bankPath(bank)}/config`, SETTINGS);
  return ok(flat) ? { r: flat, form: 'flat' } : { r, form: 'none' };
}

const syntheticText = (marker) => {
  const s = [
    `Verification note ${marker}.`,
    'The synthetic project Zeta keeps its build cache on a server named Orchid.',
    'Nadia Petrova, the maintainer of Zeta, decided on 2026-03-04 to migrate the cache to a new disk.',
    'The migration finished in nine minutes and no tasks failed.',
    'Afterwards the team agreed to run the nightly cleanup at 02:30 UTC on every weekday.',
    'The cleanup removes entries older than twenty-one days and writes a short report.',
    'Nadia noted that the report is read by the release manager, Tomas Berg, every Monday.',
  ];
  let t = s.join(' ');
  for (let i = 0; t.length < 1200; i++) t += ` Follow-up ${i + 1}: the Zeta maintainers reviewed the cache size and found it stable.`;
  return t.slice(0, 1200);
};

export async function verify({ hs = defaultHs, say = console.log } = {}) {
  const bank = `memory-v2-verify-${Math.floor(Date.now() / 1000)}`;
  const marker = `MV2MARKER-${crypto.randomBytes(4).toString('hex')}`;
  const pad = (k) => k.padEnd(24);
  try {
    say(`scratch bank: ${bank}`);
    const created = await hs('PUT', bankPath(bank), {});
    say(`create_bank status=${created.status}`);
    const { r: patch, form } = await patchConfig(hs, bank);
    say(`config_patch status=${patch.status} form=${form}`);
    say('retaining… (this waits for the model)');
    const retain = await hs('POST', `${bankPath(bank)}/memories`, { async: false, items: [{ content: syntheticText(marker), document_id: 'mv2-verify' }] }, 300000);
    say(`retain status=${retain.status}`);
    const doc = await hs('GET', `${bankPath(bank)}/documents/mv2-verify`);
    const chunks = await hs('GET', `${bankPath(bank)}/documents/mv2-verify/chunks`);
    const recall = await hs('POST', `${bankPath(bank)}/memories/recall`, { query: 'Who reads the nightly cleanup report?', include: { chunks: { max_tokens: 8192 } } });
    say(`document status=${doc.status} original_text_chars=${doc.json?.original_text?.length ?? 0}; chunks status=${chunks.status} items=${chunkList(chunks.json).length}; recall status=${recall.status} results=${(recall.json?.results || []).length}`);
    const result = evaluate({ patch, doc, chunks, recall });
    say('check                    | result');
    for (const [k, v] of Object.entries(result)) say(`${pad(k)} | ${v}`);
    return { bank, result, pass: result.pass, patch_form: form };
  } finally {
    const del = await hs('DELETE', bankPath(bank));
    say(ok(del) ? `scratch bank deleted (status=${del.status})` : `WARNING: scratch bank ${bank} NOT deleted (status=${del.status}); delete it by hand`);
  }
}

const COMPOSE_FIX = [
  'The bank override is not available on this server. Set it at server level instead:',
  '  add to the hindsight: environment: block of /opt/shared-memory/deployment/compose.4gb.yaml',
  '    HINDSIGHT_API_STORE_DOCUMENT_TEXT: "false"',
  '    HINDSIGHT_API_RECALL_INCLUDE_CHUNKS: "false"',
  '  then: cd /opt/shared-memory/deployment && docker compose --env-file /root/private/shared-memory.env -f compose.yaml -f compose.4gb.yaml up -d hindsight',
  '  and re-run: node adapters/tools/hs-no-text.mjs verify',
];

export async function apply({ hs = defaultHs, yes = false, bank = 'default', say = console.log } = {}) {
  if (!yes) { say(`refusing: this changes the config of bank ${bank}; run again with --yes`); return 1; }
  const { r: patch, form } = await patchConfig(hs, bank);
  say(`config_patch bank=${bank} status=${patch.status} form=${form}`);
  const cfg = await hs('GET', `${bankPath(bank)}/config`);
  const overrides = cfg.json?.overrides || {};
  say(`overrides: ${Object.keys(overrides).sort().join(', ') || '(none)'}`);
  say(`resolved store_document_text=${cfg.json?.config?.store_document_text}`);
  if (!ok(patch) || overrides.store_document_text !== false) { COMPOSE_FIX.forEach((l) => say(l)); return 2; }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cmd, ...flags] = process.argv.slice(2);
  const key = process.env.SHARED_MEMORY_HINDSIGHT_API_KEY ? 'set' : 'MISSING';
  console.log(`SHARED_MEMORY_HINDSIGHT_API_KEY=${key}`);
  if (key === 'MISSING') process.exitCode = 2;
  else if (cmd === 'verify') process.exitCode = (await verify()).pass ? 0 : 1;
  else if (cmd === 'apply') process.exitCode = await apply({ yes: flags.includes('--yes') });
  else { console.log('usage: hs-no-text.mjs verify | apply --yes'); process.exitCode = 2; }
}
