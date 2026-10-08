// SQLite persistence via node's built-in sqlite (no native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ApprovalRequest, LedgerEntry, Policy } from './types.js';

const DATA_DIR = process.env.SPENDGATE_DATA ?? join(process.cwd(), '..', '.spendgate');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'spendgate.db'));

db.exec(`
PRAGMA journal_mode = WAL;
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
`);

// --- signing secret (generated once, lives outside the db) ---
const SECRET_FILE = join(DATA_DIR, 'secret.key');
if (!existsSync(SECRET_FILE)) writeFileSync(SECRET_FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
export const SECRET = readFileSync(SECRET_FILE, 'utf8').trim();

// --- row mapping ---
export function rowToLedgerEntry(r: Record<string, unknown>): LedgerEntry {
  return {
    seq: r.seq as number,
    ts: r.ts as string,
    intentId: r.intent_id as string,
    agentId: r.agent_id as string,
    amount: r.amount as number,
    currency: r.currency as string,
    vendor: r.vendor as string,
    purpose: r.purpose as string,
    rail: r.rail as LedgerEntry['rail'],
    decision: r.decision as LedgerEntry['decision'],
    rule: r.rule as string,
    decidedBy: r.decided_by as string,
    approvalId: (r.approval_id as string | null) ?? null,
    prevHash: r.prev_hash as string,
    hash: r.hash as string,
    signature: r.signature as string,
  };
}

export function rowToApproval(r: Record<string, unknown>): ApprovalRequest {
  return {
    id: r.id as string,
    intent: JSON.parse(r.intent_json as string),
    rule: r.rule as string,
    reason: r.reason as string,
    status: r.status as ApprovalRequest['status'],
    createdAt: r.created_at as string,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

const stmts = {
  lastEntry: db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT 1'),
  insertEntry: db.prepare(`INSERT INTO ledger
    (seq, ts, intent_id, agent_id, amount, currency, vendor, purpose, rail, decision, rule, decided_by, approval_id, prev_hash, hash, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  insertApproval: db.prepare(`INSERT INTO approvals (id, intent_json, rule, reason, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)`),
  getApproval: db.prepare('SELECT * FROM approvals WHERE id = ?'),
  decideApproval: db.prepare(`UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'`),
  recentLedger: db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT ?'),
  ledgerByAgent: db.prepare('SELECT * FROM ledger WHERE agent_id = ? ORDER BY seq DESC LIMIT ?'),
  allLedger: db.prepare('SELECT * FROM ledger ORDER BY seq ASC'),
  todaySpend: db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM ledger
    WHERE agent_id = ? AND decision IN ('ALLOWED','APPROVED') AND ts >= ?`),
  knownVendors: db.prepare(`SELECT DISTINCT vendor FROM ledger
    WHERE agent_id = ? AND decision IN ('ALLOWED','APPROVED')`),
  listAgents: db.prepare('SELECT * FROM agents'),
  upsertAgent: db.prepare(`INSERT INTO agents (agent_id, display_name, currency) VALUES (?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET display_name = excluded.display_name, currency = excluded.currency`),
  getPolicy: db.prepare('SELECT json FROM policies WHERE agent_id = ?'),
  upsertPolicy: db.prepare(`INSERT INTO policies (agent_id, json) VALUES (?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json`),
  deletePolicy: db.prepare('DELETE FROM policies WHERE agent_id = ?'),
  deleteAgent: db.prepare('DELETE FROM agents WHERE agent_id = ?'),
  pendingApprovals: db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`),
  recentApprovals: db.prepare(`SELECT * FROM approvals WHERE status != 'pending' ORDER BY decided_at DESC LIMIT ?`),
  pruneExpired: db.prepare(`SELECT * FROM approvals WHERE status = 'pending' AND created_at < ?`),
  entryBySeq: db.prepare('SELECT * FROM ledger WHERE seq = ?'),
  claimIdem: db.prepare(`INSERT OR IGNORE INTO idempotency_keys (agent_id, key, created_at) VALUES (?, ?, ?)`),
  getIdem: db.prepare('SELECT * FROM idempotency_keys WHERE agent_id = ? AND key = ?'),
  settleIdem: db.prepare(`UPDATE idempotency_keys SET ledger_seq = ?, approval_id = ?, reason = ? WHERE agent_id = ? AND key = ?`),
};

export const store = {
  lastLedgerEntry(): LedgerEntry | null {
    const r = stmts.lastEntry.get() as Record<string, unknown> | undefined;
    return r ? rowToLedgerEntry(r) : null;
  },

  appendLedger(e: LedgerEntry): void {
    // Explicit seq: the hash is computed over e.seq, so the stored seq must be
    // exactly that value — letting AUTOINCREMENT assign its own (monotonic
    // even after row deletes) would desync hash from row and break the chain.
    stmts.insertEntry.run(
      e.seq, e.ts, e.intentId, e.agentId, e.amount, e.currency, e.vendor, e.purpose, e.rail,
      e.decision, e.rule, e.decidedBy, e.approvalId, e.prevHash, e.hash, e.signature,
    );
  },

  createApproval(a: ApprovalRequest): void {
    stmts.insertApproval.run(a.id, JSON.stringify(a.intent), a.rule, a.reason, a.createdAt);
  },

  getApproval(id: string): ApprovalRequest | null {
    const r = stmts.getApproval.get(id) as Record<string, unknown> | undefined;
    return r ? rowToApproval(r) : null;
  },

  /** Returns true if the approval was still pending and got decided. */
  decideApproval(id: string, status: 'approved' | 'rejected', by: string, note: string | null): boolean {
    const r = stmts.decideApproval.run(status, new Date().toISOString(), by, note, id);
    return r.changes > 0;
  },

  recentLedger(limit: number): LedgerEntry[] {
    return (stmts.recentLedger.all(limit) as Record<string, unknown>[]).map(rowToLedgerEntry);
  },

  ledgerForAgent(agentId: string, limit: number): LedgerEntry[] {
    return (stmts.ledgerByAgent.all(agentId, limit) as Record<string, unknown>[]).map(rowToLedgerEntry);
  },

  fullLedger(): LedgerEntry[] {
    return (stmts.allLedger.all() as Record<string, unknown>[]).map(rowToLedgerEntry);
  },

  spentToday(agentId: string): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const r = stmts.todaySpend.get(agentId, start.toISOString()) as { total: number };
    return r.total;
  },

  knownVendors(agentId: string): Set<string> {
    return new Set((stmts.knownVendors.all(agentId) as { vendor: string }[]).map((r) => r.vendor));
  },

  listAgents(): { agentId: string; displayName: string; currency: string }[] {
    return (stmts.listAgents.all() as Record<string, unknown>[]).map((r) => ({
      agentId: r.agent_id as string,
      displayName: r.display_name as string,
      currency: r.currency as string,
    }));
  },

  upsertAgent(agentId: string, displayName: string, currency: string): void {
    stmts.upsertAgent.run(agentId, displayName, currency);
  },

  /** Removes the agent and its policy. Ledger history is kept for audit. */
  deleteAgent(agentId: string): void {
    stmts.deletePolicy.run(agentId);
    stmts.deleteAgent.run(agentId);
  },

  getPolicy(agentId: string): Policy | null {
    const r = stmts.getPolicy.get(agentId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Policy) : null;
  },

  upsertPolicy(policy: Policy): void {
    stmts.upsertPolicy.run(policy.agentId, JSON.stringify(policy));
  },

  pendingApprovals(): ApprovalRequest[] {
    return (stmts.pendingApprovals.all() as Record<string, unknown>[]).map(rowToApproval);
  },

  recentDecidedApprovals(limit: number): ApprovalRequest[] {
    return (stmts.recentApprovals.all(limit) as Record<string, unknown>[]).map(rowToApproval);
  },

  stalePending(olderThanIso: string): ApprovalRequest[] {
    return (stmts.pruneExpired.all(olderThanIso) as Record<string, unknown>[]).map(rowToApproval);
  },

  ledgerEntryBySeq(seq: number): LedgerEntry | null {
    const r = stmts.entryBySeq.get(seq) as Record<string, unknown> | undefined;
    return r ? rowToLedgerEntry(r) : null;
  },

  /**
   * Claim an idempotency key for an agent. INSERT OR IGNORE makes the
   * claim atomic — concurrent duplicates race, exactly one wins.
   * fresh=false means this key was already claimed; existing carries the
   * settled outcome (or nulls while an escalation is still pending).
   */
  claimIdempotencyKey(agentId: string, key: string): {
    fresh: boolean;
    existing: { ledgerSeq: number | null; approvalId: string | null; reason: string | null } | null;
  } {
    const r = stmts.claimIdem.run(agentId, key, new Date().toISOString());
    if (r.changes > 0) return { fresh: true, existing: null };
    const row = stmts.getIdem.get(agentId, key) as Record<string, unknown> | undefined;
    return {
      fresh: false,
      existing: row
        ? { ledgerSeq: (row.ledger_seq as number | null) ?? null, approvalId: (row.approval_id as string | null) ?? null, reason: (row.reason as string | null) ?? null }
        : null,
    };
  },

  /** Attach the final outcome to a claimed key so retries can replay it. */
  settleIdempotencyKey(agentId: string, key: string, outcome: { ledgerSeq: number; approvalId: string | null; reason: string }): void {
    stmts.settleIdem.run(outcome.ledgerSeq, outcome.approvalId, outcome.reason, agentId, key);
  },
};
