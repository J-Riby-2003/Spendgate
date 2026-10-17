# Tollkeep

**The policy and approval layer above every agent payment rail.**
A Britannic & Balkan project.

> **Status: v0.1, pre-payment-execution.** Tollkeep decides and records; it does
> not yet move money or verify supplier charges. See [SECURITY.md](SECURITY.md)
> for the trust model.

Agents route payment intents through the Tollkeep MCP server. Policy decides:
auto-allow, hard-deny, or escalate to a human. Every intent — allowed or not —
lands in a SHA-256 hash-chained, HMAC-signed audit ledger.

## Run it

```bash
npm install
npm run operator:provision -w server -- operator  # hidden password prompt, once
npm run dev        # server :8787 + console :7100; sign in with that operator
npm run demo       # in a second terminal — 5 scenarios through every decision path
```

## Test it

```bash
npm run test       # unit and integration tests: policy, ledger, identity, access control, MCP, WebSocket and decision links
npm run test:e2e   # builds the web app, then Playwright on :8787: sign-in/logout, credential issuance, console approval, phone decision link
```

Unit tests run against a throwaway data dir; e2e starts a separate server on :18871 with temporary data and never reuses live servers.

## What's inside

| Piece | Path | What it does |
|---|---|---|
| Policy engine | `server/src/core/policy.ts` | Per-agent rules: auto-approve ceiling, daily budget, approval threshold, vendor lists, new-vendor gate, day/time windows. Hard denies only for blocked vendors; everything ambiguous escalates to a human. |
| Signed ledger | `server/src/core/ledger.ts` | Append-only, hash-chained rows, HMAC-signed. `GET /api/ledger/verify` re-computes the chain; tamper with any row and it fails. CSV/JSON export for auditors. |
| Approval queue | `server/src/core/engine.ts` | Durable pending requests survive reconnects/restarts. Blocking is the default; deferred submission and scoped status support longer human workflows. |
| MCP server | `server/src/mcp.ts` → `http://localhost:8787/mcp` | Tools: `spend`, `spend_status`, `budget_status`, `audit_ledger`, plus `connection_check` and `onboarding_test` for guided agent setup. Point any MCP-capable agent at it. |
| Console | `web/` | Live overview, approvals inbox, per-agent policy editor, ledger with verify + export. Dark/gold, Oranienbaum — same design language as the landing page. |
| Demo agent | `demo/` | Drives allow → escalate → deny → new-vendor → blocked-vendor scenarios end-to-end. |

## Design decisions worth knowing

- **Money is integer minor units everywhere**, using the configured currency precision. Never floats.
- **`spend` takes an optional `idempotencyKey`** — retries after timeouts or parsing errors replay the original decision instead of reserving again. Matching pending retries return/resume the same request; conflicting key reuse returns 409.
- **Default-deny posture**: unknown agent → rejected; no policy → rejected; ambiguous → human.
- **Budget modes are explicit** — blocked vendors and hard-stop budget overruns deny. Approval-override permits an authenticated operator to exceed available funds with a recorded reason; other ambiguous policy rules escalate.
- **SQLite via `node:sqlite`** — zero native dependencies, one less thing to break.
- Signing key lives in `.tollkeep/secret.key` (mode 0600), outside the database.

## Connect a real agent

For guided setup, sign in and choose **Set up an agent**. It creates the initial policy, delivers a scoped credential once, verifies a real MCP client connection and demonstrates decisions in safe simulation mode. Setup resumes after interruption; lost secrets require explicit rotation. Set `TOLLKEEP_SEED_DEMO=false` for an empty deployment. See [agent onboarding](docs/agent-onboarding.md) for the journey, recovery and API contracts.

Any MCP client (Claude Code, Claude Desktop, your own):

```json
{
  "mcpServers": {
    "tollkeep": {
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer <agent-credential>" }
    }
  }
}
```

Issue a scoped credential from the signed-in console under Agents & Policy. Each credential is bound to one agent; operators use expiring browser sessions. Console reads, exports and `/ws` require an operator session. See [access and migration](docs/access-and-migration.md) before upgrading an existing deployment.

## Phone approvals (decision links)

Any pending escalation can be decided from a phone, no operator session needed:

1. `GET /api/approvals/:id/links` (operator session) mints a one-time approve/reject link pair.
2. Opening `/decide/<token>` shows the request; one tap decides permanently — the agent's blocked call resolves and the decision lands in the signed ledger as `human:decision-link`.
3. Links are single-use, expire with the escalation, and a retap shows the spent/expired state honestly.

Raw tokens are 24 random bytes; the database stores only their sha256. To try it from a real phone, expose the server (`cloudflared tunnel --url http://localhost:8787`) and open the tunnel URL + link path.

### Automatic push (Telegram)

Every new escalation arrives on your phone with Approve/Reject buttons — no console needed:

1. Telegram → **@BotFather** → `/newbot` → copy the token.
2. Text your new bot anything, then open `https://api.telegram.org/bot<token>/getUpdates` and copy your `chat.id`.
3. Put both in `.tollkeep/env` (auto-loaded by the server, already gitignored):

```
TOLLKEEP_TELEGRAM_BOT_TOKEN=123:abc
TOLLKEEP_TELEGRAM_CHAT_ID=456
TOLLKEEP_PUBLIC_BASE_URL=https://your-tunnel.example
```

`TOLLKEEP_PUBLIC_BASE_URL` only matters off-LAN — it's the origin baked into the phone link buttons. Restart the server; the startup banner confirms `Notifications: telegram push approvals`.


Then the agent calls `spend(agent, amount, currency, vendor, purpose, rail)` —
amount in pence/cents.

## Budget accounting

Permission reserves funds; completed spend requires verified settlement. New agents use hard-stop budgets; migrated policies preserve approval-override mode. Operators must review unknown legacy obligations before authorising new work. This branch does not execute or settle payments.

## Honest prototype limits (next steps)

- Approval expiry defaults to 5 minutes, configurable from 1 minute to 7 days; deferred MCP/status polls and durable notification retries survive reconnects and restarts.
- Budget accounting uses one configured currency per agent, explicit modes and persistent reservations.
- Agent identity is bound to revocable per-agent credentials. One provisioned operator is supported initially; SSO and multi-workspace tenancy are future work.
- Ledger signing key is per-server; enterprise wants per-workspace keys + external anchoring (e.g. daily Merkle root).
- Existing deployments must migrate from the shared token to operator sessions and per-agent credentials. Production requires HTTPS and a configured public console origin; see the migration guide.

## Kill conditions

Revisit the bet if: Cloudflare/Coinbase ship cross-rail fiat policy before 100 paying teams;
no 50 paying teams within 6 months of MVP; or agent payment volume is still microscopic by mid-2027.

## Policy preview and audit history

In Agents & Policy, test an unsaved policy against a sample or compare recent requests using their recorded original context. Preview and replay do not create production requests or reservations. Saves retain versioned before/after history attributed to the signed-in operator, and ledger details show the policy version and original decision context.

## Contributing

Issues and PRs welcome. Run `npm run typecheck` and `npm run test` before
opening a PR. If you're adding a feature, the design questions that matter:
does it preserve default-deny, and does every new decision path land in the
signed ledger?

## Security

See [SECURITY.md](SECURITY.md) — trust model, vulnerability reporting, and a
hardening checklist. Please report vulnerabilities privately before opening a
public issue.

## License

Copyright © 2026 Britannic & Balkan. Apache 2.0 — see [LICENSE](LICENSE).
