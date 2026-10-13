import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrate, migrations } from '../src/core/migrations.js';
import { withImmediateTransaction } from '../src/core/transactions.js';
it('rolls back a failed migration and applies it exactly once after repair', () => {
  const db = new DatabaseSync(':memory:');
  expect(() => migrate(db, [{ id: 'test_failure', up(db) { db.exec('CREATE TABLE example (id INTEGER)'); throw new Error('failure'); } }])).toThrow('failure');
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='example'").get()).toBeUndefined();
  expect(db.prepare('SELECT * FROM schema_migrations').all()).toHaveLength(0);
  const steps = [{ id: 'test_failure', up(db: DatabaseSync) { db.exec('CREATE TABLE example (id INTEGER); INSERT INTO example VALUES (1)'); } }];
  migrate(db, steps); migrate(db, steps);
  expect(db.prepare('SELECT * FROM example').all()).toHaveLength(1);
  db.close();
});
it('rolls back nested transaction attempts without committing the outer write', () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE example (id INTEGER)');
  expect(() => withImmediateTransaction(db, () => {
    db.exec('INSERT INTO example VALUES (1)');
    withImmediateTransaction(db, () => db.exec('INSERT INTO example VALUES (2)'));
  })).toThrow('Nested transactions');
  expect(db.prepare('SELECT * FROM example').all()).toHaveLength(0);
  withImmediateTransaction(db, () => db.exec('INSERT INTO example VALUES (3)'));
  expect(db.prepare('SELECT id FROM example').get()?.id).toBe(3);
  db.close();
});
it('rejects asynchronous callbacks and rolls back their synchronous writes', () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE example (id INTEGER)');
  expect(() => withImmediateTransaction(db, async () => { db.exec('INSERT INTO example VALUES (1)'); })).toThrow('synchronous');
  expect(db.prepare('SELECT * FROM example').all()).toHaveLength(0); db.close();
});
it('adds identity tables to an existing database without rewriting legacy ledger values', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, migrations.slice(0, 1));
  db.exec("DELETE FROM schema_migrations; INSERT INTO ledger (seq,ts,intent_id,agent_id,amount,currency,vendor,purpose,rail,decision,rule,decided_by,approval_id,prev_hash,hash,signature) VALUES (42, '2020-01-01', 'intent', 'agent', 100, 'GBP', 'vendor', 'purpose', 'mcp', 'ALLOWED', 'rule', 'policy', NULL, 'GENESIS', 'legacy-hash', 'legacy-signature')");
  const before = JSON.stringify(db.prepare('SELECT seq,ts,intent_id,agent_id,amount,currency,vendor,purpose,rail,decision,rule,decided_by,approval_id,prev_hash,hash,signature FROM ledger').all());
  migrate(db); migrate(db);
  expect(JSON.stringify(db.prepare('SELECT seq,ts,intent_id,agent_id,amount,currency,vendor,purpose,rail,decision,rule,decided_by,approval_id,prev_hash,hash,signature FROM ledger').all())).toBe(before);
  expect(db.prepare('SELECT id FROM operators').all()).toHaveLength(0);
  db.close();
});
it('retains ambiguous legacy approvals and orphaned keys without inventing a final event', () => {
  const db = new DatabaseSync(':memory:'); migrate(db, migrations.slice(0, 2));
  const intent = JSON.stringify({ id: 'old-request', agentId: 'old-agent', amount: 10, currency: 'GBP', vendor: 'old', purpose: 'old', rail: 'mcp' });
  db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?)').run('old-approval', intent, 'old-rule', 'old-reason', 'approved', '2020-01-01T00:00:00.000Z', null, null, null);
  db.prepare('INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)').run('old-agent', 'orphan', null, null, null, '2020-01-01T00:00:00.000Z');
  migrate(db);
  expect(db.prepare('SELECT reconciliation_required,ledger_seq FROM spend_requests').get()).toMatchObject({ reconciliation_required: 1, ledger_seq: null });
  expect(db.prepare('SELECT decided_at,decided_by FROM approvals').get()).toMatchObject({ decided_at: null, decided_by: null });
  expect(db.prepare('SELECT request_id FROM idempotency_keys').get()?.request_id).toBeNull();
  expect(db.prepare('SELECT * FROM ledger').all()).toHaveLength(0);
  expect(db.prepare("SELECT * FROM approval_recovery_audit WHERE event='reconciliation-required'").all()).toHaveLength(1);
  db.close();
});
it('flags duplicate legacy ledger outcomes for one approval instead of failing migration or selecting a winner', () => {
  const db = new DatabaseSync(':memory:'); migrate(db, migrations.slice(0, 2));
  const intent = JSON.stringify({ id: 'duplicate-request', agentId: 'old-agent', amount: 10, currency: 'GBP', vendor: 'old', purpose: 'old', rail: 'mcp' });
  db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?)').run('duplicate-approval', intent, 'old-rule', 'old-reason', 'pending', '2020-01-01T00:00:00.000Z', null, null, null);
  for (const [seq, id, decision] of [[1,'duplicate-request','APPROVED'], [2,'different-intent','EXPIRED']] as const) {
    db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(seq, '2020-01-01', id, 'old-agent', 10, 'GBP', 'old', 'old', 'mcp', decision, 'rule', 'actor', 'duplicate-approval', 'GENESIS', 'original-hash', 'original-signature');
  }
  expect(() => migrate(db)).not.toThrow();
  expect(db.prepare('SELECT reconciliation_required FROM spend_requests WHERE request_id=?').get('duplicate-request')?.reconciliation_required).toBe(1);
  expect(db.prepare('SELECT hash FROM ledger').all().map(r => r.hash)).toEqual(['original-hash', 'original-hash']);
  db.close();
});
it('preserves contradictory terminal metadata and flags it for audited reconciliation', () => {
  const db = new DatabaseSync(':memory:'); migrate(db, migrations.slice(0, 5));
  const intent = JSON.stringify({ id: 'conflict-request', agentId: 'agent', amount: 10, currency: 'GBP', vendor: 'old', purpose: 'old', rail: 'mcp' });
  db.prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?)').run('conflict-approval', intent, 'rule', 'reason', 'rejected', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z', 'rejector', 'rejection note');
  db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(1, '2020-01-01T00:00:01.000Z', 'conflict-request', 'agent', 10, 'GBP', 'old', 'old', 'mcp', 'APPROVED', 'rule', 'human:approver', 'conflict-approval', 'GENESIS', 'hash', 'signature');
  migrate(db);
  expect(db.prepare('SELECT status,decided_by,note FROM approvals').get()).toMatchObject({ status: 'rejected', decided_by: 'rejector', note: 'rejection note' });
  expect(db.prepare('SELECT reconciliation_required FROM spend_requests').get()?.reconciliation_required).toBe(1);
  db.close();
});
it('labels existing policies as migration baselines without inventing original actors/times or request evidence', () => {
  const db = new DatabaseSync(':memory:'); migrate(db, migrations.filter(m => !m.id.startsWith('issue06_')));
  const policy = { agentId: 'legacy-policy', allowedDays: '*', budgetMode: 'approval-override' };
  db.prepare('INSERT INTO policies VALUES (?,?)').run(policy.agentId, JSON.stringify(policy));
  const before = Date.now(); migrate(db); migrate(db);
  const row = db.prepare('SELECT * FROM policy_revisions').get()!;
  expect(row).toMatchObject({ agent_id: policy.agentId, version: 1, source: 'migration', changed_by: 'system:migration', before_json: null, after_json: JSON.stringify(policy) });
  expect(Date.parse(String(row.changed_at))).toBeGreaterThanOrEqual(before);
  expect(db.prepare('SELECT * FROM policy_revisions').all()).toHaveLength(1);
  expect(db.prepare('SELECT * FROM policy_evidence').all()).toHaveLength(0);
  db.close();
});
