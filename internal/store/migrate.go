package store

import (
	"database/sql"
	"fmt"
)

// migrations run once each, in order; PRAGMA user_version counts how many have run.
var migrations = []string{
	`CREATE TABLE users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, totp_secret BLOB NOT NULL,
  totp_last_step INTEGER NOT NULL DEFAULT 0, github_id INTEGER UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE recovery_codes(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_mac TEXT NOT NULL, used_at INTEGER,
  PRIMARY KEY(user_id, code_mac));
CREATE TABLE sessions(
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '', ua_hash TEXT NOT NULL DEFAULT '');
CREATE TABLE pending_logins(id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE oauth_states(state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE secrets(
  name TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE tokens ADD COLUMN profile TEXT NOT NULL DEFAULT 'lazy';
ALTER TABLE upstreams ADD COLUMN bearer_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE audit ADD COLUMN ip TEXT NOT NULL DEFAULT '';
ALTER TABLE audit ADD COLUMN actor TEXT NOT NULL DEFAULT '';`,
	`CREATE TABLE arch_segments(
  id TEXT PRIMARY KEY,                       -- 32 hex, see SegmentID
  agent TEXT NOT NULL, project TEXT NOT NULL, session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('transcript','sidecar')),
  relpath TEXT NOT NULL DEFAULT '',          -- sidecar path relative to the session directory, '' for transcripts
  fp TEXT NOT NULL,                          -- hex sha256 of the first 1024 bytes of the source file: one value per file generation (a hint, not the proof)
  src_sha256 TEXT NOT NULL,                  -- hex sha256 of the PLAINTEXT source bytes [src_start,src_end): the content binding the sweeper verifies
  src_start INTEGER NOT NULL, src_end INTEGER NOT NULL,
  codec TEXT NOT NULL CHECK(codec IN ('zstd','br')),
  plain_bytes INTEGER NOT NULL, cipher_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  recipients TEXT NOT NULL DEFAULT '',       -- client-declared recipient fingerprints (audit of the key model, never trusted)
  stored_at INTEGER NOT NULL, token_id INTEGER);
CREATE INDEX arch_by_session ON arch_segments(agent, session_id, kind, fp, src_start);
CREATE INDEX arch_by_project ON arch_segments(project, stored_at);
CREATE TABLE arch_replicas(
  segment_id TEXT NOT NULL REFERENCES arch_segments(id) ON DELETE CASCADE, remote TEXT NOT NULL,
  replica_sha256 TEXT NOT NULL,              -- equals arch_segments.sha256 or the row is refused
  verified_at INTEGER NOT NULL, PRIMARY KEY(segment_id, remote));
CREATE TABLE arch_replica_runs(id INTEGER PRIMARY KEY, remote TEXT NOT NULL, at INTEGER NOT NULL, verified INTEGER NOT NULL, rejected INTEGER NOT NULL);
CREATE TABLE arch_recipient_pins(
  project TEXT PRIMARY KEY, fingerprints TEXT NOT NULL,   -- sorted, comma-joined 16-hex fingerprints first seen for the project
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  changed INTEGER NOT NULL DEFAULT 0, last_changed_to TEXT NOT NULL DEFAULT '', changed_at INTEGER);`,
	`CREATE TABLE mem_projects(
  name TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL,
  roots TEXT NOT NULL DEFAULT '[]', aliases TEXT NOT NULL DEFAULT '[]');
CREATE TABLE mem_notes(
  seq INTEGER PRIMARY KEY,                   -- explicit rowid: VACUUM (and VACUUM INTO) may renumber an implicit one and break the FTS link
  id TEXT NOT NULL UNIQUE, project TEXT NOT NULL REFERENCES mem_projects(name),
  kind TEXT NOT NULL CHECK(kind IN ('decision','finding','codemap','howto','error_fix','task','state','preference')),
  title TEXT NOT NULL,                       -- <= 120 runes
  body TEXT NOT NULL,                        -- <= 1500 runes, redacted
  gist TEXT NOT NULL DEFAULT '',             -- one-sentence meaning, <= 200 runes; the brief uses it for long notes
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','expired','retracted')),
  supersedes TEXT, superseded_by TEXT,
  task_status TEXT CHECK(task_status IN ('open','done')),
  importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
  confidence REAL NOT NULL DEFAULT 0.7,
  source_agent TEXT NOT NULL, source_session TEXT NOT NULL DEFAULT '', source_chunk TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL DEFAULT '[]',     -- JSON: the archived segment(s) that hold the raw behind the note
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_confirmed_at INTEGER NOT NULL, expires_at INTEGER);
CREATE INDEX mem_notes_project ON mem_notes(project, status, kind, updated_at);
CREATE VIRTUAL TABLE mem_notes_fts USING fts5(title, body, tags, content='mem_notes', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER mem_notes_ai AFTER INSERT ON mem_notes BEGIN INSERT INTO mem_notes_fts(rowid, title, body, tags) VALUES (new.seq, new.title, new.body, new.tags); END;
CREATE TRIGGER mem_notes_ad AFTER DELETE ON mem_notes BEGIN INSERT INTO mem_notes_fts(mem_notes_fts, rowid, title, body, tags) VALUES ('delete', old.seq, old.title, old.body, old.tags); END;
CREATE TRIGGER mem_notes_au AFTER UPDATE ON mem_notes BEGIN INSERT INTO mem_notes_fts(mem_notes_fts, rowid, title, body, tags) VALUES ('delete', old.seq, old.title, old.body, old.tags); INSERT INTO mem_notes_fts(rowid, title, body, tags) VALUES (new.seq, new.title, new.body, new.tags); END;
CREATE TABLE mem_vectors(note_id TEXT PRIMARY KEY REFERENCES mem_notes(id) ON DELETE CASCADE, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL);
CREATE TABLE mem_briefs(
  project TEXT PRIMARY KEY, version INTEGER NOT NULL,
  body TEXT NOT NULL,                        -- core tier
  body_full TEXT NOT NULL DEFAULT '',        -- full tier
  generator TEXT NOT NULL, body_hash TEXT NOT NULL DEFAULT '', tokens INTEGER NOT NULL DEFAULT 0,   -- tokens: informational
  items TEXT NOT NULL DEFAULT '[]',          -- JSON item list of the core tier (ref, note id, mode, line)
  generated_at INTEGER NOT NULL, stale INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mem_brief_hist(project TEXT NOT NULL, version INTEGER NOT NULL, items TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(project, version));
CREATE TABLE mem_deliveries(
  token_id INTEGER NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', project TEXT NOT NULL,
  brief_version INTEGER NOT NULL, page_id TEXT NOT NULL, delivered_at INTEGER NOT NULL,
  via TEXT NOT NULL CHECK(via IN ('inject','brief','recall')));   -- what each agent was SENT; pruned after 30 days
CREATE INDEX mem_deliveries_project ON mem_deliveries(project, delivered_at);`,
	// Migrations 4 and 5 are the OAuth tables and upstreams.auth_header: the order of the code that runs in production.
	`CREATE TABLE oauth_clients(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]', scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE oauth_requests(          -- an authorization request waiting for the owner's yes or no in the console
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT NOT NULL DEFAULT '',
  challenge TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL);
CREATE TABLE oauth_codes(             -- the one-time code handed back to the client after a yes
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id INTEGER NOT NULL, redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE oauth_grants(            -- one per approved connection: the current access token and the long-lived refresh token
  id INTEGER PRIMARY KEY, client_id TEXT NOT NULL, user_id INTEGER NOT NULL, scopes TEXT NOT NULL,
  token_label TEXT NOT NULL, refresh_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id);`,
	`ALTER TABLE upstreams ADD COLUMN auth_header TEXT NOT NULL DEFAULT '';`,
	// Migration 6: secret policy and the LLM gateway tables.
	`ALTER TABLE secrets ADD COLUMN purpose TEXT NOT NULL DEFAULT 'other';
ALTER TABLE secrets ADD COLUMN allowed_hosts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE secrets ADD COLUMN policy_set INTEGER NOT NULL DEFAULT 0;   -- 1 once a person or the one-time backfill fixed the policy; the backfill never touches such a row
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE llm_providers(
  id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('openai','anthropic')),
  preset TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, secret_name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, allow_private INTEGER NOT NULL DEFAULT 0,
  rpm INTEGER NOT NULL DEFAULT 30, max_concurrent INTEGER NOT NULL DEFAULT 2,   -- per provider and credential: shared by every role
  profile TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE llm_models(
  provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE, model_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  context INTEGER NOT NULL DEFAULT 0,
  price_in_micro INTEGER, price_out_micro INTEGER,   -- micro-USD per 1M tokens; NULL = unknown (never silently zero)
  enabled INTEGER NOT NULL DEFAULT 1, available INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'manual',
  profile TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(provider_id, model_id));
CREATE TABLE llm_roles(
  role TEXT PRIMARY KEY, chain TEXT NOT NULL, max_concurrent INTEGER NOT NULL DEFAULT 1, rpm INTEGER NOT NULL DEFAULT 30,
  daily_budget_micro INTEGER NOT NULL DEFAULT 0, default_max_tokens INTEGER NOT NULL DEFAULT 2048,
  max_output_tokens INTEGER NOT NULL DEFAULT 8192, replay INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE llm_usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, request_id TEXT NOT NULL DEFAULT '', attempt INTEGER NOT NULL DEFAULT 1,
  route_rev INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  token_id INTEGER, caller TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER, completion_tokens INTEGER,   -- NULL = the provider reported nothing
  usage_status TEXT NOT NULL DEFAULT 'complete',      -- complete | missing | partial
  cost_micro INTEGER, reserved_micro INTEGER NOT NULL DEFAULT 0,   -- cost NULL = unknown price or unknown usage
  outcome TEXT NOT NULL DEFAULT 'ok',                 -- ok | error | indeterminate
  ok INTEGER NOT NULL, ms INTEGER NOT NULL, err_kind TEXT NOT NULL DEFAULT '', translated INTEGER NOT NULL DEFAULT 0);
CREATE INDEX llm_usage_ts ON llm_usage(ts);
CREATE TABLE llm_spend(role TEXT NOT NULL, day TEXT NOT NULL, committed_micro INTEGER NOT NULL DEFAULT 0, reserved_micro INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(role, day));
CREATE TABLE llm_qual(
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL, capability TEXT NOT NULL, pass INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL,
  PRIMARY KEY(provider_id, model_id, capability));`,
	// Memory quality gates: keyed state notes (note_key, unique among ACTIVE notes of a project), the epistemic status of a
	// note, and the review queue for write-time supersession candidates. Migration 7 (after the LLM gateway's migration 6).
	`ALTER TABLE mem_notes ADD COLUMN note_key TEXT;
ALTER TABLE mem_notes ADD COLUMN epistemic TEXT NOT NULL DEFAULT 'inferred' CHECK(epistemic IN ('observed','inferred','speculative'));
CREATE UNIQUE INDEX mem_notes_key_active ON mem_notes(project, note_key) WHERE note_key IS NOT NULL AND status='active';
CREATE INDEX mem_notes_key ON mem_notes(project, note_key) WHERE note_key IS NOT NULL;
CREATE TABLE mem_review(
  id INTEGER PRIMARY KEY, project TEXT NOT NULL, note_id TEXT NOT NULL, candidate_id TEXT NOT NULL, cosine REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','dismissed')),
  created_at INTEGER NOT NULL, resolved_at INTEGER, UNIQUE(note_id, candidate_id));
CREATE INDEX mem_review_pending ON mem_review(project, status);`,
	// Explicit "where I am" checkpoints, one causal chain per project/workspace. Migration 8, append only.
	`CREATE TABLE mem_checkpoints(
  project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_revision TEXT NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, workspace_id, source_revision));
CREATE TABLE mem_checkpoint_heads(
  project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_revision TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(project_id, workspace_id));`,
}

func migrate(db *sql.DB) error {
	var done int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&done); err != nil {
		return err
	}
	for i := done; i < len(migrations); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
