# Durable approval requests

Issue #7 builds on scoped access (#1) and budget reservations (#3). A durable request is permission workflow state, never proof of payment. Pending human requests reserve nothing. Approval rechecks current budget and acquires the #3 reservation atomically. Only an authenticated operator, with a recorded nonblank reason and an approval-override policy, can approve an overrun. Phone capabilities cannot grant overrides.

## Agent protocol and compatibility

`spend` keeps blocking by default. Its final text still begins ALLOWED, DENIED, APPROVED, REJECTED or EXPIRED. It also returns structuredContent with the durable snapshot. Opt into `deferred: true` to return immediately when human approval is needed:

```json
{"decision":"PENDING","requestId":"<canonical UUID>","approvalId":"<approval UUID>","expiresAt":"<ISO deadline>","ledgerSeq":null}
```

Other snapshot fields are intent, rule, reason, decidedBy and authorisationExpiresAt. expiresAt is the approval deadline; authorisationExpiresAt is the separate execution-permission deadline from #3, null until authorised. PENDING is not an error and does not permit execution. ALLOWED/APPROVED authorise the exact request and reserve funds; they do not mean paid. The canonical requestId is the immutable SpendIntent.id, also used by #3's reservation. approvalId is a separate human-queue/phone-link identifier.

Call `spend_status({requestId, waitMs?: 0..30000})` to read or briefly wait for an outcome. Every tool invocation validates the scoped agent credential; foreign and unknown IDs both return 404 without request details. Revocation still closes active streams. A new valid credential for the same agent can retrieve its requests. Closing/cancelling a stream removes only that observer, never the request. Status observation includes commits from other server processes.

Supply a stable idempotencyKey before making a request. Matching pending retries attach to the same request; final retries replay the same result. Reusing a key with different normalised intent fields returns 409. Keys are scoped by server-derived agent identity. Omitting the key means each submission creates a new intent; request IDs cannot recover a lost submission response unless the client received the ID or retained a key. Configure a sufficiently long client/proxy timeout for blocking clients, or use deferred submission and status calls. No stateful MCP session or reconnect handshake is required.

## Deadlines and finalisation

SPENDGATE_APPROVAL_TIMEOUT_MS defaults to 300000 and accepts integer values 60000..604800000 inclusive (one minute to seven days). Invalid values fail startup. Each approval persists its chosen expiresAt; later configuration changes do not change it. At now >= expiresAt, approval/rejection attempts reconcile expiry and cannot approve. Status reads enforce this boundary too. Startup reconciles overdue work before accepting traffic or sending notifications; a periodic sweep handles unobserved work.

The separate AUTHORISATION_TTL_MS currently gives execution permission five minutes from reservation acquisition. #2 owns execution gating/reconciliation and future configuration of that deadline. Neither approval sweeps nor elapsed reservation timestamps release already-final execution holds. A payment could still complete; verified execution evidence must determine settlement/release.

`finaliseApproval(approvalId, action, actor, note?, tokenHash?)` is synchronous and owns BEGIN IMMEDIATE. It commits queue status, a single signed ledger outcome, idempotency settlement, reservation transition, phone-link invalidation and outbox obsolescence together. Failure rolls all back. Console and phone routes share this path; no waiter writes outcomes. Events broadcast after commit. The trusted DecisionActor is operator/id, decision-link, expiry or policy; caller-supplied agent metadata never establishes an actor. The compatibility decide wrapper receives operator IDs from authenticated routes.

## Notification delivery

Pending approval creation enqueues its outbox job in the same transaction. With Telegram configured, a worker claims a durable 60-second lease, sends with a 10-second network timeout, and records delivery. It retries transient failures with exponential delays starting at one second, capped at five minutes, for at most six attempts. Provider 4xx errors other than 408/429 are permanent. Errors are reduced to status codes or a generic failure; provider responses, bearer tokens and raw decision tokens are not logged or persisted. Unconfigured workers leave jobs queued for later configuration.

The worker recovers expired leases after restart and checks pending status/deadline before starting each send. Finalisation makes unstarted jobs obsolete and invalidates all sibling links. External delivery is at least once: a process/network failure after Telegram accepts a message can cause a duplicate. A request can also finalise while an external send is already in flight; any delivered buttons are inert. Exactly-once external messages cannot be guaranteed by a local SQLite transaction. Retries mint fresh capability pairs because only token hashes persist; all pairs share the approval's persisted deadline and one final outcome.

GET /api/approvals and state snapshots include notification {configured,status,attempts,nextAttemptAt,lastError,deliveredAt}. The console shows retry/failed delivery status and receives status changes through its authenticated state feed. Console decisions remain available when push delivery fails. Optional decision-confirmation messages remain best effort; they contain no action links.

## Ledger extension and #6 evidence integration

Historical version-1 rows retain their exact signed canonicalisation, hashes and signatures. New engine decisions use eventVersion 2: a fixed-order JSON array of version, the original fields and structured details. CSV/JSON exports include version and details. Details bind actor, note, optional evidence reference and a separate approval-time budgetRecheck. Delimiter characters cannot move values between version-2 fields.

#6 owns PolicyEvidenceEnvelope {schemaVersion:1,policyVersion,evaluatorVersion,evaluatedAt,context:{agentCurrency,budget,vendorKnown},verdict:{decision,rule,reason}}. #6 validates deterministic canonical UTF-8 with a 16KiB maximum (reject, never truncate) and computes its digest. The trusted synchronous hook `submitRequest(input, {evidence:{schemaVersion,digest}})` accepts a positive integer schemaVersion and lowercase SHA-256 digest. Agent-facing MCP schemas expose no evidence input. The first submission stores the original reference immutably; retries and approval-time budget rechecks never replace it. #6 must construct the envelope from the same production evaluation context within the submission transaction when it integrates; this branch does not construct or verify the full envelope.

Ledger verification proves chain/signature integrity, not completeness or truth of external evidence. Null evidence means absent, including all legacy records; it never means evidence verified. #2 must use the versioned append hook for execution events within its own execution/reconciliation transaction, without treating permission as payment.

## Upgrade and legacy reconciliation

Stop writers and back up the database plus signing key as described in access-and-migration.md. #1's runner applies issue07_001_durable_requests atomically. It adds schema only; old ledger values are not rewritten. Canonical IDs derive from recorded intent IDs. An explicit upgrade deadline policy uses recorded creation + five minutes, capped by an earlier existing phone-link deadline, and records that policy in approval_recovery_audit. It does not claim to know the old environment's timeout. Invalid/missing dates are flagged rather than invented.

Existing signed outcomes are projected when unambiguous. Legacy rejected-by-expiry rows with signed EXPIRED outcomes become expired; contradictory terminal decisions remain untouched and require reconciliation. Missing terminal outcomes, duplicate/conflicting associations and orphaned pending idempotency claims are never guessed from timestamps. No new historical actor, decision timestamp, evidence or payment outcome is fabricated. Upgrade audit timestamps identify the migration action itself.

Operator-only GET /api/approval-recovery lists flagged requests, unlinked keys and recovery audit. Flagged requests cannot finalise or replay as a verified outcome; affected agents cannot create new authorisations. An unlinked key returns 409 and cannot silently create a duplicate. Resolving these ambiguous historical records requires a separately reviewed, audited repair using original records/evidence; this branch provides diagnostics, not a generic endpoint to invent or attest a replacement outcome. Keep original backups and signed rows. #3's separate legacy budget reconciliation remains necessary where financial obligations are unknown.

## Contracts for #4 and #6

#4 consumes requestId, persisted expiresAt, status, note, authenticated decidedBy and notification projection; it uses the existing protected decision endpoint. Approval controls must respect exact server expiry and handle budget conflicts without assuming a terminal decision. Budget spent/reserved/remaining comes from #3.

#6 integrates its validated original evidence reference through submitRequest's trusted options, inside the original evaluation transaction; approval-time budget evidence remains a separate signed field. No second evaluator, identity model or reservation model is introduced.

## Validation

Unit/integration tests cover durable pending/final retries, conflicting key content, scoped status, disconnect/reconnect, exact deadline/configuration limits, no-waiter completion, ledger rollback including link/hold rollback, persisted notification errors/retries, and historical/version-2 hash verification. Independent OS processes reopen the same database, recover requests after termination, race decisions and reclaim notification leases. Browser tests preserve the console and single-use phone approval flows.
