// Unit tests for the hash-chained, HMAC-signed audit ledger (isolated temp data dir).
import { beforeAll, describe, expect, it, vi } from 'vitest';

// MUST run before the static imports below pull in store.ts — vitest hoists
// this above every import, so the real .tollkeep dir is never touched.
// (store.ts mkdirs the path itself; no fs import needed inside the hoisted block)
const env = vi.hoisted(() => {
  process.env.TOLLKEEP_DATA = `/tmp/tollkeep-test-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.env.TOLLKEEP_DATA;
});

import type { LedgerEntry, SpendIntent } from '../src/core/types.js';
import { appendLedger, computeHash, ledgerToCsv, sign, verifyLedger } from '../src/core/ledger.js';
import { db, store } from '../src/core/store.js';

function intent(over: Partial<SpendIntent> = {}): SpendIntent {
  return {
    id: crypto.randomUUID(),
    agentId: 'a',
    amount: 100,
    currency: 'GBP',
    vendor: 'acme',
    purpose: 'test',
    rail: 'mcp',
    ...over,
  };
}

describe('ledger', () => {
  it('starts empty and verifies as valid (genesis boundary)', () => {
    expect(verifyLedger()).toEqual({ valid: true, entries: 0, brokenAt: null });
  });

  it('chains entries: each row points at the previous hash', () => {
    const e1 = appendLedger({ intent: intent(), decision: 'ALLOWED', rule: 'within-policy', decidedBy: 'policy' });
    const e2 = appendLedger({ intent: intent(), decision: 'DENIED', rule: 'vendor-blocked', decidedBy: 'policy' });
    expect(e1.prevHash).toBe('GENESIS');
    expect(e2.prevHash).toBe(e1.hash);
    expect(verifyLedger()).toEqual({ valid: true, entries: 2, brokenAt: null });
  });

  it('detects tampering with any field and reports the broken row', () => {
    appendLedger({ intent: intent({ amount: 100 }), decision: 'ALLOWED', rule: 'within-policy', decidedBy: 'policy' });
    appendLedger({ intent: intent({ amount: 200 }), decision: 'ALLOWED', rule: 'within-policy', decidedBy: 'policy' });
    db.prepare('UPDATE ledger SET amount = 999 WHERE seq = 1').run();
    const v = verifyLedger();
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it('detects a reordered or re-signed chain', () => {
    const e = appendLedger({ intent: intent(), decision: 'ALLOWED', rule: 'within-policy', decidedBy: 'policy' });
    db.prepare('UPDATE ledger SET signature = ? WHERE seq = 1').run(sign(computeHash({ ...e, seq: 99 } as Omit<LedgerEntry, 'hash' | 'signature'>)));
    expect(verifyLedger().valid).toBe(false);
  });

  it('keeps hash and row seq in sync even after a tail row is deleted', () => {
    // Regression: seq is hashed before insert. The insert must pin that exact
    // seq — letting AUTOINCREMENT assign one desyncs the hash from the row.
    appendLedger({ intent: intent(), decision: 'ALLOWED', rule: 'within-policy', decidedBy: 'policy' });
    db.prepare('DELETE FROM ledger WHERE seq = (SELECT MAX(seq) FROM ledger)').run();
    db.prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'ledger'").run(); // force divergence
    appendLedger({ intent: intent(), decision: 'ALLOWED', rule: 'within-policy', decidedBy: 'policy' });
    const rows = store.fullLedger();
    const last = rows.at(-1)!;
    expect(last.seq).toBe(rows.length); // dense, no AUTOINCREMENT gap
    // the exact bug: stored hash must match recomputation over the stored row
    const { hash, signature, ...rest } = last;
    expect(computeHash(rest)).toBe(hash);
  });

  it('exports CSV with a header and quoted free-text fields', () => {
    appendLedger({ intent: intent({ vendor: 'say "hi"', purpose: 'comma, inside' }), decision: 'ALLOWED', rule: 'within-policy', decidedBy: 'policy' });
    const lines = ledgerToCsv(store.fullLedger()).split('\n');
    expect(lines[0]).toContain('seq,ts,intent_id');
    const last = lines.at(-1)!; // earlier rows may be tampered by the tests above — check our own row
    expect(last).toContain('"say ""hi"""');
    expect(last).toContain('"comma, inside"');
  });
});

beforeAll(() => {
  store.upsertAgent('a', 'Agent A', 'GBP');
});
