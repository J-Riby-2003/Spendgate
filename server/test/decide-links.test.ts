// Unit tests for decision links: minting, consumption, single-use,
// expiry and the full engine loop. Isolated temp data dir per run.
import { beforeAll, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  process.env.SPENDGATE_DATA = `/tmp/spendgate-test-links-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.env.SPENDGATE_DATA;
});

import { decide, submitSpend } from '../src/core/engine.js';
import { decideByToken, hashToken, mintDecisionLinks } from '../src/decide-links.js';
import { db, store } from '../src/core/store.js';
import type { Policy } from '../src/core/types.js';

const AGENT = 'links-test';
const POLICY: Policy = {
  agentId: AGENT,
  maxPerTxn: 10_000,
  dailyBudget: 500_000,
  approvalThreshold: 20_000,
  allowedVendors: '*',
  blockedVendors: [],
  newVendorRequiresApproval: false,
  allowedDays: '*',
  allowedWindow: null,
};

beforeAll(() => {
  store.upsertAgent(AGENT, 'Links Test', 'GBP');
  store.upsertPolicy(POLICY);
});

function escalate(purpose: string) {
  return submitSpend({
    agentId: AGENT,
    amount: 25_000,
    currency: 'GBP',
    vendor: 'acme',
    purpose,
    rail: 'mcp',
  });
}

describe('mintDecisionLinks', () => {
  it('mints an approve and a reject link, storing only the hash', async () => {
    const p = escalate('mint test');
    await new Promise((r) => setTimeout(r, 50));
    const approval = store.pendingApprovals().at(-1)!;
    const links = mintDecisionLinks(approval);

    expect(links.map((l) => l.action).sort()).toEqual(['approve', 'reject']);
    expect(links.every((l) => l.path === `/decide/${l.token}`)).toBe(true);

    const stored = store.linksForApproval(approval.id);
    expect(stored).toHaveLength(2);
    for (const link of links) {
      expect(stored.some((s) => s.tokenHash === hashToken(link.token))).toBe(true);
      expect(stored.some((s) => s.tokenHash === link.token)).toBe(false); // raw token never stored
    }
    decide(approval.id, true, 'cleanup');
    await p;
  });
});

describe('decideByToken', () => {
  it('approves via link and records human:decision-link in the ledger', async () => {
    const p = escalate('approve-by-link');
    await new Promise((r) => setTimeout(r, 50));
    const approval = store.pendingApprovals().at(-1)!;
    const link = mintDecisionLinks(approval).find((l) => l.action === 'approve')!;

    const outcome = decideByToken(link.token);
    expect(outcome.decision).toBe('approved');

    const r = await p; // the blocked agent call resolves
    expect(r.decision).toBe('APPROVED');
    const entry = store.ledgerEntryBySeq(r.ledgerSeq)!;
    expect(entry.decidedBy).toBe('human:decision-link');
    expect(entry.approvalId).toBe(approval.id);
  });

  it('rejects via link', async () => {
    const p = escalate('reject-by-link');
    await new Promise((r) => setTimeout(r, 50));
    const approval = store.pendingApprovals().at(-1)!;
    const link = mintDecisionLinks(approval).find((l) => l.action === 'reject')!;

    expect(decideByToken(link.token).decision).toBe('rejected');
    expect((await p).decision).toBe('REJECTED');
  });

  it('a used link refuses a second tap (410)', async () => {
    const p = escalate('double-tap');
    await new Promise((r) => setTimeout(r, 50));
    const approval = store.pendingApprovals().at(-1)!;
    const link = mintDecisionLinks(approval).find((l) => l.action === 'approve')!;

    decideByToken(link.token);
    await p;
    expect(() => decideByToken(link.token)).toThrowError(/already been used/);
  });

  it('the sibling link dies once the approval is decided (409)', async () => {
    const p = escalate('sibling-link');
    await new Promise((r) => setTimeout(r, 50));
    const approval = store.pendingApprovals().at(-1)!;
    const [approve, reject] = mintDecisionLinks(approval);

    decideByToken(approve.token);
    await p;
    expect(() => decideByToken(reject.token)).toThrowError(/already been decided/);
  });

  it('unknown token → 404, expired link → 410', async () => {
    expect(() => decideByToken('nope-nope-nope')).toThrowError(/Unknown decision link/);

    const p = escalate('expired-link');
    await new Promise((r) => setTimeout(r, 50));
    const approval = store.pendingApprovals().at(-1)!;
    const link = mintDecisionLinks(approval).find((l) => l.action === 'approve')!;
    db.prepare('UPDATE approval_links SET expires_at = ? WHERE token_hash = ?')
      .run(new Date(Date.now() - 1000).toISOString(), hashToken(link.token));
    expect(() => decideByToken(link.token)).toThrowError(/expired/);
    decide(approval.id, true, 'cleanup'); // release the waiter
    await p;
  });
});
