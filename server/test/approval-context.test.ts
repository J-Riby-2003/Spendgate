import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.SPENDLOCK_DATA = `/tmp/spendlock-context-${Date.now()}-${Math.random()}`; });
import { db, store, withImmediateTransaction } from '../src/core/store.js';
import { submitRequest, finaliseApproval } from '../src/core/engine.js';
import { budget } from '../src/core/budget-state.js';
import { getApprovalContext, approvalQueueContext } from '../src/core/approval-context.js';
import type { Policy } from '../src/core/types.js';

let next = 0;
function fixture(mode: Policy['budgetMode'] = 'hard-stop', vendor = 'acme') {
  const agentId = `context-${++next}`;
  store.upsertAgent(agentId, 'Context Agent', 'GBP');
  store.upsertPolicy({ agentId, dailyBudget: 10000, budgetMode: mode, maxPerTxn: 1000, approvalThreshold: null,
    allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null });
  const result = submitRequest({ agentId, amount: 5000, currency: 'GBP', vendor, purpose: 'Context test', rail: 'mcp' });
  return { agentId, requestId: result.requestId, approvalId: result.approvalId! };
}

describe('decision-ready approval context', () => {
  it('shows completed spend, existing holds and the additional authorisation without reserving pending funds', () => {
    const f = fixture();
    withImmediateTransaction(() => {
      budget.reserveBudget({ requestId: 'paid', agentId: f.agentId, amountMinor: 2000, currency: 'GBP', expiresAt: new Date(Date.now()+60000).toISOString() });
      budget.settleReservation('paid', 'receipt:paid');
      budget.reserveBudget({ requestId: 'held', agentId: f.agentId, amountMinor: 1000, currency: 'GBP', expiresAt: new Date(Date.now()+60000).toISOString() });
    });
    const c = getApprovalContext(f.approvalId)!.context;
    expect(c.agent.displayName).toBe('Context Agent');
    expect(c.budget).toMatchObject({ status: 'available', snapshot: { spentMinor: 2000, reservedMinor: 1000, remainingMinor: 7000 }, additionalReservedMinor: 5000, projectedRemainingMinor: 2000, overrideRequired: false });
    expect(c.actions.approve.enabled).toBe(true);
    expect(budget.getReservation(f.requestId)).toBeNull();
  });
  it.each(['hard-stop', 'approval-override'] as const)('explains insufficient funds in %s', mode => {
    const f = fixture(mode);
    withImmediateTransaction(() => budget.reserveBudget({ requestId: `competition-${next}`, agentId: f.agentId, amountMinor: 7000, currency: 'GBP', expiresAt: new Date(Date.now()+60000).toISOString() }));
    const c = getApprovalContext(f.approvalId)!.context;
    expect(c.budget).toMatchObject({ projectedRemainingMinor: -2000, overrideRequired: mode === 'approval-override' });
    expect(c.actions.approve.enabled).toBe(mode === 'approval-override');
    expect(c.actions.reject.enabled).toBe(true);
  });
  it('disables both actions at the exact persisted expiry without creating a decision', () => {
    const f = fixture();
    const a = store.getApproval(f.approvalId)!;
    const c = getApprovalContext(f.approvalId, new Date(a.expiresAt!))!.context;
    expect(c.actions.approve.enabled).toBe(false);
    expect(c.actions.reject.enabled).toBe(false);
    expect(store.getApproval(f.approvalId)!.status).toBe('pending');
  });
  it.each(['approve', 'reject'] as const)('disables a request %s elsewhere and exposes its actor and note', action => {
    const f = fixture();
    finaliseApproval(f.approvalId, action, { kind: 'operator', id: 'reviewer' }, 'Recorded rationale');
    const a = getApprovalContext(f.approvalId)!;
    expect(a).toMatchObject({ status: action === 'approve' ? 'approved' : 'rejected', decidedBy: 'reviewer', note: 'Recorded rationale' });
    expect(a.context.actions.approve.enabled).toBe(false);
    expect(a.context.actions.reject.enabled).toBe(false);
    if (action === 'approve') expect(a.context.budget).toMatchObject({ additionalReservedMinor: 0, projectedRemainingMinor: 5000 });
  });
  it('distinguishes empty history from unavailable history and keeps authorisation-based vendor semantics', () => {
    const f = fixture();
    expect(getApprovalContext(f.approvalId)!.context.vendorHistory).toMatchObject({ status: 'available', isNewVendor: true, recent: [] });
    const denied = submitRequest({ agentId: f.agentId, amount: 12000, currency: 'GBP', vendor: 'acme', purpose: 'Denied budget', rail: 'mcp' });
    expect(denied.decision).toBe('DENIED');
    expect(getApprovalContext(f.approvalId)!.context.vendorHistory).toMatchObject({ isNewVendor: true, recent: [{ decision: 'DENIED' }] });
    submitRequest({ agentId: f.agentId, amount: 100, currency: 'GBP', vendor: 'ACME', purpose: 'Earlier permission', rail: 'mcp' });
    const history = getApprovalContext(f.approvalId)!.context.vendorHistory;
    expect(history).toMatchObject({ status: 'available', isNewVendor: false });
    db.exec('ALTER TABLE ledger RENAME TO unavailable_ledger');
    try { expect(getApprovalContext(f.approvalId)!.context.vendorHistory).toMatchObject({ status: 'unavailable', isNewVendor: null }); }
    finally { db.exec('ALTER TABLE unavailable_ledger RENAME TO ledger'); }
  });
  it('does not expose another agent history and bounds matching activity to five entries', () => {
    const f = fixture(), other = fixture();
    for (let i=0;i<7;i++) submitRequest({ agentId: f.agentId, amount: 1, currency: 'GBP', vendor: 'acme', purpose: `history ${i}`, rail: 'mcp' });
    expect(getApprovalContext(other.approvalId)!.context.vendorHistory).toMatchObject({ recent: [], isNewVendor: true });
    const history = getApprovalContext(f.approvalId)!.context.vendorHistory;
    expect(history).toMatchObject({ status: 'available', truncated: true });
    if (history.status === 'available') expect(history.recent).toHaveLength(5);
  });
  it('matches non-ASCII vendor case consistently in history and known status', () => {
    const f = fixture('hard-stop','café');
    submitRequest({ agentId:f.agentId,amount:100,currency:'GBP',vendor:'CAFÉ',purpose:'Unicode permission',rail:'mcp' });
    expect(getApprovalContext(f.approvalId)!.context.vendorHistory).toMatchObject({ status:'available', isNewVendor:false, recent:[{decision:'ALLOWED',amount:100}] });
  });
  it('blocks legacy recovery approvals and returns unknown IDs without fabricated context', () => {
    const f = fixture();
    db.prepare('UPDATE spend_requests SET reconciliation_required=1 WHERE request_id=?').run(f.requestId);
    const c = getApprovalContext(f.approvalId)!.context;
    expect(c.actions.approve.enabled).toBe(false);
    expect(c.actions.reject.enabled).toBe(false);
    expect(getApprovalContext('missing')).toBeNull();
    expect(approvalQueueContext().pending.find(a => a.id === f.approvalId)?.context.actions.approve.enabled).toBe(false);
  });
});
