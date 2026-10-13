import type { DatabaseSync } from 'node:sqlite';
import { currencyPrecision, isSupportedCurrency } from '../../../shared/currency.js';

export type BudgetMode = 'hard-stop' | 'approval-override';
export interface BudgetSnapshot {
  agentId: string; currency: string; precision: number | null; mode: BudgetMode;
  limitMinor: number | null; periodStart: string; periodEnd: string; timezone: 'UTC';
  spentMinor: number; reservedMinor: number; remainingMinor: number | null;
  reconciliationRequired: boolean;
}
export interface ReserveBudgetInput {
  requestId: string; agentId: string; amountMinor: number; currency: string; expiresAt: string;
  override?: { operatorId: string; reason: string };
}
export interface Reservation extends Omit<ReserveBudgetInput, 'override'> {
  periodStart: string; status: 'reserved' | 'settled' | 'released';
}
export interface ReconcileInput {
  ledgerSeq: number; action: 'no-outstanding-obligation' | 'outstanding' | 'confirmed-paid';
  operatorId: string; reason: string; evidence?: string; eventId: string;
}
export class BudgetError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export function utcPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
  return { periodStart: start.toISOString(), periodEnd: new Date(start.getTime() + 86400000).toISOString() };
}
function rowReservation(row: Record<string, unknown>): Reservation {
  return { requestId: String(row.request_id), agentId: String(row.agent_id), amountMinor: Number(row.amount),
    currency: String(row.currency), expiresAt: String(row.expires_at), periodStart: String(row.period_start), status: row.status as Reservation['status'] };
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\x00-\x1f\x7f]/.test(value)) throw new BudgetError(`${label} is required (max 1000 characters, no control characters).`, 422);
}

/** All mutations are unwrapped: callers MUST hold BEGIN IMMEDIATE on this connection. */
export function createBudgetStore(db: DatabaseSync) {
  const requireTransaction = () => {
    if (!(db as DatabaseSync & { isTransaction: boolean }).isTransaction) throw new BudgetError('Budget mutation requires an outer transaction.');
  };
  function getReservation(requestId: string): Reservation | null {
    const row = db.prepare('SELECT * FROM budget_reservations WHERE request_id = ?').get(requestId);
    return row ? rowReservation(row) : null;
  }
  function accountingEvents(agentId: string) {
    return db.prepare('SELECT seq, ts, request_id, payload FROM budget_accounting_events WHERE agent_id = ? ORDER BY seq').all(agentId)
      .map(row => ({ seq: Number(row.seq), ts: String(row.ts), requestId: String(row.request_id), ...JSON.parse(String(row.payload)) }));
  }
  function appendEvent(eventId: string, requestId: string, agentId: string, kind: string, payload: object, now: Date) {
    text(eventId, 'Event ID');
    const canonical = JSON.stringify({ kind, ...payload });
    const existing = db.prepare('SELECT request_id, agent_id, payload FROM budget_accounting_events WHERE event_id = ?').get(eventId);
    if (existing) {
      if (existing.request_id !== requestId || existing.agent_id !== agentId || existing.payload !== canonical) throw new BudgetError('Conflicting accounting event reuse.');
      return false;
    }
    db.prepare('INSERT INTO budget_accounting_events (event_id, request_id, agent_id, kind, ts, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(eventId, requestId, agentId, kind, now.toISOString(), canonical);
    return true;
  }
  function legacyObligations(agentId: string) {
    return db.prepare(`SELECT o.*, l.intent_id, l.amount, l.currency, l.ts, l.vendor, l.purpose
      FROM legacy_budget_obligations o JOIN ledger l ON l.seq = o.ledger_seq WHERE o.agent_id = ? ORDER BY o.ledger_seq`).all(agentId)
      .map(row => ({ ledgerSeq: Number(row.ledger_seq), requestId: String(row.intent_id), amountMinor: Number(row.amount), currency: String(row.currency),
        ts: String(row.ts), vendor: String(row.vendor), purpose: String(row.purpose), disposition: row.disposition as string | null,
        executionStatus: row.disposition === 'confirmed-paid' ? 'confirmed-paid' : 'unknown', evidence: row.evidence, operatorId: row.operator_id, reason: row.reason }));
  }
  function getBudgetSnapshot(agentId: string, now = new Date()): BudgetSnapshot {
    const agent = db.prepare('SELECT currency FROM agents WHERE agent_id = ?').get(agentId);
    if (!agent) throw new BudgetError('Unknown agent.', 404);
    const row = db.prepare('SELECT json FROM policies WHERE agent_id = ?').get(agentId);
    const policy = row ? JSON.parse(String(row.json)) : {};
    const currency = String(agent.currency), { periodStart, periodEnd } = utcPeriod(now);
    const totals = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'settled' AND period_start = ? THEN amount ELSE 0 END), 0) AS spent,
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN amount ELSE 0 END), 0) AS reserved
      FROM budget_reservations WHERE agent_id = ? AND currency = ?`).get(periodStart, agentId, currency)!;
    const spentMinor = Number(totals.spent), reservedMinor = Number(totals.reserved);
    if (!Number.isSafeInteger(spentMinor + reservedMinor)) throw new BudgetError('Budget accounting exceeds safe integer range.');
    const limitMinor = policy.dailyBudget ?? null;
    const ambiguous = db.prepare('SELECT 1 FROM legacy_budget_obligations WHERE agent_id = ? AND disposition IS NULL LIMIT 1').get(agentId);
    const foreignHold = db.prepare("SELECT 1 FROM budget_reservations WHERE agent_id = ? AND status = 'reserved' AND currency != ? LIMIT 1").get(agentId, currency);
    return { agentId, currency, precision: isSupportedCurrency(currency) ? currencyPrecision(currency) : null,
      mode: policy.budgetMode ?? 'hard-stop', limitMinor, periodStart, periodEnd, timezone: 'UTC', spentMinor, reservedMinor,
      remainingMinor: limitMinor == null ? null : limitMinor - spentMinor - reservedMinor, reconciliationRequired: !!ambiguous || !!foreignHold };
  }
  function reserveBudget(input: ReserveBudgetInput, now = new Date()): Reservation {
    requireTransaction(); text(input.requestId, 'Request ID');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > 1e12) throw new BudgetError('Amount must be an integer in atomic minor units within 1..1e12.', 422);
    if (!isSupportedCurrency(input.currency)) throw new BudgetError('Unsupported currency.', 422);
    const existing = getReservation(input.requestId);
    if (existing) {
      if (existing.agentId !== input.agentId || existing.amountMinor !== input.amountMinor || existing.currency !== input.currency || existing.expiresAt !== input.expiresAt) throw new BudgetError('Conflicting request reuse.');
      return existing;
    }
    const expiry = new Date(input.expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry <= now) throw new BudgetError('Reservation expiry must be in the future.', 422);
    if (!db.prepare('SELECT 1 FROM policies WHERE agent_id = ?').get(input.agentId)) throw new BudgetError('No policy for this agent.');
    const snapshot = getBudgetSnapshot(input.agentId, now);
    if (snapshot.currency !== input.currency) throw new BudgetError('Request currency must match agent currency.', 422);
    if (snapshot.reconciliationRequired) throw new BudgetError('Legacy obligations require operator reconciliation before authorisation.');
    const over = snapshot.remainingMinor != null && input.amountMinor > snapshot.remainingMinor;
    if (over && (snapshot.mode !== 'approval-override' || !input.override)) throw new BudgetError('Insufficient budget funds.');
    if (input.override) { text(input.override.operatorId, 'Operator identity'); text(input.override.reason, 'Override reason'); }
    db.prepare(`INSERT INTO budget_reservations (request_id, agent_id, amount, currency, period_start, expires_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`).run(input.requestId, input.agentId, input.amountMinor, input.currency, snapshot.periodStart, input.expiresAt, now.toISOString());
    appendEvent(`reserve:${input.requestId}`, input.requestId, input.agentId, 'reserved', { amountMinor: input.amountMinor, currency: input.currency,
      periodStart: snapshot.periodStart, override: over, operatorId: input.override?.operatorId ?? null, reason: input.override?.reason ?? null }, now);
    return getReservation(input.requestId)!;
  }
  function transition(requestId: string, eventId: string, status: 'settled' | 'released', cause: string, now: Date) {
    requireTransaction(); const r = getReservation(requestId);
    if (!r) throw new BudgetError('Unknown reservation.', 404);
    const old = db.prepare('SELECT terminal_cause FROM budget_reservations WHERE request_id = ?').get(requestId)!;
    if (r.status !== 'reserved' && (r.status !== status || old.terminal_cause !== cause)) throw new BudgetError('Conflicting terminal outcome requires execution reconciliation.');
    // Identical terminal states are harmless even if the provider retries under a new event ID.
    const fresh = appendEvent(eventId, requestId, r.agentId, status, { cause, amountMinor: r.amountMinor, currency: r.currency, periodStart: r.periodStart }, now);
    if (r.status !== 'reserved') return { changed: false, reservation: r };
    if (!fresh) throw new BudgetError('Conflicting accounting event reuse.');
    db.prepare('UPDATE budget_reservations SET status = ?, terminal_cause = ?, finalised_at = ? WHERE request_id = ? AND status = ?')
      .run(status, cause, now.toISOString(), requestId, 'reserved');
    return { changed: true, reservation: getReservation(requestId)! };
  }
  function reconcileLegacy(input: ReconcileInput, now = new Date()) {
    requireTransaction(); text(input.operatorId, 'Operator identity'); text(input.reason, 'Review reason'); text(input.eventId, 'Event ID');
    if (!['no-outstanding-obligation', 'outstanding', 'confirmed-paid'].includes(input.action)) throw new BudgetError('Invalid reconciliation action.', 422);
    if (input.action === 'confirmed-paid') text(input.evidence, 'Payment evidence');
    const row = db.prepare(`SELECT o.*, l.amount, l.currency, l.ts FROM legacy_budget_obligations o JOIN ledger l ON l.seq = o.ledger_seq WHERE o.ledger_seq = ?`).get(input.ledgerSeq);
    if (!row) throw new BudgetError('Unknown legacy obligation.', 404);
    const agentId = String(row.agent_id), requestId = `legacy:${input.ledgerSeq}`;
    const payload = { ledgerSeq: input.ledgerSeq, action: input.action, operatorId: input.operatorId, reason: input.reason, evidence: input.evidence ?? null };
    const before = getBudgetSnapshot(agentId, now);
    const oldEvent = db.prepare('SELECT payload FROM budget_accounting_events WHERE event_id = ?').get(input.eventId);
    if (oldEvent) {
      const stored = JSON.parse(String(oldEvent.payload));
      if (JSON.stringify(stored.review) !== JSON.stringify(payload)) throw new BudgetError('Conflicting reconciliation event reuse.');
      return;
    }
    if (row.disposition != null && (row.disposition !== 'outstanding' || input.action === 'outstanding')) throw new BudgetError('Conflicting reconciliation: obligation already reviewed.');
    if (row.disposition === 'outstanding') {
      if (input.action === 'confirmed-paid') transition(requestId, `legacy-settle:${input.eventId}`, 'settled', 'completed', now);
      else {
        text(input.evidence, 'Evidence that the outstanding obligation cannot execute');
        transition(requestId, `legacy-release:${input.eventId}`, 'released', 'cancelled', now);
      }
    } else if (input.action !== 'no-outstanding-obligation') {
      if (!isSupportedCurrency(String(row.currency))) throw new BudgetError('Unsupported historical currency requires offline evidence review.', 422);
      db.prepare(`INSERT INTO budget_reservations (request_id, agent_id, amount, currency, period_start, expires_at, status, terminal_cause, created_at, finalised_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(requestId, agentId, row.amount, row.currency, utcPeriod(new Date(String(row.ts))).periodStart,
          now.toISOString(), input.action === 'outstanding' ? 'reserved' : 'settled', input.action === 'confirmed-paid' ? 'completed' : null, now.toISOString(), input.action === 'confirmed-paid' ? now.toISOString() : null);
    }
    db.prepare('UPDATE legacy_budget_obligations SET disposition = ?, evidence = ?, operator_id = ?, reason = ?, reconciled_at = ? WHERE ledger_seq = ?')
      .run(input.action, input.evidence ?? null, input.operatorId, input.reason, now.toISOString(), input.ledgerSeq);
    appendEvent(input.eventId, requestId, agentId, 'legacy-reconciled', { review: payload, before, after: getBudgetSnapshot(agentId, now) }, now);
  }
  function assertAgentMutable(agentId: string, now = new Date()) {
    const active = db.prepare(`SELECT 1 FROM budget_reservations WHERE agent_id = ? AND
      (status = 'reserved' OR (status = 'settled' AND period_start = ?)) LIMIT 1`).get(agentId, utcPeriod(now).periodStart);
    const unknown = db.prepare('SELECT 1 FROM legacy_budget_obligations WHERE agent_id = ? AND disposition IS NULL LIMIT 1').get(agentId);
    const pending = db.prepare("SELECT 1 FROM approvals WHERE status = 'pending' AND json_extract(intent_json, '$.agentId') = ? LIMIT 1").get(agentId);
    if (active || unknown || pending) throw new BudgetError('Agent currency/deletion is locked by outstanding requests, current-period spend or legacy obligations. Reconcile the listed obligations first.');
  }
  return { assertAgentMutable, getBudgetSnapshot, getReservation, reserveBudget, accountingEvents, legacyObligations, reconcileLegacy,
    settleReservation: (requestId: string, eventId: string, now = new Date()) => transition(requestId, eventId, 'settled', 'completed', now),
    releaseReservation: (requestId: string, eventId: string, cause: 'failed' | 'cancelled' | 'expired', now = new Date()) => {
      if (!['failed','cancelled','expired'].includes(cause)) throw new BudgetError('Invalid release cause.', 422);
      return transition(requestId, eventId, 'released', cause, now);
    },
  };
}
