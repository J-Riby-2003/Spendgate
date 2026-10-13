import { store, db, withImmediateTransaction } from './store.js';
import { cleanStr, InputError } from './sanitize.js';
import { parsePolicy } from './policy-input.js';
import { isSupportedCurrency, currencyPrecision } from '../../../shared/currency.js';
import { ownedJourney, journeyView, OnboardingError } from './onboarding-store.js';

/** Shared registration endpoint/service; onboarding supplies an optional initial policy and retry binding. */
export function registerAgent(input: Record<string, unknown>, operatorId: string) {
  const { agentId } = input;
  if (typeof agentId !== 'string' || !/^[a-z0-9-]{2,64}$/.test(agentId)) throw new InputError('agentId must be 2–64 chars of a-z, 0-9, dash.');
  const displayName = cleanStr(input.displayName, 'displayName', 80, true) ?? agentId;
  const currency = typeof input.currency === 'string' ? input.currency.toUpperCase() : input.currency == null ? 'GBP' : '';
  if (!isSupportedCurrency(currency)) throw new InputError('Unsupported currency.');
  const scale = 10 ** currencyPrecision(currency);
  const policy = parsePolicy(agentId, input.policy ?? {
    maxPerTxn: 50 * scale, dailyBudget: 500 * scale, approvalThreshold: 200 * scale,
    budgetMode: 'hard-stop', allowedVendors: '*', blockedVendors: [], newVendorRequiresApproval: true, allowedDays: '*', allowedWindow: null,
  });
  const setup = JSON.stringify({ agentId, displayName, currency, policy });
  return withImmediateTransaction(() => {
    const journey = input.onboardingId === undefined ? null : ownedJourney(String(input.onboardingId), operatorId);
    if (journey?.agent_id) {
      if (journey.setup_json !== setup || !journeyView(journey).agentExists) throw new OnboardingError('Setup was already submitted with different details, or its agent was removed. Resume the existing setup.');
      return { agentId, created: false };
    }
    if (journey) {
      if (journey.completed_at || journey.abandoned_at || journey.revision !== input.expectedRevision) throw new OnboardingError('Setup changed in another tab. Reload before creating the agent.');
      const draft = JSON.parse(String(journey.draft_json));
      const draftSetup = JSON.stringify({ agentId: draft.agentId, displayName: cleanStr(draft.displayName, 'displayName', 80, true) ?? draft.agentId, currency: draft.currency, policy: parsePolicy(agentId, draft.policy) });
      if (draftSetup !== setup) throw new OnboardingError('Submitted setup does not match the saved draft. Reload before creating the agent.');
    }
    if (store.listAgents().some(a => a.agentId === agentId)) throw new OnboardingError('Agent already exists. Choose another id.');
    store.upsertAgent(agentId, displayName, currency);
    const policyVersion = store.upsertPolicy(policy, { changedBy: operatorId, source: 'operator' });
    if (journey) db.prepare('UPDATE onboarding_sessions SET agent_id=?,setup_json=?,agent_policy_version=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(agentId, setup, policyVersion, new Date().toISOString(), journey.id);
    return { agentId, created: true };
  });
}
