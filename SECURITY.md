# Security

## Reporting a vulnerability

Email **support@britannicbalkan.com** with the subject `SpendGate security`.
Please include: affected version/commit, reproduction steps, and impact. You'll
get an acknowledgement within 48 hours. Please don't open a public issue for
unfixed vulnerabilities.

## Scope

In scope: the MCP server (`server/`), console (`web/`), decision-link flow,
Telegram notification path, ledger verification, auth model.

Out of scope: deployments you operate yourself (see trust model below),
third-party MCP clients, and the demo agent.

## Trust model — read this before deploying

SpendGate is an **early-stage, single-operator tool**. Be honest with yourself
about what it does and doesn't protect:

- **The ledger is tamper-evident, not tamper-proof.** Rows are hash-chained and
  HMAC-signed, and `/api/ledger/verify` detects modification. But the operator
  holds both the signing key (`.spendgate/secret.key`) and the database — the
  chain proves continuity, not independence. External anchoring (e.g. daily
  Merkle root elsewhere) is future work.
- **One bearer token protects all mutations and the MCP endpoint.** Read-only
  GETs and `/ws` are unauthenticated. Do not expose port 8787 to the internet.
  Per-agent scoped credentials are planned, not implemented.
- **Agent identity is self-declared.** Any client presenting the token can claim
  any agent name. Real deployments need per-agent keys.
- **Approval links are single-use and expire** with their escalation, and raw
  tokens are stored only as sha256 — but anyone holding a minted link can decide
  it, so treat links as secrets while pending.
- **SpendGate decides; it does not execute payments.** The `spend` tool
  evaluates intent. It does not move money, verify supplier charges, or
  guarantee that a blocked intent wasn't attempted elsewhere. Rail names
  (`card`, `x402`, `ap2`, …) are labels for policy rules, not live integrations.

## Hardening checklist for real deployments

1. Run behind a reverse proxy with TLS and network restrictions, not on the
   open internet.
2. Restrict the console token (`SPENDGATE_TOKEN`) to the operator; rotate it if
   it ever leaks.
3. Back up `.spendgate/` — losing the signing key means the existing chain can
   no longer be extended-verified against new rows.
4. Keep `SPENDGATE_TELEGRAM_*` values in `.spendgate/env` (gitignored), never
   in committed files.
