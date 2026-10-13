# Policy Preview Implementation Plan

Goal: preview unsaved policies, compare recent requests with recorded context, and audit policy revisions and real decisions.
Architecture: one pure production evaluator; evidence constructed in submission's BEGIN IMMEDIATE transaction. Reuse #1 identity, #3 snapshots and #7 v2 signed references. No second lifecycle model.
Spec: GitHub issue #6 and docs/policy-simulation.md.

- [x] Add regression tests for overnight/equal-minute UTC windows, revisions/conflicts, side-effect-free parity/replay, immutable original evidence and migration compatibility.
- [x] Add additive history/evidence migration and atomic versioned policy writes, preserving legacy signed rows.
- [x] Extract validation; construct bounded canonical evidence inside original submission transaction; expose protected preview/replay/history/evidence endpoints.
- [x] Add policy preview/comparison/history UI and real ledger evidence details. Preserve unrestricted days and avoid Approvals.tsx (#4 ownership).
- [x] Run unit, type, build and isolated browser verification; independent review; fix findings; create stacked draft PR. Never merge or deploy.

Constraints: UTC; pending approvals reserve nothing; known vendor means previous authorisation; replay fixes each request's original context and reports missing coverage. Equal window endpoints permit only that inclusive minute. Maximum canonical evidence 16KiB. Replay default 50 / max 500 unique requests. Policy saves require expectedVersion. Existing policies migrate to explicitly labelled system baseline revisions.

Validation: 148 unit/integration tests and 9 isolated browser tests passed; server/web type checks and production build passed. Independent review found an intent-binding issue, fixed with regression tests; re-review found no remaining actionable findings.
