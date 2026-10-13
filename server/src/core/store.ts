import { createBudgetStore } from './budget.js';
import { isSupportedCurrency } from '../../../shared/currency.js';
import { BudgetError } from './budget.js';
import type { PolicyRevision } from './policy-history.js';
import { PolicyConflict } from './policy-history.js';
import { migrate } from './migrations.js';
import { withImmediateTransaction as runImmediate } from './transactions.js';
// SQLite persistence via node's built-in sqlite (no native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ApprovalRequest, LedgerEntry, Policy } from './types.js';

const DATA_DIR = process.env.SPENDGATE_DATA ?? join(process.cwd(), '..', '.spendgate');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'spendgate.db'));

db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000');
migrate(db);

// --- signing secret (generated once, lives outside the db) ---
const SECRET_FILE = join(DATA_DIR, 'secret.key');
if (!existsSync(SECRET_FILE)) writeFileSync(SECRET_FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
export const SECRET = readFileSync(SECRET_FILE, 'utf8').trim();

// --- row mapping ---
export function rowToLedgerEntry(r: Record<string, unknown>): LedgerEntry {
  return {
    eventVersion: (r.event_version ?? 1) as 1 | 2,
    details: r.details_json ? JSON.parse(String(r.details_json)) : null,
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
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

export interface ApprovalLink {
  tokenHash: string;
  approvalId: string;
  action: 'approve' | 'reject';
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

function rowToLink(r: Record<string, unknown>): ApprovalLink {
  return {
    tokenHash: r.token_hash as string,
    approvalId: r.approval_id as string,
    action: r.action as 'approve' | 'reject',
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    usedAt: (r.used_at as string | null) ?? null,
  };
}

const stmts = {
  lastEntry: db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT 1'),
  insertEntry: db.prepare(`INSERT INTO ledger
    (seq, ts, intent_id, agent_id, amount, currency, vendor, purpose, rail, decision, rule, decided_by, approval_id, prev_hash, hash, signature, event_version, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  insertApproval: db.prepare(`INSERT INTO approvals (id, intent_json, rule, reason, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)`),
  getApproval: db.prepare('SELECT * FROM approvals WHERE id = ?'),
  decideApproval: db.prepare(`UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'`),
  recentLedger: db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT ?'),
  ledgerByAgent: db.prepare('SELECT * FROM ledger WHERE agent_id = ? ORDER BY seq DESC LIMIT ?'),
  allLedger: db.prepare('SELECT * FROM ledger ORDER BY seq ASC'),
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
  insertLink: db.prepare(`INSERT INTO approval_links (token_hash, approval_id, action, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)`),
  getLink: db.prepare('SELECT * FROM approval_links WHERE token_hash = ?'),
  linksForApproval: db.prepare('SELECT * FROM approval_links WHERE approval_id = ?'),
  markLinkUsed: db.prepare('UPDATE approval_links SET used_at = ? WHERE token_hash = ?'),
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
      e.decision, e.rule, e.decidedBy, e.approvalId, e.prevHash, e.hash, e.signature, e.eventVersion ?? 1, e.details ? JSON.stringify(e.details) : null,
    );
  },

  createApproval(a: ApprovalRequest): void {
    stmts.insertApproval.run(a.id, JSON.stringify(a.intent), a.rule, a.reason, a.createdAt, a.expiresAt ?? new Date(Date.parse(a.createdAt) + 300000).toISOString());
    db.prepare('INSERT OR IGNORE INTO spend_requests (request_id,agent_id,intent_json,approval_id,reason) VALUES (?,?,?,?,?)')
      .run(a.intent.id, a.intent.agentId, JSON.stringify(a.intent), a.id, a.reason);
    db.prepare('INSERT OR IGNORE INTO notification_outbox (approval_id) VALUES (?)').run(a.id);
  },

  insertApprovalLink(link: ApprovalLink): void {
    stmts.insertLink.run(link.tokenHash, link.approvalId, link.action, link.createdAt, link.expiresAt);
  },

  getApprovalLink(tokenHash: string): ApprovalLink | null {
    const r = stmts.getLink.get(tokenHash) as Record<string, unknown> | undefined;
    return r ? rowToLink(r) : null;
  },

  linksForApproval(approvalId: string): ApprovalLink[] {
    return (stmts.linksForApproval.all(approvalId) as Record<string, unknown>[]).map(rowToLink);
  },

  markLinkUsed(tokenHash: string, usedAt: string): void {
    stmts.markLinkUsed.run(usedAt, tokenHash);
  },

  getApproval(id: string): ApprovalRequest | null {
    const r = stmts.getApproval.get(id) as Record<string, unknown> | undefined;
    return r ? rowToApproval(r) : null;
  },

  /** Returns true if the approval was still pending and got decided. */
  decideApproval(id: string, status: 'approved' | 'rejected' | 'expired', by: string, note: string | null, now = new Date()): boolean {
    const r = stmts.decideApproval.run(status, now.toISOString(), by, note, id);
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
    return createBudgetStore(db).getBudgetSnapshot(agentId).spentMinor;
  },

  knownVendors(agentId: string): Set<string> {
    return new Set((stmts.knownVendors.all(agentId) as { vendor: string }[]).map((r) => r.vendor.toLowerCase()));
  },

  listAgents(): { agentId: string; displayName: string; currency: string }[] {
    return (stmts.listAgents.all() as Record<string, unknown>[]).map((r) => ({
      agentId: r.agent_id as string,
      displayName: r.display_name as string,
      currency: r.currency as string,
    }));
  },

  upsertAgent(agentId: string, displayName: string, currency: string): void {
    const existing = db.prepare('SELECT currency FROM agents WHERE agent_id = ?').get(agentId);
    if (!isSupportedCurrency(currency)) throw new BudgetError('Unsupported currency.', 422);
    if (existing && existing.currency !== currency) createBudgetStore(db).assertAgentMutable(agentId);
    stmts.upsertAgent.run(agentId, displayName, currency);
  },

  /** Removes the agent and its policy. Ledger history is kept for audit. */
  deleteAgent(agentId: string): void {
    createBudgetStore(db).assertAgentMutable(agentId);
    stmts.deletePolicy.run(agentId);
    stmts.deleteAgent.run(agentId);
  },

  getPolicy(agentId: string): Policy | null {
    const r = stmts.getPolicy.get(agentId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Policy) : null;
  },

  getPolicyVersion(agentId: string): number {
    return Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM policy_revisions WHERE agent_id=?').get(agentId)!.version);
  },

  policyHistory(agentId: string, limit = 50): PolicyRevision[] {
    return db.prepare('SELECT * FROM policy_revisions WHERE agent_id=? ORDER BY version DESC LIMIT ?').all(agentId, limit).map(r => ({
      agentId: String(r.agent_id), version: Number(r.version), changedAt: String(r.changed_at), changedBy: String(r.changed_by),
      source: r.source as PolicyRevision['source'], before: r.before_json ? JSON.parse(String(r.before_json)) : null, after: JSON.parse(String(r.after_json)),
    }));
  },

  /** Internal writes are versioned too; authenticated API writes must supply actor and expectedVersion. */
  upsertPolicy(policy: Policy, audit: { expectedVersion?: number; changedBy: string; source: PolicyRevision['source'] } = { changedBy: 'system:internal', source: 'system' }): number {
    const write = () => {
      const version = store.getPolicyVersion(policy.agentId);
      if (audit.expectedVersion != null && audit.expectedVersion !== version) throw new PolicyConflict();
      const before = store.getPolicy(policy.agentId);
      db.prepare('INSERT INTO policy_revisions VALUES (?,?,?,?,?,?,?)').run(policy.agentId, version + 1, new Date().toISOString(),
        audit.changedBy, audit.source, before ? JSON.stringify(before) : null, JSON.stringify(policy));
      stmts.upsertPolicy.run(policy.agentId, JSON.stringify(policy));
      return version + 1;
    };
    return db.isTransaction ? write() : withImmediateTransaction(write);
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

/** Shared transaction boundary for auth, budget and approval finalisation. */
export function withImmediateTransaction<T>(callback: () => T): T {
  return runImmediate(db, callback);
}
