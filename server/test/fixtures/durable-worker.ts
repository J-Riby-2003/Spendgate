// Independent OS process: each invocation opens the same SQLite file afresh.
import { createInterface } from 'node:readline';
import { store, db } from '../../src/core/store.js';
import { submitRequest, getRequest, decide, expireStale } from '../../src/core/engine.js';
import { budget } from '../../src/core/budget-state.js';
import { verifyLedger } from '../../src/core/ledger.js';
import { deliverNotifications } from '../../src/notify.js';
const lines = createInterface({ input: process.stdin });
process.stdout.write('ready\n');
for await (const line of lines) {
  const command = JSON.parse(line);
  try {
    let result: unknown;
    if (command.action === 'submit') {
      if (!store.getPolicy('restart')) {
        store.upsertAgent('restart', 'Restart', 'GBP');
        store.upsertPolicy({ agentId: 'restart', maxPerTxn: 50, dailyBudget: 1000, budgetMode: 'hard-stop', approvalThreshold: null, allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null });
      }
      result = submitRequest({ agentId: 'restart', amount: 60, currency: 'GBP', vendor: 'acme', purpose: 'process restart', rail: 'mcp', idempotencyKey: command.key });
    } else if (command.action === 'get') result = getRequest('restart', command.requestId);
    else if (command.action === 'decide') result = decide(command.approvalId, command.approve, 'process-operator', 'Process review');
    else if (command.action === 'expire') { expireStale(); result = true; }
    else if (command.action === 'inspect') result = { ledger: store.fullLedger(), verify: verifyLedger(), budget: budget.getBudgetSnapshot('restart') };
    else if (command.action === 'notify') {
      let sends = 0;
      await deliverNotifications({ name: 'process-test', async send() { sends++; } });
      result = { sends, jobs: db.prepare('SELECT * FROM notification_outbox').all() };
    }
    process.stdout.write(JSON.stringify({ result }) + '\n');
    if (command.crash) await new Promise(() => setInterval(() => {}, 1000));
  } catch (error) { process.stdout.write(JSON.stringify({ error: (error as Error).message }) + '\n'); }
  break;
}
lines.close(); db.close();
