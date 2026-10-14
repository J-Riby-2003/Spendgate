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
- **Operator sessions and per-agent credentials, not a shared token.**
  Operators sign in with expiring browser sessions; each agent gets its own
  revocable scoped credential, verified by a one-time challenge during
  onboarding. Console reads, exports and `/ws` require an operator session;
  the MCP endpoint requires an agent credential. Still run behind TLS with a
  restricted network — see the hardening checklist below.
- **Agent identity is as strong as the credential.** Each agent acts through its
  own revocable credential, verified at onboarding — but the credential is a
  bearer token, so anyone holding it acts as that agent. Rotate promptly on
  suspicion of leakage; that requires explicit operator action today.
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
2. Protect operator sessions (don't sign in on shared machines) and treat agent
   credentials as secrets; revoke and re-issue from the console if one leaks.
3. Back up `.spendgate/` — losing the signing key means the existing chain can
   no longer be extended-verified against new rows.
4. Keep `SPENDGATE_TELEGRAM_*` values in `.spendgate/env` (gitignored), never
   in committed files.
