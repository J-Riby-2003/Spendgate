// Public decision page: opens from a phone decision link (/decide/<token>).
// The token encodes its action; the page asks for one confirmation tap before
// executing, then renders the receipt. A retap shows the spent/expired/decided
// state instead. English-only: it's a capability URL.
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

type Phase =
  | { kind: 'loading' | 'acting' }
  | { kind: 'error'; message: string }
  | { kind: 'closed'; payload: DecidePayload }
  | { kind: 'confirm'; payload: DecidePayload }
  | { kind: 'cancelled'; action: 'approve' | 'reject'; approval: NonNullable<DecidePayload['approval']> }
  | { kind: 'done'; decision: 'approved' | 'rejected'; approval: NonNullable<DecidePayload['approval']> };

export default function DecidePage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const enc = encodeURIComponent(token);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/decide/${enc}`);
        const payload = (await res.json().catch(() => ({}))) as DecidePayload & { error?: string };
        if (!res.ok) throw new Error(payload.error ?? `decide ${res.status}`);
        setPhase(
          payload.state === 'pending' && payload.approval
            ? { kind: 'confirm', payload }
            : { kind: 'closed', payload },
        );
      } catch (err) {
        setPhase({ kind: 'error', message: String((err as Error).message ?? err) });
      }
    })();
  }, [enc]);

  async function act(action: 'approve' | 'reject', approval: NonNullable<DecidePayload['approval']>) {
    if (phase.kind === 'acting') return;
    setPhase({ kind: 'acting' });
    try {
      const done = await fetch(`/api/decide/${enc}`, { method: 'POST' }).then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { decision?: 'approved' | 'rejected'; error?: string };
        if (!r.ok) throw new Error(body.error ?? `decide ${r.status}`);
        return body.decision!;
      });
      setPhase({ kind: 'done', decision: done, approval });
    } catch (err) {
      setPhase({ kind: 'error', message: String((err as Error).message ?? err) });
    }
  }

  const summary = (a: NonNullable<DecidePayload['approval']>) => (
    <>
      <p className="font-body text-[17px] text-paper mt-3">
        {fmt(a.intent.amount, a.intent.currency)} <span className="text-paper">→</span> {a.intent.vendor}
      </p>
      <Mono className="block mt-1.5">
        {a.intent.agentId} · {a.intent.purpose} · rail {a.intent.rail}
      </Mono>
    </>
  );

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <p className="font-wordmark text-2xl font-semibold tracking-[0.04em] text-paper">SPENDLOCK</p>

        {(phase.kind === 'loading' || phase.kind === 'acting') && (
          <p className="font-mono text-[13px] tracking-[0.04em] text-paper mt-6">
            {phase.kind === 'acting' ? 'Recording your decision…' : 'Loading request…'}
          </p>
        )}

        {phase.kind === 'error' && (
          <div className="mt-6 border border-line rounded-lg px-5 py-4">
            <p className="font-mono text-[13px] tracking-[0.04em] text-[#E0522A]">{phase.message}</p>
          </div>
        )}

        {phase.kind === 'closed' && (() => {
          const { payload } = phase;
          const msg = payload.state === 'used' ? 'This decision link has already been used.'
            : payload.state === 'expired' ? 'This decision link has expired.'
            : `This escalation was ${payload.approval?.status ?? 'already decided'}.`;
          return (
            <div className="mt-6 border border-line rounded-lg px-5 py-4">
              <Badge value={payload.approval?.status ?? 'closed'} />
              <p className="font-mono text-[13px] tracking-[0.04em] text-paper mt-3">{msg}</p>
              {payload.approval && <Mono className="block mt-2">decided by {payload.approval.decidedBy ?? 'unknown'}</Mono>}
            </div>
          );
        })()}

        {phase.kind === 'confirm' && (() => {
          const { payload } = phase;
          const a = payload.approval!;
          const approving = payload.action === 'approve';
          return (
            <div className="mt-6 border border-line rounded-lg px-5 py-5">
              <Badge value={approving ? 'approve' : 'reject'} />
              <p className="font-mono text-[13px] tracking-[0.04em] text-paper mt-3">
                {approving ? 'Approve this payment?' : 'Reject this payment?'}
              </p>
              {summary(a)}
              <button
                type="button"
                onClick={() => act(payload.action, a)}
                className={`w-full mt-5 h-12 rounded-md font-mono text-[14px] font-semibold tracking-[0.04em] text-black ${
                  approving ? 'bg-[#4CAF50] active:bg-[#4CAF50]/80' : 'bg-[#E0522A] active:bg-[#E0522A]/80'
                }`}
              >
                Confirm {approving ? 'approve' : 'reject'}
              </button>
              <button
                type="button"
                onClick={() => setPhase({ kind: 'cancelled', action: payload.action, approval: a })}
                className="w-full mt-2 h-12 rounded-md border border-line font-mono text-[14px] tracking-[0.04em] text-paper active:bg-white/10"
              >
                Cancel
              </button>
            </div>
          );
        })()}

        {phase.kind === 'cancelled' && (
          <div className="mt-6 border border-line rounded-lg px-5 py-4 text-center">
            <p className="font-mono text-[13px] tracking-[0.04em] text-paper">Nothing was recorded.</p>
            <Mono className="block mt-2">The escalation is still awaiting a decision.</Mono>
          </div>
        )}

        {phase.kind === 'done' && (() => {
          const approved = phase.decision === 'approved';
          return (
            <div className="mt-6 border border-line rounded-lg px-5 py-5 text-center">
              <div className={`mx-auto w-14 h-14 rounded-full flex items-center justify-center ${approved ? 'bg-[#4CAF50]/20' : 'bg-[#E0522A]/20'}`}>
                <svg viewBox="0 0 24 24" className={`w-8 h-8 ${approved ? 'text-[#4CAF50]' : 'text-[#E0522A]'}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  {approved ? <path d="M4 12.5l5 5L20 6.5" /> : <path d="M6 6l12 12M18 6L6 18" />}
                </svg>
              </div>
              <p className="font-mono text-[15px] font-semibold tracking-[0.04em] text-paper mt-4">
                {approved ? 'APPROVED' : 'REJECTED'}
              </p>
              <div className="text-left">{summary(phase.approval)}</div>
              <p className="font-mono text-[12px] tracking-[0.04em] text-paper/70 mt-4">
                Recorded permanently in the signed audit ledger. The agent has been released.
              </p>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
