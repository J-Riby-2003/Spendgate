import { afterEach, expect, it } from 'vitest';
import { processWorker } from './helpers/process-worker.js';
const workers = new Set<ReturnType<typeof processWorker>>();
afterEach(async () => { await Promise.all([...workers].map(worker => worker.stop())); workers.clear(); });
function start(args: string[]) { const worker = processWorker(args, process.env); workers.add(worker); return worker; }
it('reports a child that exits before readiness, including its diagnostic, without waiting for a test timeout', async () => {
  const worker = start(['-e', "process.stderr.write('intentional startup failure'); process.exit(7)"]);
  await expect(worker.run({ action: 'unused' })).rejects.toThrow(/intentional startup failure/);
});
it('parses all output after the child closes its pipes and reports command failures', async () => {
  const worker = start(['-e', `console.log('ready'); process.stdin.once('data', () => console.log(JSON.stringify({error:'intentional command failure'})))`]);
  await expect(worker.run({ action: 'unused' })).rejects.toThrow(/intentional command failure/);
});

it('cleans up a live waiting child while preserving its failed result for callers', async () => {
  const worker = start(['-e', `console.log('ready'); setInterval(() => {}, 1000)`]);
  await worker.ready;
  await worker.stop();
  await expect(worker.run({ action: 'unused' })).rejects.toThrow(/SIGKILL/);
  expect(worker.child.signalCode).toBe('SIGKILL');
});
it('rejects a zero-exit child that never sent readiness instead of leaving a barrier pending', async () => {
  const worker = start(['-e', `console.log('finished without handshake')`]);
  await expect(worker.ready).rejects.toThrow(/before readiness/);
});
