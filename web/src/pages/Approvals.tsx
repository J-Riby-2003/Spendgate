import { useState } from 'react';
import { decideApproval, fmt, type ApprovalRequest, type State } from '../lib/api';
import { Badge, Mono, PageHeader, timeAgo } from '../components/ui';
import { useLang } from '../lib/i18n';

export default function Approvals({ state }: { state: State }) {
  const { t } = useLang();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError(null);
    try {
      await decideApproval(id, approve, note || undefined);
      setNote('');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        sub={t('page.approvals.sub')}
        title={t('page.approvals.title')}
        right={<Mono>{t('header.pending', { n: state.approvalsPending.length })}</Mono>}
      />

      {error && <p className="font-mono text-sm text-[#E0522A] border border-[#E0522A]/40 px-4 py-2 mb-6">{error}</p>}

      {state.approvalsPending.length === 0 ? (
        <p className="font-mono text-sm text-paper py-8">{t('empty.approvals')}</p>
      ) : (
        <div className="space-y-3 mb-8">
          {state.approvalsPending.map((a: ApprovalRequest) => (
            <div key={a.id} className="border border-line bg-black rounded-lg px-5 py-4">
              <div className="flex items-start justify-between gap-6">
                <div className="min-w-0">
                  <div className="flex items-center gap-3 mb-1.5">
                    <Badge value="pending" />
                    <Mono>{a.rule}</Mono>
                    <Mono>{timeAgo(a.createdAt)}</Mono>
                  </div>
                  <p className="font-body text-[15px] text-paper">
                    {fmt(a.intent.amount, a.intent.currency)} <span className="text-paper">→</span> {a.intent.vendor}
                  </p>
                  <p className="text-sm text-paper mt-0.5">{a.reason}</p>
                  {a.notification?.configured && ['retry', 'failed'].includes(a.notification.status ?? '') && (
                    <p role="status" className="text-sm text-[#E0522A] mt-1">
                      {t(a.notification.status === 'failed' ? 'notification.failed' : 'notification.retry')}
                      {' · '}{a.notification.lastError}
                    </p>
                  )}
                  <Mono className="block mt-1.5">
                    {a.intent.agentId} · {a.intent.purpose} · rail {a.intent.rail}
                  </Mono>
                </div>
                <div className="flex gap-2.5 shrink-0 pt-1">
                  <button
                    disabled={busy === a.id}
                    onClick={() => decide(a.id, true)}
                    className="h-10 px-4 py-2 rounded-md bg-paper text-bg font-mono text-[12px] tracking-[0.04em] hover:bg-white transition-colors disabled:opacity-50"
                  >
                    {t('btn.approve')}
                  </button>
                  <button
                    disabled={busy === a.id}
                    onClick={() => decide(a.id, false)}
                    className="h-10 px-4 py-2 rounded-md border border-[#E0522A]/60 text-[#E0522A] font-mono text-[12px] tracking-[0.04em] hover:bg-[#E0522A] hover:text-bg transition-colors disabled:opacity-50"
                  >
                    {t('btn.reject')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-6">
        <label className="font-mono text-[11px] tracking-[0.04em] text-paper block mb-2">
          {t('label.decisionNote')}
        </label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reference or rationale, recorded permanently in the ledger"
          maxLength={500}
          className="w-full max-w-xl h-10 bg-black border border-line rounded-md px-3.5 py-2 text-[13px] text-paper placeholder:text-paper/50 focus:outline-none focus:border-white"
        />
      </div>

      {state.approvalsRecent.length > 0 && (
        <>
          <div className="flex items-baseline justify-between mb-3 mt-10">
            <h2 className="font-body text-sm font-medium tracking-wide text-paper">{t('sec.recentDecisions')}</h2>
            <Mono>{t('sec.lastN', { n: state.approvalsRecent.length })}</Mono>
          </div>
          <div className="border-t border-line">
            {state.approvalsRecent.map((a) => (
              <div key={a.id} className="flex items-center gap-4 py-2.5 border-b border-line">
                <Badge value={a.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-paper truncate">
                    {fmt(a.intent.amount, a.intent.currency)} → {a.intent.vendor}{' '}
                    <span className="text-paper">({a.intent.agentId})</span>
                  </p>
                  {a.note && <Mono className="block truncate">{a.note}</Mono>}
                </div>
                <Mono className="w-32 shrink-0 truncate text-right hidden lg:block">{a.decidedBy}</Mono>
                <Mono className="w-20 shrink-0 text-right">{a.decidedAt ? timeAgo(a.decidedAt) : ''}</Mono>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
