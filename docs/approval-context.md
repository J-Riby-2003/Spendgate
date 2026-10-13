# Decision-ready approval queue

Issue #4 consumes identity (#1), budget accounting (#3) and durable finalisation (#7). It adds a derived context projection, not a second request, reservation or payment lifecycle.

## API

Protected `GET /api/approvals/:id/context` returns the approval plus `requestId`, notification projection and `context`. The same context is attached to each pending/recent row in `/api/approvals`, `/api/state` and authenticated state events. Unknown IDs return 404; anonymous and agent access return 401. Responses retain no-store caching.

`shared/approval-context.ts` defines the projection. Each queue/context read uses a single deferred SQLite read transaction. Context includes serverNow, agent display name, budget preview, bounded vendor activity and advisory approve/reject eligibility. Server decisions always recheck identity, expiry and funds in #7's finalisation transaction. Context reads do not finalise requests; the existing expiry reconciliation at API/sweep boundaries still does.

Budget preview consumes #3's BudgetSnapshot. Pending human requests have no reservation. Projected remaining subtracts this request once from current available funds; final approvals add nothing further. Null remaining means unlimited. Pending requests compete for funds, so a preview is not a guarantee. Hard-stop forbids insufficient funds; approval-override uses the explicitly named override action and requires a nonblank recorded reason. Legacy reconciliation gates and currency mismatches disable approval.

Vendor activity shows the most recent five other decisions for this agent/vendor, with truncation indicated. Allowed/approved rows are authorisations, never proof of purchase or payment. A new vendor means no prior authorisation; denied activity alone does not make it known. Empty available history and unavailable history are separate states. No payment lifecycle or provider receipts are inferred. Historical authorisations remain visible without retroactively asserting settlement.

Decision POST accepts `{approve,note?,overrideBudget?:boolean}` and the authenticated server principal. Success adds the current approval projection. A stale terminal decision returns 409 with `code: approval-not-pending` and the current contextual approval; budget refusal returns its existing status with `code: approval-budget-conflict` and current contextual approval. The console must explicitly send overrideBudget=true for the named override action. A normal approval with a note cannot silently become an override after competing requests consume funds. The flag is checked inside #7’s finalisation transaction through its optional sixth argument `{allowBudgetOverride:boolean}`; Absent/false options never grant an override in finaliseApproval. The trusted legacy decide wrapper explicitly opts in when its caller supplies an operator reason, preserving its existing internal semantics. New v2 signed budgetRecheck details record overrideConsent with authenticated actor and reason; existing signed rows are unchanged. Refusal can leave a request pending. Clients must not interpret every conflict as terminal.

## Queue behaviour

Each request has its own labelled 500-character note field and native keyboard-operable controls. The queue displays explicit currency, purpose, rule/reason, budgets, projected authorisation effect, vendor history, persisted expiry and delivery status. New notes are signed through #7's version-2 ledger entries; historical notes are not retrospectively verified.

The countdown anchors to server time with a monotonic browser elapsed clock. Controls stop at the exact deadline, for nonpending/recovery records, absent expiry/context, or after 30 seconds without fresh context. State polls every 10 seconds while visible, refreshes on focus/connection, and refreshes after decisions/conflicts. A terminal conflict also updates its card directly if the background refresh fails. Mobile cards stack, text wraps, and completion/error messages receive keyboard focus without moving focus on every countdown tick.

No schema migration is needed for this projection. Use the migrations documented in access-and-migration.md, budget-accounting.md and durable-approvals.md; do not rewrite old signed records. #6 policy/evidence integration and #2 payment execution remain separately owned.

New queue strings use the existing translation dictionary's English fallback. Existing translated controls retain their translations; full translations of the new context copy can follow independently.
