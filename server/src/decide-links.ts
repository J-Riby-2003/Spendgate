// Decision links (push approvals, step 1): single-use bearer tokens that let a
// human approve/reject an escalation from a phone without the console token.
// Raw tokens live only in the notification; the db stores sha256(token).
import { createHash, randomBytes } from 'node:crypto';
import { store } from './core/store.js';
import { decide, EngineError, APPROVAL_TIMEOUT_MS } from './core/engine.js';
import type { ApprovalRequest } from './core/types.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface DecisionLink {
  action: 'approve' | 'reject';
  token: string;
  /** Full path the phone should open, e.g. /decide/<token>. */
  path: string;
}

/** Mint the approve+reject link pair for a freshly created escalation. */
export function mintDecisionLinks(approval: ApprovalRequest): DecisionLink[] {
  const expiresAt = new Date(new Date(approval.createdAt).getTime() + APPROVAL_TIMEOUT_MS).toISOString();
  return (['approve', 'reject'] as const).map((action) => {
    const token = randomBytes(24).toString('base64url');
    store.insertApprovalLink({
      tokenHash: hashToken(token),
      approvalId: approval.id,
      action,
      createdAt: new Date().toISOString(),
      expiresAt,
      usedAt: null,
    });
    return { action, token, path: `/decide/${token}` };
  });
}

export interface DecideOutcome {
  ok: boolean;
  decision: 'approved' | 'rejected';
  approvalId: string;
}

/**
 * Consume a link and record the human decision through the same engine path
 * as the console. Throws EngineError: 404 unknown, 410 used/expired,
 * 409 approval already decided.
 */
export function decideByToken(token: string): DecideOutcome {
  const link = store.getApprovalLink(hashToken(token));
  if (!link) throw new EngineError('Unknown decision link.', 404);
  if (link.usedAt) throw new EngineError('This decision link has already been used.', 410);
  if (link.expiresAt <= new Date().toISOString()) throw new EngineError('This decision link has expired.', 410);
  const approval = store.getApproval(link.approvalId);
  if (!approval || approval.status !== 'pending') {
    throw new EngineError('This escalation has already been decided.', 409);
  }
  const ok = decide(link.approvalId, link.action === 'approve', 'decision-link');
  if (!ok) throw new EngineError('This escalation has already been decided.', 409);
  store.markLinkUsed(link.tokenHash, new Date().toISOString());
  return { ok: true, decision: link.action === 'approve' ? 'approved' : 'rejected', approvalId: link.approvalId };
}
