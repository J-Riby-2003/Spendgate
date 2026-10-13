# Budget modes, reservations and reconciliation

Issue #3 supplies provider-neutral accounting on top of issue #1's identity and transaction foundation. It does not execute payments. ALLOWED/APPROVED means permission, not paid. No agent or operator API may mark a new payment completed without execution evidence from the controlled integration in issue #2.

## Policy and currency

`budgetMode` is `hard-stop` or `approval-override`. New agents and seed policies use hard-stop. Migration explicitly writes approval-override into existing policy JSON lacking a mode to preserve the former human-exception behaviour. Updating a policy without this field preserves its stored value. Null dailyBudget is unlimited; zero permits no positive authorisations without an explicit override. Remaining can be negative after an override.

Hard-stop availability checks precede softer vendor/threshold/time escalation rules. Blocked vendors remain denied. Pending human requests reserve nothing; requests may compete while pending. The approval action checks current available funds inside BEGIN IMMEDIATE and acquires a reservation atomically with the existing approval status write. Insufficient funds in hard-stop leaves the request pending and returns a conflict. Approval-override requires an authenticated console operator and a nonblank reason. Phone decision links can approve within available funds but cannot grant budget overrides. Override details live in accounting audit events, and the signed decision rule is prefixed `budget-override:`.

Amounts are bounded positive integers, 1..1e12 atomic minor units. The shared currency module validates against the runtime's ICU currency catalogue and supplies its currency precision. Console decimal input rejects fractional atomic units instead of rounding. GBP/USD/EUR remain two-decimal units; JPY uses zero, KWD three. Unsupported asset codes are rejected for new operations; historical unsupported codes render as raw atomic units. No USDC support or alias to USD is introduced. An eventual token integration needs an explicit asset namespace and precision contract. Pin the deployment runtime/ICU version when operating against a fixed supported-currency catalogue.

Each agent has one configured currency. Currency mismatches fail before authorisation. Currency changes and agent deletion are blocked by outstanding reservations, pending approvals, unresolved legacy records, or current-period completed spend; the latter prevents changing currency or recreating an ID to reset today's budget. Once clear, a currency change preserves integer policy limits (no conversion); review the limits in the selected currency before sending requests. Startup seeding no longer overwrites registered currency choices. Agent deletion uses auth.deleteAgentWithCredentials: guard, deletion, credential revocation and audit share one BEGIN IMMEDIATE transaction; revocation events emit after commit.

## UTC periods and rollover

Daily periods are `[00:00:00 UTC, next 00:00:00 UTC)`. Policy allowedDays/allowedWindow also use UTC. A reservation records its authorisation period permanently. Completed spend belongs to that period, even if settlement arrives tomorrow. All unresolved reservations reduce current availability across midnight. Expiry timestamps do not themselves prove execution failed, so old in-flight reservations remain held until safe reconciliation.

For a £100 limit, reserving £30 late on day 1 leaves £70. Day 2 starts with £0 completed, £30 reserved, £70 remaining. Settling that request on day 2 removes its hold and records £30 for day 1: day 2 now has £100 remaining. If day 2 already has £20 completed, its remaining becomes £80. Same-day settlement changes £30 reserved into £30 spent without changing remaining. There is no conversion or cross-currency summation.

`BudgetSnapshot` exposes agentId, currency, precision, mode, limitMinor, spentMinor, reservedMinor, remainingMinor (null for unlimited), periodStart, periodEnd, timezone and reconciliationRequired. REST/WebSocket state attaches it as `agents[].budget`; `spentToday` remains a compatibility alias for completed spend. MCP budget_status uses the actual agent currency. The console shows all three amounts even for unlimited budgets.

## Shared transaction contract

`core/budget-state.ts` exports the bound `budget` instance. `createBudgetStore(db)` in `core/budget.ts` permits independently connected writers/tests. Read operations are `getBudgetSnapshot(agentId, now?)`, `getReservation(requestId)`, `legacyObligations(agentId)` and `accountingEvents(agentId)`.

Mutations are synchronous, **unwrapped**, and require an active transaction on that same connection. Call #1's bound `withImmediateTransaction(() => { ... })`; never nest it or await inside. Mutations throw BudgetError with status 409/422/404 as applicable. Use BEGIN IMMEDIATE, not a deferred transaction, to serialize availability decisions across processes. Set a suitable SQLite busy_timeout (the bound store uses 10 seconds).

- `reserveBudget({ requestId, agentId, amountMinor, currency, expiresAt, override? }, now?)`: unique requestId is the canonical request identity, currently equal to SpendIntent.id. `override` is `{ operatorId, reason }` from trusted operator context, never caller-supplied agent metadata. Identical retries return the original reservation, including after expiry; conflicting amount/currency/agent/expiry reuse fails.
- `settleReservation(requestId, eventId, now?)`: exact full-amount confirmed settlement; reserved -> settled once. Returns `{ changed, reservation }`.
- `releaseReservation(requestId, eventId, cause, now?)`: confirmed failed/cancelled/safely expired authorisation; reserved -> released once. Causes are failed, cancelled, expired. Returns `{ changed, reservation }`.
- Repeated identical terminal evidence has no monetary effect. Contradictory terminal evidence raises a reconciliation conflict. Verified external event IDs must be uniquely namespaced (provider/account/event), not arbitrary caller-generated completion claims.

No #2 tables, authorisation foreign keys or #7 request table are required. Future authorisation linkage belongs to the owning lifecycle record, keyed to this requestId. A transaction can combine reservation mutation, approval/execution state, and the owner's audit writes; broadcast only after commit.

### Integration obligations

#7 must replace the current blocking waiter's final ledger/idempotency writes with its durable, exactly-once finalisation transaction. The existing approval decision and reservation acquisition are already atomic; signed decision append still occurs when the live waiter resumes. Reservation durability does not imply the whole approval workflow is restart-safe. #7 should pass its persisted canonical request ID, preserve the no-hold-pending rule, and recheck funds inside finalisation. Reject/expiry before authorisation have no reservation to release.

#2 must verify settlement/failure/cancellation evidence, forbid execution after safe authorisation expiry, reconcile ambiguous in-flight payments and invoke settle/release in its execution transaction. No generic sweep releases a hold at its timestamp: a provider may still complete it. `expiresAt` is currently a five-minute permission deadline from acquisition; #2 must consume it as an execution gate and own its configuration. A provider's sent status alone is not sufficient evidence of completion. This approval-only branch leaves permissions reserved until the controlled execution integration reconciles them; it does not pretend to pay or settle demo requests.

Reserve an extension point for verified provider returns: a future idempotent append-only adjustment must reference original settlement and verified event, preserving history. Do not implement it by deleting or rewriting the settlement, or by treating an unsolicited late capture as a new authorised spend. User refunds and partial captures are out of scope.

Accounting audit events are separate append-only application records, like #1's security audit. They contain override attribution and reconciliation before/after snapshots, but do not yet claim cryptographic tamper evidence. The existing signed monetary decision chain remains unchanged and verifiable. #2 must append its signed lifecycle audit in the same reconciliation transaction; #6 owns policy history.

## Upgrade and operator reconciliation

Back up the stopped database and signing key first, as in access-and-migration.md. Immutable migrations use the reserved IDs issue03_001_budget_policy_modes, issue03_002_reservation_accounting, issue03_003_legacy_reconciliation under #1's runner.

Migration copies only legacy ALLOWED/APPROVED references into legacy_budget_obligations; it never edits signed ledger rows or assumes payment occurred. Denied/rejected/expired rows create no ambiguity. Each listed unresolved row gates new authorisations for that agent. Existing pending requests reserve nothing and can be decided only after the agent's legacy gate is clear. Unknown obligations in different currencies stay separate.

In Agents & Policy, select Review legacy obligations. Each record shows ledger sequence, date, vendor, purpose, original currency/amount, review disposition and payment status. Choose one disposition with a recorded reason and confirm:

1. **No outstanding obligation:** operator attests there is no outstanding financial commitment. Historical payment remains unknown; no spend is invented. Record supporting evidence where available.
2. **Outstanding:** creates a conservative full-amount hold in the original currency/period, even if above the budget. This is a migration hold, not new permission to execute. Same-currency holds reduce current availability; foreign-currency holds keep the authorisation gate closed rather than combining money. A subsequent review can confirm payment with evidence or release the obligation with evidence that it can no longer execute.
3. **Confirmed paid:** requires provider receipt/evidence reference. Records completed spend in the original UTC period. Does not rewrite the legacy signed permission row.

Operator identity comes from the authenticated session. Reconciliation is idempotent by eventId; reuse with different content conflicts. Every review stores identity, timestamp, reason, evidence, target ledger record, and before/after balances. Once all listed ambiguous records have dispositions, the gate clears, subject to foreign-currency outstanding holds. Unsupported historic assets may be attested no-outstanding after offline evidence review; new reservations/settlements in unsupported assets remain rejected.

API: operator-only GET `/api/agents/:agentId/budget/reconciliation` returns `{ budget, obligations, events }`; POST accepts `{ ledgerSeq, action, reason, evidence?, eventId }` and returns updated balances/obligations. POST requires the session, Origin and CSRF protections from #1. Caller-supplied operatorId is ignored. There is no agent reconciliation endpoint.

## Validation

Tests exercise concurrent independent processes, restart/reopen, duplicate/conflicting events, rollback with a failed decision, currency mismatch, policy mode precedence, pending-request competition, override attribution, UTC rollover, expired in-flight holds, migration preservation, idempotent evidenced legacy review, and zero/two/three-decimal currency handling. Isolated browser tests cover mode persistence, separate balances and operator attestation without inventing spend.
