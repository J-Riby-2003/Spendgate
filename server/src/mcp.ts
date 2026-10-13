import { assertAgentActive, AuthError, type AgentPrincipal } from './auth.js';
// MCP server: this is what agents actually talk to.
// One tool is the product: `spend` — route a payment intent through policy.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { submitRequest, waitForRequest, getRequest, EngineError, type RequestSnapshot } from './core/engine.js';
import { budget } from './core/budget-state.js';
import { BudgetError } from './core/budget.js';
import { store } from './core/store.js';
import { checkConnection, testJourneyAsAgent } from './core/onboarding.js';
import { OnboardingError } from './core/onboarding-store.js';
import { InputError } from './core/sanitize.js';
import { formatMinor } from './core/money.js';

export function buildMcpServer(principal: AgentPrincipal, connectionSignal?: AbortSignal): McpServer {
  function scopedAgent(supplied?: string): string {
    assertAgentActive(principal);
    if (supplied !== undefined && supplied !== principal.agentId) throw new AuthError('Agent identity mismatch', 403);
    return principal.agentId;
  }
  function response(result: RequestSnapshot) {
    return { isError: !['ALLOWED', 'APPROVED', 'PENDING'].includes(result.decision),
      structuredContent: { ...result },
      content: [{ type: 'text' as const, text: [
        `${result.decision} — ${result.reason}`, `  request: ${result.requestId}`,
        `  accounting: authorised permission is not proof of payment`,
        `  agent: ${result.intent.agentId}`, `  amount: ${formatMinor(result.intent.amount, result.intent.currency)}`,
        `  vendor: ${result.intent.vendor}`, `  rail: ${result.intent.rail}`, `  rule: ${result.rule}`,
        result.decision === 'PENDING' ? `  expires: ${result.expiresAt}; resume with spend_status(requestId)` : `  decided: ${result.decidedBy}`,
        result.ledgerSeq == null ? `  approval: ${result.approvalId}` : `  ledger: #${result.ledgerSeq}${result.approvalId ? ` (approval ${result.approvalId})` : ''}`,
      ].join('\n') }] };
  }
  function failure(err: unknown) {
    const status = err instanceof InputError ? 422 : err instanceof OnboardingError || err instanceof EngineError || err instanceof AuthError || err instanceof BudgetError ? err.status : 500;
    const message = status === 500 ? 'Internal request error' : (err as Error).message;
    return { isError: true, content: [{ type: 'text' as const, text: `SpendGate error (${status}): ${message}` }] };
  }
  const server = new McpServer(
    { name: 'spendgate', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.tool('connection_check', 'Verify this scoped agent credential against the one-time challenge shown in the onboarding console. Does not submit a spend.', {
    challenge: z.string().min(1).max(128),
  }, async ({ challenge }) => {
    try {
      const result = checkConnection(principal, challenge);
      return { structuredContent: result, content: [{ type: 'text', text: `Connection verified for ${result.agentId}. Own-agent permissions confirmed. Return to onboarding and check connection status.` }] };
    } catch (err) { return failure(err); }
  });
  server.tool('onboarding_test', 'Safe onboarding simulation only. Uses saved policy plus labelled unsaved illustrative fixtures. Never creates payments, approvals, reservations or production ledger entries.', {
    onboardingId: z.string().uuid().describe('Onboarding journey ID from the console'),
    sample: z.object({ amount: z.number().int().positive().max(1e12), currency: z.string(), vendor: z.string().min(1).max(120), purpose: z.string().min(1).max(280), rail: z.enum(['x402','mpp','ap2','acp','card','stablecoin','mcp']).default('mcp') }),
  }, async ({ onboardingId, sample }) => {
    try {
      const result = testJourneyAsAgent(onboardingId, principal, sample);
      return { structuredContent: result, content: [{ type: 'text', text: `SIMULATION — ${result.saved.verdict.decision}: ${result.saved.verdict.reason}\n${result.fixtureNotice}\n${result.nextAction}` }] };
    } catch (err) { return failure(err); }
  });

  server.tool(
    'spend',
    `Route a payment intent through SpendGate policy. Returns the decision: ALLOWED, DENIED, APPROVED or REJECTED.
- Blocked vendors and hard-stop budget overruns are denied instantly.
- Ambiguous cases escalate to a human. Blocking remains the default; deferred=true returns PENDING and a durable requestId immediately.
- Permission reserves funds; only verified settlement records completed spend.`,
    {
      agent: z.string().min(1).max(64).optional().describe('Agent id registered in SpendGate, e.g. "procurement-02"'),
      amount: z.number().int().positive().max(1e12).describe('Amount in minor units (pence/cents) — money is never a float'),
      currency: z.string().regex(/^[A-Za-z]{3}$/).describe('ISO 4217, e.g. GBP, USD'),
      vendor: z.string().min(1).max(120).describe('Who gets paid'),
      purpose: z.string().min(1).max(280).describe('What this payment is for'),
      rail: z.enum(['x402', 'mpp', 'ap2', 'acp', 'card', 'stablecoin', 'mcp']).default('mcp').describe('Payment rail'),
      deferred: z.boolean().default(false).describe('Return a durable PENDING request immediately; retrieve its outcome with spend_status.'),
      idempotencyKey: z.string().min(1).max(128).optional().describe(
        'Client-generated unique key for this payment intent. Safe to retry: a duplicate key returns the original decision without spending again.',
      ),
    },
    async (args, extra) => {
      try {
        const agentId = scopedAgent(args.agent);
        const initial = submitRequest({ ...args, agentId });
        const signal = connectionSignal ? AbortSignal.any([connectionSignal, extra.signal]) : extra.signal;
        const result = !args.deferred && initial.decision === 'PENDING'
          ? await waitForRequest(agentId, initial.requestId, { signal, maxWaitMs: 604800100 }) : initial;
        scopedAgent(args.agent);
        return response(result);
      } catch (err) { return failure(err); }
    },
  );

  server.tool('spend_status', 'Read or resume your own durable request. PENDING is not authorisation to execute.', {
    requestId: z.string().uuid(),
    waitMs: z.number().int().min(0).max(30000).default(0).describe('Optionally wait up to 30 seconds for a final outcome.'),
  }, async ({ requestId, waitMs }, extra) => {
    try {
      const agentId = scopedAgent();
      const signal = connectionSignal ? AbortSignal.any([connectionSignal, extra.signal]) : extra.signal;
      const result = waitMs ? await waitForRequest(agentId, requestId, { signal, maxWaitMs: waitMs }) : getRequest(agentId, requestId);
      scopedAgent();
      return response(result);
    } catch (err) { return failure(err); }
  });

  server.tool(
    'budget_status',
    'Check an agent\'s remaining daily budget and recent ledger entries.',
    {
      agent: z.string().optional().describe('Agent id; must match credential'),
    },
    async ({ agent: supplied }) => {
      let agent: string;
      try { agent = scopedAgent(supplied); } catch { return { isError: true, content: [{ type: 'text', text: 'Unauthorized or agent identity mismatch' }] }; }
      const policy = store.getPolicy(agent);
      if (!policy) {
        return { isError: true, content: [{ type: 'text', text: `Unknown agent "${agent}".` }] };
      }
      const snapshot = budget.getBudgetSnapshot(agent);
      const recent = store.ledgerForAgent(agent, 5);
      return {
        content: [{
          type: 'text',
          text: [
            `Agent: ${agent}`,
            `Budget mode: ${snapshot.mode}`,
            `Period: ${snapshot.periodStart} to ${snapshot.periodEnd} (UTC)`,
            `Completed spend: ${formatMinor(snapshot.spentMinor, snapshot.currency)}`,
            `Reserved: ${formatMinor(snapshot.reservedMinor, snapshot.currency)}`,
            snapshot.remainingMinor != null ? `Remaining budget: ${formatMinor(snapshot.remainingMinor, snapshot.currency)}` : 'Daily budget: unlimited',
            snapshot.reconciliationRequired ? 'Legacy obligations require operator reconciliation before authorisation.' : '',
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
    async ({ agent: supplied, limit }) => {
      let agent: string;
      try { agent = scopedAgent(supplied); } catch { return { isError: true, content: [{ type: 'text', text: 'Unauthorized or agent identity mismatch' }] }; }
      const entries = store.ledgerForAgent(agent, limit);
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
