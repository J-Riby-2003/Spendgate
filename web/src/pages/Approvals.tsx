import { useRef, useState } from 'react';
import { fmt, type State } from '../lib/api';
import { Badge, Mono, PageHeader, timeAgo } from '../components/ui';
import ApprovalCard from '../components/ApprovalCard';
import { useLang } from '../lib/i18n';

export default function Approvals({ state, refresh }: { state: State; refresh: () => Promise<void> }) {
  const { t } = useLang();
  const [message, setMessage] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  function completed(message: string) { setMessage(message); status.current?.focus(); }
  return (
    <div>
      <PageHeader sub={t('page.approvals.sub')} title={t('page.approvals.title')} right={<Mono>{t('header.pending', { n: state.approvalsPending.length })}</Mono>} />
      <p ref={status} role="status" tabIndex={-1} className="text-sm text-paper mb-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-paper">{message}</p>
      {state.approvalsPending.length === 0 ? <p className="text-sm text-paper py-8">{t('approval.empty')}</p> : (
        <div className="space-y-3 mb-8">{state.approvalsPending.map(a => <ApprovalCard key={a.id} approval={a} refresh={refresh} completed={completed} />)}</div>
      )}
      {state.approvalsRecent.length > 0 && <>
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3 mt-10">
          <h2 className="text-sm font-medium text-paper">{t('sec.recentDecisions')}</h2>
          <Mono>{t('sec.lastN', { n: state.approvalsRecent.length })}</Mono>
        </div>
        <div className="border-t border-line">
          {state.approvalsRecent.map(a => <div key={a.id} className="flex flex-wrap items-start gap-3 py-3 border-b border-line text-paper break-words">
            <Badge value={a.status} />
            <div className="flex-1 min-w-0">
              <p className="text-sm">{fmt(a.intent.amount,a.intent.currency)} {a.intent.currency} → {a.intent.vendor} ({a.intent.agentId})</p>
              <p className="text-sm mt-1">{a.intent.purpose}</p>
              {a.note && <p className="text-sm mt-1 whitespace-pre-wrap">{a.note}</p>}
              <Mono className="block mt-1">{a.decidedBy} · {a.decidedAt ? timeAgo(a.decidedAt) : ''}</Mono>
            </div>
          </div>)}
        </div>
      </>}
    </div>
  );
}
