// Real-agent smoke test: connects to SpendGate over the MCP protocol
// (Streamable HTTP, exactly like Claude Code / any MCP client would) and
// drives every tool the way an autonomous agent would.
//
//   node scripts/agent-smoke.mjs
//
// Expects the server on :8787 (npm run dev -w server).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ENDPOINT = process.env.SPENDGATE_URL ?? 'http://localhost:8787/mcp';
let failures = 0;

function report(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (detail) console.log(detail.split('\n').map((l) => `   ${l}`).join('\n'));
  if (!ok) failures++;
}

const client = new Client({ name: 'spendgate-smoke-agent', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
await client.connect(transport);

// 1. discover tools, like an agent does on connect
const { tools } = await client.listTools();
report(
  'tool discovery',
  tools.map((t) => t.name).join(',') === 'spend,budget_status,audit_ledger',
  tools.map((t) => `• ${t.name} — ${t.description?.split('\n')[0]}`).join('\n'),
);

const call = (name, args) => client.callTool({ name, arguments: args });

// 2. an in-policy spend → should be auto-ALLOWED instantly
const allowed = await call('spend', {
  agent: 'finance-01',
  amount: 500, // £5.00, pence — money is never a float
  currency: 'GBP',
  vendor: 'acme-analytics',
  purpose: 'Real MCP client smoke test — quarterly market dataset',
  rail: 'mcp',
});
const allowedText = allowed.content?.[0]?.text ?? '';
report(
  'in-policy spend auto-allowed',
  !allowed.isError && allowedText.startsWith('ALLOWED'),
  allowedText,
);

// 3. a blocked-vendor spend → should be hard-DENIED
const denied = await call('spend', {
  agent: 'procurement-02',
  amount: 120,
  currency: 'GBP',
  vendor: 'bobs-discount-emporium',
  purpose: 'Smoke test — blocked vendor path',
  rail: 'mcp',
});
const deniedText = denied.content?.[0]?.text ?? '';
report(
  'blocked vendor hard-denied',
  denied.isError === true && deniedText.startsWith('DENIED'),
  deniedText,
);

// 4. unknown agent → default-deny posture
const unknown = await call('spend', {
  agent: 'totally-not-real',
  amount: 100,
  currency: 'GBP',
  vendor: 'acme-analytics',
  purpose: 'Smoke test — unknown agent',
  rail: 'mcp',
});
report('unknown agent rejected', unknown.isError === true, unknown.content?.[0]?.text);

// 5. budget_status — the agent checking its own leash
const budget = await call('budget_status', { agent: 'finance-01' });
report('budget_status', budget.isError !== true, budget.content?.[0]?.text);

// 6. audit_ledger — the agent (or auditor) reading the signed trail
const ledger = await call('audit_ledger', { limit: 5 });
const ledgerText = ledger.content?.[0]?.text ?? '';
report(
  'audit_ledger contains both decisions',
  ledgerText.includes('ALLOWED') && ledgerText.includes('DENIED'),
  ledgerText.split('\n').slice(0, 6).join('\n'),
);

await client.close();
console.log(failures === 0 ? '\nAll checks passed — SpendGate works over real MCP.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
