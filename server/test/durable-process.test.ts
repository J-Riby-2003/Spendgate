import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, expect, it, vi } from 'vitest';
const dir = mkdtempSync(join(tmpdir(), 'spendgate-process-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function worker() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/durable-worker.ts'], { env: { ...process.env, SPENDGATE_DATA: dir }, stdio: ['pipe','pipe','pipe'] });
  let output = '', errors = '';
  let readyResolve!: () => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) readyResolve(); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const exited = new Promise<any>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) { reject(new Error(errors)); return; }
      try { resolve(JSON.parse(output.trim().split('\n').at(-1)!)); } catch { reject(new Error(output + errors)); }
    });
  });
  return { ready, async run(command: unknown) { await ready; child.stdin.end(JSON.stringify(command) + '\n'); return exited; } };
}
async function run(command: unknown) { return worker().run(command); }
it('recovers pending request and idempotency after actual process termination, then finalises without a waiter', async () => {
  const first = (await run({ action: 'submit', key: 'restart-1' })).result;
  expect(first.decision).toBe('PENDING');
  expect((await run({ action: 'submit', key: 'restart-1' })).result).toEqual(first);
  expect((await run({ action: 'get', requestId: first.requestId })).result).toEqual(first);
  expect((await run({ action: 'decide', approvalId: first.approvalId, approve: true })).result).toBe(true);
  const recovered = (await run({ action: 'get', requestId: first.requestId })).result;
  expect(recovered.decision).toBe('APPROVED');
  expect((await run({ action: 'submit', key: 'restart-1' })).result).toEqual(recovered);
  const inspected = (await run({ action: 'inspect' })).result;
  expect(inspected.ledger.filter((e: any) => e.intentId === first.requestId)).toHaveLength(1);
  expect(inspected.budget.reservedMinor).toBe(60); expect(inspected.verify.valid).toBe(true);
}, 15000);
it('serialises independent approve/reject writers into exactly one outcome', async () => {
  const pending = (await run({ action: 'submit', key: 'race' })).result;
  const approve = worker(), reject = worker();
  await Promise.all([approve.ready, reject.ready]);
  const results = await Promise.all([approve.run({ action: 'decide', approvalId: pending.approvalId, approve: true }), reject.run({ action: 'decide', approvalId: pending.approvalId, approve: false })]);
  expect(results.filter(r => r.result === true)).toHaveLength(1);
  const inspected = (await run({ action: 'inspect' })).result;
  expect(inspected.ledger.filter((e: any) => e.intentId === pending.requestId)).toHaveLength(1);
  expect(inspected.verify.valid).toBe(true);
}, 15000);
it('expires overdue work after process restart and reclaims an interrupted notification lease safely', async () => {
  const stale = (await run({ action: 'submit', key: 'stale' })).result;
  const live = (await run({ action: 'submit', key: 'live-notify' })).result;
  const db = new DatabaseSync(join(dir, 'spendgate.db'));
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), stale.approvalId);
  db.prepare("UPDATE notification_outbox SET status='sending',lease_id='dead-process',lease_until=0 WHERE approval_id=?").run(live.approvalId);
  db.close();
  const delivery = (await run({ action: 'notify' })).result;
  expect(delivery.sends).toBe(1);
  expect(delivery.jobs.find((r: any) => r.approval_id === stale.approvalId).status).toBe('obsolete');
  expect(delivery.jobs.find((r: any) => r.approval_id === live.approvalId).status).toBe('delivered');
  expect((await run({ action: 'get', requestId: stale.requestId })).result.decision).toBe('EXPIRED');
  expect((await run({ action: 'submit', key: 'stale' })).result.decision).toBe('EXPIRED');
  expect((await run({ action: 'notify' })).result.sends).toBe(0);
}, 15000);
it('concurrent retries in separate processes create one durable request and one notification job', async () => {
  const left = worker(), right = worker(); await Promise.all([left.ready, right.ready]);
  const results = await Promise.all([left.run({ action: 'submit', key: 'concurrent-duplicate' }), right.run({ action: 'submit', key: 'concurrent-duplicate' })]);
  expect(results[0].result).toEqual(results[1].result);
  const db = new DatabaseSync(join(dir, 'spendgate.db'));
  expect(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE approval_id=?').get(results[0].result.approvalId)?.n).toBe(1);
  db.close();
}, 15000);
it('competing approval and expiry processes cannot approve overdue work or append twice', async () => {
  const pending = (await run({ action: 'submit', key: 'expiry-race' })).result;
  const approve = worker(), expire = worker(); await Promise.all([approve.ready, expire.ready]);
  const db = new DatabaseSync(join(dir, 'spendgate.db'));
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), pending.approvalId); db.close();
  const [decision] = await Promise.all([approve.run({ action: 'decide', approvalId: pending.approvalId, approve: true }), expire.run({ action: 'expire' })]);
  expect(decision.result).toBe(false);
  const inspected = (await run({ action: 'inspect' })).result;
  const entries = inspected.ledger.filter((e: any) => e.intentId === pending.requestId);
  expect(entries).toHaveLength(1); expect(entries[0].decision).toBe('EXPIRED'); expect(inspected.verify.valid).toBe(true);
}, 15000);

it('recovers the exact pending request after an ungraceful SIGKILL', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/durable-worker.ts'], { env: { ...process.env, SPENDGATE_DATA: dir }, stdio: ['pipe','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ action: 'submit', key: 'hard-crash', crash: true }) + '\n');
  try {
    await vi.waitFor(() => expect(output).toContain('PENDING'), { timeout: 5000 });
    const pending = JSON.parse(output.trim().split('\n').at(-1)!).result;
    const exited = new Promise<string | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
    expect((await run({ action: 'submit', key: 'hard-crash' })).result).toEqual(pending);
    expect((await run({ action: 'decide', approvalId: pending.approvalId, approve: false })).result).toBe(true);
    expect((await run({ action: 'get', requestId: pending.requestId })).result.decision).toBe('REJECTED');
  } finally { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); }
}, 15000);
