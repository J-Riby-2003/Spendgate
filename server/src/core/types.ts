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
  budgetMode: 'hard-stop' | 'approval-override';
  /** amount >= threshold escalates to a human. */
  approvalThreshold: number | null;
  /** '*' = any vendor, otherwise allowlist. */
  allowedVendors: string[] | '*';
  blockedVendors: string[];
  newVendorRequiresApproval: boolean;
  /** 0 = Sunday … 6 = Saturday. '*' = any day. */
  allowedDays: number[] | '*';
  /** UTC window, e.g. { start: '08:00', end: '20:00' }. Null = any hour. */
  allowedWindow: { start: string; end: string } | null;
}

export type LedgerDecision = 'ALLOWED' | 'APPROVED' | 'DENIED' | 'REJECTED' | 'EXPIRED';

export interface DecisionDetails {
  actor: { kind: 'policy' | 'operator' | 'decision-link' | 'expiry'; id: string | null };
  note: string | null;
  evidence: { schemaVersion: number; digest: string } | null;
  budgetRecheck: { reservedMinor: number; remainingMinor: number | null; overrideReason: string | null } | null;
}

export interface LedgerEntry {
  eventVersion?: 1 | 2;
  details?: DecisionDetails | null;
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
  expiresAt?: string; // present on every persisted approval; optional for legacy callers constructing rows
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

export interface AgentState {
  agentId: string;
  displayName: string;
  policy: Policy;
  spentToday: number; // completed spend attributed to the current UTC authorisation period
  currency: string;
}
