// MCP server: this is what agents actually talk to.
// One tool is the product: `spend` — route a payment intent through policy.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { submitSpend, EngineError } from './core/engine.js';
import { store } from './core/store.js';
import { formatMinor } from './core/money.js';

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'spendgate', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.tool(
    'spend',
    `Route a payment intent through SpendGate policy. Returns the decision: ALLOWED, DENIED, APPROVED or REJECTED.
- Hard violations (blocked vendor, over per-tx max) are denied instantly.
- Ambiguous cases (over approval threshold, new vendor, over budget, off-hours) escalate to a human and block until decided.
- Every intent lands in the signed audit ledger regardless of outcome.`,
    {
      agent: z.string().min(1).max(64).describe('Agent id registered in SpendGate, e.g. "procurement-02"'),
      amount: z.number().int().positive().max(1e12).describe('Amount in minor units (pence/cents) — money is never a float'),
      currency: z.string().regex(/^[A-Za-z]{3}$/).describe('ISO 4217, e.g. GBP, USD'),
      vendor: z.string().min(1).max(120).describe('Who gets paid'),
      purpose: z.string().min(1).max(280).describe('What this payment is for'),
      rail: z.enum(['x402', 'mpp', 'ap2', 'acp', 'card', 'stablecoin', 'mcp']).default('mcp').describe('Payment rail'),
    },
    async (args) => {
      try {
        const result = await submitSpend({ ...args, agentId: args.agent });
        const ok = result.decision === 'ALLOWED' || result.decision === 'APPROVED';
        return {
          isError: !ok,
          content: [{
            type: 'text',
            text: [
              `${result.decision} — ${result.reason}`,
              `  agent:   ${result.intent.agentId}`,
              `  amount:  ${formatMinor(result.intent.amount, result.intent.currency)}`,
              `  vendor:  ${result.intent.vendor}`,
              `  rail:    ${result.intent.rail}`,
              `  rule:    ${result.rule}`,
              `  decided: ${result.decidedBy}`,
              `  ledger:  #${result.ledgerSeq}${result.approvalId ? ` (approval ${result.approvalId})` : ''}`,
            ].join('\n'),
          }],
        };
      } catch (err) {
        const msg = err instanceof EngineError ? err.message : String(err);
        const status = err instanceof EngineError ? err.status : 500;
        return { isError: true, content: [{ type: 'text', text: `SpendGate error (${status}): ${msg}` }] };
      }
    },
  );

  server.tool(
    'budget_status',
    'Check an agent\'s remaining daily budget and recent ledger entries.',
    {
      agent: z.string().describe('Agent id'),
    },
    async ({ agent }) => {
      const policy = store.getPolicy(agent);
      if (!policy) {
        return { isError: true, content: [{ type: 'text', text: `Unknown agent "${agent}".` }] };
      }
      const spent = store.spentToday(agent);
      const remaining = policy.dailyBudget != null ? Math.max(0, policy.dailyBudget - spent) : null;
      const recent = store.ledgerForAgent(agent, 5);
      return {
        content: [{
          type: 'text',
          text: [
            `Agent: ${agent}`,
            `Spent today: ${formatMinor(spent, 'GBP')}`, // prototype: report in policy-agnostic form on the ledger page
            remaining != null ? `Remaining budget: ${formatMinor(remaining, 'GBP')}` : 'Daily budget: unlimited',
            '',
            'Recent ledger entries:',
            ...recent.map((e) => `  #${e.seq} ${e.decision.padEnd(8)} ${e.vendor} — ${e.rule}`),
          ].join('\n'),
        }],
      };
    },
  );

  server.tool(
    'audit_ledger',
    'Read the signed audit ledger. Every intent, decision and mandate — hash-chained.',
    {
      agent: z.string().optional().describe('Filter by agent id'),
      limit: z.number().int().positive().max(200).default(20),
    },
    async ({ agent, limit }) => {
      const entries = agent ? store.ledgerForAgent(agent, limit) : store.recentLedger(limit);
      return {
        content: [{
          type: 'text',
          text: entries.length === 0
            ? 'Ledger is empty.'
            : entries.map((e) =>
                `#${e.seq} ${e.ts} ${e.decision.padEnd(8)} ${e.agentId} ${e.vendor} ${e.amount} ${e.currency} rule=${e.rule} by=${e.decidedBy} hash=${e.hash.slice(0, 16)}…`,
              ).join('\n'),
        }],
      };
    },
  );

  return server;
}
