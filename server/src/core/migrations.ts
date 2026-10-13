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
  { id: 'issue03_001_budget_policy_modes', up(db) {
    for (const row of db.prepare('SELECT agent_id, json FROM policies').all()) {
      const policy = JSON.parse(String(row.json));
      policy.budgetMode ??= 'approval-override';
      db.prepare('UPDATE policies SET json = ? WHERE agent_id = ?').run(JSON.stringify(policy), row.agent_id);
    }
  } },
  { id: 'issue03_002_reservation_accounting', up(db) { db.exec(`
    CREATE TABLE budget_reservations (
      request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL, period_start TEXT NOT NULL, expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','settled','released')), terminal_cause TEXT,
      created_at TEXT NOT NULL, finalised_at TEXT
    );
    CREATE INDEX idx_budget_agent ON budget_reservations(agent_id, currency, status, period_start);
    CREATE TABLE budget_accounting_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
      ts TEXT NOT NULL, payload TEXT NOT NULL
    );
  `); } },
  { id: 'issue03_003_legacy_reconciliation', up(db) { db.exec(`
    CREATE TABLE legacy_budget_obligations (
      ledger_seq INTEGER PRIMARY KEY, agent_id TEXT NOT NULL,
      disposition TEXT, evidence TEXT, operator_id TEXT, reason TEXT, reconciled_at TEXT
    );
    INSERT INTO legacy_budget_obligations (ledger_seq, agent_id)
      SELECT seq, agent_id FROM ledger WHERE decision IN ('ALLOWED','APPROVED');
  `); } },
  { id: 'issue07_001_durable_requests', up(db) {
    db.exec(`
      ALTER TABLE approvals ADD COLUMN expires_at TEXT;
      ALTER TABLE ledger ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE ledger ADD COLUMN details_json TEXT;
      ALTER TABLE idempotency_keys ADD COLUMN request_id TEXT;
      ALTER TABLE idempotency_keys ADD COLUMN fingerprint TEXT;
      CREATE TABLE spend_requests (
        request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, intent_json TEXT NOT NULL,
        approval_id TEXT UNIQUE, ledger_seq INTEGER, reason TEXT NOT NULL,
        evidence_json TEXT, reconciliation_required INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_requests_agent ON spend_requests(agent_id);
      CREATE TABLE notification_outbox (
        approval_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT, lease_until INTEGER, last_error TEXT, delivered_at TEXT
      );
      CREATE INDEX idx_outbox_due ON notification_outbox(status, next_attempt_at);
      CREATE TABLE approval_recovery_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, approval_id TEXT,
        event TEXT NOT NULL, details TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    // No old ledger row, timestamp, actor or payment claim is rewritten.
    for (const row of db.prepare('SELECT * FROM ledger ORDER BY seq').all()) {
      const intent = { id: row.intent_id, agentId: row.agent_id, amount: row.amount, currency: row.currency,
        vendor: row.vendor, purpose: row.purpose, rail: row.rail };
      const exists = db.prepare('SELECT request_id FROM spend_requests WHERE request_id=?').get(row.intent_id);
      if (exists) {
        db.prepare('UPDATE spend_requests SET reconciliation_required=1 WHERE request_id=?').run(row.intent_id);
        continue;
      }
      const duplicateApproval = row.approval_id && db.prepare('SELECT request_id FROM spend_requests WHERE approval_id=?').get(row.approval_id);
      if (duplicateApproval) db.prepare('UPDATE spend_requests SET reconciliation_required=1 WHERE approval_id=?').run(row.approval_id);
      db.prepare('INSERT INTO spend_requests (request_id,agent_id,intent_json,approval_id,ledger_seq,reason,reconciliation_required) VALUES (?,?,?,?,?,?,?)')
        .run(row.intent_id, row.agent_id, JSON.stringify(intent), duplicateApproval ? null : row.approval_id, row.seq, row.rule, duplicateApproval ? 1 : 0);
    }
    for (const row of db.prepare('SELECT * FROM approvals').all()) {
      const intent = JSON.parse(String(row.intent_json));
      const link = db.prepare('SELECT MIN(expires_at) AS deadline FROM approval_links WHERE approval_id=?').get(row.id);
      // This is an explicit upgrade deadline policy, not a claim about the old configured timeout.
      const created = Date.parse(String(row.created_at));
      const defaultDeadline = Number.isFinite(created) ? new Date(created + 300000).toISOString() : null;
      const deadline = defaultDeadline && link?.deadline && String(link.deadline) < defaultDeadline ? String(link.deadline) : defaultDeadline;
      db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(deadline, row.id);
      db.prepare('INSERT INTO approval_recovery_audit (approval_id,event,details) VALUES (?,?,?)')
        .run(row.id, 'upgrade-deadline-policy', JSON.stringify({ expiresAt: deadline, source: link?.deadline ? 'minimum-existing-link-and-five-minutes' : 'five-minutes-from-recorded-creation' }));
      const linked = db.prepare('SELECT * FROM ledger WHERE approval_id=?').all(row.id);
      const expectedStatus = linked.length === 1 ? ({ APPROVED: 'approved', REJECTED: 'rejected', EXPIRED: 'expired' } as Record<string,string>)[String(linked[0].decision)] : null;
      const legacyExpiry = row.status === 'rejected' && row.decided_by === 'expiry' && expectedStatus === 'expired';
      const terminalConflict = row.status !== 'pending' && expectedStatus && row.status !== expectedStatus && !legacyExpiry;
      const ambiguous = terminalConflict || !deadline || linked.length > 1 || (linked.length === 0 && row.status !== 'pending') ||
        (linked.length === 1 && (linked[0].intent_id !== intent.id || !['APPROVED','REJECTED','EXPIRED'].includes(String(linked[0].decision))));
      if (!ambiguous && linked.length === 1) {
        const statuses: Record<string,string> = { APPROVED: 'approved', REJECTED: 'rejected', EXPIRED: 'expired' };
        const status = statuses[String(linked[0].decision)];
        if (status) db.prepare('UPDATE approvals SET status=? WHERE id=?').run(status, row.id);
      }
      db.prepare('INSERT OR IGNORE INTO spend_requests (request_id,agent_id,intent_json,approval_id,ledger_seq,reason,reconciliation_required) VALUES (?,?,?,?,?,?,?)')
        .run(intent.id, intent.agentId, row.intent_json, row.id, linked.length === 1 ? linked[0].seq : null, row.reason, ambiguous ? 1 : 0);
      if (ambiguous) {
        db.prepare('UPDATE spend_requests SET reconciliation_required=1 WHERE request_id=?').run(intent.id);
        db.prepare('INSERT INTO approval_recovery_audit (approval_id,event,details) VALUES (?,?,?)')
          .run(row.id, 'reconciliation-required', 'Legacy terminal outcome is missing or contradictory; no outcome was invented.');
      } else if (row.status === 'pending' && linked.length === 0) {
        db.prepare('INSERT INTO notification_outbox (approval_id) VALUES (?)').run(row.id);
      }
    }
    db.exec(`UPDATE idempotency_keys SET request_id=(SELECT intent_id FROM ledger WHERE seq=idempotency_keys.ledger_seq) WHERE ledger_seq IS NOT NULL`);
    for (const row of db.prepare('SELECT agent_id,key,created_at FROM idempotency_keys WHERE request_id IS NULL').all()) {
      db.prepare('INSERT INTO approval_recovery_audit (approval_id,event,details) VALUES (NULL,?,?)')
        .run('orphaned-idempotency-claim', JSON.stringify({ agentId: row.agent_id, key: row.key, createdAt: row.created_at }));
    }
  } },
  { id: 'issue06_001_policy_history_evidence', up(db) {
    db.exec(`
      CREATE TABLE policy_revisions (
        agent_id TEXT NOT NULL, version INTEGER NOT NULL, changed_at TEXT NOT NULL,
        changed_by TEXT NOT NULL, source TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL,
        PRIMARY KEY (agent_id, version)
      );
      CREATE TRIGGER policy_revisions_no_update BEFORE UPDATE ON policy_revisions
        BEGIN SELECT RAISE(ABORT, 'Policy revision history is immutable'); END;
      CREATE TRIGGER policy_revisions_no_delete BEFORE DELETE ON policy_revisions
        BEGIN SELECT RAISE(ABORT, 'Policy revision history is immutable'); END;
      CREATE TABLE policy_evidence (
        request_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL,
        digest TEXT NOT NULL, envelope_json TEXT NOT NULL
      );
    `);
    const timestamp = new Date().toISOString();
    for (const row of db.prepare('SELECT agent_id,json FROM policies').all()) {
      db.prepare('INSERT INTO policy_revisions VALUES (?,1,?,?,?,NULL,?)')
        .run(row.agent_id, timestamp, 'system:migration', 'migration', row.json);
    }
  } },

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
