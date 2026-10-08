// Waiter registry: MCP tool calls block here until a human decides or the clock runs out.
export type Outcome = 'approved' | 'rejected' | 'expired';

const waiters = new Map<string, (o: Outcome) => void>();

export function registerWaiter(id: string, resolve: (o: Outcome) => void): void {
  waiters.set(id, resolve);
}

export function removeWaiter(id: string): void {
  waiters.delete(id);
}

export function resolveWaiter(id: string, outcome: Outcome): boolean {
  const w = waiters.get(id);
  if (!w) return false;
  waiters.delete(id);
  w(outcome);
  return true;
}

export function awaitDecisionAsync(approvalId: string, timeoutMs: number): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => {
      removeWaiter(approvalId);
      resolve('expired');
    }, timeoutMs);
    registerWaiter(approvalId, (o) => {
      clearTimeout(timer);
      resolve(o);
    });
  });
}
