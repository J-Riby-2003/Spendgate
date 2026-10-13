import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from './transactions.js';

export interface Migration { id: string; up(db: DatabaseSync): void }
export const migrations: Migration[] = [
  { id: 'issue01_001_legacy_schema', up: (db) => db.exec(`

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP'
);
CREATE TABLE IF NOT EXISTS policies (
  agent_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  vendor TEXT NOT NULL,
  purpose TEXT NOT NULL,
  rail TEXT NOT NULL,
  decision TEXT NOT NULL,
  rule TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  approval_id TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  signature TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  intent_json TEXT NOT NULL,
  rule TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_agent ON ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger(ts);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  ledger_seq INTEGER,
  approval_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, key)
);
CREATE TABLE IF NOT EXISTS approval_links (
  token_hash TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_links_approval ON approval_links(approval_id);
`) },
  { id: 'issue01_002_identity', up: (db) => db.exec(`
CREATE TABLE operators (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE operator_sessions (id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE agent_credentials (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX idx_credentials_agent ON agent_credentials(agent_id);
CREATE TABLE security_audit_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL, operator_id TEXT NOT NULL, agent_id TEXT, credential_id TEXT, replacement_id TEXT);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, reset_at INTEGER NOT NULL);
`) },
];

/** Append immutable, uniquely named migrations; never renumber deployed IDs. */
export function migrate(db: DatabaseSync, steps: readonly Migration[] = migrations): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const migration of steps) {
    withImmediateTransaction(db, () => {
      if (db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migration.id)) return;
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.id, Date.now());
    });
  }
}
