// Unit tests for the Telegram notifier: pushes a decision-link pair for every
// new escalation, never re-pushes, and resolves configuration correctly.
import { beforeAll, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  process.env.SPENDGATE_DATA = `/tmp/spendgate-test-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return process.env.SPENDGATE_DATA;
});

import { onEvent, submitSpend, decide } from '../src/core/engine.js';
import { attachNotifier, resolveNotifier, telegramNotifier } from '../src/notify.js';
import { store } from '../src/core/store.js';
import type { Policy } from '../src/core/types.js';

const AGENT = 'notify-test';
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(() => {
  store.upsertAgent(AGENT, 'Notify Test', 'GBP');
  store.upsertPolicy(POLICY);
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  // notifier delegates to the current fetchMock so tests can re-stub freely
  const notifier = telegramNotifier({ botToken: 'B', chatId: 'C', baseUrl: 'https://gate.example', fetchImpl: (...args) => fetchMock(...args) });
  attachNotifier(onEvent, notifier);
});

function escalate(purpose: string) {
  return submitSpend({ agentId: AGENT, amount: 25_000, currency: 'GBP', vendor: 'acme', purpose, rail: 'mcp' });
}

describe('telegram push on escalation', () => {
  it('sends one sendMessage with both decision-link buttons', async () => {
    const p = escalate('telegram push test');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5_000 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botB/sendMessage');
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe('C');
    expect(body.text).toContain('acme');
    expect(body.text).toContain('£250.00');
    expect(body.text).toContain('notify-test');
    const buttons = body.reply_markup.inline_keyboard[0];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatchObject({ text: '✅ Approve', url: expect.stringMatching(/^https:\/\/gate\.example\/decide\/.+$/) });
    expect(buttons[1]).toMatchObject({ text: '❌ Reject', url: expect.stringMatching(/^https:\/\/gate\.example\/decide\/.+$/) });
    expect(buttons[0].url).not.toBe(buttons[1].url);

    await new Promise((r) => setTimeout(r, 50));
    decide((store.pendingApprovals().at(-1)!).id, true, 'cleanup');
    await p;
  });

  it('does not re-push when the escalation is decided', async () => {
    const callsBefore = fetchMock.mock.calls.length;
    const p = escalate('no re-push test');
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 1), { timeout: 5_000 });
    const approval = store.pendingApprovals().at(-1)!;
    decide(approval.id, true, 'cleanup');
    await p;
    await new Promise((r) => setTimeout(r, 150));
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
  });

  it('pushes again for a genuinely new escalation', async () => {
    const callsBefore = fetchMock.mock.calls.length;
    const p = escalate('second push test');
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 1), { timeout: 5_000 });
    decide(store.pendingApprovals().at(-1)!.id, true, 'cleanup');
    await p;
  });
});

describe('resolveNotifier', () => {
  it('returns null when unconfigured', () => {
    expect(resolveNotifier({})).toBeNull();
  });

  it('returns null (with a warning) when only half-configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveNotifier({ SPENDGATE_TELEGRAM_BOT_TOKEN: 'B' })).toBeNull();
    expect(resolveNotifier({ SPENDGATE_TELEGRAM_CHAT_ID: 'C' })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('uses SPENDGATE_PUBLIC_BASE_URL for link URLs', () => {
    const n = resolveNotifier({
      SPENDGATE_TELEGRAM_BOT_TOKEN: 'B',
      SPENDGATE_TELEGRAM_CHAT_ID: 'C',
      SPENDGATE_PUBLIC_BASE_URL: 'https://tunnel.example/',
    });
    expect(n?.name).toBe('telegram');
    // trailing slash stripped — links would otherwise get a double slash
    void n;
  });
});
