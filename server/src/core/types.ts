// Shared domain types for SpendGate core.

export type Rail = 'x402' | 'mpp' | 'ap2' | 'acp' | 'card' | 'stablecoin' | 'mcp';

export const RAILS: Rail[] = ['x402', 'mpp', 'ap2', 'acp', 'card', 'stablecoin', 'mcp'];

export interface SpendIntent {
  id: string;
  agentId: string;
  /** Amount in minor units (integer cents/pence) — money is never a float. */
  amount: number;
  currency: string; // ISO 4217, e.g. GBP, USD
  vendor: string;
  purpose: string;
  rail: Rail;
}

export type PolicyDecision = 'ALLOW' | 'DENY' | 'ESCALATE';

export interface Policy {
  agentId: string;
  /** Minor units. Null = unlimited / unset. */
  maxPerTxn: number | null;
  dailyBudget: number | null;
  /** amount >= threshold escalates to a human. */
  approvalThreshold: number | null;
  /** '*' = any vendor, otherwise allowlist. */
  allowedVendors: string[] | '*';
  blockedVendors: string[];
  newVendorRequiresApproval: boolean;
  /** 0 = Sunday … 6 = Saturday. '*' = any day. */
  allowedDays: number[] | '*';
  /** Local-time window, e.g. { start: '08:00', end: '20:00' }. Null = any hour. */
  allowedWindow: { start: string; end: string } | null;
}

export type LedgerDecision = 'ALLOWED' | 'APPROVED' | 'DENIED' | 'REJECTED' | 'EXPIRED';

export interface LedgerEntry {
  seq: number;
  ts: string; // ISO
  intentId: string;
  agentId: string;
  amount: number;
  currency: string;
  vendor: string;
  purpose: string;
  rail: Rail;
  decision: LedgerDecision;
  rule: string;
  decidedBy: string; // 'policy' | 'human:<name>' | 'expiry'
  approvalId: string | null;
  prevHash: string;
  hash: string;
  signature: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: string;
  intent: SpendIntent;
  rule: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

export interface AgentState {
  agentId: string;
  displayName: string;
  policy: Policy;
  spentToday: number; // minor units, summed across currencies as-is (prototype simplification)
  currency: string;
}
