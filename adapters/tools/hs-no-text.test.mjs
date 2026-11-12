import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, verify, apply } from './hs-no-text.mjs';
import { makeClient } from './hs-client.mjs';
import { fakeServer } from '../test-helpers.mjs';

test('evaluate passes only when no raw text survives anywhere', () => {
  const good = evaluate({
    patch: { status: 200 },
    doc: { status: 200, json: { id: 'mv2-verify', original_text: null, memory_unit_count: 3 } },
    chunks: { status: 200, json: { items: [{ chunk_id: 'c1', chunk_text: '' }, { chunk_id: 'c2', chunk_text: null }], total: 2 } },
    recall: { status: 200, json: { results: [{ id: 'f1', text: 'a fact' }], chunks: {} } },
  });
  assert.deepEqual(good, { config_patch_accepted: true, original_text_empty: true, chunks_empty: true, recall_has_no_chunks: true, facts_extracted: true, pass: true });
  const bad = evaluate({
    patch: { status: 422 },
    doc: { status: 200, json: { original_text: 'MV2MARKER-1 the text', memory_unit_count: 3 } },
    chunks: { status: 200, json: { items: [{ chunk_text: 'MV2MARKER-1 the text' }], total: 1 } },
    recall: { status: 200, json: { results: [], chunks: { c1: { text: 'MV2MARKER' } } } },
  });
  assert.equal(bad.pass, false);
  assert.equal(bad.config_patch_accepted, false);
  assert.equal(bad.original_text_empty, false);
  assert.equal(bad.chunks_empty, false);
  assert.equal(bad.recall_has_no_chunks, false);
  assert.equal(bad.facts_extracted, false);
  // an empty string and a missing field both count as "no text"
  assert.equal(evaluate({ patch: { status: 200 }, doc: { status: 200, json: { original_text: '' } }, chunks: { status: 200, json: { items: [] } }, recall: { status: 200, json: { results: [{}] } } }).original_text_empty, true);
});

test('evaluate never counts an unreadable answer as proof that no text is stored', () => {
  const r = evaluate({ patch: { status: 200 }, doc: { status: 500, json: null }, chunks: { status: 0, json: null }, recall: { status: 503, json: null } });
  assert.equal(r.original_text_empty, false);
  assert.equal(r.chunks_empty, false);
  assert.equal(r.recall_has_no_chunks, false);
  assert.equal(r.pass, false);
  assert.equal(evaluate({ patch: { status: 200 }, doc: { status: 200, json: {} }, chunks: { status: 200, json: [{ chunk_text: "x" }] }, recall: { status: 200, json: { results: [{}] } } }).chunks_empty, false, "a bare array of chunks is read too");
  // a document that does not exist holds no text
  assert.equal(evaluate({ patch: { status: 200 }, doc: { status: 404, json: null }, chunks: { status: 404, json: null }, recall: { status: 200, json: { results: [{}] } } }).original_text_empty, true);
});

// A stateful stand-in for Hindsight: text is kept unless the bank override store_document_text=false was accepted.
const fakeHindsight = ({ honour = true, flatOnly = false } = {}) => {
  const st = { keep: true, content: '', deleted: false };
  const server = fakeServer((c) => {
    const u = c.url;
    if (c.method === 'PUT' && /^\/v1\/default\/banks\/[^/]+$/.test(u)) return { status: 200, json: {} };
    if (c.method === 'PATCH' && u.endsWith('/config')) {
      const upd = flatOnly ? (c.body?.updates ? null : c.body) : c.body?.updates;
      if (!upd || !honour) return { status: 422, json: { detail: 'nope' } };
      if (upd.store_document_text === false) st.keep = false;
      return { status: 200, json: { overrides: upd, config: {} } };
    }
    if (c.method === 'POST' && u.endsWith('/memories')) { st.content = c.body.items[0].content; return { status: 200, json: { success: true } }; }
    if (c.method === 'GET' && u.endsWith('/documents/mv2-verify')) return { status: 200, json: { id: 'mv2-verify', original_text: st.keep ? st.content : null, memory_unit_count: 2 } };
    if (c.method === 'GET' && u.endsWith('/documents/mv2-verify/chunks')) return { status: 200, json: { items: [{ chunk_id: 'c1', chunk_text: st.keep ? st.content : '' }], total: 1 } };
    if (c.method === 'POST' && u.endsWith('/memories/recall')) return { status: 200, json: { results: [{ id: 'f1', text: 'a distilled fact' }], chunks: st.keep ? { c1: { text: st.content } } : {} } };
    if (c.method === 'DELETE' && /^\/v1\/default\/banks\/[^/]+$/.test(u)) { st.deleted = true; return { status: 200, json: {} }; }
    if (c.method === 'GET' && u.endsWith('/config')) return { status: 200, json: { config: { store_document_text: !st.keep ? false : true }, overrides: st.keep ? {} : { store_document_text: false } } };
    return { status: 404, json: {} };
  });
  return { st, server };
};
const clientFor = (url) => makeClient({ urlEnv: 'SM_HS_URL', urlDefault: url, keyEnv: 'SHARED_MEMORY_HINDSIGHT_API_KEY', env: { SHARED_MEMORY_HINDSIGHT_API_KEY: 'test-key' } });

test('verify on a scratch bank passes when the override works, prints no raw text and deletes the bank', async () => {
  const { st, server } = fakeHindsight();
  const fs_ = await server;
  const out = [];
  const r = await verify({ hs: clientFor(fs_.url), say: (s) => out.push(s) });
  assert.equal(r.pass, true);
  assert.match(r.bank, /^memory-v2-verify-\d+$/);
  const retain = fs_.calls.find((c) => c.method === 'POST' && c.url.endsWith('/memories'));
  assert.equal(retain.body.async, false);
  assert.deepEqual(fs_.calls.find((c) => c.url.endsWith("/memories/recall")).body.include, { chunks: { max_tokens: 8192 } });
  assert.equal(retain.body.items[0].document_id, 'mv2-verify');
  assert.ok(retain.body.items[0].content.length >= 1200 && /MV2MARKER-[0-9a-f]+/.test(retain.body.items[0].content));
  assert.ok(!out.join('\n').includes('MV2MARKER'), 'the marker text must not be printed');
  assert.equal(fs_.calls.at(-1).method, 'DELETE', 'the scratch bank is deleted last');
  assert.ok(fs_.calls.every((c) => c.url.includes(r.bank) && !c.url.includes('/banks/default')), 'only the scratch bank is touched');
  assert.equal(st.deleted, true);
  fs_.srv.close();
});

test('verify falls back to the flat body, and reports a failure (and still cleans up) when the override is not honoured', async () => {
  const flat = await fakeHindsight({ flatOnly: true }).server;
  const ok = await verify({ hs: clientFor(flat.url), say: () => {} });
  assert.equal(ok.pass, true);
  assert.equal(ok.patch_form, 'flat');
  flat.srv.close();
  const { st, server } = fakeHindsight({ honour: false });
  const fs_ = await server;
  const bad = await verify({ hs: clientFor(fs_.url), say: () => {} });
  assert.equal(bad.pass, false);
  assert.equal(bad.result.config_patch_accepted, false);
  assert.equal(bad.result.original_text_empty, false);
  assert.equal(st.deleted, true, 'scratch bank removed even on failure');
  fs_.srv.close();
});

test('apply refuses without --yes, writes only the two settings, and exits 2 with the compose fix when the override is not visible', async () => {
  const { server } = fakeHindsight();
  const s = await server;
  const out = [];
  assert.equal(await apply({ hs: clientFor(s.url), yes: false, say: (x) => out.push(x) }), 1);
  assert.equal(s.calls.length, 0, 'nothing is sent without --yes');
  assert.equal(await apply({ hs: clientFor(s.url), yes: true, say: (x) => out.push(x) }), 0);
  const patch = s.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, '/v1/default/banks/default/config');
  assert.deepEqual(patch.body, { updates: { store_document_text: false, recall_include_chunks: false } });
  assert.ok(out.some((l) => /overrides: .*store_document_text/.test(l)));
  s.srv.close();
  const refusing = await fakeHindsight({ honour: false }).server;
  const out2 = [];
  assert.equal(await apply({ hs: clientFor(refusing.url), yes: true, say: (x) => out2.push(x) }), 2);
  assert.ok(out2.join('\n').includes('HINDSIGHT_API_STORE_DOCUMENT_TEXT: "false"'));
  refusing.srv.close();
});
