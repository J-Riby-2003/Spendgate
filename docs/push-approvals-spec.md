# Roadmap #4 — Phone/push approvals (spec)

**Status:** spec, not started. **Goal:** an escalated spend reaches the operator's phone in seconds; one tap approves or rejects; the blocked agent's MCP call resolves exactly as if the decision happened in the console.

## Problem

Today an escalation waits up to 5 minutes (then expires denied) unless a human happens to be staring at the console. The agent is blocked the whole time. For SpendGate to be the "policy layer above every agent payment rail", the human decision must be as fast as the agent is.

## Requirements

1. Push arrives < 5 s after the escalation is created.
2. One tap decides: no login, no console token on the phone, no password manager.
3. The decision lands in the same hash-chained ledger with `decidedBy: human:<identity>`, indistinguishable from a console decision.
4. Reject/ignore is safe: an untapped escalation still expires denied after the existing timeout.
5. A decision link works exactly once and dies with the approval (replay → 409).
6. Console and push stay consistent: whoever decides first wins; the other's tap shows "already decided".

## Options considered

| Channel | Latency | Effort | Verdict |
|---|---|---|---|
| Telegram bot | <2 s | Low (Bot API, no approval needed) | **Recommended for MVP** |
| WhatsApp | <2 s | High (Meta Business onboarding, app review) | Later — customers will ask for it |
| Web Push (VAPID) | 2–10 s, unreliable on iOS Safari | Medium (push service + subscription UI) | Later |
| SMS | 5–60 s | Medium + per-message cost | No — slow and spoofable |

Recommendation: **Telegram first** (one evening of work, zero gatekeepers), architect the notifier as an interface so WhatsApp/web push slot in later.

## Design

### New module: `server/src/notify/`

```
notify/
  interface.ts   → Notifier { name; sendEscalation(approval): Promise<void> }
  telegram.ts    → TelegramNotifier (fetch to api.telegram.org)
  noop.ts        → used when no bot is configured
```

Config (all env, zero new deps for the interface; `form-data`-free — Telegram accepts URL-encoded bodies):

- `SPENDGATE_TELEGRAM_BOT_TOKEN` — from @BotFather
- `SPENDGATE_TELEGRAM_CHAT_ID` — the operator's chat id (send `/start` to the bot, read it from the server log)

### Decision tokens (the security core)

Table `approval_links`:

| column | notes |
|---|---|
| `token_hash` | sha256 of the random token — the token itself is never stored |
| `approval_id` | FK-ish to the approval |
| `action` | `approve` / `reject` |
| `expires_at` | approval `createdAt` + approval timeout |
| `used_at` | null until consumed |

- On escalation, the engine mints **two** tokens (approve + reject), random 24 bytes base64url, sends two inline buttons: `[✅ Approve £214.00]` `[❌ Reject]`.
- Callback URL: `https://<host>/decide/<token>` — a plain GET so tapping the button in Telegram's in-app browser is enough. The page shows a one-screen confirm (amount, vendor, agent, rule) and the tap POSTs `/api/decide/:token`.
- The POST handler: hash token → look up link → checks: unused, unexpired, approval still pending → records decision via the **same** `decide()` engine function the console uses (ledger row, waiter release, WS broadcast — all identical), marks `used_at`.
- Wrong/used/expired → a dead-end page saying so. No information leak beyond "this link is spent".

Threat model notes:
- Tokens are bearer capabilities: 24 bytes random, single-use, short-lived, HTTPS-only. Guessing is out of reach; leaking a link in a notification screenshot only exposes that one decision, and only until used.
- The console bearer token is **never** involved — phone approval works even if you rotate the console token.
- Add `SPENDGATE_PUBLIC_BASE_URL` env; the tunnel (ngrok/cloudflared) is an operator concern, documented in README.

### Engine hook

One line in `submitSpend`'s ESCALATE branch, after `store.createApproval`:

```ts
void notifyEscalation(approval); // fire-and-forget; never blocks the agent's wait
```

Notifier failure is logged, never thrown — the console remains the fallback.

### Web layer

- `POST /api/decide/:token` (public by design — the token *is* the auth).
- `web/src/pages/Decide.tsx` — confirm screen in the existing design system; success screen shows the ledger row (`APPROVED — decided by human:telegram`) and a "open console" link.
- Route added to the SPA router; no gate (it's a public decision page).

## Testing

- Unit: token mint/hash/consume, expiry, double-use → 409, decide-by-link writes identical ledger shape (reuse engine tests).
- E2E (Playwright): mint a link via a real escalation, open `/decide/<token>` headless, tap Approve, assert the blocked MCP call resolves APPROVED — mirrors the existing console approval e2e.
- Manual: real Telegram bot, real phone, `npm run demo`.

## Build order (each step is shippable)

1. `approval_links` table + token mint/consume + `/api/decide/:token` + Decide page (test end-to-end with a hand-crafted link before any bot exists).
2. Telegram notifier + env config + engine hook. (done — wired via the approvals event bus in `server/src/notify.ts` rather than inside the engine, so a failed push can never touch agent flow)
3. Polish: reject button, expiry page, "already decided" page, README + `.env.example`.
4. (Later) WhatsApp/web push behind the same `Notifier` interface; multi-user routing (who gets paged for which agent's spend).

## Out of scope for this item

Multi-approver quorums, approval policies (e.g. "£1k+ needs 2 humans"), phone-number identity for `decidedBy`. Logged as `human:telegram:<chatId-hash>` for now.
