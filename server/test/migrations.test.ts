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
  db.exec("DELETE FROM schema_migrations; INSERT INTO ledger VALUES (42, '2020-01-01', 'intent', 'agent', 100, 'GBP', 'vendor', 'purpose', 'mcp', 'ALLOWED', 'rule', 'policy', NULL, 'GENESIS', 'legacy-hash', 'legacy-signature')");
  const before = JSON.stringify(db.prepare('SELECT * FROM ledger').all());
  migrate(db); migrate(db);
  expect(JSON.stringify(db.prepare('SELECT * FROM ledger').all())).toBe(before);
  expect(db.prepare('SELECT id FROM operators').all()).toHaveLength(0);
  db.close();
});
