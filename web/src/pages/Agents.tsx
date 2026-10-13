import Credentials from '../components/Credentials';
import { useState } from 'react';
import {
  addAgent, CURRENCIES, currencySymbol, fmt, minorToUnits, removeAgent, savePolicy, setCurrency, toMinor,
  type AgentState, type Policy, type State,
} from '../lib/api';
import { Mono, PageHeader } from '../components/ui';
import { ConfirmModal, Modal } from '../components/Modal';
import { DataTable, Td } from '../components/Table';
import { useLang } from '../lib/i18n';

function PolicyEditor({ agent }: { agent: AgentState }) {
  const { t } = useLang();
  const p = agent.policy!;
  const initialForm = {
    maxPerTxn: minorToUnits(p.maxPerTxn),
    dailyBudget: minorToUnits(p.dailyBudget),
    approvalThreshold: minorToUnits(p.approvalThreshold),
    newVendor: p.newVendorRequiresApproval,
    blocked: p.blockedVendors.join(', '),
    windowEnabled: p.allowedWindow != null,
    windowStart: p.allowedWindow?.start ?? '08:00',
    windowEnd: p.allowedWindow?.end ?? '20:00',
    days: p.allowedDays === '*' ? [1, 2, 3, 4, 5] : p.allowedDays,
  };
  const [form, setForm] = useState(initialForm);
  const [baseline, setBaseline] = useState(initialForm);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const [error, setError] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [currency, setCur] = useState(agent.currency);

  const set = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }));
  };

  async function save(): Promise<boolean> {
    setError(null);
    const parseAmt = (raw: string, label: string): number | null | false => {
      if (raw.trim() === '') return null;
      const v = toMinor(raw);
      if (v === null) {
        setError(`${label}: enter a valid amount (0 – 10,000,000,000).`);
        return false;
      }
      return v;
    };
    const maxPerTxn = parseAmt(form.maxPerTxn, 'Auto-approve ceiling');
    if (maxPerTxn === false) return false;
    const dailyBudget = parseAmt(form.dailyBudget, 'Daily budget');
    if (dailyBudget === false) return false;
    const approvalThreshold = parseAmt(form.approvalThreshold, 'Human-approval threshold');
    if (approvalThreshold === false) return false;

    const blocked = [...new Set(form.blocked.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
    if (blocked.some((v) => v.length > 120)) {
      setError('Blocked vendors: each entry must be 120 characters or fewer.');
      return false;
    }
    if (blocked.length > 200) {
      setError('Blocked vendors: at most 200 entries.');
      return false;
    }
    const policy: Policy = {
      agentId: agent.agentId,
      maxPerTxn,
      dailyBudget,
      approvalThreshold,
      allowedVendors: p.allowedVendors,
      blockedVendors: blocked,
      newVendorRequiresApproval: form.newVendor,
      allowedDays: form.days.length === 7 ? '*' : form.days,
      allowedWindow: form.windowEnabled ? { start: form.windowStart, end: form.windowEnd } : null,
    };
    try {
      await savePolicy(policy);
      setBaseline({ ...form });
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }

  const budget = agent.policy?.dailyBudget ?? null;
  const pct = budget ? Math.min(100, Math.round((agent.spentToday / budget) * 100)) : null;

  return (
    <div className="border border-line bg-black rounded-lg p-6 mb-6">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="font-body text-[15px] font-medium text-paper">{agent.displayName}</h2>
        <Mono>{agent.agentId}</Mono>
      </div>

      {pct != null && (
        <div className="mb-5">
          <div className="flex justify-between mb-1.5">
            <Mono>{t('label.dailyBudget')}</Mono>
            <Mono className="text-paper">{fmt(agent.spentToday, currency)} / {fmt(budget ?? 0, currency)}</Mono>
          </div>
          <div className="h-1.5 bg-line rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${pct > 90 ? 'bg-[#E0522A]' : 'bg-[#4CAF50]'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <Field label={t('label.autoApprove')} unit={currency} symbol={currencySymbol(currency)} hint="Blank = unlimited" value={form.maxPerTxn} onChange={(v) => set({ maxPerTxn: v })} placeholder="50.00" maxLength={16} />
        <Field label={t('label.dailyBudget')} unit={currency} symbol={currencySymbol(currency)} hint="Blank = unlimited" value={form.dailyBudget} onChange={(v) => set({ dailyBudget: v })} placeholder="500.00" maxLength={16} />
        <Field label={t('label.humanApproval')} unit={currency} symbol={currencySymbol(currency)} hint="Blank = none" value={form.approvalThreshold} onChange={(v) => set({ approvalThreshold: v })} placeholder="200.00" maxLength={16} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mt-5">
        <div>
          <label className="font-mono text-[12px] tracking-[0.04em] text-paper block mb-2">{t('label.blockedVendors')}</label>
          <input
            value={form.blocked}
            onChange={(e) => set({ blocked: e.target.value })}
            placeholder="bobs-discount-emporium, sketchy-cdn"
            maxLength={2500}
            className="w-full h-10 bg-black border border-line rounded-md px-3 py-2 text-sm text-paper placeholder:text-paper/50 focus:outline-none focus:border-white"
          />
        </div>
        <div>
          <label className="font-mono text-[12px] tracking-[0.04em] text-paper block mb-2">{t('label.allowedDays')}</label>
          <div className="flex gap-1.5">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <button
                key={i}
                onClick={() =>
                  set({ days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i].sort() })
                }
                className={`w-10 h-10 py-2 rounded-full font-mono text-[13px] border transition-colors ${
                  form.days.includes(i) ? 'bg-[#4CAF50] border-[#4CAF50] text-white' : 'border-line text-paper hover:border-paper'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      </div>

      {form.blocked.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).length > 0 && (
        <div className="mt-3">
          <DataTable columns={[{ label: t('th.vendor') }, { label: t('th.action'), align: 'right' }]}>
            {form.blocked.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((v) => (
              <tr key={v} className="border-b border-line last:border-b-0">
                <Td className="px-3 py-2">{v}</Td>
                <td className="border-l border-line px-3 py-2 text-right">
                  <button
                    onClick={() => setConfirmRemove(v)}
                    className="font-mono text-[12px] tracking-[0.04em] text-[#E0522A] hover:text-white"
                  >
                    {t('btn.remove')}
                  </button>
                </td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 sm:gap-6 mt-5">
        <Toggle
          label={t('label.newVendors')}
          on={form.newVendor}
          onChange={(v) => set({ newVendor: v })}
        />
        <Toggle
          label={t('label.spendingWindow')}
          on={form.windowEnabled}
          onChange={(v) => set({ windowEnabled: v })}
        />
        <div
          className={`flex items-center gap-2 transition-opacity duration-200 ${form.windowEnabled ? '' : 'opacity-0 pointer-events-none'}`}
          aria-hidden={!form.windowEnabled}
        >
          <input type="time" value={form.windowStart} disabled={!form.windowEnabled} onChange={(e) => set({ windowStart: e.target.value })}
            aria-label={t('label.windowStart')}
            className="h-10 bg-black border border-line rounded-md px-2 py-1.5 font-mono text-sm text-paper focus:outline-none focus:border-white" />
          <Mono>—</Mono>
          <input type="time" value={form.windowEnd} disabled={!form.windowEnabled} onChange={(e) => set({ windowEnd: e.target.value })}
            aria-label={t('label.windowEnd')}
            className="h-10 bg-black border border-line rounded-md px-2 py-1.5 font-mono text-sm text-paper focus:outline-none focus:border-white" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 mt-6">
        <button
          onClick={() => setConfirmSave(true)}
          disabled={!dirty}
          title={dirty ? undefined : 'Nothing has changed'}
          className="h-10 px-5 py-2.5 rounded-md bg-paper text-bg font-mono text-[13px] tracking-[0.04em] hover:bg-paper/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-paper"
        >
          {t('btn.savePolicy')}
        </button>
        <CurrencySelect
          value={currency}
          onChange={(c) => {
            setCur(c);
            setCurrency(agent.agentId, c).catch((err) => setError(String(err)));
          }}
        />
        <button
          onClick={() => setConfirmDelete(true)}
          className="ml-auto font-mono text-[13px] tracking-[0.04em] text-[#E0522A] hover:text-[#F0643C]"
        >
          {t('btn.removeAgent')}
        </button>
        {error && !confirmSave && <Mono className="text-[#E0522A]">{error}</Mono>}
      </div>

      <Credentials agentId={agent.agentId} />

      {confirmSave && (
        <ConfirmModal
          title={t('modal.saveTitle', { name: agent.displayName })}
          body={t('modal.saveBody', { id: agent.agentId })}
          busyLabel={t('modal.saving')}
          doneMessage={t('modal.saved')}
          error={error}
          onConfirm={save}
          onClose={() => setConfirmSave(false)}
        />
      )}

      {confirmRemove && (
        <ConfirmModal
          title={t('modal.removeVendorTitle')}
          body={t('modal.removeVendorBody', { v: confirmRemove, id: agent.agentId })}
          confirmLabel={t('btn.remove')}
          danger
          doneMessage={t('modal.removed')}
          onConfirm={() => {
            setForm((f) => ({
              ...f,
              blocked: f.blocked.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).filter((x) => x !== confirmRemove).join(', '),
            }));
            return true;
          }}
          onClose={() => setConfirmRemove(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={t('modal.removeAgentTitle', { name: agent.displayName })}
          body={t('modal.removeAgentBody')}
          confirmLabel={t('btn.remove')}
          danger
          doneMessage={t('modal.agentRemoved')}
          error={error}
          onConfirm={() =>
            removeAgent(agent.agentId)
              .then(() => true)
              .catch((err) => {
                setError(String(err));
                return false;
              })
          }
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, hint, unit, symbol, maxLength }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string; unit?: string; symbol?: string; maxLength?: number }) {
  return (
    <div>
      <label className="font-mono text-[12px] tracking-[0.04em] text-paper block mb-2">
        <span className="relative inline-block group">
          <span className="cursor-help underline decoration-dotted decoration-paper/40 underline-offset-4">
            {label}{unit ? ` (${unit})` : ''}
          </span>
          {hint && (
            <span className="pointer-events-none absolute left-0 bottom-full mb-2 whitespace-nowrap rounded-md border border-line bg-black px-2.5 py-1.5 text-[12px] tracking-[0.04em] text-paper opacity-0 translate-y-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-y-0 z-20">
              {hint}
            </span>
          )}
        </span>
      </label>
      <div className="relative">
        {symbol && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-paper/50">{symbol}</span>
        )}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode="decimal"
          maxLength={maxLength}
          className={`w-full h-10 bg-black border border-line rounded-md py-2 text-sm text-paper placeholder:text-paper/50 focus:outline-none focus:border-white ${symbol ? 'pl-8 pr-3' : 'px-3'}`}
        />
      </div>
    </div>
  );
}

function CurrencySelect({ value, onChange, label }: { value: string; onChange: (c: string) => void; label?: string }) {
  const { t } = useLang();
  const aria = label ?? t('label.currency');
  return (
    <div>
      {label && <label className="font-mono text-[12px] tracking-[0.04em] text-paper block mb-2">{label}</label>}
      <select
        value={value}
        aria-label={aria}
        title={aria}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 bg-black border border-line rounded-md pl-2 pr-8 py-2 font-mono text-[13px] tracking-[0.04em] text-paper focus:outline-none focus:border-white cursor-pointer"
      >
        {CURRENCIES.map((c) => (
          <option key={c} value={c} className="bg-black text-paper">{c} ({currencySymbol(c) || c})</option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className="flex items-center gap-2.5 group">
      <span className={`relative inline-block h-[18px] w-[34px] rounded-full transition-colors ${on ? 'bg-[#4CAF50]' : 'bg-line'}`}>
        <span className={`absolute top-[3px] h-[12px] w-[12px] rounded-full transition-all ${on ? 'left-[19px] bg-white' : 'left-[3px] bg-[#8A8474]'}`} />
      </span>
      <span className="font-mono text-[13px] tracking-wide text-paper group-hover:text-white">{label}</span>
    </button>
  );
}

export default function Agents({ state }: { state: State }) {
  const { t } = useLang();
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newCurrency, setNewCurrency] = useState('GBP');
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [showRegister, setShowRegister] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAdded(false);
    const id = newId.trim().toLowerCase();
    if (!/^[a-z0-9-]{2,64}$/.test(id)) {
      setError('Agent id must be 2–64 characters of a-z, 0-9 and dash.');
      return;
    }
    try {
      await addAgent(id, newName.trim() || id, newCurrency);
      setNewId('');
      setNewName('');
      setNewCurrency('GBP');
      setAdded(true);
      setShowRegister(false);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div>
      <PageHeader sub={t('page.agents.sub')} title={t('page.agents.title')} right={<Mono>{t('header.agentsCount', { n: state.agents.length })}</Mono>} />

      {state.agents.map((a) => (
        <PolicyEditor key={a.agentId} agent={a} />
      ))}

      <button
        onClick={() => { setShowRegister(true); setError(null); }}
        className="px-5 py-2.5 rounded-md bg-paper text-bg font-mono text-[13px] tracking-[0.04em] hover:bg-paper/80 transition-colors"
      >
        {t('btn.registerAgent')}
      </button>
      {added && <Mono className="text-[#4CAF50] mt-3 block">{t('hint.registered')}</Mono>}

      {showRegister && (
        <Modal form wide onClose={() => setShowRegister(false)}>
          {({ close, leaving }) => (
            <>
              <div className="flex items-baseline justify-between mb-5">
                <h3 className="font-body text-[15px] font-medium text-paper">{t('modal.registerTitle')}</h3>
                <button type="button" onClick={() => { if (!leaving) close(); }} className="font-mono text-[13px] text-paper/60 hover:text-white tracking-[0.04em]">
                  {t('btn.close')}
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                <Field label={t('label.agentId')} value={newId} onChange={setNewId} placeholder="research-01" maxLength={64} />
                <Field label={t('label.displayName')} value={newName} onChange={setNewName} placeholder="Research — research agent" maxLength={80} />
                <CurrencySelect label={t('label.currency')} value={newCurrency} onChange={setNewCurrency} />
              </div>
              {error && <Mono className="text-[#E0522A] mt-4 block">{error}</Mono>}
              <div className="flex items-center gap-4 mt-6">
                <button type="submit" className="h-10 px-5 py-2.5 rounded-md bg-paper text-bg font-mono text-[13px] tracking-[0.04em] hover:bg-paper/80 transition-colors">
                  {t('btn.register')}
                </button>
                <Mono>{t('hint.registerDefault')}</Mono>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
