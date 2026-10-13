import { DatabaseSync } from 'node:sqlite';
import { createBudgetStore } from '../../src/core/budget.js';
import { withImmediateTransaction } from '../../src/core/transactions.js';
const db = new DatabaseSync(process.argv[2]); db.exec('PRAGMA busy_timeout = 10000');
const budget = createBudgetStore(db);
process.send!('ready');
process.once('message', () => {
  try {
    withImmediateTransaction(db, () => budget.reserveBudget({ requestId: process.argv[3], agentId: 'a', amountMinor: 7000, currency: 'GBP', expiresAt: '2026-10-14T01:00:00Z' }, new Date('2026-10-13T23:59:00Z')));
    process.send!('reserved');
  } catch (error) { process.send!({ error: (error as Error).message }); }
  db.close(); process.disconnect();
});
