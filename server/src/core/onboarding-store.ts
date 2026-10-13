import { db, store, withImmediateTransaction } from './store.js';
import { InputError } from './sanitize.js';
import { parsePolicy } from './policy-input.js';
import { isSupportedCurrency } from '../../../shared/currency.js';

export class OnboardingError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new InputError('A valid journey ID is required.');
  return value;
}
/** Owner check is also used inside existing agent/credential transactions. */
export function ownedJourney(id: string, operatorId: string) {
  const row = db.prepare('SELECT * FROM onboarding_sessions WHERE id=? AND operator_id=?').get(uuid(id), operatorId);
  if (!row) throw new OnboardingError('Unknown onboarding journey.', 404);
  return row;
}
export function journeyView(row: ReturnType<typeof ownedJourney>) {
  const generation = row.agent_id ? db.prepare('SELECT MAX(version) AS version FROM policy_revisions WHERE agent_id=? AND before_json IS NULL').get(row.agent_id)?.version : null;
  const agentExists = !!store.listAgents().find(a => a.agentId === row.agent_id) && generation === row.agent_policy_version;
  const credentialActive = agentExists && !!db.prepare('SELECT 1 FROM agent_credentials c JOIN agents a ON a.agent_id=c.agent_id WHERE c.id=? AND c.agent_id=? AND c.revoked_at IS NULL').get(row.credential_id, row.agent_id);
  return { id: String(row.id), revision: Number(row.revision), draft: JSON.parse(String(row.draft_json)),
    agentId: row.agent_id as string | null, agentExists, credentialId: row.credential_id as string | null, credentialActive,
    connectedAt: credentialActive ? row.connected_at as string | null : null,
    testedAt: credentialActive ? row.tested_at as string | null : null,
    completedAt: row.completed_at as string | null, abandonedAt: row.abandoned_at as string | null };
}
export function listJourneys(operatorId: string) {
  return db.prepare('SELECT * FROM onboarding_sessions WHERE operator_id=? AND abandoned_at IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 20').all(operatorId).map(journeyView);
}
export function startJourney(operatorId: string, requestId: unknown) {
  const id = uuid(requestId);
  return withImmediateTransaction(() => {
    const existing = db.prepare('SELECT * FROM onboarding_sessions WHERE operator_id=? AND (id=? OR (completed_at IS NULL AND abandoned_at IS NULL)) ORDER BY completed_at IS NULL AND abandoned_at IS NULL DESC LIMIT 1').get(operatorId, id);
    if (existing) return journeyView(existing);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO onboarding_sessions (id,operator_id,created_at,updated_at) VALUES (?,?,?,?)').run(id, operatorId, now, now);
    return journeyView(ownedJourney(id, operatorId));
  });
}
export function saveDraft(id: string, operatorId: string, expectedRevision: unknown, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Draft is required.');
  const draft = input as Record<string, unknown>;
  // Persist only form fields; never caller metadata, passwords or bearer secrets.
  const agentId = typeof draft.agentId === 'string' ? draft.agentId.trim().toLowerCase() : '';
  if (agentId && !/^[a-z0-9-]{2,64}$/.test(agentId)) throw new InputError('Agent id must be 2–64 letters, digits or dashes.');
  const displayName = typeof draft.displayName === 'string' ? draft.displayName.trim() : '';
  if (displayName.length > 80) throw new InputError('Display name is too long.');
  const currency = typeof draft.currency === 'string' ? draft.currency.toUpperCase() : 'GBP';
  if (!isSupportedCurrency(currency)) throw new InputError('Unsupported currency.');
  const value = { agentId, displayName, currency, ...(draft.policy ? { policy: parsePolicy(agentId, draft.policy) } : {}) };
  return withImmediateTransaction(() => {
    const row = ownedJourney(id, operatorId);
    if (row.completed_at || row.abandoned_at) throw new OnboardingError('Setup is no longer active.');
    if (row.agent_id) throw new OnboardingError('Agent already created. Continue setup or edit its saved policy in Agents & Policy.');
    if (row.revision !== expectedRevision) throw new OnboardingError('Setup changed in another tab. Reload to resume.');
    db.prepare('UPDATE onboarding_sessions SET draft_json=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(value), new Date().toISOString(), id);
    return journeyView(ownedJourney(id, operatorId));
  });
}
/** Called within #1 credential transaction. Retries never reveal a secret again. */
export function credentialJourney(id: string, operatorId: string, agentId: string) {
  const row = ownedJourney(id, operatorId);
  if (row.agent_id !== agentId || row.completed_at || row.abandoned_at || !journeyView(row).agentExists) throw new OnboardingError('Credential does not belong to this active setup.');
  return row;
}
export function attachCredential(id: string, credentialId: string): void {
  db.prepare('UPDATE onboarding_sessions SET credential_id=?,connected_at=NULL,tested_at=NULL,revision=revision+1,updated_at=? WHERE id=?')
    .run(credentialId, new Date().toISOString(), id);
  db.prepare('DELETE FROM onboarding_challenges WHERE onboarding_id=?').run(id);
}

/** Progress only: leaves the agent, credentials and real requests under their owners. */
export function abandonJourney(id: string, operatorId: string) {
  return withImmediateTransaction(() => {
    const row = ownedJourney(id, operatorId);
    if (row.completed_at) throw new OnboardingError('Completed setup cannot be abandoned. Start another agent instead.');
    db.prepare('UPDATE onboarding_sessions SET abandoned_at=COALESCE(abandoned_at,?),updated_at=? WHERE id=?').run(new Date().toISOString(), new Date().toISOString(), id);
    db.prepare('DELETE FROM onboarding_challenges WHERE onboarding_id=?').run(id);
    return journeyView(ownedJourney(id, operatorId));
  });
}
