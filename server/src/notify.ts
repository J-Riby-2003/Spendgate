// Push notifications for escalations — Telegram first.
// Subscribes to the engine's approval events and pushes a fresh decision-link
// pair for every new escalation. Fire-and-forget: a failed push never blocks
// the agent — the console and the expiry timeout remain the fallback.
import { formatMinor as fmtMoney } from './core/money.js';
import { randomUUID } from 'node:crypto';
import { db, store, withImmediateTransaction } from './core/store.js';
import { expireStale, emit } from './core/engine.js';
import type { ApprovalRequest } from './core/types.js';
import type { onEvent } from './core/engine.js';
import { mintDecisionLinksUnwrapped, type DecisionLink } from './decide-links.js';

export interface Notifier {
  name: string;
  send(approval: ApprovalRequest, links: DecisionLink[]): Promise<void>;
  /** Follow-up after a human decided via link (approve or reject). */
  confirm?(approval: ApprovalRequest, decision: 'approved' | 'rejected'): Promise<void>;
}

/** Telegram HTML parse_mode escaping for user-controlled fields. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function summaryLines(approval: ApprovalRequest): string[] {
  const i = approval.intent;
  return [
    `<b>${esc(fmtMoney(i.amount, i.currency))}</b> → ${esc(i.vendor)}`,
    `🤖 ${esc(i.agentId)} · rail ${esc(i.rail)}`,
    `📝 ${esc(i.purpose)}`,
  ];
}

export interface TelegramOpts {
  botToken: string;
  chatId: string;
  /** Public origin used in decision-link URLs, e.g. an https tunnel. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export function telegramNotifier(opts: TelegramOpts): Notifier {
  const { botToken, chatId, baseUrl, fetchImpl = fetch } = opts;

  async function postMessage(text: string, replyMarkup?: unknown): Promise<void> {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    if (!res.ok) throw new NotificationDeliveryError(res.status);
    const payload = await res.json() as { ok?: boolean; error_code?: number };
    if (payload.ok === false) throw new NotificationDeliveryError(payload.error_code ?? 502);
  }

  return {
    name: 'telegram',

    async send(approval, links) {
      const approve = links.find((l) => l.action === 'approve');
      const reject = links.find((l) => l.action === 'reject');
      if (!approve || !reject) throw new Error('decision link pair incomplete');
      const text = [
        '⏳ <b>SpendGate approval needed</b>',
        '',
        ...summaryLines(approval),
        '',
        `📏 Rule: <b>${esc(approval.rule)}</b>`,
        `💬 ${esc(approval.reason)}`,
        '',
        '<i>One tap decides permanently. Untapped requests expire denied.</i>',
      ].join('\n');
      await postMessage(text, {
        inline_keyboard: [[
          { text: '✅ Approve', url: `${baseUrl}${approve.path}` },
          { text: '❌ Reject', url: `${baseUrl}${reject.path}` },
        ]],
      });
    },

    async confirm(approval, decision) {
      const approved = decision === 'approved';
      const text = [
        `${approved ? '✅' : '❌'} <b>${approved ? 'APPROVED' : 'REJECTED'}</b>`,
        '',
        ...summaryLines(approval),
        '',
        '<i>Recorded permanently in the signed audit ledger.</i>',
      ].join('\n');
      await postMessage(text);
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


export class NotificationDeliveryError extends Error {
  readonly status: number;
  constructor(status: unknown) {
    const code = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502;
    super(`Notification provider status ${code}`);
    this.status = code;
  }
}

/** At-least-once external delivery with persisted, exclusively leased jobs. */
export async function deliverNotifications(notifier: Notifier): Promise<void> {
  expireStale();
  // Bound each tick so a backlog cannot monopolise the server.
  for (let index = 0; index < 20; index++) {
    const job = withImmediateTransaction(() => {
      const now = Date.now();
      const row = db.prepare(`SELECT * FROM notification_outbox WHERE
        (status IN ('pending','retry') AND next_attempt_at<=?) OR
        (status='sending' AND lease_until<=?) ORDER BY next_attempt_at LIMIT 1`).get(now, now);
      if (!row) return null;
      const approvalId = String(row.approval_id);
      const approval = store.getApproval(approvalId);
      if (!approval || approval.status !== 'pending' || approval.expiresAt! <= new Date(now).toISOString()) {
        db.prepare("UPDATE notification_outbox SET status='obsolete',lease_id=NULL,lease_until=NULL WHERE approval_id=?").run(approvalId);
        return { obsolete: true } as const;
      }
      const lease = randomUUID();
      db.prepare("UPDATE notification_outbox SET status='sending',attempts=attempts+1,lease_id=?,lease_until=? WHERE approval_id=?")
        .run(lease, now + 60000, approvalId);
      const links = mintDecisionLinksUnwrapped(approvalId);
      return { obsolete: false, approval, links, lease, attempts: Number(row.attempts) + 1 } as const;
    });
    if (!job) break;
    if (job.obsolete) continue;
    // No async work occurs between this final status check and starting the send.
    const current = store.getApproval(job.approval.id);
    if (!current || current.status !== 'pending' || current.expiresAt! <= new Date().toISOString()) {
      db.prepare("UPDATE notification_outbox SET status='obsolete' WHERE approval_id=? AND lease_id=?").run(job.approval.id, job.lease);
      continue;
    }
    try {
      await notifier.send(current, job.links);
      db.prepare("UPDATE notification_outbox SET status='delivered',delivered_at=?,last_error=NULL,lease_id=NULL,lease_until=NULL WHERE approval_id=? AND lease_id=? AND status='sending'")
        .run(new Date().toISOString(), job.approval.id, job.lease);
      emit({ type: 'state' });
    } catch (error) {
      const code = error instanceof NotificationDeliveryError ? error.status : null;
      const permanent = code != null && code >= 400 && code < 500 && code !== 429 && code !== 408;
      const exhausted = permanent || job.attempts >= 6;
      const message = code ? `Provider status ${code}` : 'Delivery failed or timed out';
      console.error(`[notify] ${message}; approval ${job.approval.id}`);
      db.prepare("UPDATE notification_outbox SET status=?,next_attempt_at=?,last_error=?,lease_id=NULL,lease_until=NULL WHERE approval_id=? AND lease_id=? AND status='sending'")
        .run(exhausted ? 'failed' : 'retry', Date.now() + Math.min(300000, 1000 * 2 ** (job.attempts - 1)), message, job.approval.id, job.lease);
      emit({ type: 'state' });
    }
  }
}
export function notificationStatus(approvalId: string) {
  return db.prepare('SELECT status,attempts,next_attempt_at AS nextAttemptAt,last_error AS lastError,delivered_at AS deliveredAt FROM notification_outbox WHERE approval_id=?').get(approvalId) ?? null;
}

/** Wakeups improve latency; SQLite, rather than event delivery, owns the backlog. */
export function attachNotifier(subscribe: typeof onEvent, notifier: Notifier | null): () => void {
  if (!notifier) return () => {};
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await deliverNotifications(notifier); } catch { console.error('[notify] delivery worker failed'); }
    finally { running = false; }
  };
  const unsubscribe = subscribe(event => { if (event.type === 'approvals') void tick(); });
  const interval = setInterval(() => void tick(), 1000);
  interval.unref();
  void tick();
  return () => { stopped = true; clearInterval(interval); unsubscribe(); };
}
