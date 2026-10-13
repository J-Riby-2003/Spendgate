import { useEffect, useState } from 'react';
import { issueCredential, listCredentials, revokeCredential, type Credential } from '../lib/api';
import { ConfirmModal } from './Modal';

export default function Credentials({ agentId }: { agentId: string }) {
  const [rows, setRows] = useState<Credential[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ id: string; rotate: boolean } | null>(null);
  const refresh = () => listCredentials(agentId).then(setRows);
  useEffect(() => { refresh().catch(() => setError('Unable to load credentials')); }, [agentId]);
  async function issue(id?: string) {
    setBusy(true); setError('');
    try { const next = await issueCredential(agentId, id); setSecret(next.secret); await refresh(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : 'Credential issuance failed'); return false; }
    finally { setBusy(false); }
  }
  return <section aria-label={`Credentials for ${agentId}`} className="mt-6 pt-5 border-t border-line text-paper text-sm">
    <h3 className="font-semibold mb-3">Agent credentials</h3>
    <button disabled={busy || secret !== null} onClick={() => issue()} className="h-10 px-4 bg-paper text-bg rounded-md disabled:opacity-50">Issue credential</button>
    {secret && <div className="mt-3 border border-line rounded-md p-3">
      <p>Save this credential in your agent’s secret store. It is shown once. Rotation immediately revokes the previous credential.</p>
      <label className="block mt-2">New credential<input readOnly value={secret} className="block w-full bg-black border border-line p-2 rounded-md mt-1" onFocus={e => e.target.select()} /></label>
      <button className="mt-2 h-10 underline" onClick={() => setSecret(null)}>I have saved it</button>
    </div>}
    <ul className="mt-3 space-y-2">{rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-3">
      <span className="break-all">{row.id} · {row.revokedAt ? 'Revoked' : 'Active'}</span>
      {!row.revokedAt && <><button disabled={busy || secret !== null} className="h-10 underline disabled:opacity-50" onClick={() => setAction({ id: row.id, rotate: true })}>Rotate</button>
        <button disabled={busy} className="h-10 text-danger underline" onClick={() => setAction({ id: row.id, rotate: false })}>Revoke</button></>}
    </li>)}</ul>
    {error && <p role="alert" className="text-danger mt-2">{error}</p>}
    {action && <ConfirmModal doneMessage="Credential updated" title={action.rotate ? 'Rotate credential?' : 'Revoke credential?'} body="The current credential and its active connections will stop working. Pending approvals are preserved." danger confirmLabel={action.rotate ? 'Rotate' : 'Revoke'} onClose={() => setAction(null)} onConfirm={async () => {
      if (action.rotate) return issue(action.id);
      try { await revokeCredential(agentId, action.id); await refresh(); return true; }
      catch (e) { setError(String(e)); return false; }
    }} error={error} />}
  </section>;
}
