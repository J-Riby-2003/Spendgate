import { useState } from 'react';
import { fetchReconciliation, reconcileLegacy, fmt, type AgentState, type LegacyObligation, type ReconciliationPreview } from '../lib/api';
import { ConfirmModal } from './Modal';

export default function BudgetReconciliation({ agent }: { agent: AgentState }) {
  const [preview, setPreview] = useState<ReconciliationPreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true); setError('');
    try { setPreview(await fetchReconciliation(agent.agentId)); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }
  return <div className="mb-5">
    {agent.budget.reconciliationRequired && <p className="text-sm mb-2">New authorisations are paused until the listed unknown obligations are reviewed. Foreign-currency outstanding obligations must be resolved before spending resumes.</p>}
    <button onClick={() => preview ? setPreview(null) : void load()} disabled={loading} className="font-mono text-[12px] underline underline-offset-4">
      {loading ? 'Loading obligations…' : preview ? 'Close legacy review' : 'Review legacy obligations'}
    </button>
    {error && <p role="alert" className="text-danger text-sm mt-2">{error}</p>}
    {preview && <div className="mt-3 space-y-3">
      <p className="text-[12px]">Approval-only history has unknown payment status. Attesting no outstanding obligation does not confirm that a payment occurred.</p>
      {preview.obligations.length === 0 && <p className="text-sm">No legacy obligations require review.</p>}
      {preview.obligations.map(obligation => <Obligation key={`${obligation.ledgerSeq}:${obligation.disposition}`} agentId={agent.agentId} obligation={obligation} onRecorded={load} />)}
    </div>}
  </div>;
}
function Obligation({ agentId, obligation: o, onRecorded }: { agentId: string; obligation: LegacyObligation; onRecorded: () => Promise<void> }) {
  const [action, setAction] = useState('no-outstanding-obligation');
  const [reason, setReason] = useState(''), [evidence, setEvidence] = useState(''), [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  // Stable across transport retries; changed payload requires a fresh review key.
  const [eventId, setEventId] = useState(() => crypto.randomUUID());
  const editable = o.disposition == null || o.disposition === 'outstanding';
  const evidenceRequired = action === 'confirmed-paid' || (o.disposition === 'outstanding' && action === 'no-outstanding-obligation');
  return <section aria-label={`Legacy obligation ${o.ledgerSeq}`} className="border border-line rounded-lg p-4">
    <p className="text-sm">Ledger #{o.ledgerSeq} · {o.vendor} · {fmt(o.amountMinor, o.currency)} ({o.currency}) · {o.ts}</p>
    <p className="text-[12px] mt-1">{o.purpose} · Payment status: {o.executionStatus} · Disposition: {o.disposition ?? 'Review required'}</p>
    {o.reason && <p className="text-[12px] mt-1">Recorded by {o.operatorId}: {o.reason}{o.evidence ? ` · Evidence: ${o.evidence}` : ''}</p>}
    {editable && <>
      <label className="block text-[12px] mt-3">Disposition
        <select value={action} onChange={e => { setAction(e.target.value); setEventId(crypto.randomUUID()); }} className="block bg-black border border-line rounded-md p-2 mt-1 text-sm">
          <option value="no-outstanding-obligation">No outstanding obligation; historical payment remains unknown</option>
          {o.disposition == null && <option value="outstanding">Outstanding obligation; reserve funds</option>}
          <option value="confirmed-paid">Confirmed payment; evidence required</option>
        </select>
      </label>
      <label className="block text-[12px] mt-2">Review reason
        <input value={reason} maxLength={1000} onChange={e => { setReason(e.target.value); setEventId(crypto.randomUUID()); }} className="block w-full h-10 bg-black border border-line rounded-md px-3 mt-1 text-sm" />
      </label>
      <label className="block text-[12px] mt-2">Evidence reference{evidenceRequired ? ' (required)' : ''}
        <input value={evidence} maxLength={1000} onChange={e => { setEvidence(e.target.value); setEventId(crypto.randomUUID()); }} className="block w-full h-10 bg-black border border-line rounded-md px-3 mt-1 text-sm" />
      </label>
      <button disabled={!reason.trim() || (evidenceRequired && !evidence.trim())} onClick={() => { setError(''); setConfirm(true); }} className="mt-3 h-10 px-4 rounded-md bg-paper text-bg text-[12px] disabled:opacity-30">Record reconciliation</button>
      {confirm && <ConfirmModal title={`Reconcile ledger #${o.ledgerSeq}`} body={`Record ${action} for ${fmt(o.amountMinor, o.currency)}. Reason: ${reason}. ${action === 'no-outstanding-obligation' ? 'This attests no outstanding obligation; historical payment remains unknown.' : action === 'outstanding' ? 'This reserves the full amount against available funds.' : `This records completed spend in the original authorisation period. Evidence: ${evidence}.`}`}
        error={error} doneMessage="Reconciliation recorded" onClose={() => setConfirm(false)} onConfirm={async () => {
          try { await reconcileLegacy(agentId, { ledgerSeq: o.ledgerSeq, action, reason, evidence: evidence || undefined, eventId }); await onRecorded(); return true; }
          catch (e) { setError(String(e)); return false; }
        }} />}
    </>}
  </section>;
}
