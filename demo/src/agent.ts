// Demo agent: drives the SpendLock MCP server through every decision path.
// Run with: npm run demo   (server must be running — `npm run dev -w server`)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.SPENDGATE_URL ?? 'http://localhost:8787';
const credentials: Record<string, string> = JSON.parse(process.env.SPENDGATE_AGENT_CREDENTIALS ?? '{}');
const clients = new Map<string, Client>();
async function clientFor(agentId: string): Promise<Client> {
  const existing = clients.get(agentId);
  if (existing) return existing;
  const credential = credentials[agentId];
  if (!credential) throw new Error(`Issue a scoped credential for ${agentId} and set SPENDGATE_AGENT_CREDENTIALS. See docs/access-and-migration.md.`);
  const client = new Client({ name: 'demo-agent', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }));
  clients.set(agentId, client);
  return client;
}
console.log('Running scoped-agent scenarios. Decide escalations in the operator console.\n');

async function spend(args: {
  agent: string; amount: number; currency: string; vendor: string; purpose: string; rail: string;
}, label: string) {
  console.log(`▶ ${label}`);
  const client = await clientFor(args.agent);
  const res = await client.callTool({ name: 'spend', arguments: args }, undefined, { timeout: 330_000 });
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
for (const client of clients.values()) await client.close();
process.exit(0);
