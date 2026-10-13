# Budget reservations implementation plan

Goal: enforce issue #3's reviewed budget accounting contract independently of provider and durable-request tables.
Spec: GitHub issue #3 and the reviewed design in this chat; docs/budget-accounting.md will preserve the final contract.
Architecture: request-keyed reservations and append-only accounting events, composed with #1's synchronous transaction helper. #7 owns durable requests; #2 owns execution.

## Global constraints
- No merge/deploy; isolated branch based on 34e32563a337eb054ea85ae5d272a8ae4c1fe68e.
- Pending human requests reserve nothing. New modes hard-stop; migrated modes approval-override.
- UTC days; completed spend attributed to original authorisation period; unresolved reservations carry forward.
- Legacy approvals stay unknown. Reconciliation is explicit, evidenced, audited and idempotent.
- No provider selection, USDC, refund or partial-capture implementation.

## Review focus
- A softer escalation must not bypass a hard budget stop.
- Separate database connections must not oversubscribe funds.
- Period rollover must neither hide holds nor double-count settlement.
- Failed approval/currency changes must leave balances unchanged.
- Unknown legacy history must never silently become paid.

## Tasks
1. Migrations and core accounting: add tests for modes, migration, reserve/settle/release/reconcile, rollover and duplicate conflicts; watch failures; implement; run tests.
2. Engine and API: test currency guards, approval rechecks, transactional holds, policy defaults and authenticated reconciliation; implement; run tests/type checks.
3. Console, MCP and documentation: show modes/balances/reconciliation; preserve design system; verify isolated browser flow and build.
4. Independent branch review, fix significant findings with regression tests, run full validation, commit and open stacked draft PR.

## Execution evidence

- Started from exact approved access commit in an isolated native worktree; baseline 79 tests passed.
- Accounting, engine/API, currency parsing, notification precision and deletion rollback regressions were observed failing before their implementations/fixes.
- Final verification: 107 server tests; server/web type checks; production web build; seven isolated browser tests. Screenshots inspected for budget balances.
- Independent reviewer found agent deletion's missing coherent transaction and Telegram's two-decimal assumption. Both fixed with regression coverage. MCP BudgetError status classification also corrected because treating an operator-required conflict as a server failure invites misleading retries.
- Policy editor now preserves unrestricted days when saving a mode-only edit; otherwise a budget-mode edit could accidentally restrict spending days.
- Dockerfile includes the shared currency module before web build. Docker runtime unavailable locally; container image build remains unverified.
- #7 still owns durable final ledger/idempotency writes; #2 owns verified execution, expiry safety, signed lifecycle audit and eventual provider-return adjustments. This draft does not claim those integrations are complete.
