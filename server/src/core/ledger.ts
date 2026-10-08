// The audit ledger: append-only, hash-chained, HMAC-signed.
// Tampering with any row breaks the chain on verify — that is the product.
import { createHash, createHmac } from 'node:crypto';
import type { LedgerDecision, LedgerEntry, SpendIntent } from './types.js';
import { store, SECRET } from './store.js';

const GENESIS = 'GENESIS';

function canonical(e: Omit<LedgerEntry, 'hash' | 'signature'>): string {
  return [
    e.seq, e.ts, e.intentId, e.agentId, e.amount, e.currency, e.vendor,
    e.purpose, e.rail, e.decision, e.rule, e.decidedBy, e.approvalId ?? '',
    e.prevHash,
  ].join('|');
}

export function computeHash(entry: Omit<LedgerEntry, 'hash' | 'signature'>): string {
  return createHash('sha256').update(canonical(entry)).digest('hex');
}

export function sign(hash: string): string {
  return createHmac('sha256', SECRET).update(hash).digest('hex');
}

export function appendLedger(opts: {
  intent: SpendIntent;
  decision: LedgerDecision;
  rule: string;
  decidedBy: string;
  approvalId?: string | null;
}): LedgerEntry {
  const last = store.lastLedgerEntry();
  const seq = (last?.seq ?? 0) + 1;
  const entry: Omit<LedgerEntry, 'hash' | 'signature'> = {
    seq,
    ts: new Date().toISOString(),
    intentId: opts.intent.id,
    agentId: opts.intent.agentId,
    amount: opts.intent.amount,
    currency: opts.intent.currency,
    vendor: opts.intent.vendor,
    purpose: opts.intent.purpose,
    rail: opts.intent.rail,
    decision: opts.decision,
    rule: opts.rule,
    decidedBy: opts.decidedBy,
    approvalId: opts.approvalId ?? null,
    prevHash: last?.hash ?? GENESIS,
  };
  const hash = computeHash(entry);
  const full: LedgerEntry = { ...entry, hash, signature: sign(hash) };
  store.appendLedger(full);
  return full;
}

export function verifyLedger(): { valid: boolean; entries: number; brokenAt: number | null } {
  const rows = store.fullLedger();
  let prev = GENESIS;
  for (const row of rows) {
    const { hash, signature, ...rest } = row;
    const recomputed = computeHash(rest);
    if (row.prevHash !== prev || recomputed !== hash || sign(recomputed) !== signature) {
      return { valid: false, entries: rows.length, brokenAt: row.seq };
    }
    prev = hash;
  }
  return { valid: true, entries: rows.length, brokenAt: null };
}

export function ledgerToCsv(entries: LedgerEntry[]): string {
  const header = 'seq,ts,intent_id,agent_id,amount_minor,currency,vendor,purpose,rail,decision,rule,decided_by,approval_id,prev_hash,hash,signature';
  const esc = (s: string) => `"${String(s).replaceAll('"', '""')}"`;
  const lines = entries.map((e) =>
    [e.seq, e.ts, e.intentId, e.agentId, e.amount, e.currency, esc(e.vendor), esc(e.purpose), e.rail, e.decision, e.rule, e.decidedBy, e.approvalId ?? '', e.prevHash, e.hash, e.signature].join(','),
  );
  return [header, ...lines].join('\n');
}
