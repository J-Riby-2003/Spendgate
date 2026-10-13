# Adoption integration candidate

This branch is a review candidate, not a merged or deployed release. It combines the approved policy preview, approval-context and onboarding work without rewriting their issue branches. Payment provider choice/execution in issue #2 is deliberately excluded.

## Provenance and order

Base: aec5d8199e48136efe9e6f4c96c51a4c85d44c9d on codex/issue-7-durable-approvals. This includes the identity (#1), budget/reservation (#3), durable approval (#7), and SQLite startup/process-test foundations.

Applied in order:

1. #6: 7e44904acb996db8c0532a8b8c490c8b1fc6e60b, policy preview/replay, history and original evaluation evidence (PR #11).
2. #4: a56e3e99c387d6574285050a9f1bfe117224be71, decision-ready approval context and explicit override consent (PR #12).
3. Integration-only browser fixture repair: policy updates fetch the current version, send expectedVersion and assert success.
4. #5: sole own commit 341fc1c0f037e7f0426b2242b2b8e5b2889dcc7f, resumable onboarding and safe MCP tests (PR #13).
5. Integration-only cross-feature regression test and this record.

The app.ts import conflict retains finaliseApproval from #4 and shared validation from #6. The App.tsx navigation conflict retains #4's approval refresh callback/polling and #5's empty-account/setup navigation. All original issue branches and the primary checkout remain unchanged.

## Preserved contracts

- Operator console approval calls finaliseApproval with its sixth options argument. Only overrideBudget=true plus an authenticated operator and nonblank reason can authorise an over-budget exception in approval-override mode. Absent/false consent and ordinary notes cannot silently override. Phone capabilities cannot override. New signed v2 budgetRecheck details retain overrideConsent.
- #6 constructs bounded intent-bound policy evidence inside the original production submission transaction before reservation. Retries/finalisation preserve the original digest. Approval-time budget rechecks remain separate. Existing v1/v2 ledger rows are never rewritten.
- #4 projects current approval context; #6 exposes original evaluation context. Neither is substituted for the other.
- #5 uses #1's scoped credentials and #6's pure preview evaluator. Setup and credential retries remain duplicate-safe, with one-time secret delivery and explicit recovery rotation. Connection verification is an authenticated MCP challenge. Tests update only onboarding progress, never requests, reservations, monetary ledger or policy evidence.
- Pending approvals reserve nothing; current funds are rechecked atomically at approval. UTC periods and overnight/equal-minute windows remain consistent. Permission is not payment.
- Startup uses #7's bounded SQLITE_BUSY retry before WAL/migrations; process worker failures remain visible to the test harness.

## Validation

Combined backend suites pass 179 tests across 25 files, including independent-process startup/restart/concurrency tests. All 18 isolated browser tests pass, including mobile approval context, explicit override races, onboarding from a clean account/credential recovery, phone decision links and policy preview/replay/history. Server/web type checks, production web build and whitespace checks pass.

The additional adoption-integration.test.ts exercises a real HTTP/MCP flow across features: duplicate-safe registration and one-time credential issuance; agent credential exclusion from console access; connection challenge and zero-monetary-effect onboarding tests; real pending requests; override consent/reason refusals; explicit override with signed consent; unchanged original evidence; fixed-context replay and idempotent outcome recovery. Independent integration review found no actionable production findings.

## Proposed delivery strategy

The draft integration PR targets codex/issue-7-durable-approvals so its diff contains the combined #6/#4/#5 work and integration repairs, without repackaging the foundation as new work. It contains references to issues and sibling PRs, not duplicate automatic issue-closing directives.

If the user chooses this candidate as the delivery vehicle, first land the separately reviewed #1 -> #3 -> #7 foundation chain. Retarget/reconcile this integration PR against main after that base lands, inspect the resulting diff and rerun checks before any merge. Deliver #6/#4/#5 through this integration candidate rather than also merging the sibling copies (#11/#12/#13). Mark those copies superseded only with explicit user authorisation. Alternatively retain the individual PR route and use this branch solely as compatibility evidence; do not mix the two delivery paths.

No merge, deployment, production migration, provider selection or real payment activation is authorised by candidate creation. Reservations from real authorisations remain held until verified controlled execution/reconciliation from #2; this candidate does not claim to pay or settle them. Existing historical reconciliation flags and missing evidence remain explicit rather than guessed.
