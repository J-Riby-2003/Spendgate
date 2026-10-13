// Only invoked by the isolated browser suite: simulate one migrated approval-only row.
import { db, store, withImmediateTransaction } from '../../src/core/store.js';
import { appendLedger } from '../../src/core/ledger.js';
withImmediateTransaction(() => {
  store.upsertAgent('legacy-browser', 'Legacy browser', 'GBP');
  store.upsertPolicy({ agentId: 'legacy-browser', dailyBudget: 10000, budgetMode: 'approval-override', maxPerTxn: 10000, approvalThreshold: null, allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null });
  const entry = appendLedger({ intent: { id: 'legacy-browser-intent', agentId: 'legacy-browser', amount: 1250, currency: 'GBP', vendor: 'old-acme', purpose: 'Legacy execution unknown', rail: 'mcp' }, decision: 'ALLOWED', rule: 'within-policy', decidedBy: 'policy' });
  db.prepare('INSERT INTO legacy_budget_obligations (ledger_seq, agent_id) VALUES (?, ?)').run(entry.seq, entry.agentId);
});
db.close();
