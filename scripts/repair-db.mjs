// One-off repair: restore seq 1 (tampered by an early test run that hit the
// real db before env isolation was in place) and strip test-junk rows.
// Junk rows are a pure suffix (seq >= 24), so deleting them leaves all real
// hashes untouched.
process.env.SPENDGATE_DATA = new URL('../.spendgate', import.meta.url).pathname;

const { db, store } = await import('../server/src/core/store.js');
const { computeHash, sign, verifyLedger } = await import('../server/src/core/ledger.js');

// 1. restore the original demo row (demo/src/agent.ts scenario 1: £1,180.00)
const row = db.prepare('SELECT * FROM ledger WHERE seq = 1').get();
if (row.amount !== 999) throw new Error(`seq 1 amount is ${row.amount}, expected tampered 999 — inspect before repairing`);
db.prepare('UPDATE ledger SET amount = 118000 WHERE seq = 1').run();
const { hash: _h, signature: _s, ...rest } = db.prepare('SELECT * FROM ledger WHERE seq = 1').get();
const fixed = {
  seq: rest.seq, ts: rest.ts, intentId: rest.intent_id, agentId: rest.agent_id,
  amount: rest.amount, currency: rest.currency, vendor: rest.vendor, purpose: rest.purpose,
  rail: rest.rail, decision: rest.decision, rule: rest.rule, decidedBy: rest.decided_by,
  approvalId: rest.approval_id, prevHash: rest.prev_hash,
};
const hash = computeHash(fixed);
db.prepare('UPDATE ledger SET hash = ?, signature = ? WHERE seq = 1').run(hash, sign(hash));

// 2. strip the test-junk suffix (agents 'a' + 'engine-test', all seq >= 24)
const junk = db.prepare("SELECT COUNT(*) n FROM ledger WHERE seq >= 24 AND agent_id IN ('a','engine-test')").get();
db.prepare('DELETE FROM ledger WHERE seq >= 24').run();
db.prepare("DELETE FROM agents WHERE agent_id IN ('a','engine-test')").run();
db.prepare("DELETE FROM policies WHERE agent_id IN ('a','engine-test')").run();
db.prepare("DELETE FROM approvals WHERE intent_json LIKE '%\"agentId\":\"engine-test\"%'").run();
db.prepare("DELETE FROM idempotency_keys WHERE agent_id IN ('a','engine-test')").run();

console.log(`restored seq 1, removed ${junk.n} junk ledger rows`);
console.log('verify:', JSON.stringify(verifyLedger()));
console.log('agents:', store.listAgents().map((a) => a.agentId).join(', '));
