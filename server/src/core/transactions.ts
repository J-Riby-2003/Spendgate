import type { DatabaseSync } from 'node:sqlite';

/** Synchronous only. Nested transactions are rejected before BEGIN. */
const active = new WeakSet<DatabaseSync>();
export function withImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
  if (active.has(db)) throw new Error('Nested transactions are not supported');
  db.exec('BEGIN IMMEDIATE');
  active.add(db);
  try {
    const result = callback();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('Transaction callbacks must be synchronous');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    active.delete(db);
  }
}
