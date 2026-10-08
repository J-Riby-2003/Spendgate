# SpendGate

**The policy and approval layer above every agent payment rail.**
A Britannic & Balkan project.

Agents route payment intents through the SpendGate MCP server. Policy decides:
auto-allow, hard-deny, or escalate to a human. Every intent — allowed or not —
lands in a SHA-256 hash-chained, HMAC-signed audit ledger.

## Run it

```bash
npm install
npm run dev        # server :8787 + console :7100
npm run demo       # in a second terminal — 5 scenarios through every decision path
```

## What's inside

| Piece | Path | What it does |
|---|---|---|
| Policy engine | `server/src/core/policy.ts` | Per-agent rules: auto-approve ceiling, daily budget, approval threshold, vendor lists, new-vendor gate, day/time windows. Hard denies only for blocked vendors; everything ambiguous escalates to a human. |
| Signed ledger | `server/src/core/ledger.ts` | Append-only, hash-chained rows, HMAC-signed. `GET /api/ledger/verify` re-computes the chain; tamper with any row and it fails. CSV/JSON export for auditors. |
| Approval queue | `server/src/core/engine.ts` | Escalated intents block the agent's MCP call until a human decides in the console (or a 5-min timeout expires them denied). |
| MCP server | `server/src/mcp.ts` → `http://localhost:8787/mcp` | Tools: `spend`, `budget_status`, `audit_ledger`. Point any MCP-capable agent at it. |
| Console | `web/` | Live overview, approvals inbox, per-agent policy editor, ledger with verify + export. Dark/gold, Oranienbaum — same design language as the landing page. |
| Demo agent | `demo/` | Drives allow → escalate → deny → new-vendor → blocked-vendor scenarios end-to-end. |

## Design decisions worth knowing

- **Money is integer minor units everywhere** (pence/cents). Never floats.
- **Default-deny posture**: unknown agent → rejected; no policy → rejected; ambiguous → human.
- **Deny is rare by design** — blocked vendors only. Over-ceiling spends *escalate*, they don't bounce; the human is the safety valve, and the ledger records who decided.
- **SQLite via `node:sqlite`** — zero native dependencies, one less thing to break.
- Signing key lives in `.spendgate/secret.key` (mode 0600), outside the database.

## Connect a real agent

Any MCP client (Claude Code, Claude Desktop, your own):

```json
{
  "mcpServers": {
    "spendgate": { "url": "http://localhost:8787/mcp" }
  }
}
```

Then the agent calls `spend(agent, amount, currency, vendor, purpose, rail)` —
amount in pence/cents.

## Honest prototype limits (next steps)

- Escalations wait up to 5 min then expire — approvals belong on your phone (WhatsApp/Telegram/push), not just this console.
- Multi-currency budgets are summed naively (per-agent single currency is fine).
- Agent identity is self-declared — real deployments need API keys / agent identity (Skyfire, Nevermined-style attestation).
- Ledger signing key is per-server; enterprise wants per-workspace keys + external anchoring (e.g. daily Merkle root).
- No auth on the console API yet. Don't expose :8787 to the internet.

## Kill conditions (from the idea doc)

Revisit the bet if: Cloudflare/Coinbase ship cross-rail fiat policy before 100 paying teams;
no 50 paying teams within 6 months of MVP; or agent payment volume is still microscopic by mid-2027.
