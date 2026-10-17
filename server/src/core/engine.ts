// Durable request lifecycle. Waiters observe committed outcomes; they never own them.
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalRequest, LedgerDecision, Rail, SpendIntent, DecisionDetails } from './types.js';
import { store, db, withImmediateTransaction } from './store.js';
import { budget } from './budget-state.js';
import { BudgetError } from './budget.js';
import { parseIntent, intentDigest } from './policy-input.js';
import { encodeEvidence, evaluateContext, EVALUATOR_VERSION, type EvidenceContext } from './policy-evidence.js';
import { appendLedger } from './ledger.js';
import { cleanStr } from './sanitize.js';

export function approvalTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SPENDLOCK_APPROVAL_TIMEOUT_MS ?? 300000);
  if (!Number.isSafeInteger(value) || value < 60000 || value > 604800000) throw new Error('SPENDLOCK_APPROVAL_TIMEOUT_MS must be an integer from 60000 to 604800000.');
  return value;
}
export const APPROVAL_TIMEOUT_MS = approvalTimeout();
// Execution permission has its own deadline. Never release an execution hold merely because it elapsed.
export const AUTHORISATION_TTL_MS = 300000;
type Event = { type: 'ledger'; entry: unknown } | { type: 'approvals'; pending: unknown[] } | { type: 'state' };
const listeners = new Set<(e: Event) => void>();
export function onEvent(fn: (e: Event) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(e: Event): void {
  for (const fn of listeners) { try { fn(e); } catch (err) { console.error('[events] subscriber failed', err instanceof Error ? err.name : 'Error'); } }
}
export class EngineError extends Error { constructor(message: string, public status = 400) { super(message); } }
export interface SpendResult {
  intent: SpendIntent; requestId: string; decision: LedgerDecision; rule: string; reason: string;
  decidedBy: string; approvalId: string | null; ledgerSeq: number; expiresAt: string | null; authorisationExpiresAt: string | null;
}
export interface PendingSpendResult {
  intent: SpendIntent; requestId: string; decision: 'PENDING'; rule: string; reason: string;
  decidedBy: null; approvalId: string; ledgerSeq: null; expiresAt: string; authorisationExpiresAt: null;
}
export type RequestSnapshot = SpendResult | PendingSpendResult;
export interface SpendInput {
  agentId: string; amount: number; currency: string; vendor: string; purpose: string; rail: Rail;
  idempotencyKey?: string;
}
export type EvidenceReference = { schemaVersion: number; digest: string };
function details(actor: DecisionDetails['actor'], note: string | null, evidence: EvidenceReference | null, budgetRecheck: DecisionDetails['budgetRecheck'] = null): DecisionDetails {
  return { actor, note, evidence, budgetRecheck };
}
function readRequest(requestId: string): RequestSnapshot {
  const row = db.prepare('SELECT * FROM spend_requests WHERE request_id=?').get(requestId);
  if (!row) throw new EngineError('Unknown request.', 404);
  if (row.reconciliation_required) throw new EngineError('Legacy request requires audited reconciliation.', 409);
  const intent: SpendIntent = JSON.parse(String(row.intent_json));
  const approval = row.approval_id ? store.getApproval(String(row.approval_id)) : null;
  if (row.ledger_seq != null) {
    const entry = store.ledgerEntryBySeq(Number(row.ledger_seq));
    if (!entry) throw new EngineError('Request outcome requires reconciliation.', 409);
    return { requestId, intent, decision: entry.decision, rule: entry.rule, reason: String(row.reason),
      decidedBy: entry.decidedBy, approvalId: entry.approvalId, ledgerSeq: entry.seq, expiresAt: approval?.expiresAt ?? null, authorisationExpiresAt: budget.getReservation(requestId)?.expiresAt ?? null };
  }
  if (!approval || approval.status !== 'pending') throw new EngineError('Request outcome requires reconciliation.', 409);
  return { requestId, intent, decision: 'PENDING', rule: approval.rule, reason: approval.reason, decidedBy: null,
    approvalId: approval.id, ledgerSeq: null, expiresAt: approval.expiresAt!, authorisationExpiresAt: null };
}
/** Agent ID must originate from #1's validated principal, never caller metadata. */
export function getRequest(agentId: string, requestId: string): RequestSnapshot {
  const row = db.prepare('SELECT agent_id, approval_id FROM spend_requests WHERE request_id=?').get(requestId);
  if (!row || row.agent_id !== agentId) throw new EngineError('Unknown request.', 404);
  if (row.approval_id) finaliseApproval(String(row.approval_id), 'expire', { kind: 'expiry', id: null });
  return readRequest(requestId);
}
function reserveIntent(intent: SpendIntent, now: Date, override?: { operatorId: string; reason: string }): void {
  budget.reserveBudget({ requestId: intent.id, agentId: intent.agentId, amountMinor: intent.amount,
    currency: intent.currency, expiresAt: new Date(now.getTime() + AUTHORISATION_TTL_MS).toISOString(), override }, now);
}
/** Synchronous submission: policy, context, evidence, reservation and outcome share one transaction. */
export function submitRequest(input: SpendInput, options: { evidence?: EvidenceReference } = {}): RequestSnapshot {
  const agent = store.listAgents().find(a => a.agentId === input.agentId);
  if (!agent) throw new EngineError(`Unknown agent "${input.agentId}". Register it in the console first.`, 404);
  const normalised = parseIntent(input.agentId, input, 'pending');
  const { vendor, purpose, currency } = normalised;
  const key = input.idempotencyKey == null ? null : cleanStr(input.idempotencyKey, 'idempotencyKey', 128)!;
  if (options.evidence !== undefined) throw new EngineError('Caller-supplied evidence is not accepted; evidence is constructed within submission.', 422);
  const fingerprint = createHash('sha256').update(JSON.stringify([input.agentId, input.amount, currency, vendor, purpose, input.rail])).digest('hex');
  const result = withImmediateTransaction(() => {
    if (key) {
      const existing = db.prepare('SELECT * FROM idempotency_keys WHERE agent_id=? AND key=?').get(input.agentId, key);
      if (existing) {
        // Legacy settled keys can replay, but unlinked claims cannot safely be matched by timestamps.
        if (existing.fingerprint && existing.fingerprint !== fingerprint) throw new EngineError('Idempotency key reused with different request content.', 409);
        if (!existing.request_id) throw new EngineError('Legacy idempotency claim requires audited reconciliation.', 409);
        if (!existing.fingerprint) {
          const old = readRequest(String(existing.request_id)).intent;
          const oldHash = createHash('sha256').update(JSON.stringify([old.agentId, old.amount, old.currency, old.vendor, old.purpose, old.rail])).digest('hex');
          if (oldHash !== fingerprint) throw new EngineError('Idempotency key reused with different request content.', 409);
        }
        return { requestId: String(existing.request_id), fresh: false };
      }
    }
    if (db.prepare('SELECT request_id FROM spend_requests WHERE agent_id=? AND reconciliation_required=1 LIMIT 1').get(input.agentId)) throw new EngineError('Legacy requests require audited reconciliation before new authorisation.', 409);
    // Replay precedes mutable policy/currency checks so a retry can still recover its original result.
    const transactionAgent = store.listAgents().find(a => a.agentId === input.agentId);
    if (!transactionAgent) throw new EngineError('Unknown agent.', 404);
    if (currency !== transactionAgent.currency) throw new EngineError('Request currency must match the configured agent currency.', 422);
    const policy = store.getPolicy(input.agentId);
    if (!policy) throw new EngineError(`No policy for agent "${input.agentId}".`, 409);
    const now = new Date();
    const intent: SpendIntent = { id: randomUUID(), agentId: input.agentId, amount: input.amount, currency, vendor, purpose, rail: input.rail };
    const snapshot = budget.getBudgetSnapshot(input.agentId, now);
    if (snapshot.reconciliationRequired) throw new BudgetError('Legacy obligations require operator reconciliation before authorisation.');
    const context: EvidenceContext = { agentCurrency: snapshot.currency, budget: snapshot, vendorKnown: store.knownVendors(input.agentId).has(vendor.toLowerCase()) };
    const verdict = evaluateContext(policy, intent, context, now);
    const encoded = encodeEvidence({ schemaVersion: 1, intentDigest: intentDigest(intent), policyVersion: store.getPolicyVersion(input.agentId), evaluatorVersion: EVALUATOR_VERSION,
      evaluatedAt: now.toISOString(), context, verdict });
    const evidence: EvidenceReference = { schemaVersion: 1, digest: encoded.digest };
    db.prepare('INSERT INTO policy_evidence (request_id,schema_version,digest,envelope_json) VALUES (?,1,?,?)').run(intent.id, encoded.digest, encoded.json);
    db.prepare('INSERT INTO spend_requests (request_id,agent_id,intent_json,reason,evidence_json) VALUES (?,?,?,?,?)')
      .run(intent.id, intent.agentId, JSON.stringify(intent), verdict.reason, evidence ? JSON.stringify(evidence) : null);
    if (key) db.prepare('INSERT INTO idempotency_keys (agent_id,key,created_at,request_id,fingerprint,reason) VALUES (?,?,?,?,?,?)')
      .run(intent.agentId, key, now.toISOString(), intent.id, fingerprint, verdict.reason);
    if (verdict.decision !== 'ESCALATE') {
      const decision = verdict.decision === 'ALLOW' ? 'ALLOWED' : 'DENIED';
      if (decision === 'ALLOWED') reserveIntent(intent, now);
      const entry = appendLedger({ intent, decision, rule: verdict.rule, decidedBy: 'policy', now, details: details({ kind: 'policy', id: null }, null, evidence) });
      db.prepare('UPDATE spend_requests SET ledger_seq=? WHERE request_id=?').run(entry.seq, intent.id);
      db.prepare('UPDATE idempotency_keys SET ledger_seq=? WHERE request_id=?').run(entry.seq, intent.id);
    } else {
      const approval: ApprovalRequest = { id: randomUUID(), intent, rule: verdict.rule, reason: verdict.reason,
        status: 'pending', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + APPROVAL_TIMEOUT_MS).toISOString(), decidedAt: null, decidedBy: null, note: null };
      store.createApproval(approval);
      db.prepare('UPDATE spend_requests SET approval_id=? WHERE request_id=?').run(approval.id, intent.id);
      db.prepare('UPDATE idempotency_keys SET approval_id=? WHERE request_id=?').run(approval.id, intent.id);
    }
    return { requestId: intent.id, fresh: true };
  });
  const snapshot = getRequest(input.agentId, result.requestId);
  if (result.fresh) broadcast(snapshot);
  return snapshot;
}
function broadcast(result: RequestSnapshot): void {
  if (result.ledgerSeq != null) emit({ type: 'ledger', entry: store.ledgerEntryBySeq(result.ledgerSeq) });
  emit({ type: 'approvals', pending: store.pendingApprovals() }); emit({ type: 'state' });
}
export interface FinalisationResult { changed: boolean; requestId: string | null; status: ApprovalRequest['status'] | null }
export type DecisionActor = DecisionDetails['actor'];
/** All writes, including capability consumption, share one BEGIN IMMEDIATE boundary. */
export function finaliseApproval(approvalId: string, action: 'approve' | 'reject' | 'expire', actor: DecisionActor, note?: string, tokenHash?: string, options?: { allowBudgetOverride: boolean }): FinalisationResult {
  const result = withImmediateTransaction<FinalisationResult>(() => {
    const approval = store.getApproval(approvalId);
    if (!approval) return { changed: false, requestId: null, status: null };
    const request = db.prepare('SELECT * FROM spend_requests WHERE request_id=?').get(approval.intent.id);
    if (!request || request.reconciliation_required) throw new EngineError('Legacy request requires audited reconciliation.', 409);
    if (approval.status !== 'pending') return { changed: false, requestId: approval.intent.id, status: approval.status };
    const now = new Date();
    const overdue = now.toISOString() >= approval.expiresAt!;
    if (action === 'expire' && !overdue) return { changed: false, requestId: approval.intent.id, status: approval.status };
    if (tokenHash) {
      const link = store.getApprovalLink(tokenHash);
      if (!link || link.approvalId !== approval.id || link.action !== action || link.usedAt) throw new EngineError('This decision link has already been used.', 410);
      if (link.expiresAt <= now.toISOString() && !overdue) throw new EngineError('This decision link has expired.', 410);
    }
    const status = overdue ? 'expired' : action === 'approve' ? 'approved' : 'rejected';
    const finalActor: DecisionActor = overdue ? { kind: 'expiry', id: null } : actor;
    const finalNote = overdue ? 'Escalation timed out' : cleanStr(note, 'note', 500, true) ?? null;
    let recheck: DecisionDetails['budgetRecheck'] = null;
    if (status === 'approved') {
      if (db.prepare('SELECT request_id FROM spend_requests WHERE agent_id=? AND reconciliation_required=1 LIMIT 1').get(approval.intent.agentId)) throw new EngineError('Legacy requests require audited reconciliation before new authorisation.', 409);
      const snapshot = budget.getBudgetSnapshot(approval.intent.agentId, now);
      const over = snapshot.remainingMinor != null && approval.intent.amount > snapshot.remainingMinor;
      if (over && finalActor.kind !== 'operator') throw new BudgetError('Budget overrides require an authenticated console operator.');
      if (over && snapshot.mode === 'approval-override' && !finalNote?.trim()) throw new BudgetError('An explicit override reason is required.', 422);
      if (over && snapshot.mode === 'approval-override' && options?.allowBudgetOverride !== true) throw new BudgetError('Budget changed. Review and explicitly approve the budget override.');
      reserveIntent(approval.intent, now, over ? { operatorId: finalActor.id!, reason: finalNote ?? '' } : undefined);
      recheck = { reservedMinor: snapshot.reservedMinor, remainingMinor: snapshot.remainingMinor, overrideReason: over ? finalNote : null, overrideConsent: over && options?.allowBudgetOverride === true };
    } else {
      // Pending requests normally have no hold. Never release an already-final execution reservation.
      const reservation = budget.getReservation(approval.intent.id);
      if (reservation?.status === 'reserved') budget.releaseReservation(approval.intent.id, `approval:${approval.id}:${status}`, status === 'expired' ? 'expired' : 'cancelled', now);
    }
    const by = finalActor.kind === 'operator' ? finalActor.id! : finalActor.kind === 'decision-link' ? 'decision-link' : 'expiry';
    store.decideApproval(approval.id, status, by, finalNote, now);
    const decisions = { approved: 'APPROVED', rejected: 'REJECTED', expired: 'EXPIRED' } as const;
    const reason = status === 'expired' ? 'No human decided in time — escalations expire denied.' : approval.reason;
    const entry = appendLedger({ intent: approval.intent, decision: decisions[status],
      rule: recheck?.overrideReason ? `budget-override:${approval.rule}` : approval.rule,
      decidedBy: status === 'expired' ? 'expiry' : `human:${by}`, approvalId: approval.id, now,
      details: details(finalActor, finalNote, request.evidence_json ? JSON.parse(String(request.evidence_json)) : null, recheck) });
    db.prepare('UPDATE spend_requests SET ledger_seq=?,reason=? WHERE request_id=?').run(entry.seq, reason, approval.intent.id);
    db.prepare('UPDATE idempotency_keys SET ledger_seq=?,approval_id=?,reason=? WHERE request_id=?').run(entry.seq, approval.id, reason, approval.intent.id);
    db.prepare('UPDATE approval_links SET used_at=COALESCE(used_at,?) WHERE approval_id=?').run(now.toISOString(), approval.id);
    db.prepare("UPDATE notification_outbox SET status='obsolete',lease_id=NULL,lease_until=NULL WHERE approval_id=? AND status!='delivered'").run(approval.id);
    return { changed: true, requestId: approval.intent.id, status };
  });
  if (result.changed && result.requestId) broadcast(readRequest(result.requestId));
  return result;
}
export function decide(approvalId: string, approve: boolean, by: string, note?: string): boolean {
  const result = finaliseApproval(approvalId, approve ? 'approve' : 'reject', by === 'decision-link' ? { kind: 'decision-link', id: null } : { kind: 'operator', id: by }, note, undefined, { allowBudgetOverride: by !== 'decision-link' && Boolean(note?.trim()) });
  return result.changed && result.status === (approve ? 'approved' : 'rejected');
}
export function expireStale(): void {
  for (const row of db.prepare("SELECT id FROM approvals WHERE status='pending' AND expires_at<=? AND NOT EXISTS (SELECT 1 FROM spend_requests r WHERE r.approval_id=approvals.id AND r.reconciliation_required=1)").all(new Date().toISOString())) {
    finaliseApproval(String(row.id), 'expire', { kind: 'expiry', id: null });
  }
}
/** Polling also observes commits from other processes; disconnect cleanup cannot affect durable state. */
export async function waitForRequest(agentId: string, requestId: string, options: { signal?: AbortSignal; maxWaitMs?: number } = {}): Promise<RequestSnapshot> {
  const until = Date.now() + (options.maxWaitMs ?? APPROVAL_TIMEOUT_MS);
  while (true) {
    const result = getRequest(agentId, requestId);
    if (result.decision !== 'PENDING' || options.signal?.aborted || Date.now() >= until) return result;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, Math.min(100, Math.max(1, Date.parse(result.expiresAt) - Date.now()), Math.max(1, until - Date.now())));
      options.signal?.addEventListener('abort', finish, { once: true });
    });
  }
}
export async function submitSpend(input: SpendInput): Promise<SpendResult> {
  const initial = submitRequest(input);
  const result = initial.decision === 'PENDING' ? await waitForRequest(input.agentId, initial.requestId, { maxWaitMs: 604800100 }) : initial;
  if (result.decision === 'PENDING') throw new EngineError('Request remains pending; resume using its request ID.', 409);
  return result;
}
