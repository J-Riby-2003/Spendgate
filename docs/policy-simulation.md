# Policy preview, replay and history

Issue #6 builds on authenticated operators (#1), budget accounting (#3) and durable approval finalisation (#7). Preview and replay call the same pure evaluator as real submissions. They never submit requests, make payments, write approval/outbox/idempotency rows, acquire reservations, emit production events or append ledger entries.

## Console

In Agents & Policy, edit the policy then open Policy preview. Evaluate a sample amount/vendor/purpose in the agent's configured currency against the unsaved draft. The response shows allow/deny/escalate, the exact rule and reason, the evaluation timestamp and the budget/vendor context. The sample uses MCP as its rail; rails currently do not change policy rules. Preview uses one consistent current server snapshot; it does not offer arbitrary caller-supplied budget/history context.

Compare recent requests compares the current saved policy and unsaved draft against the same original context for each selected request. The default is 50 unique requests, maximum 500. Selection is by original durable submission order, including pending requests; finalisation and payment lifecycle events cannot duplicate a request. The results count decision transitions and changed rules/reasons separately. Neither side substitutes historical human approvals for evaluator ALLOW results.

Coverage states selected/evaluated/unavailable counts. Legacy requests without context, invalid evidence, reconciliation flags, unsupported evaluator versions and requests in a different currently configured currency are excluded with reasons. No context is reconstructed from present-day balances or completion timestamps. This is a fixed-context sensitivity comparison, not a chronological counterfactual: it does not predict how earlier changed outcomes would change later funds or vendor history. Historical replay is not a guarantee of future outcomes.

Policy history shows the latest 50 immutable revisions with UTC timestamp, server-derived operator ID and complete before/after policy values in atomic minor units. Saves require the version loaded with the form. A concurrent change returns 409; the draft stays visible until the operator explicitly reloads the current policy. Unrestricted allowedDays remains '*'. Ledger details show the policy version, original evaluator outcome and exact context separately from a later human decision and approval-time budget recheck. #4 owns approval-screen context; Approvals.tsx is intentionally unchanged.

## Rule and context semantics

Amounts are atomic minor-unit integers and currencies use #3's shared catalogue/precision. Unsupported/mismatched currencies and malformed requests are validation errors, not fabricated policy denials. Preview checks the same legacy reconciliation gates as production. Hard-stop/approval-override rules, reservations and blocked-vendor precedence come from #3.

Daily periods and allowed days/windows use UTC. Pending human requests reserve nothing. Known vendor means a previous ALLOWED/APPROVED authorisation, not evidence of completed payment; matching is case-insensitive. Completed-payment history is a separate concept owned by execution.

Time windows are inclusive at minute precision. 22:00–06:00 includes 22:00 through 06:00 across midnight. At 00:00 the allowed-day check uses that new UTC calendar date, not the previous evening's date. Equal endpoints retain the existing same-minute meaning: 08:00–08:00 permits 08:00:00 through 08:00:59, not an unrestricted day. Null is the explicit unrestricted window.

## Protected API

All routes require #1's operator session; POST/PUT require Origin and CSRF. Agent credentials grant no access. Responses are no-store.

- POST /api/policies/:agentId/preview: `{policy, sample:{amount,currency,vendor,purpose,rail}}`; returns verdict, context, evaluatedAt, evaluatorVersion, currentVersion and assumptions.
- POST /api/policies/:agentId/replay: `{policy, expectedVersion, limit?:number}`; positive integer limit 1..500. Returns currentVersion, coverage, changedOutcomes, changedReasons, transitions, rows, unavailable and assumptions. Stale version is 409.
- PUT /api/policies/:agentId: existing policy fields plus required positive integer expectedVersion; returns policy and policyVersion. Caller actor/timestamp fields are ignored. This is an intentional API cutover: scripts must fetch current policyVersion first.
- GET /api/policies/:agentId/history?limit=50: returns revisions, integer limit 1..200.
- GET /api/requests/:requestId/evidence: returns `{integrity,digest,envelope}`; integrity is verified/invalid/unavailable. Unknown request is 404. Legacy requests return unavailable.
- /api/state agents and /api/policies include policyVersion.

## Shared evidence contract

`core/policy-evidence.ts` owns PolicyEvidenceEnvelope schema 1, encodeEvidence and evaluateContext. Envelope fields are schemaVersion, intentDigest, policyVersion, evaluatorVersion, evaluatedAt, context `{agentCurrency,budget:BudgetSnapshot,vendorKnown}` and verdict `{decision,rule,reason}`. intentDigest binds the canonical request identity and all normalised intent fields using SHA-256 of JSON array `[id,agentId,amount,currency,vendor,purpose,rail]`.

The budget schema is #3's snapshot, never another reservation model. Encoding validates exact fields, finite integer bounds, ISO timestamps and budget arithmetic, recursively sorts object keys lexicographically, serialises compact JSON and hashes its UTF-8 bytes with SHA-256. Canonical envelopes exceeding 16KiB are rejected, never truncated. The current evaluator version is policy-utc-v2. A future rule change must version the evaluator and either retain compatible replay support or report old context as unavailable.

Production constructs and persists the envelope inside submitRequest's original BEGIN IMMEDIATE transaction, from the policy version, budget snapshot, vendor membership, time and verdict actually used. It is captured before reserving allowed funds. A reservation/ledger failure rolls back the evidence too. No caller supplies context, envelope or digest; the earlier trusted reference-only hook now rejects supplied evidence. Idempotent retries return original work without creating or replacing evidence.

#7's existing evidence_json stores only `{schemaVersion:1,digest}` and its eventVersion-2 details sign this reference. Approval finalisation preserves the original reference; budgetRecheck is a separate signed field. No third ledger format is introduced. Evidence reads validate the envelope digest and request-intent binding; finalised requests additionally require matching signed ledger intent, hash and HMAC. 'Verified' means these checks passed, not that external context is independently proven. Pending evidence has a durable digest reference but no final ledger signature yet. Whole-chain integrity remains /api/ledger/verify, displayed separately in the console.

## Migration and ownership

Stop writers and back up SQLite plus secret.key as described in access-and-migration.md. Immutable migration issue06_001_policy_history_evidence adds policy_revisions and policy_evidence. Existing policies receive version 1 labelled source=migration, changedBy=system:migration, before=null and the migration timestamp. That timestamp is explicitly not the original policy creation time. No original operator or earlier history is invented. No evidence is fabricated for legacy requests, including approvals still pending during upgrade. Version-1 ledger rows, hashes and signatures remain unchanged.

All store.upsertPolicy calls now append history and update the active policy in the same transaction, composing into an existing transaction where present. API creation/saves use authenticated operator IDs; seed writes identify system:seed; trusted internal writes identify system:internal. Revisions are protected from UPDATE/DELETE by database triggers. Agent deletion preserves history; recreation continues monotonically increasing versions with before=null for a newly created active policy. History is application audit, not a separate signed chain.

#5 should call preview/replay services instead of introducing another evaluator. #4 can fetch original evidence through the protected request endpoint while keeping its live approval-time budget context separate. #2 must preserve the original decision reference and use #7's version-2 lifecycle append contract; it must not replace original evidence with settlement context.

## Verification

Unit/integration tests cover thresholds, hard-stop/override budgets, held funds, normalised vendors, currency mismatch, UTC overnight/equal-minute/day boundaries, deterministic bounded envelopes, failed-write rollback, original evidence through approval/retry, invalid evidence and tampered final/pending intents, history migration preservation, authenticated attribution, stale/racing saves, replay bounds/coverage and zero simulation mutations. Isolated browser tests cover preview, comparison, history, original ledger context and stale-form recovery alongside the existing authentication/budget/phone approval journeys.
