# Access, credentials and migration

Issue #1 separates console operators from MCP agents. One locally provisioned operator is supported initially. SSO, account recovery and multi-workspace tenancy are future work.

## First setup and upgrade

1. Back up the existing data directory while the server is stopped, including the SQLite database and signing key. Keep the backup private. Do not copy runtime files into Git.
2. Install/build the new version. Before starting, run `npm run operator:provision -w server -- operator` with the same `SPENDGATE_DATA` as the server. The terminal prompts for a hidden password of 12–1024 characters. Noninteractive provisioning reads the password from stdin; never pass it in command arguments. Provisioning refuses to replace an existing operator.
3. Production must configure `SPENDGATE_PUBLIC_BASE_URL` to the externally visible HTTPS origin, including any nondefault port. This is required for login, mutation and WebSocket origin validation. Configure it for the public console origin even when a proxy terminates TLS. Development uses same-origin requests; the Vite proxy supports the default local workflow.
4. Start the server and sign in using the new operator account. In Agents & Policy, issue a separate credential for each agent. Save each secret in that agent's secret store; the console reveals it only at creation or rotation.
5. Replace the MCP client's old shared token with its scoped agent credential. Restart/reconnect the client and test its own budget/ledger tools.
6. Retire `.spendgate/console.token` and `SPENDGATE_TOKEN` from configuration and clients. Neither is accepted by the new server. Clear old browser session storage. Do not reuse the formerly shared token as an operator password.

This is an explicit cutover: old clients lose access until updated. There is no mode that reopens reads or accepts the shared bearer. Existing agent IDs, policy JSON, approval rows, decision links, ledger values, hashes and signatures are preserved. Migration changes SQLite schema/storage, not existing ledger content. Rolling the binary back reinstates the old access weaknesses; use the protected backup for a deliberate rollback rather than deleting identity tables in place.

## Operator sessions

Passwords use Node's salted scrypt KDF with a random 16-byte salt and 64-byte derived key. Session and agent secrets use 32 random bytes; only SHA-256 hashes are persisted. Passwords, bearer secrets, cookies and decision tokens are never included in auth logs or audit events.

Sessions use an HttpOnly, SameSite=Strict cookie, with Secure enabled in production. The CSRF token is separate, returned by login/session status and held in browser memory. Mutations require the session, matching Origin and `X-CSRF-Token`; login also requires Origin. Console API reads and WebSocket upgrades require an operator session. Agent bearer credentials do not grant console access; operator cookies do not grant MCP access. Sensitive API responses use `Cache-Control: no-store`; responses use `Referrer-Policy: no-referrer`.

Default idle expiry is 30 minutes, absolute expiry eight hours. Set `SPENDGATE_SESSION_IDLE_SECONDS` (60–86400) and `SPENDGATE_SESSION_ABSOLUTE_SECONDS` (300–604800). Invalid values fail startup. Effective expiry is the earlier limit. Background reads, status checks and WebSocket events do not renew idle time; authenticated activity calls from pointer/keyboard interactions do. Logout invalidates the server-side session and closes its WebSockets immediately. Expiry closes WebSockets within one second; every read/event validates the session before releasing data.

Five attempted logins per source address or username in 15 minutes trigger a persisted throttle. Successful login clears that source/account's counters. The server uses its actual socket peer, not caller-controlled forwarding headers; shared reverse proxies therefore share a source limit. This conservative first implementation may throttle multiple legitimate users behind one proxy.

## Shared interfaces

`server/src/auth.ts` exports:

```ts
type OperatorPrincipal = { kind: 'operator'; operatorId: string; sessionId: string };
type AgentPrincipal = { kind: 'agent'; agentId: string; credentialId: string };
type Principal = OperatorPrincipal | AgentPrincipal;
```

`requireOperator` and `requireAgent` are Express middleware; validated identity is in `res.locals.principal`. `authenticateSession(token, touch = true)` and `authenticateAgent(token)` return the corresponding principal or null. `assertAgentActive(principal)` revalidates credential/agent existence at a tool boundary. `buildMcpServer(principal)` requires an authenticated agent principal. Existing optional MCP `agent` arguments must match that identity; omitting them uses the credential identity. All three tools enforce this, and unfiltered `audit_ledger` returns only that agent's records.

Console decisions pass `operatorId` to the engine, which retains its existing `human:<operatorId>` ledger convention. Caller-supplied `by` is ignored. Public phone-link decisions retain `human:decision-link`: they are capability-authorised, not attributed to an operator session.

`authEvents` emits `session-revoked(sessionId)` and `credential-revoked(credentialId)` only after successful storage changes. Credential revocation/rotation closes active MCP streams with a protocol error. It does not cancel, delete or decide pending approvals. Issue #7 owns resumable request lookup and durable finalisation; this change does not claim to implement those.

## Credential API and audit

All endpoints below require an operator session; mutations also require Origin/CSRF:

- `GET /api/agents/:agentId/credentials`: metadata only (`id`, `agentId`, `createdAt`, `revokedAt`).
- `POST /api/agents/:agentId/credentials`: returns `{ id, agentId, secret }` once.
- `POST /api/agents/:agentId/credentials/:credentialId/rotate`: atomically issues a replacement and revokes the old credential; returns the replacement secret once.
- `DELETE /api/agents/:agentId/credentials/:credentialId`: revokes an active credential.
- `GET /api/security-audit`: latest 200 security events, operator-only.

The append-only application audit records provisioning and credential creation/rotation/revocation, operator ID, agent/credential IDs, replacement ID and timestamp. It is separate from the signed monetary ledger; it does not claim cryptographic tamper evidence. Deleting an agent revokes its credentials before removal. Reusing that agent ID cannot revive old credentials.

## Shared migrations and transactions

`server/src/core/migrations.ts` owns `Migration { id; up(db): void }`, `migrations` and `migrate(db, steps = migrations)`. Append immutable named migrations; never edit a deployed migration or renumber it. Applied IDs live in `schema_migrations`. Each migration runs under BEGIN IMMEDIATE with its applied-ID record in the same transaction. Failure rolls both back and allows retry.

Issue #1 supplies `issue01_001_legacy_schema` (idempotent bootstrap for existing databases) and `issue01_002_identity`. Reserved downstream IDs: `issue03_001_budget_policy_modes`, `issue03_002_reservation_accounting`, `issue03_003_legacy_reconciliation`.

Use the bound `withImmediateTransaction<T>(callback: () => T): T` from `core/store.ts`, or the database-parameter version from `core/transactions.ts`. It uses BEGIN IMMEDIATE, commits on synchronous success and rolls back on error. Nested transactions are rejected, not silently committed. Callbacks must be synchronous: never await, schedule work, or return a Promise inside a transaction. Compose unwrapped storage operations within one outer transaction; do not call a transaction-owning credential operation inside a budget/finalisation transaction.

Issue #3 owns reservations keyed by requestId; #7 owns approval finalisation; #2 owns payment execution/reconciliation. They consume authenticated agent identity rather than establishing another identity model. #6 owns policy history; #5 reuses this credential issuance API.

## Demo and smoke clients

Export `SPENDGATE_AGENT_CREDENTIALS` as a JSON object mapping the seeded agent IDs to their independently issued secrets (`finance-01`, `procurement-02`, and `crawler-01` for the demo). Populate it from a private secret store, never a checked-in file or pasted command containing actual secrets. Each simulated agent uses a separate MCP connection. These processes receive no operator credential. Approve their escalations separately in the console.

`npm run demo` uses `SPENDGATE_URL` as the server origin; `node scripts/agent-smoke.mjs` uses it as the full MCP endpoint (existing conventions). Both allow enough client timeout for the five-minute approval window. The smoke script pauses for a human decision on its idempotency escalation.

## Validation isolation

`npm test` uses throwaway data directories and ephemeral ports for HTTP/MCP/WebSocket tests. `npm run test:e2e` creates a fresh temporary data directory, provisions a test-only operator and starts its own server on port 18871 (override `SPENDGATE_E2E_PORT`). It refuses to reuse a running server. Do not set `SPENDGATE_DATA` to a real deployment when running tests. Tests never need production secrets or notifications.
