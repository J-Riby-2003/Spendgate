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
const credentials = JSON.parse(process.env.SPENDGATE_AGENT_CREDENTIALS ?? '{}');
// per-run nonce so idempotency keys are hermetic across runs
const RUN = Date.now().toString(36);
let failures = 0;

function report(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (detail) console.log(detail.split('\n').map((l) => `   ${l}`).join('\n'));
  if (!ok) failures++;
}

const clients = new Map();
async function clientFor(agentId) {
  if (clients.has(agentId)) return clients.get(agentId);
  if (!credentials[agentId]) throw new Error(`Missing scoped credential for ${agentId}; see docs/access-and-migration.md`);
  const client = new Client({ name: 'spendgate-smoke-agent', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { requestInit: { headers: { Authorization: `Bearer ${credentials[agentId]}` } } }));
  clients.set(agentId, client); return client;
}
const client = await clientFor('finance-01');

// 1. discover tools, like an agent does on connect
const { tools } = await client.listTools();
report(
  'tool discovery',
  tools.map((t) => t.name).join(',') === 'spend,budget_status,audit_ledger',
  tools.map((t) => `• ${t.name} — ${t.description?.split('\n')[0]}`).join('\n'),
);

const call = async (name, args) => (await clientFor(args.agent === 'procurement-02' ? 'procurement-02' : 'finance-01')).callTool({ name, arguments: args }, undefined, { timeout: 330_000 });

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
  'audit_ledger is restricted to the authenticated agent',
  ledgerText.includes('finance-01') && !ledgerText.includes('procurement-02'),
  ledgerText.split('\n').slice(0, 6).join('\n'),
);

// 7. idempotency — same key twice must not spend twice
const IDEM = { agent: 'finance-01', amount: 100, currency: 'GBP', vendor: 'acme-analytics', purpose: 'Idempotency test', rail: 'mcp', idempotencyKey: `smoke-idem-1-${RUN}` };
const first = await call('spend', IDEM);
const second = await call('spend', IDEM);
const seq1 = first.content?.[0]?.text?.match(/ledger:\s+#(\d+)/)?.[1];
const seq2 = second.content?.[0]?.text?.match(/ledger:\s+#(\d+)/)?.[1];
report(
  'idempotent retry returns original decision',
  !first.isError && !second.isError && seq1 != null && seq1 === seq2,
  `first → ledger #${seq1}, retry → ledger #${seq2} (same = no double spend)`,
);

// 8. idempotent deny replay
const IDEM_DENY = { agent: 'procurement-02', amount: 50, currency: 'GBP', vendor: 'bobs-discount-emporium', purpose: 'Idempotency deny test', rail: 'mcp', idempotencyKey: `smoke-idem-deny-${RUN}` };
await call('spend', IDEM_DENY);
const denyReplay = await call('spend', IDEM_DENY);
const denySeq = denyReplay.content?.[0]?.text?.match(/ledger:\s+#(\d+)/)?.[1];
report(
  'denied intent also replays (same ledger seq)',
  denyReplay.isError === true && denySeq != null,
  denyReplay.content?.[0]?.text,
);

// 9. duplicate key while escalation is pending → rejected, no second escalation
const IDEM_ESC = { agent: 'procurement-02', amount: 90000, currency: 'GBP', vendor: 'paper-mill-co', purpose: 'Idempotency escalation test', rail: 'mcp', idempotencyKey: `smoke-idem-esc-${RUN}` };
const escPromise = call('spend', IDEM_ESC).then((r) => r).catch((e) => e);
await new Promise((r) => setTimeout(r, 400)); // let the first call reach the queue
const dupWhilePending = await call('spend', IDEM_ESC);
const dupText = dupWhilePending.content?.[0]?.text ?? '';
report(
  'duplicate during pending escalation rejected (409)',
  dupWhilePending.isError === true && dupText.includes('409'),
  dupText.split('\n')[0],
);

console.log('Approve the Idempotency escalation test in the operator console; the agent has no operator credentials.');
const escResult = await escPromise;
const escText = escResult?.content?.[0]?.text ?? '';
report(
  'original escalation resolved by human decision',
  escText.startsWith('APPROVED'),
  escText.split('\n')[0],
);

// 10. retry AFTER the escalation settled → replays the approved outcome
const escReplay = await call('spend', IDEM_ESC);
const escReplayText = escReplay.content?.[0]?.text ?? '';
report(
  'post-decision retry replays approved outcome',
  !escReplay.isError && escReplayText.startsWith('APPROVED'),
  escReplayText.split('\n')[0],
);

for (const connection of clients.values()) await connection.close();
console.log(failures === 0 ? '\nAll checks passed — SpendGate works over real MCP.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
