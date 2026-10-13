import { createHash, randomBytes } from 'node:crypto';
import { db, store, withImmediateTransaction } from './store.js';
import { assertAgentActive, type AgentPrincipal } from '../auth.js';
import { ownedJourney, journeyView, OnboardingError } from './onboarding-store.js';
import { preview } from './simulation.js';
import type { Policy } from './types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function createChallenge(id: string, operatorId: string) {
  return withImmediateTransaction(() => {
    const row = ownedJourney(id, operatorId), view = journeyView(row);
    if (!view.credentialActive || row.completed_at || row.abandoned_at) throw new OnboardingError('Create or rotate a credential in this active setup first.');
    const token = randomBytes(24).toString('base64url'), expiresAt = Date.now() + 10 * 60_000;
    db.prepare('DELETE FROM onboarding_challenges WHERE onboarding_id=? OR expires_at<=?').run(id, Date.now());
    db.prepare('INSERT INTO onboarding_challenges VALUES (?,?,?,?,?,NULL)').run(hash(token), id, row.agent_id, row.credential_id, expiresAt);
    return { challenge: token, expiresAt: new Date(expiresAt).toISOString() };
  });
}
export function checkConnection(principal: AgentPrincipal, challenge: string) {
  return withImmediateTransaction(() => {
    assertAgentActive(principal);
    const row = db.prepare(`SELECT c.*,s.completed_at,s.abandoned_at FROM onboarding_challenges c JOIN onboarding_sessions s ON s.id=c.onboarding_id
      WHERE c.token_hash=? AND c.agent_id=? AND c.credential_id=? AND s.agent_id=c.agent_id AND s.credential_id=c.credential_id`).get(hash(challenge), principal.agentId, principal.credentialId);
    if (!row || row.used_at != null || Number(row.expires_at) <= Date.now() || row.completed_at || row.abandoned_at) throw new OnboardingError('Connection check failed: use the matching agent credential and request a fresh, unexpired challenge.', 403);
    const journey = db.prepare('SELECT * FROM onboarding_sessions WHERE id=?').get(row.onboarding_id)!;
    if (!journeyView(journey).agentExists) throw new OnboardingError('Agent was removed or replaced. Start a new setup.');
    if (!store.getPolicy(principal.agentId)) throw new OnboardingError('Agent has no policy. Restore its policy before connecting.');
    const now = new Date().toISOString();
    db.prepare('UPDATE onboarding_challenges SET used_at=? WHERE token_hash=?').run(Date.now(), hash(challenge));
    db.prepare('UPDATE onboarding_sessions SET connected_at=?,tested_at=NULL,revision=revision+1,updated_at=? WHERE id=?').run(now, now, row.onboarding_id);
    // #1 currently has one fixed own-agent tool permission set, no configurable scopes.
    return { verified: true, agentId: principal.agentId, credentialId: principal.credentialId,
      permissions: ['spend:own', 'spend_status:own', 'budget_status:own', 'audit_ledger:own', 'onboarding_test:own'], connectedAt: now };
  });
}
/** Simulation service only. Fixtures vary the unsaved policy, never balances/history. */
export function testJourney(id: string, operatorId: string, sample: unknown) {
  const row = ownedJourney(id, operatorId);
  return runTests(row, sample);
}
export function testJourneyAsAgent(id: string, principal: AgentPrincipal, sample: unknown) {
  assertAgentActive(principal);
  const row = db.prepare('SELECT * FROM onboarding_sessions WHERE id=? AND agent_id=? AND credential_id=?').get(id, principal.agentId, principal.credentialId);
  if (!row) throw new OnboardingError('Unknown setup for this credential.', 404);
  return runTests(row, sample);
}
function runTests(row: ReturnType<typeof ownedJourney>, sample: unknown) {
  const view = journeyView(row);
  if (row.abandoned_at) throw new OnboardingError('Setup was abandoned.');
  if (!view.connectedAt || !view.credentialActive) throw new OnboardingError('Verify the MCP client connection with the current credential before testing.');
  const agentId = String(row.agent_id);
  const { policy, policyVersion } = withImmediateTransaction(() => ({ policy: store.getPolicy(agentId), policyVersion: store.getPolicyVersion(agentId) }));
  if (!policy) throw new OnboardingError('Agent or policy removed.');
  const saved = preview(agentId, policy, sample);
  const fixture: Policy = { ...policy, maxPerTxn: null, dailyBudget: null, approvalThreshold: null,
    allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: false, allowedDays: '*', allowedWindow: null };
  const exampleSample = { amount: 1, currency: saved.context.agentCurrency, vendor: 'onboarding-example', purpose: 'Illustrative onboarding simulation', rail: 'mcp' };
  const examples = [
    { label: 'Illustrative allow policy', policy: fixture },
    { label: 'Illustrative approval policy', policy: { ...fixture, approvalThreshold: 1 } },
    { label: 'Illustrative denial policy', policy: { ...fixture, blockedVendors: ['onboarding-example'] } },
  ].map(e => ({ ...e, sample: exampleSample, preview: preview(agentId, e.policy, exampleSample) }));
  // Only progress changes. All monetary/approval/evidence state remains untouched.
  withImmediateTransaction(() => {
    const current = db.prepare('SELECT * FROM onboarding_sessions WHERE id=?').get(row.id)!;
    if (current.abandoned_at) throw new OnboardingError('Setup was abandoned during testing.');
    if (saved.currentVersion !== policyVersion || store.getPolicyVersion(agentId) !== policyVersion) throw new OnboardingError('Policy changed during testing. Run safe tests again with the current saved policy.');
    if (current.credential_id !== row.credential_id || !journeyView(current).connectedAt) throw new OnboardingError('Credential changed during testing. Reconnect before retrying.');
    const now = new Date().toISOString();
    db.prepare('UPDATE onboarding_sessions SET tested_at=?,revision=revision+1,updated_at=? WHERE id=?').run(now, now, row.id);
  });
  return { mode: 'simulation', saved, examples, fixtureNotice: 'Illustrative policies are unsaved examples. They do not change your saved policy or predict its outcome. Existing budget and vendor history are read only.',
    nextAction: 'Review the saved-policy result, then finish setup. Real authorised requests can reserve funds; these tests cannot.' };
}
export function completeJourney(id: string, operatorId: string) {
  return withImmediateTransaction(() => {
    const row = ownedJourney(id, operatorId), view = journeyView(row);
    if (row.abandoned_at || !view.credentialActive || !view.connectedAt || !view.testedAt) throw new OnboardingError('Complete credential, connection and safe test steps first.');
    db.prepare('UPDATE onboarding_sessions SET completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=?').run(new Date().toISOString(), new Date().toISOString(), id);
    return journeyView(ownedJourney(id, operatorId));
  });
}
