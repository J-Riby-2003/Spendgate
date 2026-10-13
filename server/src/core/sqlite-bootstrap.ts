import type { DatabaseSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = 10000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** SQLite may bypass its busy handler for a competing journal-mode lock upgrade. */
export function configureSqlite(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const deadline = performance.now() + BUSY_TIMEOUT_MS;
  while (true) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    db.exec(`PRAGMA busy_timeout = ${remaining}`);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return;
    } catch (error) {
      const code = (error as { errcode?: unknown })?.errcode;
      if (typeof code !== 'number' || (code & 255) !== 5 || performance.now() >= deadline) throw error;
      // Only retry SQLITE_BUSY, within the same startup wait budget. No open transaction is retained.
      Atomics.wait(pause, 0, 0, Math.min(25, Math.max(1, deadline - performance.now())));
    }
  }
}
