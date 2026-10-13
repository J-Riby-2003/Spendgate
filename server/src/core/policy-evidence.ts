import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BudgetSnapshot } from './budget.js';
import { evaluate, type EvalResult } from './policy.js';
import type { Policy, SpendIntent } from './types.js';

export const EVALUATOR_VERSION = 'policy-utc-v2';
export const MAX_EVIDENCE_BYTES = 16 * 1024;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const iso = z.string().datetime();
const snapshotSchema = z.object({
  agentId: z.string().min(1).max(64), currency: z.string().regex(/^[A-Z]{3}$/), precision: integer.max(9).nullable(),
  mode: z.enum(['hard-stop', 'approval-override']), limitMinor: integer.max(1e12).nullable(),
  periodStart: iso, periodEnd: iso, timezone: z.literal('UTC'), spentMinor: integer, reservedMinor: integer,
  remainingMinor: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), reconciliationRequired: z.boolean(),
}).strict().refine(b => Number.isSafeInteger(b.spentMinor + b.reservedMinor) &&
  b.remainingMinor === (b.limitMinor == null ? null : b.limitMinor - b.spentMinor - b.reservedMinor), 'Inconsistent budget context');
const schema = z.object({
  schemaVersion: z.literal(1), intentDigest: z.string().regex(/^[a-f0-9]{64}$/), policyVersion: integer.min(1), evaluatorVersion: z.string().min(1).max(80), evaluatedAt: iso,
  context: z.object({ agentCurrency: z.string().regex(/^[A-Z]{3}$/), budget: snapshotSchema, vendorKnown: z.boolean() }).strict(),
  verdict: z.object({ decision: z.enum(['ALLOW', 'DENY', 'ESCALATE']), rule: z.string().min(1).max(120), reason: z.string().min(1).max(1000) }).strict(),
}).strict().refine(e => e.context.agentCurrency === e.context.budget.currency, 'Inconsistent currency context');
export type PolicyEvidenceEnvelope = z.infer<typeof schema>;
export interface EvidenceContext { agentCurrency: string; budget: BudgetSnapshot; vendorKnown: boolean }

/** The same fixed context is used for production, preview and both sides of replay. */
export function evaluateContext(policy: Policy, intent: SpendIntent, context: EvidenceContext, now: Date): EvalResult {
  return evaluate(policy, intent, { spentTodayMinor: context.budget.spentMinor, reservedMinor: context.budget.reservedMinor,
    knownVendors: new Set(context.vendorKnown ? [intent.vendor.toLowerCase()] : []), now });
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, ordered(v)]));
  return value;
}
/** Validated, recursively lexicographically ordered JSON, encoded as UTF-8. No silent truncation. */
export function encodeEvidence(value: unknown): { envelope: PolicyEvidenceEnvelope; json: string; digest: string } {
  const envelope = schema.parse(value);
  const json = JSON.stringify(ordered(envelope));
  if (Buffer.byteLength(json, 'utf8') > MAX_EVIDENCE_BYTES) throw new Error('Policy evidence exceeds 16KiB.');
  return { envelope, json, digest: createHash('sha256').update(json, 'utf8').digest('hex') };
}
