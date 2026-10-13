import { useEffect, useState } from 'react';
import { fetchPolicyEvidence, fmt, type PolicyEvidence } from '../lib/api';
import { decisionLabel } from './PolicyTools';
export default function DecisionEvidence({ requestId }: { requestId: string }) {
  const [evidence, setEvidence] = useState<PolicyEvidence | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true; setEvidence(null); setError(null);
    fetchPolicyEvidence(requestId).then(result => { if (active) setEvidence(result); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [requestId]);
  const e = evidence?.envelope;
  return <div className="col-span-2 border-t border-line mt-2 pt-3 text-xs space-y-2">
    {error ? <p role="alert">{error}</p> : !evidence ? <p>Loading original policy context…</p> : !e ? <p>Original policy context {evidence.integrity === 'invalid' ? 'failed integrity checks' : 'unavailable for this historical request'}.</p> : <>
      <p>Policy version: {e.policyVersion}</p><p>Original evaluation: {decisionLabel(e.verdict.decision)}</p>
      <p>{e.verdict.rule} · {e.verdict.reason}</p>
      <p>Evaluated at {e.evaluatedAt} · UTC · Evaluator {e.evaluatorVersion}</p>
      <p>Currency {e.context.agentCurrency} · Vendor {e.context.vendorKnown ? 'previously authorised' : 'not previously authorised'}</p>
      <p>Original budget: completed {fmt(e.context.budget.spentMinor, e.context.agentCurrency)} · reserved {fmt(e.context.budget.reservedMinor, e.context.agentCurrency)} · remaining {e.context.budget.remainingMinor == null ? 'Unlimited' : fmt(e.context.budget.remainingMinor, e.context.agentCurrency)}</p>
      <p>Mode {e.context.budget.mode} · Period {e.context.budget.periodStart} – {e.context.budget.periodEnd}</p>
      <p className="break-all">Evidence digest matches recorded reference: {evidence.digest}</p>
      <p>Original evaluation precedes any human decision and its separate budget recheck. Ledger chain verification is shown above.</p>
    </>}
  </div>;
}
