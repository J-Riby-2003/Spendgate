// Demo agent: drives the SpendGate MCP server through every decision path.
// Run with: npm run demo   (server must be running — `npm run dev -w server`)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.SPENDGATE_URL ?? 'http://localhost:8787';
const AUTO_APPROVE_AFTER_MS = 8000;

const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
const client = new Client({ name: 'demo-agent', version: '0.1.0' });
await client.connect(transport);

console.log('Connected to SpendGate MCP. Running scenarios…\n');

async function spend(args: {
  agent: string; amount: number; currency: string; vendor: string; purpose: string; rail: string;
}, label: string) {
  console.log(`▶ ${label}`);
  const call = client.callTool({ name: 'spend', arguments: args });
  // For escalations, pretend to be the human: approve via the console API after a beat,
  // matching the pending approval by agent + vendor + amount.
  const timer = setTimeout(async () => {
    try {
      const res = await fetch(`${BASE}/api/approvals`);
      const data = await res.json() as { pending: { id: string; intent: { agentId: string; vendor: string; amount: number } }[] };
      const match = data.pending.find((p) =>
        p.intent.agentId === args.agent && p.intent.vendor === args.vendor && p.intent.amount === args.amount);
      if (match) {
        console.log('  …a human (the demo script) approved it in the console');
        await fetch(`${BASE}/api/approvals/${match.id}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approve: true, by: 'james (demo)' }),
        });
      }
    } catch { /* approval may already be resolved */ }
  }, AUTO_APPROVE_AFTER_MS);
  const res = await call;
  clearTimeout(timer);
  const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
  console.log(text.split('\n').map((l) => `  ${l}`).join('\n'));
  console.log();
}

// 1. Finance agent, trusted profile — should auto-allow.
await spend({
  agent: 'finance-01', amount: 118000, currency: 'GBP',
  vendor: 'acme-analytics', purpose: 'Quarterly market dataset', rail: 'mpp',
}, 'Scenario 1 — finance-01 buys £1,180 (trusted profile, expect ALLOWED)');

// 2. Procurement over its £200 threshold — should escalate, then the demo "human" approves.
await spend({
  agent: 'procurement-02', amount: 21400, currency: 'GBP',
  vendor: 'paper-mill-co', purpose: 'Bulk printer paper restock', rail: 'x402',
}, 'Scenario 2 — procurement-02 buys £214 (over approval threshold, expect ESCALATE → human approves)');

// 3. Procurement way over its £50 per-tx max — hard deny.
await spend({
  agent: 'procurement-02', amount: 90000, currency: 'GBP',
  vendor: 'paper-mill-co', purpose: 'Emergency restock (way over limit)', rail: 'x402',
}, 'Scenario 3 — procurement-02 tries £900 (over per-tx ceiling, expect ESCALATE → human approves)');

// 4. Crawler hits a brand-new vendor — escalate on new-vendor rule.
await spend({
  agent: 'crawler-01', amount: 410, currency: 'USD',
  vendor: 'scrapebox-api', purpose: 'Page-render credits', rail: 'x402',
}, 'Scenario 4 — crawler-01 pays new vendor $4.10 (expect ESCALATE → human approves)');

// 5. Blocked vendor — hard deny regardless of amount.
await spend({
  agent: 'procurement-02', amount: 1200, currency: 'GBP',
  vendor: 'bobs-discount-emporium', purpose: 'Suspiciously cheap toner', rail: 'card',
}, 'Scenario 5 — procurement-02 tries a blocked vendor (expect DENIED)');

console.log('Done. Open the dashboard to see the ledger: every decision above is hash-chained and signed.');
await client.close();
process.exit(0);
