# Scoped access implementation plan

**Goal:** Resolve GitHub issue #1 with operator sessions, scoped agent credentials and authenticated console data.
**Spec:** https://github.com/J-Riby-2003/spendgate/issues/1 and the approved plan in this chat.
**Architecture:** Local operator and hashed opaque sessions/credentials in SQLite; server-resolved principals at HTTP, MCP and WebSocket boundaries. Credential audit is separate from monetary ledger. Public decision links retain their existing capability checks.
**Constraints:** Preserve legacy ledger values and primary local changes. Work only in the isolated branch. Draft PR only; no merge or deployment. Provision one operator; scrypt passwords, login throttling, HttpOnly/Secure production cookies, CSRF/origin checks, idle/absolute expiry, stream revocation without request cancellation.

- [x] Review and commit eight visual/title changes separately as the deployed baseline.
- [x] Add versioned migrations and shared synchronous BEGIN IMMEDIATE transaction plumbing.
- [x] Test and implement operator sessions, credential creation/rotation/revocation and audit.
- [x] Test and enforce console HTTP/MCP/WebSocket access and authenticated decision attribution.
- [x] Update console sign-in/logout and one-time credential management; validate browser flows with temporary data/ports.
- [x] Update demo and smoke clients and document deployment migration/shared contracts.
- [ ] Independent whole-branch review and fix material findings.
- [ ] Final validation, push and draft PR.

Review focus: anonymous read/export leakage; identity mismatch in every MCP tool; background traffic defeating idle expiry; credential revocation during an active approval stream; upgrades preserving existing ledger values and capability links.

Execution record:
- Baseline: 58 tests passed; visual baseline commit f42c053.
- Authentication tests first failed because provisioning did not exist; eight tests then passed.
- Access tests first failed because the application factory did not exist. Fixed WebSocket test event argument; MCP revocation now sends a protocol error so clients do not remain waiting. Pending approvals remain intact.
- Idle renewal regression failed against background reads before separating explicit user activity; now passes.
- 78 unit/integration tests, server/web/demo typechecks and five isolated browser tests pass.
- Ruling: Explicit operator activity renews idle time; background snapshots and status checks do not. This prevents a busy WebSocket feed from defeating idle expiry.
- Ruling: No legacy bearer fallback, because a previously agent-shared token cannot establish operator identity. Deployment requires explicit operator provisioning and client cutover.
- Ruling: Migration IDs are named and immutable; shared bound transactions reject nesting. Downstream issue03 migration IDs are documented and reserved.
- Independent review: no Critical findings or access bypasses; one Important inherited notification logging gap. A synthetic secret-bearing upstream-error test failed before redaction, then passed. Push/confirmation handlers now emit generic diagnostics; Telegram response bodies are not included in errors. Notifier subscriptions are released when the application closes.
- Final: Ruling: Preserve existing decision-link status/detail reads after expiry/use, while rejecting decision execution. They remain scoped to the original request/action; changing their existing status UX is outside this access migration. Cost if wrong: a holder of an old capability can still see that request's existing details.
- Final: Ruling: Keep the synchronous transaction contract and reject Promise returns; arbitrary callbacks can still schedule later work, which must be prohibited by downstream callers. Cost if ignored: work scheduled outside the transaction cannot be rolled back.
- Final: Ruling: Keep conservative socket-source and account login throttling, documenting shared-proxy impact. Cost: legitimate attempts behind one proxy can share a temporary lockout.
- Final: Ruling: Leave durable approval finalisation/recovery to issue #7. Revoking credentials preserves existing pending rows and the active engine waiter; this branch does not add restart recovery semantics. Cost: inherited recovery limits remain until #7 lands.
- Standalone client verification: all smoke checks and five demo scenarios passed with separate scoped agent connections on a fresh database and ephemeral port; operator approvals ran in a separate harness.
