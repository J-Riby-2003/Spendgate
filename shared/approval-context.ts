import type { BudgetSnapshot } from '../server/src/core/budget.js';

export type VendorHistory =
  | { status: 'unavailable'; isNewVendor: null; reason: string }
  | { status: 'available'; isNewVendor: boolean; truncated: boolean; recent: Array<{
      requestId: string; at: string; amount: number; currency: string; decision: string;
    }> };
export type ApprovalBudgetPreview =
  | { status: 'unavailable'; reason: string }
  | { status: 'available'; snapshot: BudgetSnapshot; additionalReservedMinor: number;
      projectedRemainingMinor: number | null; overrideRequired: boolean };
export interface ApprovalDecisionContext {
  serverNow: string;
  agent: { id: string; displayName: string };
  budget: ApprovalBudgetPreview;
  vendorHistory: VendorHistory;
  actions: {
    approve: { enabled: boolean; reason: string | null };
    reject: { enabled: boolean; reason: string | null };
  };
}
