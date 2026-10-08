// Public decision page: opens from a phone decision link (/decide/<token>).
// One screen: what the agent wants, then Approve / Reject. English-only —
// it's a capability URL, not part of the console's i18n surface.
import { useEffect, useState } from 'react';
import { Badge, Mono } from '../components/ui';
import { fmt } from '../lib/api';

interface DecidePayload {
  state: 'pending' | 'used' | 'expired' | 'decided';
  action: 'approve' | 'reject';
  approval: {
    id: string;
    status: string;
    rule: string;
    reason: string;
    intent: { agentId: string; amount: number; currency: string; vendor: string; purpose: string; rail: string };
    decidedBy: string | null;
  } | null;
}

type Phase = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; payload: DecidePayload } | { kind: 'done'; decision: 'approved' | 'rejected' };

export default function DecidePage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/decide/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `decide ${res.status}`);
        return res.json() as Promise<DecidePayload>;
      })
      .then((payload) => setPhase({ kind: 'ready', payload }))
      .catch((err) => setPhase({ kind: 'error', message: String(err.message ?? err) }));
  }, [token]);

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/decide/${encodeURIComponent(token)}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 410 used/expired or 409 decided — reload to show the honest state
        const again = await fetch(`/api/decide/${encodeURIComponent(token)}`).then((r) => r.json() as Promise<DecidePayload>);
        setPhase({ kind: 'ready', payload: again });
        return;
      }
      setPhase({ kind: 'done', decision: body.decision });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="font-wordmark text-2xl font-semibold tracking-[0.04em] text-paper">SPENDGATE</p>

        {phase.kind === 'loading' && <p className="font-mono text-[13px] tracking-[0.04em] text-paper mt-6">Loading request…</p>}

        {phase.kind === 'error' && (
          <div className="mt-6 border border-line rounded-lg px-5 py-4">
            <p className="font-mono text-[13px] tracking-[0.04em] text-[#E0522A]">{phase.message}</p>
          </div>
        )}

        {phase.kind === 'ready' && (() => {
          const { payload } = phase;
          if (payload.state !== 'pending' || !payload.approval) {
            const msg = payload.state === 'used' ? 'This decision link has already been used.'
              : payload.state === 'expired' ? 'This decision link has expired.'
              : `This escalation was ${payload.approval?.status ?? 'already decided'}.`;
            return (
              <div className="mt-6 border border-line rounded-lg px-5 py-4">
                <Badge value={payload.approval?.status ?? 'closed'} />
                <p className="font-mono text-[13px] tracking-[0.04em] text-paper mt-3">{msg}</p>
                {payload.approval?.decidedBy && <Mono className="block mt-2">decided by {payload.approval.decidedBy}</Mono>}
              </div>
            );
          }
          const a = payload.approval;
          return (
            <div className="mt-6 border border-line rounded-lg px-5 py-5">
              <div className="flex items-center gap-3">
                <Badge value="pending" />
                <Mono>{a.rule}</Mono>
              </div>
              <p className="font-body text-[22px] text-paper mt-4">
                {fmt(a.intent.amount, a.intent.currency)} <span className="text-paper">→</span> {a.intent.vendor}
              </p>
              <p className="text-sm text-paper mt-1">{a.reason}</p>
              <Mono className="block mt-3">
                {a.intent.agentId} · {a.intent.purpose} · rail {a.intent.rail}
              </Mono>
              <div className="flex gap-3 mt-6">
                <button
                  disabled={busy}
                  onClick={() => decide(true)}
                  className="flex-1 h-12 rounded-md bg-[#E8A020] text-bg font-mono text-[14px] font-semibold tracking-[0.04em] hover:bg-[#F0B03A] transition-colors disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  disabled={busy}
                  onClick={() => decide(false)}
                  className="flex-1 h-12 rounded-md border border-[#E0522A]/60 text-[#E0522A] font-mono text-[14px] tracking-[0.04em] hover:bg-[#E0522A] hover:text-bg transition-colors disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
              <p className="font-mono text-[11px] tracking-[0.04em] text-paper/60 mt-4">
                One tap decides permanently — recorded in the signed audit ledger. Untapped requests expire denied.
              </p>
            </div>
          );
        })()}

        {phase.kind === 'done' && (
          <div className="mt-6 border border-line rounded-lg px-5 py-5 text-center">
            <div className={`mx-auto w-14 h-14 rounded-full flex items-center justify-center ${phase.decision === 'approved' ? 'bg-[#4CAF50]/20' : 'bg-[#E0522A]/20'}`}>
              <svg viewBox="0 0 24 24" className={`w-8 h-8 ${phase.decision === 'approved' ? 'text-[#4CAF50]' : 'text-[#E0522A]'}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {phase.decision === 'approved' ? <path d="M4 12.5l5 5L20 6.5" /> : <path d="M6 6l12 12M18 6L6 18" />}
              </svg>
            </div>
            <p className="font-mono text-[15px] font-semibold tracking-[0.04em] text-paper mt-4">
              {phase.decision === 'approved' ? 'APPROVED' : 'REJECTED'}
            </p>
            <p className="font-mono text-[12px] tracking-[0.04em] text-paper/70 mt-2">
              The agent has been released and the decision is permanent in the ledger.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
