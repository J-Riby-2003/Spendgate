import { useEffect, useRef, useState } from 'react';
import { CURRENCIES, fmt, minorToUnits, onboardingRequest, toMinor,
  type OnboardingJourney, type OnboardingTests, type Policy } from '../lib/api';
import { ConfirmModal } from '../components/Modal';
import { PageHeader } from '../components/ui';

const inputClass = 'mt-1 w-full h-10 bg-black border border-line rounded-md px-3 text-paper';
const buttonClass = 'h-10 px-4 bg-paper text-bg rounded-md text-sm disabled:opacity-50';
type Step = 'details' | 'policy' | 'credential' | 'connect' | 'test' | 'done';
const steps: Step[] = ['details', 'policy', 'credential', 'connect', 'test'];
const labels: Record<Step, string> = { details: 'Agent', policy: 'Policy', credential: 'Credential', connect: 'Connect', test: 'Safe tests', done: 'Complete' };
function resumeStep(j: OnboardingJourney): Step {
  return j.completedAt ? 'done' : !j.agentId ? 'details' : !j.credentialId || !j.credentialActive ? 'credential' : j.connectedAt ? 'test' : 'credential';
}
export default function Onboarding() {
  const [journey, setJourney] = useState<OnboardingJourney | null>(null);
  const [step, setStep] = useState<Step>('details');
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('GBP');
  const [ceiling, setCeiling] = useState('50');
  const [daily, setDaily] = useState('500');
  const [threshold, setThreshold] = useState('200');
  const [mode, setMode] = useState<Policy['budgetMode']>('hard-stop');
  const [newVendor, setNewVendor] = useState(true);
  const [blocked, setBlocked] = useState('');
  const [secret, setSecret] = useState('');
  const [reveal, setReveal] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [challenge, setChallenge] = useState<{ challenge: string; expiresAt: string } | null>(null);
  const [results, setResults] = useState<OnboardingTests | null>(null);
  const [amount, setAmount] = useState('1');
  const [vendor, setVendor] = useState('example-vendor');
  const [purpose, setPurpose] = useState('Onboarding safe test');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const alive = useRef(true);
  const path = journey ? `onboarding/${journey.id}` : '';

  function restore(j: OnboardingJourney) {
    setJourney(j); setStep(resumeStep(j));
    setAgentId(j.draft.agentId ?? j.agentId ?? ''); setName(j.draft.displayName ?? '');
    const cur = j.draft.currency ?? 'GBP'; setCurrency(cur);
    if (j.draft.policy) {
      const p = j.draft.policy;
      setCeiling(minorToUnits(p.maxPerTxn, cur)); setDaily(minorToUnits(p.dailyBudget, cur)); setThreshold(minorToUnits(p.approvalThreshold, cur));
      setMode(p.budgetMode); setNewVendor(p.newVendorRequiresApproval); setBlocked(p.blockedVendors.join(', '));
    }
  }
  async function refresh() {
    const j = await onboardingRequest<OnboardingJourney>(path); setJourney(j); return j;
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : 'Unable to complete setup. Retry or reload to resume.'); }
    finally { setBusy(false); }
  }
  async function load() {
    const journeys = await onboardingRequest<OnboardingJourney[]>('onboarding');
    const j = journeys.find(j => !j.completedAt) ?? journeys[0] ?? await onboardingRequest<OnboardingJourney>('onboarding', 'POST', { requestId: requestId.current });
    if (alive.current) restore(j);
  }
  useEffect(() => {
    alive.current = true;
    void perform(load);
    return () => { alive.current = false; };
  }, []);

  function policy(): Policy {
    const parse = (value: string, label: string) => {
      if (!value.trim()) return null;
      const minor = toMinor(value, currency);
      if (minor === null) throw new Error(`${label}: enter a valid amount in ${currency}.`);
      return minor;
    };
    return { agentId: agentId.trim().toLowerCase(), maxPerTxn: parse(ceiling, 'Auto-approve ceiling'), dailyBudget: parse(daily, 'Daily budget'),
      approvalThreshold: parse(threshold, 'Approval threshold'), budgetMode: mode, newVendorRequiresApproval: newVendor,
      blockedVendors: blocked.split(',').map(v => v.trim()).filter(Boolean), allowedVendors: '*', allowedDays: '*', allowedWindow: null };
  }
  async function saveDraft(includePolicy: boolean) {
    const next = await onboardingRequest<OnboardingJourney>(path, 'PATCH', { expectedRevision: journey!.revision,
      draft: { agentId: agentId.trim().toLowerCase(), displayName: name.trim(), currency, ...(includePolicy ? { policy: policy() } : {}) } });
    setJourney(next); return next;
  }
  async function deliverCredential(rotation = false) {
    const j = rotation ? journey! : await refresh();
    if (!j.agentId) throw new Error('Create the agent first.');
    const route = `agents/${encodeURIComponent(j.agentId)}/credentials${rotation ? `/${encodeURIComponent(j.credentialId!)}/rotate` : ''}`;
    const result = await onboardingRequest<{ id: string; secret: string | null }>(route, 'POST', { onboardingId: j.id });
    setSecret(result.secret ?? ''); setReveal(false); setChallenge(null); setResults(null);
    await refresh();
    if (!result.secret) setNotice('Credential already issued. Use your saved secret or explicitly rotate to recover it.');
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('Copied.'); }
    catch { setNotice('Clipboard unavailable. Select and copy the text.'); }
  }
  const configuration = JSON.stringify({ mcpServers: { spendlock: { type: 'http', url: `${location.origin}/mcp`, headers: { Authorization: 'Bearer ${SPENDLOCK_AGENT_TOKEN}' } } } }, null, 2);
  const prompt = challenge ? `Use SpendLock connection_check with ${JSON.stringify({ challenge: challenge.challenge })}. This is a connection check only; do not call spend.` : '';
  const testPrompt = journey ? `Use SpendLock onboarding_test with ${JSON.stringify({ onboardingId: journey.id, sample: { amount: toMinor(amount, currency), currency, vendor, purpose, rail: 'mcp' } })}. This is simulation only; do not call spend.` : '';

  return <div>
    <PageHeader title="Set up an agent" sub="" />
    <p className="text-sm text-paper mb-5">Create an agent, connect its scoped credential, then test policy safely. You can leave and resume setup.</p>
    <ol aria-label="Setup steps" className="flex flex-wrap gap-3 mb-6 text-sm text-paper">
      {steps.map((s, i) => <li key={s} aria-current={step === s ? 'step' : undefined} className={`border border-line rounded-md px-3 py-2 ${step === s ? 'bg-panel font-semibold' : ''}`}>{i + 1}. {labels[s]}</li>)}
    </ol>
    {error && <p role="alert" className="text-danger text-sm mb-4">{error} <button className="underline ml-2" disabled={busy} onClick={() => void perform(load)}>Reload setup</button></p>}
    <p role="status" className="text-paper text-sm mb-3">{notice}</p>
    {!journey ? <p className="text-paper">{busy ? 'Loading setup…' : 'Setup unavailable. Use Reload setup to retry.'}</p> : <div className="border border-line rounded-lg p-5 bg-black text-paper">
      {journey.agentId && !journey.agentExists && !journey.completedAt ? <div className="space-y-3"><p role="alert">This agent was removed or replaced. This setup cannot attach to another agent with the same id.</p><p className="text-sm">Abandoning setup only clears progress. Manage any remaining agent credentials and requests in Agents & Policy.</p><button disabled={busy} className={buttonClass} onClick={() => void perform(async () => { await onboardingRequest(path + '/abandon', 'POST', {}); requestId.current = crypto.randomUUID(); restore(await onboardingRequest<OnboardingJourney>('onboarding', 'POST', { requestId: requestId.current })); })}>Abandon setup and restart</button></div> : <>
      {step === 'details' && <form className="space-y-4 max-w-lg" onSubmit={e => { e.preventDefault(); void perform(async () => { await saveDraft(false); setStep('policy'); }); }}>
        <h2 className="text-lg font-semibold">Agent details</h2>
        <label className="block text-sm">Agent id<input required pattern="[a-z0-9-]{2,64}" maxLength={64} value={agentId} onChange={e => setAgentId(e.target.value)} className={inputClass} /></label>
        <label className="block text-sm">Display name<input maxLength={80} value={name} onChange={e => setName(e.target.value)} className={inputClass} /></label>
        <label className="block text-sm">Currency<select value={currency} onChange={e => setCurrency(e.target.value)} className={inputClass}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></label>
        <p className="text-sm">Each agent uses one currency. Daily budgets and time windows use UTC.</p>
        <button disabled={busy} className={buttonClass}>Continue to policy</button>
      </form>}
      {step === 'policy' && <form className="space-y-4 max-w-lg" onSubmit={e => { e.preventDefault(); void perform(async () => {
        const next = await saveDraft(true);
        await onboardingRequest('agents', 'POST', { ...next.draft, onboardingId: next.id, expectedRevision: next.revision });
        await refresh(); setStep('credential');
      }); }}>
        <h2 className="text-lg font-semibold">Initial policy · {currency}</h2>
        <p className="text-sm">Start with a hard budget stop and human review for new vendors. Review these limits before connecting.</p>
        <label className="block text-sm">Auto-approve ceiling<input inputMode="decimal" value={ceiling} onChange={e => setCeiling(e.target.value)} className={inputClass} /></label>
        <label className="block text-sm">Daily budget<input inputMode="decimal" value={daily} onChange={e => setDaily(e.target.value)} className={inputClass} /></label>
        <label className="block text-sm">Approval threshold<input inputMode="decimal" value={threshold} onChange={e => setThreshold(e.target.value)} className={inputClass} /></label>
        <p className="text-sm">Blank amount means unlimited budget/ceiling, or no approval threshold.</p>
        <label className="block text-sm">Budget mode<select value={mode} onChange={e => setMode(e.target.value as Policy['budgetMode'])} className={inputClass}><option value="hard-stop">Hard stop</option><option value="approval-override">Approval override</option></select></label>
        <p className="text-sm">Hard stop denies requests without available funds. Approval override requires a recorded operator exception.</p>
        <label className="block text-sm"><input type="checkbox" checked={newVendor} onChange={e => setNewVendor(e.target.checked)} className="mr-2" />New vendors require approval</label>
        <label className="block text-sm">Blocked vendors<input value={blocked} onChange={e => setBlocked(e.target.value)} maxLength={2500} className={inputClass} placeholder="Comma-separated vendor names" /></label>
        <p className="text-sm">Other vendors and all UTC days/hours are allowed initially. Further restrictions are available in Agents & Policy.</p>
        <div className="flex gap-3"><button type="button" disabled={busy} className="text-sm underline" onClick={() => setStep('details')}>Back</button><button disabled={busy} className={buttonClass}>Create agent and policy</button></div>
      </form>}
      {step === 'credential' && <div className="space-y-4 max-w-2xl">
        <h2 className="text-lg font-semibold">Agent credential</h2>
        <p className="text-sm">This credential accesses only {journey.agentId}. Store it in your agent’s secret manager and load it as SPENDLOCK_AGENT_TOKEN in the environment used to launch Claude Code. Keep it out of source control, chat messages and shell history.</p>
        {secret ? <>
          <label className="block text-sm">New agent credential<input type={reveal ? 'text' : 'password'} readOnly autoComplete="off" value={secret} className={inputClass} /></label>
          <div className="flex flex-wrap gap-3"><button className="text-sm underline" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide' : 'Reveal'} credential</button><button className="text-sm underline" onClick={() => void copy(secret)}>Copy credential</button></div>
          <p className="text-sm">Shown only during creation or rotation. After leaving this step, use your saved copy or rotate it.</p>
          <button disabled={busy} className={buttonClass} onClick={() => { setSecret(''); setReveal(false); setStep('connect'); }}>I have saved the credential</button>
        </> : !journey.credentialId ? <button disabled={busy} className={buttonClass} onClick={() => void perform(() => deliverCredential())}>Create credential</button> : <>
          <p className="text-sm">A credential was already issued. Its secret cannot be retrieved. {journey.credentialActive ? 'Continue with your saved secret.' : 'It has been revoked. Rotate to create a replacement.'}</p>
          <div className="flex flex-wrap gap-3">
            {journey.credentialActive && <button disabled={busy} className={buttonClass} onClick={() => setStep('connect')}>Continue with saved credential</button>}
            <button disabled={busy} className="text-sm underline" onClick={() => setRotate(true)}>Rotate credential to recover</button>
          </div>
        </>}
      </div>}
      {step === 'connect' && <div className="space-y-4">
        <h2 className="text-lg font-semibold">Connect Claude Code</h2>
        <p className="text-sm">Merge this into your project’s .mcp.json. It references your private environment variable; it contains no credential secret. Launch Claude Code with that variable loaded, approve this project server, then use /mcp to check its status.</p>
        <pre aria-label="Claude Code configuration" className="border border-line rounded-md p-3 text-xs overflow-x-auto whitespace-pre">{configuration}</pre>
        <button className="text-sm underline" onClick={() => void copy(configuration)}>Copy configuration</button>
        <p className="text-sm"><a className="underline" href="https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json" target="_blank" rel="noreferrer">Claude Code connection documentation</a></p>
        <p className="text-sm">Credentials can spend within policy. Use only connection_check and onboarding_test during setup.</p>
        {!journey.connectedAt && <button disabled={busy} className={buttonClass} onClick={() => void perform(async () => { setChallenge(await onboardingRequest(path + '/challenge', 'POST', {})); })}>{challenge ? 'Get a fresh challenge' : 'Get connection challenge'}</button>}
        {challenge && !journey.connectedAt && <>
          <label className="block text-sm">Connection challenge<input readOnly value={challenge.challenge} className={inputClass} /></label>
          <p className="text-sm">Expires {new Date(challenge.expiresAt).toLocaleTimeString()}. In Claude Code, ask:</p>
          <pre className="border border-line rounded-md p-3 text-xs whitespace-pre-wrap break-all">{prompt}</pre>
          <button className="text-sm underline" onClick={() => void copy(prompt)}>Copy connection request</button>
        </>}
        {journey.connectedAt ? <p role="status" className="text-ok text-sm">MCP connection verified</p> : <p className="text-sm">Authentication error: check SPENDLOCK_AGENT_TOKEN, restart the client after rotation and use the current challenge. Network error: check the endpoint and server availability. Expired challenge: request a fresh one.</p>}
        <div className="flex flex-wrap gap-3">
          <button disabled={busy} className="text-sm underline" onClick={() => { setSecret(''); setStep('credential'); }}>Credential recovery</button>
          <button disabled={busy} className={buttonClass} onClick={() => void perform(async () => {
            const j = await refresh();
            if (!j.connectedAt) throw new Error('No MCP client has verified this credential yet. Run connection_check in your client, then retry.');
          })}>Check connection status</button>
          {journey.connectedAt && <button disabled={busy} className={buttonClass} onClick={() => setStep('test')}>Continue to safe tests</button>}
        </div>
      </div>}
      {step === 'test' && <div className="space-y-4">
        <h2 className="text-lg font-semibold">Safe test mode</h2>
        <p className="text-sm">Simulation only. No payments, approval queue items, reservations or production ledger entries are created. Your saved policy stays unchanged.</p>
        {journey.testedAt && <p role="status" className="text-ok text-sm">Safe tests completed</p>}
        <form className="space-y-4 max-w-lg" onSubmit={e => { e.preventDefault(); void perform(async () => {
          const minor = toMinor(amount, currency); if (minor === null || minor <= 0) throw new Error(`Enter a positive amount in ${currency}.`);
          setResults(await onboardingRequest<OnboardingTests>(path + '/test', 'POST', { sample: { amount: minor, currency, vendor, purpose, rail: 'mcp' } }));
          await refresh();
        }); }}>
          <label className="block text-sm">Test amount ({currency})<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" required className={inputClass} /></label>
          <label className="block text-sm">Test vendor<input value={vendor} onChange={e => setVendor(e.target.value)} required maxLength={120} className={inputClass} /></label>
          <label className="block text-sm">Test purpose<input value={purpose} onChange={e => setPurpose(e.target.value)} required maxLength={280} className={inputClass} /></label>
          <button disabled={busy} className={buttonClass}>Run safe tests</button>
        </form>
        <details><summary className="text-sm cursor-pointer">Send the same safe test from Claude Code</summary><pre className="border border-line p-3 mt-2 text-xs whitespace-pre-wrap break-all">{testPrompt}</pre><button className="text-sm underline" onClick={() => void copy(testPrompt)}>Copy safe test request</button><button disabled={busy} className="ml-3 text-sm underline" onClick={() => void perform(async () => { const j = await refresh(); if (!j.testedAt) throw new Error('No safe test received yet. Run onboarding_test in your client, then retry.'); })}>Check safe test status</button></details>
        {results && <div className="space-y-4" aria-live="polite">
          <Result title="Your saved policy" preview={results.saved} />
          <p className="text-sm">{results.fixtureNotice}</p>
          {results.examples.map(e => <Result key={e.label} title={e.label} preview={e.preview} extra={`${fmt(e.sample.amount, e.sample.currency)} · ${e.sample.vendor}. Fixture: unlimited daily budget and UTC hours; ${e.policy.approvalThreshold === 1 ? 'approval at one atomic unit' : e.policy.blockedVendors.length ? 'example vendor blocked' : 'no approval gates'}.`} />)}
          <p className="text-sm">{results.nextAction}</p>
        </div>}
        <div className="flex flex-wrap gap-3"><button disabled={busy} className="text-sm underline" onClick={() => setStep('connect')}>Back to connection</button>
          <button disabled={busy || !journey.testedAt} className={buttonClass} onClick={() => void perform(async () => { setJourney(await onboardingRequest(path + '/complete', 'POST', {})); setStep('done'); })}>Finish setup</button></div>
      </div>}
      {step === 'done' && <div className="space-y-4"><h2 className="text-lg font-semibold">Agent setup complete</h2>{!journey.credentialActive && <p role="alert" className="text-sm">The setup credential is no longer active. Manage credentials in Agents & Policy or start another agent.</p>}<p className="text-sm">{journey.agentId} completed onboarding. Review its policy in Agents & Policy before real spending. Authorisation can reserve funds; it is not proof of payment.</p><button disabled={busy} className={buttonClass} onClick={() => void perform(async () => {
        requestId.current = crypto.randomUUID(); setSecret(''); setResults(null); setChallenge(null);
        setCeiling('50'); setDaily('500'); setThreshold('200'); setMode('hard-stop'); setNewVendor(true); setBlocked('');
        restore(await onboardingRequest<OnboardingJourney>('onboarding', 'POST', { requestId: requestId.current }));
      })}>Start another agent</button></div>}
      </>}
    </div>}
    {rotate && <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Rotate agent credential"><ConfirmModal title="Rotate agent credential?" body="The previous credential will stop working immediately. Save the replacement secret and reconnect the MCP client. Pending real requests are preserved." confirmLabel="Rotate now" doneMessage="Credential rotated" error={error || null} onConfirm={async () => {
      setError('');
      try { await deliverCredential(true); setRotate(false); return true; }
      catch (err) { setError(err instanceof Error ? err.message : 'Rotation failed. Reload setup before retrying.'); return false; }
    }} onClose={() => setRotate(false)} /></div>}
  </div>;
}
function Result({ title, preview, extra }: { title: string; preview: OnboardingTests['saved']; extra?: string }) {
  const outcome = { ALLOW: 'Allowed', ESCALATE: 'Approval required', DENY: 'Denied' }[preview.verdict.decision];
  return <section className="border border-line rounded-md p-4"><h3 className="font-semibold text-sm">{title}</h3>
    <p className="text-sm mt-2">{outcome} · {preview.verdict.rule}</p><p className="text-sm">{preview.verdict.reason}</p>
    {extra && <p className="text-xs mt-2">{extra}</p>}
    <p className="text-xs mt-2">Saved-policy reference {preview.currentVersion} · {preview.evaluatedAt} · {preview.context.vendorKnown ? 'Previously authorised vendor' : 'No prior vendor authorisation'} · Completed {fmt(preview.context.budget.spentMinor, preview.context.agentCurrency)} · Reserved {fmt(preview.context.budget.reservedMinor, preview.context.agentCurrency)}</p>
    {!extra && <details className="text-xs mt-2"><summary className="cursor-pointer">Simulation context and assumptions</summary><p className="mt-2">{preview.assumptions}</p></details>}
    <p className="text-sm mt-2">{preview.verdict.decision === 'ESCALATE' ? 'A real request would require a human decision. This simulation creates no approval.' : preview.verdict.decision === 'DENY' ? 'Review the triggering restriction before submitting a real request.' : 'This sample passes the shown policy and context. Real requests recheck current conditions.'}</p>
  </section>;
}
