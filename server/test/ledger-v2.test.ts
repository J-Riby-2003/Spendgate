import { expect, it, vi } from 'vitest';
vi.hoisted(() => { process.env.TOLLKEEP_DATA = `/tmp/tollkeep-ledger-v2-${Date.now()}-${Math.random()}`; });
import { appendLedger, verifyLedger, ledgerToCsv, computeHash } from '../src/core/ledger.js';
import { store, db } from '../src/core/store.js';
const intent = { id: 'request', agentId: 'agent', amount: 1, currency: 'GBP', vendor: 'vendor', purpose: 'purpose', rail: 'mcp' as const };
it('verifies a mixed historical/new chain and exports all v2 signed fields', () => {
  const old = appendLedger({ intent, decision: 'DENIED', rule: 'rule', decidedBy: 'policy' });
  const entry = appendLedger({ intent: { ...intent, id: 'new' }, decision: 'REJECTED', rule: 'rule', decidedBy: 'human:op',
    details: { actor: { kind: 'operator', id: 'op' }, note: 'reviewed', evidence: { schemaVersion: 1, digest: 'a'.repeat(64) }, budgetRecheck: null } });
  expect(verifyLedger().valid).toBe(true); expect(store.ledgerEntryBySeq(old.seq)?.hash).toBe(old.hash);
  expect(ledgerToCsv(store.fullLedger()).split('\n')[0]).toContain('event_version,details_json');
  expect(ledgerToCsv([entry])).toContain('reviewed');
  expect(computeHash({ ...entry, vendor: 'v|p', purpose: 'x' })).not.toBe(computeHash({ ...entry, vendor: 'v', purpose: 'p|x' }));
  db.prepare('UPDATE ledger SET event_version=1 WHERE seq=?').run(entry.seq);
  expect(verifyLedger().valid).toBe(false);
});
it('does not treat injected version-1 evidence as signed legacy evidence', () => {
  const legacy = appendLedger({ intent: { ...intent, id: 'old-evidence' }, decision: 'DENIED', rule: 'rule', decidedBy: 'policy' });
  expect(() => computeHash({ ...legacy, details: { actor: { kind: 'policy', id: null }, note: 'forged', evidence: { schemaVersion: 1, digest: 'a'.repeat(64) }, budgetRecheck: null } })).toThrow(/legacy/i);
});
