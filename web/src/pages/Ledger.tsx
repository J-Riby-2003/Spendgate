import { useState } from 'react';
import { fmt, type LedgerEntry, type State } from '../lib/api';
import { Badge, clock, Mono, PageHeader } from '../components/ui';
import { DataTable, Td, TdRight } from '../components/Table';
import { useLang } from '../lib/i18n';

function EntryDetail({ e, leaving }: { e: LedgerEntry; leaving: boolean }) {
  // grid-rows animation: the row's height grows/shrinks with the fade,
  // so the table below slides instead of jumping
  return (
    <td colSpan={6} className="bg-black p-0">
      <div
        className="grid transition-all duration-200 ease-out"
        style={{ gridTemplateRows: leaving ? '0fr' : '1fr' }}
      >
        <div className="overflow-hidden">
          <div className={`px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-2 ${leaving ? 'sg-detail-out' : 'sg-detail-in'}`}>
            <Mono>intent: {e.intentId}</Mono>
            <Mono>rail: {e.rail}</Mono>
            <Mono>rule: {e.rule}</Mono>
            <Mono>decided by: {e.decidedBy}</Mono>
            <Mono>purpose: {e.purpose}</Mono>
            <Mono>approval: {e.approvalId ?? '—'}</Mono>
            <Mono className="col-span-2 break-all">prev hash: {e.prevHash}</Mono>
            <Mono className="col-span-2 break-all text-[#E8A020]/80">hash: {e.hash}</Mono>
            <Mono className="col-span-2 break-all">signature: {e.signature}</Mono>
          </div>
        </div>
      </div>
    </td>
  );
}

export default function Ledger({ state }: { state: State }) {
  const { t, lang } = useLang();
  const [detail, setDetail] = useState<{ seq: number; leaving: boolean } | null>(null);

  const toggle = (seq: number) => {
    if (detail && detail.seq === seq) {
      setDetail({ seq, leaving: true });
      window.setTimeout(() => setDetail((d) => (d && d.seq === seq ? null : d)), 200);
    } else {
      setDetail({ seq, leaving: false });
    }
  };

  return (
    <div>
      <PageHeader
        sub={t('page.ledger.sub')}
        title={t('page.ledger.title')}
        right={
          <div className="flex flex-wrap items-center gap-3 sm:gap-6">
            <Mono>{t('header.entries', { n: state.verify.entries })}</Mono>
            <a
              href="/api/export.csv"
              className="h-10 inline-flex items-center px-4 py-2 rounded-md border border-line text-paper font-mono text-[12px] tracking-[0.04em] hover:border-paper hover:text-paper transition-colors"
            >
              {t('btn.exportCsv')}
            </a>
            <a
              href="/api/export.json"
              className="h-10 inline-flex items-center px-4 py-2 rounded-md border border-line text-paper font-mono text-[12px] tracking-[0.04em] hover:border-paper hover:text-paper transition-colors"
            >
              {t('btn.exportJson')}
            </a>
          </div>
        }
      />

      <div className={`flex items-center gap-3 mb-5 px-4 py-2.5 rounded-lg ${state.verify.valid ? 'bg-[#4CAF50]' : 'bg-[#E0522A]'}`}>
        {state.verify.valid ? (
          <svg viewBox="0 0 16 16" className="w-4 h-4 shrink-0" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="black" />
            <path d="M5 8.5l2 2 4-4.5" stroke="#4CAF50" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" className="w-4 h-4 shrink-0" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="black" />
            <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          </svg>
        )}
        <p className="font-mono text-[12px] tracking-[0.04em] text-black">
          {state.verify.valid ? t('banner.verified') : t('banner.broken', { n: state.verify.brokenAt ?? '—' })}
        </p>
        <p className="font-mono text-[12px] ml-auto hidden md:block text-black/70">
          {t('banner.sub')}
        </p>
      </div>

      <DataTable
        columns={[
          { label: '#' },
          { label: t('th.decision') },
          { label: t('th.vendor') },
          { label: t('th.time'), align: 'right' },
          { label: t('th.amount'), align: 'right' },
          { label: t('th.date'), align: 'right' },
        ]}
      >
        {[...state.ledger].reverse().flatMap((e) => {
          const isOpen = detail?.seq === e.seq;
          const row = (
            <tr
              key={e.seq}
              onClick={() => toggle(e.seq)}
              className="cursor-pointer border-b border-line hover:bg-white/5 transition-colors"
            >
              <Td className="font-mono tabular-nums">#{e.seq}</Td>
              <Td><Badge value={e.decision} /></Td>
              <Td className="max-w-0 w-full">
                <p className="truncate">{e.vendor} <span>({e.agentId})</span></p>
              </Td>
              <TdRight>{clock(e.ts)}</TdRight>
              <TdRight>{fmt(e.amount, e.currency)}</TdRight>
              <TdRight>{new Date(e.ts).toLocaleDateString(lang === 'en' ? 'en-GB' : lang)}</TdRight>
            </tr>
          );
          return isOpen
            ? [
                row,
                <tr key={`${e.seq}-detail`} className="border-b border-line">
                  <EntryDetail e={e} leaving={detail.leaving} />
                </tr>,
              ]
            : [row];
        })}
        {state.ledger.length === 0 && (
          <tr>
            <td colSpan={6} className="px-4 py-8 text-center font-mono text-sm text-paper">{t('empty.ledger')}</td>
          </tr>
        )}
      </DataTable>
      <p className="font-mono text-[11px] tracking-[0.04em] text-paper mt-3">{t('hint.clickRow')}</p>
    </div>
  );
}
