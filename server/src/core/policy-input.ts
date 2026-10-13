import { createHash } from 'node:crypto';
import { isSupportedCurrency } from '../../../shared/currency.js';
import { cleanHhmm, cleanMinor, cleanStr, cleanVendorList, InputError } from './sanitize.js';
import { isRail } from './policy.js';
import type { Policy, SpendIntent } from './types.js';

export function parsePolicy(agentId: string, input: unknown, currentMode: Policy['budgetMode'] = 'hard-stop'): Policy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Policy must be an object.');
  const b = input as Record<string, unknown>;
  const allowedDays = b.allowedDays ?? '*';
  if (allowedDays !== '*' && !(Array.isArray(allowedDays) && allowedDays.length <= 7 && allowedDays.every(d => Number.isInteger(d) && d >= 0 && d <= 6))) throw new InputError('allowedDays must be "*" or weekday indices 0–6.');
  const mode = b.budgetMode ?? currentMode;
  if (mode !== 'hard-stop' && mode !== 'approval-override') throw new InputError('Invalid budget mode.');
  if (b.newVendorRequiresApproval != null && typeof b.newVendorRequiresApproval !== 'boolean') throw new InputError('newVendorRequiresApproval must be boolean.');
  const window = b.allowedWindow as Record<string, unknown> | null | undefined;
  return { agentId, maxPerTxn: cleanMinor(b.maxPerTxn, 'maxPerTxn'), dailyBudget: cleanMinor(b.dailyBudget, 'dailyBudget'), budgetMode: mode,
    approvalThreshold: cleanMinor(b.approvalThreshold, 'approvalThreshold'),
    allowedVendors: b.allowedVendors === undefined || b.allowedVendors === '*' ? '*' : cleanVendorList(b.allowedVendors, 'allowedVendors'),
    blockedVendors: b.blockedVendors == null ? [] : cleanVendorList(b.blockedVendors, 'blockedVendors'),
    newVendorRequiresApproval: b.newVendorRequiresApproval === true,
    allowedDays: allowedDays as Policy['allowedDays'],
    allowedWindow: window == null ? null : { start: cleanHhmm(window.start, 'Window start'), end: cleanHhmm(window.end, 'Window end') } };
}
/** Shared request normalisation, prior to mutable currency/legacy gates and idempotency recovery. */
export function parseIntent(agentId: string, input: unknown, id: string): SpendIntent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Request must be an object.');
  const b = input as Record<string, unknown>;
  if (!Number.isSafeInteger(b.amount) || Number(b.amount) <= 0 || Number(b.amount) > 1e12) throw new InputError('amount must be a positive integer in minor units within 1..1e12.');
  const currency = typeof b.currency === 'string' ? b.currency.toUpperCase() : '';
  if (!isSupportedCurrency(currency)) throw new InputError('Unsupported currency.');
  if (typeof b.rail !== 'string' || !isRail(b.rail)) throw new InputError('Unsupported payment rail.');
  return { id, agentId, amount: Number(b.amount), currency, vendor: cleanStr(b.vendor, 'vendor', 120)!, purpose: cleanStr(b.purpose, 'purpose', 280)!, rail: b.rail };
}

/** Bind original evidence to the complete normalised request, including canonical request identity. */
export function intentDigest(intent: SpendIntent): string {
  return createHash('sha256').update(JSON.stringify([intent.id, intent.agentId, intent.amount, intent.currency, intent.vendor, intent.purpose, intent.rail]), 'utf8').digest('hex');
}
