// Push notifications for escalations — Telegram first (see docs/push-approvals-spec.md).
// Subscribes to the engine's approval events and pushes a fresh decision-link
// pair for every new escalation. Fire-and-forget: a failed push never blocks
// the agent — the console and the expiry timeout remain the fallback.
import type { ApprovalRequest } from './core/types.js';
import type { onEvent } from './core/engine.js';
import { mintDecisionLinks, type DecisionLink } from './decide-links.js';

export interface Notifier {
  name: string;
  send(approval: ApprovalRequest, links: DecisionLink[]): Promise<void>;
}

const fmtMoney = (minor: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);

export interface TelegramOpts {
  botToken: string;
  chatId: string;
  /** Public origin used in decision-link URLs, e.g. an https tunnel. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export function telegramNotifier(opts: TelegramOpts): Notifier {
  const { botToken, chatId, baseUrl, fetchImpl = fetch } = opts;
  return {
    name: 'telegram',
    async send(approval, links) {
      const approve = links.find((l) => l.action === 'approve');
      const reject = links.find((l) => l.action === 'reject');
      if (!approve || !reject) throw new Error('decision link pair incomplete');
      const i = approval.intent;
      const text = [
        '⏳ SpendGate approval needed',
        '',
        `${fmtMoney(i.amount, i.currency)} → ${i.vendor}`,
        `${i.agentId} · ${i.purpose} · rail ${i.rail}`,
        `Rule: ${approval.rule}`,
        approval.reason,
      ].join('\n');
      const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approve', url: `${baseUrl}${approve.path}` },
              { text: '❌ Reject', url: `${baseUrl}${reject.path}` },
            ]],
          },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Telegram API ${res.status}: ${detail.slice(0, 200)}`);
      }
    },
  };
}

/** Build the notifier from the environment, or null when unconfigured. */
export function resolveNotifier(env: NodeJS.ProcessEnv = process.env): Notifier | null {
  const token = env.SPENDGATE_TELEGRAM_BOT_TOKEN;
  const chatId = env.SPENDGATE_TELEGRAM_CHAT_ID;
  if (!token && !chatId) return null;
  if (!token || !chatId) {
    console.warn('[notify] SPENDGATE_TELEGRAM_BOT_TOKEN and SPENDGATE_TELEGRAM_CHAT_ID must both be set — push approvals disabled.');
    return null;
  }
  return telegramNotifier({
    botToken: token,
    chatId,
    baseUrl: (env.SPENDGATE_PUBLIC_BASE_URL ?? `http://localhost:${env.SPENDGATE_PORT ?? 8787}`).replace(/\/$/, ''),
  });
}

/** Subscribe to engine events and push a decision-link pair per new escalation. */
export function attachNotifier(subscribe: typeof onEvent, notifier: Notifier | null): void {
  if (!notifier) return;
  const pushed = new Set<string>();
  subscribe((event) => {
    if (event.type !== 'approvals') return;
    for (const approval of event.pending as ApprovalRequest[]) {
      if (pushed.has(approval.id)) continue;
      pushed.add(approval.id);
      const links = mintDecisionLinks(approval);
      notifier.send(approval, links).catch((err) => {
        console.error(`[notify] ${notifier.name} push failed for approval ${approval.id}:`, err);
      });
    }
  });
}
