import { fmt, type State } from '../lib/api';
import { Badge, clock, Mono, PageHeader, Stat } from '../components/ui';
import { DataTable, Td, TdRight } from '../components/Table';
import { useLang } from '../lib/i18n';

export default function Overview({ state }: { state: State }) {
  const { t, lang } = useLang();
  const { stats } = state;
  return (
    <div>
      <PageHeader
        sub={t('page.overview.sub')}
        title={t('page.overview.title')}
        right={<Mono>{t('header.ledgerChain', { n: stats.ledgerEntries, status: state.verify.valid ? t('status.verified') : t('status.broken') })}</Mono>}
      />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-10">
        <Stat label={t('stat.allowed')} value={String(stats.allowedToday)} tone="ok" />
        <Stat label={t('stat.approved')} value={String(stats.approvedToday)} tone="gold" />
        <Stat label={t('stat.denied')} value={String(stats.deniedToday)} tone="danger" />
        <Stat label={t('stat.pending')} value={String(stats.pendingApprovals)} tone={stats.pendingApprovals > 0 ? 'gold' : undefined} />
      </div>

      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-body text-sm font-medium tracking-wide text-paper">{t('sec.ledgerActivity')}</h2>
        <Mono>{t('sec.lastN', { n: state.ledger.length })}</Mono>
      </div>

      <DataTable
        columns={[
          { label: '#' },
          { label: t('th.decision') },
          { label: t('th.vendor') },
          { label: t('th.agent') },
          { label: t('th.time'), align: 'right' },
          { label: t('th.amount'), align: 'right' },
        ]}
      >
          {[...state.ledger].reverse().map((e) => (
            <tr key={e.seq} className="border-b border-line last:border-b-0 hover:bg-white/5 transition-colors">
              <Td className="font-mono tabular-nums">#{e.seq}</Td>
              <Td><Badge value={e.decision} /></Td>
              <Td className="max-w-0 w-full">
                <p className="truncate">{e.vendor}</p>
                <p className="font-mono text-[11px] text-paper/70 truncate tracking-[0.04em]">{e.purpose}</p>
              </Td>
              <Td className="font-mono whitespace-nowrap">{e.agentId}</Td>
              <TdRight>{clock(e.ts)}</TdRight>
              <TdRight>{fmt(e.amount, e.currency)}</TdRight>
            </tr>
          ))}
          {state.ledger.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center font-mono text-sm text-paper">
                {t('empty.overview')} <code className="text-[#E8A020]">npm run demo</code>.
              </td>
            </tr>
          )}
      </DataTable>
    </div>
  );
}
