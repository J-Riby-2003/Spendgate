import { db, store, withImmediateTransaction } from './store.js';
import { budget } from './budget-state.js';
import { BudgetError } from './budget.js';
import { parseIntent, parsePolicy, intentDigest } from './policy-input.js';
import { PolicyConflict } from './policy-history.js';
import { encodeEvidence, evaluateContext, EVALUATOR_VERSION, type PolicyEvidenceEnvelope, type EvidenceContext } from './policy-evidence.js';
import { computeHash, sign } from './ledger.js';
import { InputError } from './sanitize.js';
import type { EvalResult } from './policy.js';
import type { Policy, SpendIntent } from './types.js';

export const SIMULATION_ASSUMPTIONS = 'UTC time and daily periods. Pending approvals reserve nothing. Known vendor means prior authorisation, not completed payment. Each comparison holds the original pre-request budget, time, currency and vendor-history context fixed; it does not simulate downstream changes. Historical replay is not a guarantee of future outcomes. No payments, approvals, reservations or ledger entries are created.';
export function requireVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new InputError('expectedVersion must be a positive integer.');
  return Number(value);
}
function currentPolicy(agentId: string): Policy {
  const policy = store.getPolicy(agentId);
  if (!policy) throw new BudgetError('Unknown agent or missing policy.', 404);
  return policy;
}
function ensureAvailable(agentId: string, context: EvidenceContext): void {
  if (context.budget.reconciliationRequired || db.prepare('SELECT 1 FROM spend_requests WHERE agent_id=? AND reconciliation_required=1 LIMIT 1').get(agentId)) throw new BudgetError('Legacy obligations or requests require operator reconciliation before evaluation.');
}
/** Read-only BEGIN IMMEDIATE supplies one consistent policy/accounting snapshot across processes. */
export function preview(agentId: string, proposed: unknown, sample: unknown) {
  return withImmediateTransaction(() => {
    const current = currentPolicy(agentId);
    const policy = parsePolicy(agentId, proposed, current.budgetMode);
    const intent = parseIntent(agentId, sample, 'simulation');
    const now = new Date(), snapshot = budget.getBudgetSnapshot(agentId, now);
    if (intent.currency !== snapshot.currency) throw new InputError('Request currency must match the configured agent currency.');
    const context: EvidenceContext = { agentCurrency: snapshot.currency, budget: snapshot, vendorKnown: store.knownVendors(agentId).has(intent.vendor.toLowerCase()) };
    ensureAvailable(agentId, context);
    return { verdict: evaluateContext(policy, intent, context, now), context, evaluatedAt: now.toISOString(),
      evaluatorVersion: EVALUATOR_VERSION, currentVersion: store.getPolicyVersion(agentId), assumptions: SIMULATION_ASSUMPTIONS };
  });
}
export interface EvidenceView {
  integrity: 'verified' | 'invalid'; digest: string; envelope: PolicyEvidenceEnvelope | null;
}
/** Compare stored envelope to both its persisted digest and original durable/signed reference. */
export function requestEvidence(requestId: string): EvidenceView | null {
  const row = db.prepare('SELECT * FROM policy_evidence WHERE request_id=?').get(requestId);
  if (!row) return null;
  try {
    const encoded = encodeEvidence(JSON.parse(String(row.envelope_json)));
    const request = db.prepare('SELECT evidence_json,intent_json,ledger_seq FROM spend_requests WHERE request_id=?').get(requestId);
    const reference = request?.evidence_json ? JSON.parse(String(request.evidence_json)) : null;
    const intent = request ? JSON.parse(String(request.intent_json)) : null;
    const entry = request?.ledger_seq != null ? store.ledgerEntryBySeq(Number(request.ledger_seq)) : null;
    if (request?.ledger_seq != null) {
      if (!entry || entry.eventVersion !== 2 || entry.intentId !== requestId || computeHash(entry) !== entry.hash || sign(entry.hash) !== entry.signature ||
        intentDigest({ id: entry.intentId, agentId: entry.agentId, amount: entry.amount, currency: entry.currency, vendor: entry.vendor, purpose: entry.purpose, rail: entry.rail }) !== encoded.envelope.intentDigest) throw new Error('Signed intent mismatch');
    }
    const signedReference = entry ? entry.details?.evidence : reference;
    const revision = intent && db.prepare('SELECT 1 FROM policy_revisions WHERE agent_id=? AND version=?').get(intent.agentId, encoded.envelope.policyVersion);
    if (!intent || intent.id !== requestId || intentDigest(intent) !== encoded.envelope.intentDigest || row.schema_version !== 1 || encoded.digest !== row.digest || reference?.digest !== row.digest || reference?.schemaVersion !== 1 ||
      signedReference?.digest !== row.digest || signedReference?.schemaVersion !== 1 || !revision || encoded.envelope.context.budget.agentId !== intent?.agentId || encoded.envelope.context.agentCurrency !== intent?.currency) throw new Error('Evidence mismatch');
    return { integrity: 'verified', digest: encoded.digest, envelope: encoded.envelope };
  } catch { return { integrity: 'invalid', digest: String(row.digest), envelope: null }; }
}
export interface ReplayRow { requestId: string; original: EvalResult; current: EvalResult; proposed: EvalResult; evaluatedAt: string; policyVersion: number }
export function replay(agentId: string, proposed: unknown, expectedVersion: unknown, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new InputError('Replay limit must be an integer from 1 to 500.');
  const version = requireVersion(expectedVersion);
  return withImmediateTransaction(() => {
    const current = currentPolicy(agentId);
    if (store.getPolicyVersion(agentId) !== version) throw new PolicyConflict();
    const policy = parsePolicy(agentId, proposed, current.budgetMode);
    const agentCurrency = store.listAgents().find(a => a.agentId === agentId)!.currency;
    // rowid orders first submissions, never finalisation/lifecycle events; each durable request appears once.
    const samples = db.prepare('SELECT request_id,intent_json,reconciliation_required FROM spend_requests WHERE agent_id=? ORDER BY rowid DESC LIMIT ?').all(agentId, limit);
    const rows: ReplayRow[] = [], unavailable: { requestId: string; reason: string }[] = [];
    const transitions: Record<string, number> = {};
    for (const sample of samples) {
      const requestId = String(sample.request_id), evidence = requestEvidence(requestId);
      if (sample.reconciliation_required || !evidence || evidence.integrity !== 'verified' || !evidence.envelope || evidence.envelope.evaluatorVersion !== EVALUATOR_VERSION) {
        unavailable.push({ requestId, reason: sample.reconciliation_required ? 'Requires reconciliation' : !evidence ? 'Original context unavailable' : 'Evidence invalid or evaluator version unsupported' }); continue;
      }
      const original = evidence.envelope, intent = JSON.parse(String(sample.intent_json)) as SpendIntent;
      if (intent.currency !== agentCurrency || intent.currency !== original.context.agentCurrency) { unavailable.push({ requestId, reason: 'Historical currency context mismatch' }); continue; }
      const now = new Date(original.evaluatedAt);
      const a = evaluateContext(current, intent, original.context, now), b = evaluateContext(policy, intent, original.context, now);
      transitions[`${a.decision} → ${b.decision}`] = (transitions[`${a.decision} → ${b.decision}`] ?? 0) + 1;
      rows.push({ requestId, original: original.verdict, current: a, proposed: b, evaluatedAt: original.evaluatedAt, policyVersion: original.policyVersion });
    }
    return { currentVersion: version, coverage: { selected: samples.length, evaluated: rows.length, unavailable: unavailable.length },
      changedOutcomes: rows.filter(r => r.current.decision !== r.proposed.decision).length,
      changedReasons: rows.filter(r => r.current.rule !== r.proposed.rule || r.current.reason !== r.proposed.reason).length,
      transitions, rows, unavailable, assumptions: SIMULATION_ASSUMPTIONS };
  });
}
