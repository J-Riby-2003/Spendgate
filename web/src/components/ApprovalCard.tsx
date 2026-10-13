import { useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalDecisionError, decideApproval, fmt, type ApprovalRequest } from '../lib/api';
import { Badge, Mono } from './ui';
import { useLang } from '../lib/i18n';

const amount = (n: number, currency: string) => `${fmt(n, currency)} ${currency}`;
const date = (s: string) => new Date(s).toLocaleString(undefined, { timeZone: 'UTC' }) + ' UTC';

export default function ApprovalCard({ approval, refresh, completed }: {
  approval: ApprovalRequest; refresh: () => Promise<void>; completed: (message: string) => void;
}) {
  const { t } = useLang();
  const [replacement, setReplacement] = useState<ApprovalRequest | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const a = replacement ?? approval, c = a.context;
  const anchor = useMemo(() => ({ server: Date.parse(c?.serverNow ?? ''), received: performance.now() }), [c?.serverNow]);
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(n => n+1), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setReplacement(null); }, [approval]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const age = performance.now() - anchor.received;
  const remaining = Date.parse(a.expiresAt) - (anchor.server + age);
  const expired = !Number.isFinite(remaining) || remaining <= 0;
  const stale = !c || age >= 30_000;
  const inactive = a.status !== 'pending' || expired || stale;
  const preview = c?.budget.status === 'available' ? c.budget : null;
  const override = !!preview?.overrideRequired;
  const disabledApprove = busy || inactive || !c?.actions.approve.enabled || (override && !note.trim());
  async function decide(approve: boolean) {
    if (submitting.current || inactive || (approve ? disabledApprove : !c?.actions.reject.enabled)) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      await decideApproval(a.id, approve, note.trim() || undefined, approve && override);
      setNote('');
      // Keep the old card inert if the subsequent state refresh fails.
      setReplacement({ ...a, status: approve ? 'approved' : 'rejected' });
      completed(t(approve ? 'approval.approved' : 'approval.rejected'));
    } catch (err) {
      if (err instanceof ApprovalDecisionError && err.approval) setReplacement(err.approval);
      setError(err instanceof Error ? err.message : t('approval.error'));
    } finally {
      await refresh(); submitting.current = false; setBusy(false);
    }
  }
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const history = c?.vendorHistory;
  const notification = a.notification;
  return (
    <div role="region" aria-label={`Approval: ${a.intent.purpose}`} className="border border-line bg-black rounded-lg px-4 sm:px-5 py-4 text-paper break-words">
      <div className="flex flex-wrap items-center gap-3 mb-2"><Badge value={expired && a.status === 'pending' ? 'expired' : a.status} /><Mono>{a.rule}</Mono></div>
      <p className="text-[17px] font-medium">{amount(a.intent.amount, a.intent.currency)}</p>
      <p className="mt-1">{a.intent.vendor}</p>
      <p className="text-sm mt-2">{a.reason}</p>
      <p className="text-sm mt-2">{c ? `${c.agent.displayName} (${c.agent.id})` : a.intent.agentId}</p>
      <p className="text-sm mt-1 whitespace-pre-wrap">{a.intent.purpose}</p>
      <Mono className="block mt-1">{t('approval.rail', { rail: a.intent.rail })}</Mono>
      <div className="mt-4 border-t border-line pt-3">
        <p className="text-sm font-medium mb-2">{t('approval.budget')}</p>
        {preview ? <>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
            <div><dt>{t('approval.spent')}</dt><dd>{amount(preview.snapshot.spentMinor, preview.snapshot.currency)}</dd></div>
            <div><dt>{t('approval.reserved')}</dt><dd>{amount(preview.snapshot.reservedMinor, preview.snapshot.currency)}</dd></div>
            <div><dt>{t('approval.remaining')}</dt><dd>{preview.snapshot.remainingMinor == null ? t('approval.unlimited') : amount(preview.snapshot.remainingMinor, preview.snapshot.currency)}</dd></div>
          </dl>
          <p className="text-sm mt-2">{t('approval.mode', { mode: preview.snapshot.mode })}</p>
          <Mono className="block mt-1">{t('approval.period', { start: date(preview.snapshot.periodStart), end: date(preview.snapshot.periodEnd) })}</Mono>
          {a.status === 'pending' && <>
            <p className="text-sm mt-2">{t('approval.projection', { remaining: preview.projectedRemainingMinor == null ? t('approval.unlimited') : amount(preview.projectedRemainingMinor, preview.snapshot.currency) })}</p>
            <p className="text-sm mt-1">{t('approval.noHold')}</p>
            <p className="text-sm mt-1">{t('approval.permission')}</p>
          </>}
        </> : <p className="text-sm">{t('approval.budgetUnavailable')}</p>}
      </div>
      <div className="mt-4 border-t border-line pt-3 text-sm">
        <p className="font-medium mb-2">{t('approval.vendorHistory')}</p>
        {history?.status === 'available' ? <>
          <p>{t(history.isNewVendor ? 'approval.newVendor' : 'approval.knownVendor')}</p>
          {history.recent.length === 0 ? <p className="mt-1">{t('approval.noHistory')}</p> : <ul className="mt-2 space-y-2">
            {history.recent.map(h => <li key={h.requestId} className="flex flex-wrap gap-x-3 gap-y-1"><span>{date(h.at)}</span><span>{amount(h.amount,h.currency)}</span><span>{h.decision}</span></li>)}
          </ul>}
          {history.truncated && <p className="mt-2">{t('approval.latestFive')}</p>}
          <p className="mt-2">{t('approval.historyPermission')}</p>
        </> : <p>{t('approval.historyUnavailable')}</p>}
      </div>
      <div className="mt-4 text-sm space-y-1">
        <p>{Number.isFinite(Date.parse(a.expiresAt)) ? t('approval.expiry', { date: date(a.expiresAt) }) : t('approval.expiryUnavailable')}</p>
        {a.status === 'pending' && <p>{expired ? t('approval.expired') : t('approval.countdown', { time: `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}` })}</p>}
        <p>{t('approval.notification', { status: t(`approval.push.${!notification?.configured ? 'unconfigured' : notification.status ?? 'pending'}`) })}</p>
        {notification?.configured && (notification.status === 'retry' || notification.status === 'failed') && <p role="status">
          {notification.lastError}{notification.status === 'retry' && notification.nextAttemptAt ? ` · ${t('approval.retryAt', { date: date(new Date(notification.nextAttemptAt).toISOString()) })}` : ''}
        </p>}
      </div>
      {a.status === 'pending' ? <div className="mt-4">
        <label htmlFor={`note-${a.id}`} className="block text-sm mb-2">{t('approval.note')}</label>
        <textarea id={`note-${a.id}`} value={note} onChange={e => setNote(e.target.value)} disabled={busy} maxLength={500} rows={2}
          className="w-full bg-black border border-line rounded-md px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-paper" />
        {override && <p className="text-sm mt-2">{t('approval.overrideReason')}</p>}
        {stale && <p className="text-sm mt-2">{t('approval.stale')}</p>}
        {c?.actions.approve.reason && <p className="text-sm mt-2">{c.actions.approve.reason}</p>}
        <div className="flex flex-wrap gap-3 mt-3">
          <button disabled={disabledApprove} onClick={() => decide(true)} className="min-h-11 px-4 py-2 rounded-md bg-paper text-bg text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper">{t(override ? 'approval.override' : 'btn.approve')}</button>
          <button disabled={busy || inactive || !c?.actions.reject.enabled} onClick={() => decide(false)} className="min-h-11 px-4 py-2 rounded-md border border-danger text-danger text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper">{t('btn.reject')}</button>
          <button disabled={busy} onClick={() => refresh()} className="min-h-11 px-4 py-2 border border-line rounded-md text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-paper">{t('approval.refresh')}</button>
        </div>
      </div> : <p className="text-sm mt-3">{a.decidedBy} · {a.note}</p>}
      {error && <p ref={errorRef} tabIndex={-1} role="alert" className="text-danger text-sm mt-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-paper">{error}</p>}
    </div>
  );
}
