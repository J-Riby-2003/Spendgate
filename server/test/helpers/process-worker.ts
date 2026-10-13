import { spawn } from 'node:child_process';

/** Fail both startup and command observers; wait for drained pipes before parsing. */
export function processWorker(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', diagnostic = '', isReady = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let resultResolve!: (value: any) => void, resultReject!: (error: Error) => void;
  let closedResolve!: () => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise<any>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  const closed = new Promise<void>(resolve => { closedResolve = resolve; });
  // Either promise can fail before the caller reaches its await (e.g. a readiness barrier).
  // Register handlers now; callers still receive the original rejected promises.
  void ready.catch(() => {});
  void result.catch(() => {});
  const fail = (error: Error) => { readyReject(error); resultReject(error); };
  child.stdout.on('data', chunk => {
    output += String(chunk);
    if (!isReady && output.split('\n').includes('ready')) { isReady = true; readyResolve(); }
  });
  child.stderr.on('data', chunk => { diagnostic += String(chunk); });
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.once('close', (code, signal) => {
    closedResolve();
    if (code !== 0) { fail(new Error(`Worker exited (${signal ?? code}): ${diagnostic}`)); return; }
    if (!isReady) { fail(new Error(`Worker exited before readiness: ${diagnostic || output}`)); return; }
    try {
      const value = JSON.parse(output.trim().split('\n').at(-1)!);
      if (value.error) throw new Error(`Worker command failed: ${value.error}`);
      resultResolve(value);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  return {
    child, ready,
    async run(command: unknown) {
      await ready;
      if (!child.stdin.destroyed) child.stdin.end(JSON.stringify(command) + '\n');
      return result;
    },
    async stop() {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      await closed;
    },
  };
}
