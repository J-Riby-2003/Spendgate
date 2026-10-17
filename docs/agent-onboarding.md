# Guided agent onboarding

Issue #5 composes authenticated identity (#1), currency/budget rules (#3) and versioned policy/simulation (#6). It does not own payment execution, budget reservations or approval finalisation.

## Operator journey

Sign in, then choose **Set up an agent** (also linked from an empty overview and Agents & Policy). Enter an agent ID, display name and one configured currency; choose the initial policy; create and save a scoped credential; connect Claude Code; run a connection challenge; and run safe policy tests. New policies default to a hard budget stop and human review of new vendors. Amounts respect the selected currency precision. Budget periods are UTC.

Form details persist when Continue is selected. A refresh, logout or process restart resumes the latest unfinished journey for that authenticated operator. Unsubmitted field edits are not autosaved. Only one unfinished journey per operator is allowed; racing starts converge on it. Draft updates require `expectedRevision`. Creation binds to that exact saved draft/revision, and retries of the same submitted setup reuse its agent and initial policy revision.

The journey references its original agent generation using the immutable initial policy revision. Deleting and recreating an agent ID cannot attach its old onboarding or credentials to the replacement. Unavailable unfinished journeys offer **Abandon setup and restart**. Abandonment changes progress only: it does not delete agents, revoke credentials, cancel pending requests or release funds. Manage those separately through their existing controls. Completed journeys remain completed even if their credential is later revoked; use Agents & Policy to manage credentials, or start another agent.

## Credential delivery and recovery

The existing credential creation/rotation endpoints accept an optional `onboardingId`. They use #1's credential generation, hashing, security audit and revocation events. The journey association and credential mutation commit in the same existing transaction.

Only the first successful creation/rotation response contains a secret. Repeating creation returns the original credential ID with `secret: null`. Repeating rotation with the same original credential ID returns the same replacement metadata with `secret: null`; it never rotates that replacement implicitly. The UI preserves the original ID when retrying an action whose response was lost. A later, explicitly confirmed recovery action can rotate the current credential again. An explicitly confirmed onboarding rotation can also replace its revoked credential, provided the original agent generation still exists.

Raw secrets exist only in the creation/rotation response and current component memory. They are not stored in onboarding rows, browser storage, configuration snippets or logs. Leaving the credential step clears the in-memory secret. The operator saves it in their private agent secret manager and loads `SPENDLOCK_AGENT_TOKEN` into the environment that launches Claude Code. The copyable `.mcp.json` references that variable in the Authorization header, with `type: http` and the console origin's `/mcp` URL. Merge it with existing configuration rather than replacing other servers. See [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).

## Actual MCP connection check

An authenticated operator creates a random, single-use, ten-minute challenge. Only its SHA-256 hash is stored. It is bound to the journey, agent and exact credential. Creating a fresh challenge replaces older unused challenges for that journey.

The external MCP client calls `connection_check({challenge})` using its agent bearer credential. The server revalidates credential activity, original agent generation, policy availability and challenge binding under the writer transaction before recording success. Wrong agent/credential, revoked credentials, expired/used challenges and abandoned journeys cannot verify it. This is evidence of an authenticated client tool call; clicking a browser status button cannot mark it connected. #1 currently grants a fixed own-agent permission set, so the response reports those permissions rather than inventing configurable scopes. No spend or budget mutation occurs.

Connection errors explain how to check the endpoint, environment variable, rotated credentials and challenge expiry. After client success, **Check connection status** reads the persisted result. The check does not attest the safety of an agent's future prompts or actions.

## Safe test mode

After connection verification, the operator can run a sample from the console or ask the client to call `onboarding_test({onboardingId,sample})`. Both call the same #6 `preview` service, which normalises the request, enforces currency/reconciliation gates and uses the production evaluator. Agent callers are restricted to their exact journey and credential. An invalid sample is an error, not a fabricated policy denial.

Results distinguish the saved-policy outcome from three explicitly labelled illustrative policies. Illustrations use one atomic unit, the example vendor, an unlimited daily budget and unrestricted UTC days/hours; the approval example has a one-unit threshold, and the denial example blocks that vendor. They use the existing read-only server budget/vendor snapshot. Each result includes the exact rule, reason, context and next action. Illustrative policies remain unsaved and do not promise that the saved policy can yield all three outcomes.

Tests update onboarding progress only. They never call submitRequest, finaliseApproval, a payment provider, reservation mutations or appendLedger; they create no production requests, idempotency claims, policy revisions, policy evidence, notifications, approvals or ledger entries. Simulated approval means **Approval required**, never a completed human decision or payment. Real tools remain available to a scoped credential; onboarding instructions explicitly request only connection_check/onboarding_test, not spend.

## API and migration

All console routes below use the existing operator session/Origin/CSRF protections and no-store responses:

- `GET /api/onboarding`: recent nonabandoned operator-owned journeys, metadata only.
- `POST /api/onboarding {requestId}`: idempotent start; returns the existing unfinished journey if any.
- `GET /api/onboarding/:id`: owner-scoped progress; no secret/challenge retrieval.
- `PATCH /api/onboarding/:id {expectedRevision,draft}`: validated form fields only; rejects stale/inactive drafts.
- Existing `POST /api/agents` additionally accepts `onboardingId`, `expectedRevision`, and initial `policy`; one shared registration service creates the agent, versioned policy and progress atomically.
- Existing credential creation/rotation routes optionally accept `{onboardingId}` for duplicate-safe delivery.
- `POST /api/onboarding/:id/challenge`: returns a fresh raw challenge once and its expiry.
- `POST /api/onboarding/:id/test {sample}`: pure policy tests, then progress update.
- `POST /api/onboarding/:id/complete`: requires active credential, verified MCP contact and safe test progress.
- `POST /api/onboarding/:id/abandon`: closes unfinished progress without altering its resources.

Immutable migration `issue05_001_onboarding` adds only onboarding_sessions and onboarding_challenges plus their indexes. It uses #1's migration runner and #1/#3/#6 transactions; old agents, policies, credentials, approvals, reservations, evidence and signed ledger rows are untouched. Existing deployments are not forced into onboarding. Back up stopped SQLite and secret.key before upgrading as described in access-and-migration.md.

Set `SPENDLOCK_SEED_DEMO=false` to start a genuinely empty deployment. Omission retains existing demo seeding for compatibility; it does not remove existing demo agents. Operator provisioning remains the existing first setup step.

## Verification and integration

Backend tests cover empty startup, ownership/CSRF, revision conflicts, concurrent HTTP submissions, independent OS-process writers/reopens, one-time delivery, rotation recovery, challenge expiry/reuse/foreign identity, revocation, deleted-ID generation guards, abandonment and zero simulation monetary side effects. Browser tests launch their own empty server/database and cover the complete failed-check/retry journey plus mobile refresh/resume and a deliberately dropped committed rotation response.

This branch starts at #6 commit 7e44904. Shared-file overlaps with sibling #4 are App.tsx/api.ts and the registration area of app.ts; preserve #4's explicit budget-override consent and approval-context changes during coordinated integration. #7's independently supplied process-startup fix must be integrated by the coordinator before combined readiness is claimed. No merges or deployments are part of this work.
