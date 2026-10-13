import { useEffect, useRef, useState } from 'react';
import { fetchPolicyHistory, fmt, previewPolicy, replayPolicy, toMinor, type AgentState, type Policy, type PolicyPreview, type PolicyReplay, type PolicyRevision, type EvalResult } from '../lib/api';
const button = 'border border-line rounded-md px-3 py-2 text-sm hover:bg-panel disabled:opacity-40';
const inputClass = 'w-full bg-black border border-line rounded-md p-2 text-sm';
export const decisionLabel = (value: EvalResult['decision']) => ({ ALLOW: 'Allow', DENY: 'Deny', ESCALATE: 'Escalate' }[value]);
function PolicyValues({ policy }: { policy: Policy | null }) {
  if (!policy) return <p>No previous policy</p>;
  return <dl className="text-xs space-y-1">
    {Object.entries(policy).filter(([key]) => key !== 'agentId').map(([key, value]) => <div key={key}><dt className="inline">{key === 'allowedDays' ? 'Allowed days' : key}: </dt><dd className="inline break-words">{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}
  </dl>;
}
export default function PolicyTools({ agent, draft, draftKey, expectedVersion }: { agent: AgentState; draft: () => Policy | null; draftKey: string; expectedVersion: number }) {
  const [open, setOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const [amount, setAmount] = useState('10'), [vendor, setVendor] = useState('acme'), [purpose, setPurpose] = useState('Policy test');
  const [limit, setLimit] = useState('50');
  const [preview, setPreview] = useState<PolicyPreview | null>(null), [comparison, setComparison] = useState<PolicyReplay | null>(null);
  const [history, setHistory] = useState<PolicyRevision[]>([]), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setPreview(null); setComparison(null); setBusy(false); setError(null); }, [draftKey, expectedVersion, agent.policyVersion, amount, vendor, purpose, limit]);
  useEffect(() => {
    if (!historyOpen) return;
    let active = true;
    fetchPolicyHistory(agent.agentId).then(rows => { if (active) setHistory(rows); }).catch(err => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [historyOpen, agent.agentId, agent.policyVersion]);
  useEffect(() => () => { generation.current++; }, []);
  async function run(compare: boolean) {
    const policy = draft(); if (!policy) return;
    const minor = toMinor(amount, agent.currency);
    const count = Number(limit);
    if (!compare && (minor == null || minor <= 0)) { setError('Enter a positive sample amount in this currency.'); return; }
    if (compare && (!Number.isSafeInteger(count) || count < 1 || count > 500)) { setError('Choose 1 to 500 recent requests.'); return; }
    const token = ++generation.current;
    setError(null); setBusy(true);
    try {
      if (compare) { const result = await replayPolicy(policy, expectedVersion, count); if (token === generation.current) setComparison(result); }
      else { const result = await previewPolicy(policy, { amount: minor!, currency: agent.currency, vendor, purpose, rail: 'mcp' }); if (token === generation.current) setPreview(result); }
    } catch (err) { if (token === generation.current) setError(String(err)); }
    finally { if (token === generation.current) setBusy(false); }
  }
  return <section aria-label={`Policy tools for ${agent.agentId}`} className="border-t border-line mt-5 pt-4">
    <div className="flex flex-wrap gap-3">
      <button className={button} aria-expanded={open} onClick={() => setOpen(!open)}>Policy preview</button>
      <button className={button} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>Policy history</button>
    </div>
    {open && <div className="mt-4 space-y-4">
      <p className="text-sm">Test the unsaved policy. Simulation creates no payments, approvals, reservations or ledger entries.</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="text-xs">Sample amount ({agent.currency})<input className={inputClass} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="text-xs">Sample vendor<input className={inputClass} maxLength={120} value={vendor} onChange={e => setVendor(e.target.value)} /></label>
        <label className="text-xs">Sample purpose<input className={inputClass} maxLength={280} value={purpose} onChange={e => setPurpose(e.target.value)} /></label>
      </div>
      <button className={button} disabled={busy} onClick={() => void run(false)}>Evaluate sample</button>
      {preview && <div data-testid="policy-preview-result" role="status" className="border border-line rounded-lg p-4 text-sm space-y-2">
        <p className="font-semibold">{decisionLabel(preview.verdict.decision)} · {preview.verdict.rule}</p><p>{preview.verdict.reason}</p>
        <p>Context: {preview.evaluatedAt} · UTC · {preview.context.agentCurrency} · Vendor {preview.context.vendorKnown ? 'previously authorised' : 'not previously authorised'}</p>
        <p>Completed spend {fmt(preview.context.budget.spentMinor, agent.currency)} · Reserved {fmt(preview.context.budget.reservedMinor, agent.currency)}</p>
        <p>{preview.assumptions}</p>
      </div>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">Recent requests<input className={inputClass} type="number" min={1} max={500} value={limit} onChange={e => setLimit(e.target.value)} /></label>
        <button className={button} disabled={busy} onClick={() => void run(true)}>Compare recent requests</button>
      </div>
      {comparison && <div data-testid="policy-replay-result" role="status" className="border border-line rounded-lg p-4 text-sm space-y-3">
        <p>{comparison.changedOutcomes} changed outcome{comparison.changedOutcomes === 1 ? '' : 's'} · {comparison.changedReasons} changed reason{comparison.changedReasons === 1 ? '' : 's'}</p>
        <p>Coverage: {comparison.coverage.evaluated} of {comparison.coverage.selected} requests · {comparison.coverage.unavailable} unavailable · Current policy version {comparison.currentVersion}</p>
        <p>{comparison.assumptions}</p>
        {Object.entries(comparison.transitions).map(([transition, count]) => <p key={transition}>{transition.toLowerCase()}: {count}</p>)}
        <div className="max-h-80 overflow-auto"><table className="w-full border-collapse text-left text-xs"><caption className="text-left mb-2">Same original context for both policies</caption>
          <thead><tr><th className="border border-line p-2">Request / UTC time</th><th className="border border-line p-2">Current policy</th><th className="border border-line p-2">Proposed policy</th></tr></thead>
          <tbody>{comparison.rows.map(row => <tr key={row.requestId}><td className="border border-line p-2 break-all">{row.requestId}<br />{row.evaluatedAt}</td><td className="border border-line p-2">{decisionLabel(row.current.decision)}<br />{row.current.rule}<br />{row.current.reason}</td><td className="border border-line p-2">{decisionLabel(row.proposed.decision)}<br />{row.proposed.rule}<br />{row.proposed.reason}</td></tr>)}</tbody>
        </table></div>
        {comparison.unavailable.map(row => <p key={row.requestId} className="break-all">{row.requestId}: {row.reason}</p>)}
      </div>}
    </div>}
    {historyOpen && <div data-testid="policy-history" className="mt-4 space-y-3">
      <p className="text-xs">Latest 50 revisions · Amounts in atomic minor units · UTC timestamps</p>
      {history.map(row => <details key={row.version} className="border border-line rounded-lg p-3 text-sm">
        <summary className="cursor-pointer break-words">Version {row.version} · {row.changedAt} · {row.changedBy} · {row.source === 'migration' ? 'Migration baseline; earlier change history unavailable' : row.source}</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3"><div><h4 className="mb-2">Before</h4><PolicyValues policy={row.before} /></div><div><h4 className="mb-2">After</h4><PolicyValues policy={row.after} /></div></div>
      </details>)}
    </div>}
    {error && <p role="alert" className="text-danger text-sm mt-3">{error}</p>}
  </section>;
}
