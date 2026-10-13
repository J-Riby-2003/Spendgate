import { CURRENCIES, currencyPrecision, isSupportedCurrency, parseMinor } from '../../../shared/currency';
export { CURRENCIES };
// Shared client types mirroring the server contract.
export interface Policy {
  agentId: string;
  maxPerTxn: number | null;
  dailyBudget: number | null;
  budgetMode: 'hard-stop' | 'approval-override';
  approvalThreshold: number | null;
  allowedVendors: string[] | '*';
  blockedVendors: string[];
  newVendorRequiresApproval: boolean;
  allowedDays: number[] | '*';
  allowedWindow: { start: string; end: string } | null;
}

export interface AgentState {
  agentId: string;
  displayName: string;
  currency: string;
  policy: Policy | null;
  spentToday: number;
  budget: BudgetSnapshot;
}

export interface LedgerEntry {
  seq: number;
  ts: string;
  intentId: string;
  agentId: string;
  amount: number;
  currency: string;
  vendor: string;
  purpose: string;
  rail: string;
  decision: 'ALLOWED' | 'APPROVED' | 'DENIED' | 'REJECTED' | 'EXPIRED';
  rule: string;
  decidedBy: string;
  approvalId: string | null;
  prevHash: string;
  hash: string;
  signature: string;
}

export interface ApprovalRequest {
  id: string;
  requestId: string;
  expiresAt: string;
  notification?: { configured: boolean; status?: 'pending' | 'sending' | 'retry' | 'failed' | 'delivered' | 'obsolete'; attempts?: number; lastError?: string | null; nextAttemptAt?: number; deliveredAt?: string | null };
  intent: {
    id: string;
    agentId: string;
    amount: number;
    currency: string;
    vendor: string;
    purpose: string;
    rail: string;
  };
  rule: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

export interface State {
  agents: AgentState[];
  ledger: LedgerEntry[];
  approvalsPending: ApprovalRequest[];
  approvalsRecent: ApprovalRequest[];
  stats: {
    allowedToday: number;
    approvedToday: number;
    deniedToday: number;
    pendingApprovals: number;
    ledgerEntries: number;
  };
  verify: { valid: boolean; entries: number; brokenAt: number | null };
}

const SYMBOLS: Record<string, string> = {
  GBP: '£', USD: '$', EUR: '€', JPY: '¥', CNY: '¥', CHF: '₣',
  AUD: '$', CAD: '$', HKD: '$', NZD: '$', SGD: '$', MXN: '$', TWD: '$',
  BRL: 'R$', INR: '₹', RUB: '₽', KRW: '₩', TRY: '₺', ZAR: 'R',
  PLN: 'zł', SEK: 'kr', NOK: 'kr', DKK: 'kr', ISK: 'kr',
  AED: 'د.إ', SAR: '﷼', ILS: '₪', THB: '฿', VND: '₫', PHP: '₱',
  IDR: 'Rp', MYR: 'RM', HUF: 'Ft', CZK: 'Kč', RON: 'lei', BGN: 'лв',
  GHS: '₵', NGN: '₦', KES: 'KSh', PKR: '₨', LKR: '₨', NPR: '₨',
  BDT: '৳', EGP: 'E£', KWD: 'د.ك', QAR: 'ر.ق', UAH: '₴', MAD: 'د.م.',
};

export function currencySymbol(currency: string): string {
  return SYMBOLS[currency?.toUpperCase()] ?? '';
}

export function fmt(amount: number, currency: string): string {
  const code = currency?.toUpperCase() ?? '';
  if (!isSupportedCurrency(code)) return `${amount} ${code} atomic units`;
  const precision = currencyPrecision(code), scale = 10 ** precision;
  const sym = SYMBOLS[code] ?? `${code} `, sign = amount < 0 ? '−' : '', abs = Math.abs(amount);
  return `${sign}${sym}${Math.floor(abs / scale).toLocaleString('en-GB')}${precision ? `.${String(abs % scale).padStart(precision, '0')}` : ''}`;
}
export function toMinor(units: string, currency = 'GBP'): number | null { return parseMinor(units, currency); }
export function minorToUnits(minor: number | null, currency = 'GBP'): string {
  if (minor == null) return '';
  if (!isSupportedCurrency(currency)) return String(minor);
  const precision = currencyPrecision(currency), scale = 10 ** precision;
  const fraction = String(Math.abs(minor) % scale).padStart(precision, '0').replace(/0+$/, '');
  return `${Math.trunc(minor / scale)}${fraction ? `.${fraction}` : ''}`;
}

export interface BudgetSnapshot {
  agentId: string; currency: string; precision: number | null; mode: 'hard-stop' | 'approval-override';
  limitMinor: number | null; spentMinor: number; reservedMinor: number; remainingMinor: number | null;
  periodStart: string; periodEnd: string; timezone: 'UTC'; reconciliationRequired: boolean;
}
export interface LegacyObligation {
  ledgerSeq: number; requestId: string; amountMinor: number; currency: string; ts: string;
  vendor: string; purpose: string; disposition: string | null; executionStatus: string;
  evidence: string | null; operatorId: string | null; reason: string | null;
}
export interface ReconciliationPreview { budget: BudgetSnapshot; obligations: LegacyObligation[]; events: unknown[] }
export async function fetchReconciliation(agentId: string): Promise<ReconciliationPreview> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/budget/reconciliation`);
  await checkOk(res, 'reconciliation'); return res.json();
}
export async function reconcileLegacy(agentId: string, review: { ledgerSeq: number; action: string; reason: string; evidence?: string; eventId: string }): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/budget/reconciliation`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(review),
  });
  await checkOk(res, 'reconciliation');
}

// Operator session secret stays in an HttpOnly cookie; CSRF token stays in memory.
let onUnauthorized: (() => void) | null = null;
let csrf = '';
export function setUnauthorizedHandler(fn: () => void): () => void {
  onUnauthorized = fn;
  return () => { if (onUnauthorized === fn) onUnauthorized = null; };
}
export async function loadSession(): Promise<boolean> {
  const res = await fetch('/api/auth/session');
  if (res.status === 401) { csrf = ''; return false; }
  await checkOk(res, 'session');
  csrf = (await res.json()).csrfToken;
  return true;
}
export async function signIn(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  await checkOk(res, 'sign in');
  csrf = (await res.json()).csrfToken;
  sessionStorage.removeItem('sg-token'); // discard obsolete shared-token storage
}
export async function signOut(): Promise<void> {
  const res = await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() });
  await checkOk(res, 'sign out');
  csrf = '';
}
function authHeaders(base?: Record<string, string>): Record<string, string> {
  return { ...base, 'X-CSRF-Token': csrf };
}

async function checkOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    csrf = '';
    onUnauthorized?.();
  }
  throw new Error(body.error ?? `${label} ${res.status}`);
}

export async function fetchState(): Promise<State> {
  const res = await fetch('/api/state');
  await checkOk(res, 'state');
  return res.json();
}

export async function decideApproval(id: string, approve: boolean, note?: string): Promise<void> {
  const res = await fetch(`/api/approvals/${id}/decide`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ approve, note }),
  });
  await checkOk(res, 'decide');
}

export async function savePolicy(policy: Policy): Promise<void> {
  const res = await fetch(`/api/policies/${policy.agentId}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(policy),
  });
  await checkOk(res, 'save policy');
}

export async function removeAgent(agentId: string): Promise<void> {
  const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE', headers: authHeaders() });
  await checkOk(res, 'remove agent');
}

export async function setCurrency(agentId: string, currency: string): Promise<void> {
  const res = await fetch(`/api/agents/${agentId}/currency`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ currency }),
  });
  await checkOk(res, 'currency');
}

export async function addAgent(agentId: string, displayName: string, currency: string): Promise<void> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ agentId, displayName, currency }),
  });
  await checkOk(res, 'add agent');
}

export interface Credential { id: string; agentId: string; createdAt: number; revokedAt: number | null }
export async function listCredentials(agentId: string): Promise<Credential[]> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/credentials`);
  await checkOk(res, 'credentials'); return res.json();
}
export async function issueCredential(agentId: string, rotateId?: string): Promise<{ id: string; secret: string }> {
  const path = `/api/agents/${encodeURIComponent(agentId)}/credentials${rotateId ? `/${encodeURIComponent(rotateId)}/rotate` : ''}`;
  const res = await fetch(path, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
  await checkOk(res, 'issue credential'); return res.json();
}
export async function revokeCredential(agentId: string, id: string): Promise<void> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
  await checkOk(res, 'revoke credential');
}

export async function recordActivity(): Promise<void> {
  const res = await fetch('/api/auth/activity', { method: 'POST', headers: authHeaders() });
  await checkOk(res, 'session activity');
}
