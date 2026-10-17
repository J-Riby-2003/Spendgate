import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchState, loadSession, signIn, signOut, recordActivity, setUnauthorizedHandler, type State } from './lib/api';
import { LANG_LABELS, LANGS, useLang, type Lang } from './lib/i18n';
import Overview from './pages/Overview';
import Approvals from './pages/Approvals';
import Agents from './pages/Agents';
import Ledger from './pages/Ledger';
import Onboarding from './pages/Onboarding';
import { Mono } from './components/ui';

type Page = 'overview' | 'approvals' | 'agents' | 'ledger' | 'onboarding';

const NAV: { id: Page; label: string }[] = [
  { id: 'overview', label: 'nav.overview' },
  { id: 'approvals', label: 'nav.approvals' },
  { id: 'agents', label: 'nav.agents' },
  { id: 'onboarding', label: 'nav.onboarding' },
  { id: 'ledger', label: 'nav.ledger' },
];

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [state, setState] = useState<State | null>(null);
  const [connected, setConnected] = useState(false);
  const { lang, setLang, t } = useLang();
  const [menuOpen, setMenuOpen] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionVersion = useRef(0);

  const changeLanguage = (l: Lang) => setLang(l);

  const refresh = useCallback(async () => {
    const version = sessionVersion.current;
    await fetchState().then(next => { if (version === sessionVersion.current) setState(next); }).catch(() => undefined);
  }, []);

  const clearSession = useCallback(() => {
    sessionVersion.current++; setAuthed(false); setState(null); setConnected(false); wsRef.current?.close();
  }, []);
  useEffect(() => {
    const unregister = setUnauthorizedHandler(clearSession);
    loadSession().then(setAuthed).catch(() => setAuthError('Unable to reach the server.')).finally(() => setChecking(false));
    return unregister;
  }, [clearSession]);
  useEffect(() => {
    if (!authed) return;
    refresh();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => { setConnected(true); refresh(); };
    ws.onclose = (event) => { setConnected(false); if (event.code === 4001) clearSession(); };
    ws.onmessage = () => refresh();
    // HTTP activity renews idle time only while the operator uses the console.
    const recheck = () => { if (document.visibilityState === 'visible') refresh(); };
    let lastActivity = 0;
    const activity = () => { if (Date.now() - lastActivity >= 30_000) { lastActivity = Date.now(); recordActivity().catch(() => undefined); } };
    const stateCheck = setInterval(recheck, 10_000);
    const sessionCheck = setInterval(() => { loadSession().then(valid => { if (!valid) clearSession(); }).catch(() => undefined); }, 30_000);
    window.addEventListener('focus', recheck);
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    return () => { clearInterval(stateCheck); clearInterval(sessionCheck); ws.close(); window.removeEventListener('focus', recheck); window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity); };
  }, [authed, clearSession, refresh]);

  const pending = state?.stats.pendingApprovals ?? 0;

  if (checking) return <p className="p-8 text-paper">Checking session…</p>;
  if (!authed) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <p className="font-wordmark text-2xl font-semibold tracking-[0.04em] text-paper">TOLLKEEP</p>
          <p className="font-mono text-[13px] tracking-[0.04em] text-paper mt-2">
            Sign in to manage agents, policies and approvals.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault(); setBusy(true); setAuthError('');
              try { await signIn(username, password); setPassword(''); setAuthed(true); }
              catch (err) { setAuthError(err instanceof Error ? err.message : 'Sign in failed'); }
              finally { setBusy(false); }
            }}
            className="mt-6 flex flex-col gap-3"
          >
            <label className="text-paper text-sm">Username
              <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required maxLength={64} className="mt-1 w-full h-10 bg-black border border-line rounded-md px-3 text-paper" />
            </label>
            <label className="text-paper text-sm">Password
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required maxLength={1024} className="mt-1 w-full h-10 bg-black border border-line rounded-md px-3 text-paper" />
            </label>
            {authError && <p role="alert" className="text-danger text-sm">{authError}</p>}
            <button disabled={busy} type="submit" className="h-10 px-4 bg-paper text-bg rounded-md text-sm disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black">
      {/* mobile top bar */}
      <div className="lg:hidden sticky top-0 z-40 bg-bg border-b border-line flex items-center justify-between px-4 h-14">
        <p className="font-wordmark text-[17px] font-semibold tracking-[0.04em] text-paper">TOLLKEEP</p>
        <button onClick={() => setMenuOpen(true)} aria-label="Open menu" className="p-2 -mr-2 text-paper">
          <svg viewBox="0 0 20 20" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
      </div>

      {/* mobile menu backdrop */}
      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/70" onClick={() => setMenuOpen(false)} />
      )}

      <div className="flex">
      {/* sidebar */}
      <aside className={`fixed lg:sticky inset-y-0 left-0 z-50 w-52 shrink-0 border-r border-line flex flex-col bg-bg h-screen transition-transform duration-200 ${menuOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
        <div className="px-5 pt-6 pb-5 border-b border-line flex items-center justify-between">
          <p className="font-wordmark text-[17px] font-semibold tracking-[0.04em] text-paper">TOLLKEEP</p>
          <button onClick={() => setMenuOpen(false)} aria-label="Close menu" className="lg:hidden p-1 text-paper/70 hover:text-white">
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <nav className="flex-1 py-3">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => { setPage(n.id); setMenuOpen(false); }}
              className={`w-full text-left pl-5 pr-4 py-2.5 flex items-center gap-2 border-l-2 transition-colors ${
                page === n.id
                  ? 'border-paper text-paper bg-white/10'
                  : 'border-transparent text-paper hover:text-paper'
              }`}
            >
              <span className="font-mono text-[12px] tracking-[0.04em]">{t(n.label)}</span>
              {n.id === 'approvals' && pending > 0 && (
                <span className="ml-auto font-mono text-[11px] tabular-nums bg-[#E8A020] text-bg px-1.5 py-px">{pending}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-line">
          <p className="font-mono text-[11px] tracking-[0.04em] text-paper flex items-center gap-2">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${connected ? 'bg-[#4CAF50]' : 'bg-[#E0522A]'}`} />
            {connected ? t('side.live') : t('side.offline')}
          </p>
          <select
            value={lang}
            onChange={(e) => changeLanguage(e.target.value as Lang)}
            aria-label="Language"
            className="w-full h-10 mt-3 bg-black border border-line rounded-md pl-2 pr-8 py-2 font-mono text-[13px] tracking-[0.04em] text-paper focus:outline-none focus:border-white cursor-pointer"
          >
            {LANGS.map((l) => (
              <option key={l} value={l} className="bg-black text-paper">{LANG_LABELS[l]}</option>
            ))}
          </select>
          <button className="mt-3 text-paper text-sm" onClick={async () => { setAuthError(''); try { await signOut(); clearSession(); } catch { setAuthError('Sign out failed. Try again.'); } }}>Sign out</button>
          {authError && <p role="alert" className="text-danger text-sm">{authError}</p>}
          <Mono className="block mt-3 text-[11px] tracking-[0.04em]">{t('side.copyright')}</Mono>
        </div>
      </aside>

      {/* main */}
      <main className="flex-1 min-w-0 px-4 sm:px-6 lg:px-10 py-6 sm:py-7 max-w-6xl mx-auto w-full">
        {state ? (
          <>
            {page === 'overview' && <>{state.agents.length === 0 && <div className="border border-line rounded-lg p-5 mb-6 text-paper"><p className="text-sm mb-3">No agents registered. Create your first agent and test its policy safely.</p><button className="h-10 px-4 bg-paper text-bg rounded-md text-sm" onClick={() => setPage('onboarding')}>Set up your first agent</button></div>}<Overview state={state} /></>}
            {page === 'approvals' && <Approvals state={state} refresh={refresh} />}
            {page === 'agents' && <><button className="mb-5 h-10 px-4 bg-paper text-bg rounded-md text-sm" onClick={() => setPage('onboarding')}>Guided agent setup</button><Agents state={state} /></>}
            {page === 'onboarding' && <Onboarding key={sessionVersion.current} />}
            {page === 'ledger' && <Ledger state={state} />}
          </>
        ) : (
          <p className="font-mono text-sm text-paper mt-10">Connecting to Tollkeep server…</p>
        )}
      </main>
      </div>
    </div>
  );
}
