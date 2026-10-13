import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { migrate } from '../src/core/migrations.js';
import { createBudgetStore } from '../src/core/budget.js';
import { withImmediateTransaction } from '../src/core/transactions.js';
it('serialises independent processes and recovers persisted holds after closing and reopening the database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spendgate-budget-race-')), path = join(dir, 'test.db');
  const setup = new DatabaseSync(path); setup.exec('PRAGMA journal_mode = WAL'); migrate(setup);
  setup.exec(`INSERT INTO agents VALUES ('a','A','GBP'); INSERT INTO policies VALUES ('a','{"dailyBudget":10000,"budgetMode":"hard-stop"}')`); setup.close();
  const children = ['one','two'].map(id => fork(fileURLToPath(new URL('./fixtures/budget-writer.ts', import.meta.url)), [path, id], { execArgv: ['--import', 'tsx'], stdio: ['ignore','ignore','pipe','ipc'] }));
  try {
    await Promise.all(children.map(async c => { const [ready] = await once(c, 'message'); expect(ready).toBe('ready'); }));
    const outcomes = children.map(c => once(c, 'message'));
    const exits = children.map(c => once(c, 'exit'));
    children.forEach(c => c.send('start'));
    const values = (await Promise.all(outcomes)).map(v => v[0]);
    expect(values.filter(v => v === 'reserved')).toHaveLength(1);
    expect(values.filter(v => typeof v === 'object' && /funds/i.test(v.error))).toHaveLength(1);
    await Promise.all(exits);
    const restarted = new DatabaseSync(path), budget = createBudgetStore(restarted);
    expect(budget.getBudgetSnapshot('a', new Date('2026-10-14T00:01:00Z'))).toMatchObject({ spentMinor: 0, reservedMinor: 7000, remainingMinor: 3000 });
    const requestId = String(restarted.prepare('SELECT request_id FROM budget_reservations').get()!.request_id);
    withImmediateTransaction(restarted, () => budget.releaseReservation(requestId, 'failure-after-restart', 'failed', new Date('2026-10-14T00:02:00Z')));
    withImmediateTransaction(restarted, () => budget.releaseReservation(requestId, 'failure-after-restart', 'failed', new Date('2026-10-14T00:03:00Z')));
    expect(budget.getBudgetSnapshot('a').reservedMinor).toBe(0); restarted.close();
  } finally { children.forEach(c => c.kill()); rmSync(dir, { recursive: true, force: true }); }
}, 15000);
