// SpendGate server: REST console API + WebSocket live feed + MCP (Streamable HTTP).
import './config.js'; // loads .spendgate/env — must run before any env reads
import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { seed } from './seed.js';
import { buildMcpServer } from './mcp.js';
import { decide, expireStale, onEvent, emit, EngineError } from './core/engine.js';
import { cleanHhmm, cleanMinor, cleanStr, cleanVendorList, InputError } from './core/sanitize.js';
import { store, db } from './core/store.js';
import { verifyLedger, ledgerToCsv } from './core/ledger.js';
import { requireOperator, requireAgent, requireCsrf, requireOrigin, allowedOrigin, sessionToken, authenticateSession, assertAgentActive, authEvents, login, logout, csrfToken, SESSION_COOKIE, cookieOptions, AuthError, issueCredential, listCredentials, rotateCredential, revokeCredential, revokeAgentCredentials, type OperatorPrincipal } from './auth.js';
import { mintDecisionLinks, decideByToken, hashToken } from './decide-links.js';
import { attachNotifier, resolveNotifier } from './notify.js';
import type { Policy } from './core/types.js';

export function createApplication() {
const app = express();
app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '256kb' }));

seed();

// push a decision-link pair to Telegram (if configured) for every new escalation
const notifier = resolveNotifier();
const detachNotifier = attachNotifier(onEvent, notifier);

// ---------- state snapshot for the console ----------
function buildState() {
  const agents = store.listAgents().map((a) => ({
    ...a,
    policy: store.getPolicy(a.agentId),
    spentToday: store.spentToday(a.agentId),
  }));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const allToday = store.fullLedger().filter((e) => e.ts >= today.toISOString());
  return {
    agents,
    ledger: store.recentLedger(50),
    approvalsPending: store.pendingApprovals(),
    approvalsRecent: store.recentDecidedApprovals(20),
    stats: {
      allowedToday: allToday.filter((e) => e.decision === 'ALLOWED').length,
      approvedToday: allToday.filter((e) => e.decision === 'APPROVED').length,
      deniedToday: allToday.filter((e) => e.decision === 'DENIED' || e.decision === 'REJECTED').length,
      pendingApprovals: store.pendingApprovals().length,
      ledgerEntries: store.fullLedger().length,
    },
    verify: verifyLedger(),
  };
}

// ---------- authentication ----------
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/login', requireOrigin, async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || username.length > 64 || typeof password !== 'string' || password.length > 1024) {
      return res.status(422).json({ error: 'Username and password required' });
    }
    const session = await login(username, password, req.socket.remoteAddress ?? 'unknown');
    res.cookie(SESSION_COOKIE, session.token, cookieOptions());
    res.json({ principal: session.principal, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  } catch (err) { next(err); }
});
app.get('/api/auth/session', requireOperator, (req, res) => {
  res.json({ principal: res.locals.principal, csrfToken: csrfToken(sessionToken(req)) });
});
app.post('/api/auth/activity', requireOperator, requireCsrf, (req, res) => {
  authenticateSession(sessionToken(req), true);
  res.json({ ok: true });
});
app.post('/api/auth/logout', requireOperator, requireCsrf, (req, res) => {
  logout(sessionToken(req));
  const { maxAge: _maxAge, ...options } = cookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
  res.json({ ok: true });
});
// One intentionally public capability route; all other API routes default to operator-only.
app.use('/api', (req, res, next) => {
  if (/^\/decide\/[^/]+$/.test(req.path)) return next();
  requireOperator(req, res, () => requireCsrf(req, res, next));
});
app.get('/api/security-audit', (_req, res) => {
  res.json(db.prepare('SELECT * FROM security_audit_events ORDER BY seq DESC LIMIT 200').all());
});
app.get('/api/agents/:agentId/credentials', (req, res) => res.json(listCredentials(req.params.agentId)));
app.post('/api/agents/:agentId/credentials', (req, res) => {
  res.status(201).json(issueCredential(req.params.agentId, (res.locals.principal as OperatorPrincipal).operatorId));
});
app.post('/api/agents/:agentId/credentials/:credentialId/rotate', (req, res) => {
  res.status(201).json(rotateCredential(req.params.agentId, req.params.credentialId, (res.locals.principal as OperatorPrincipal).operatorId));
});
app.delete('/api/agents/:agentId/credentials/:credentialId', (req, res) => {
  revokeCredential(req.params.agentId, req.params.credentialId, (res.locals.principal as OperatorPrincipal).operatorId);
  res.json({ ok: true });
});

// ---------- REST ----------
app.get('/api/state', (_req, res) => res.json(buildState()));

app.get('/api/ledger', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const agent = req.query.agent as string | undefined;
  res.json(agent ? store.ledgerForAgent(agent, limit) : store.recentLedger(limit));
});

app.get('/api/ledger/verify', (_req, res) => res.json(verifyLedger()));

app.get('/api/export.json', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="spendgate-ledger.json"');
  res.json({ exportedAt: new Date().toISOString(), entries: store.fullLedger(), verify: verifyLedger() });
});

app.get('/api/export.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="spendgate-ledger.csv"');
  res.send(ledgerToCsv(store.fullLedger()));
});

app.get('/api/approvals', (_req, res) => {
  res.json({ pending: store.pendingApprovals(), recent: store.recentDecidedApprovals(20) });
});

// Mint (or fetch fresh) phone-decision links for a pending approval.
// Bearer-protected: raw capability tokens must only go to the operator.
app.get('/api/approvals/:id/links', (req, res) => {
  const approval = store.getApproval(req.params.id);
  if (!approval) return res.status(404).json({ error: 'Unknown approval.' });
  if (approval.status !== 'pending') return res.status(409).json({ error: 'Approval is no longer pending.' });
  res.json({ approvalId: approval.id, links: mintDecisionLinks(approval) });
});

app.post('/api/approvals/:id/decide', (req, res) => {
  try {
    const { approve } = req.body ?? {};
    if (typeof approve !== 'boolean') return res.status(422).json({ error: 'approve (boolean) is required' });
    const by = (res.locals.principal as OperatorPrincipal).operatorId;
    const note = cleanStr(req.body?.note, 'note', 500, true) ?? undefined;
    const ok = decide(req.params.id, approve, by, note);
    if (!ok) return res.status(409).json({ error: 'Approval is no longer pending (already decided or expired).' });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof InputError) return res.status(422).json({ error: err.message });
    throw err;
  }
});

app.get('/api/policies', (_req, res) => {
  res.json(store.listAgents().map((a) => ({ agentId: a.agentId, policy: store.getPolicy(a.agentId) })));
});

app.put('/api/policies/:agentId', (req, res) => {
  try {
    const agentId = req.params.agentId;
    if (!store.listAgents().some((a) => a.agentId === agentId)) {
      return res.status(404).json({ error: `Unknown agent "${agentId}".` });
    }
    const b = req.body ?? {};
    const allowedVendors = b.allowedVendors === undefined || b.allowedVendors === '*' ? '*' : cleanVendorList(b.allowedVendors, 'allowedVendors');
    const blockedVendors = b.blockedVendors == null ? [] : cleanVendorList(b.blockedVendors, 'blockedVendors');
    const allowedDays = b.allowedDays ?? '*';
    if (allowedDays !== '*' && !(Array.isArray(allowedDays) && allowedDays.length <= 7 && allowedDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) {
      throw new InputError('allowedDays must be "*" or a list of weekday indices 0–6 (0 = Sunday).');
    }
    const policy: Policy = {
      agentId,
      maxPerTxn: cleanMinor(b.maxPerTxn, 'maxPerTxn'),
      dailyBudget: cleanMinor(b.dailyBudget, 'dailyBudget'),
      approvalThreshold: cleanMinor(b.approvalThreshold, 'approvalThreshold'),
      allowedVendors,
      blockedVendors,
      newVendorRequiresApproval: Boolean(b.newVendorRequiresApproval),
      allowedDays,
      allowedWindow: b.allowedWindow == null ? null : {
        start: cleanHhmm(b.allowedWindow.start, 'Window start'),
        end: cleanHhmm(b.allowedWindow.end, 'Window end'),
      },
    };
    store.upsertPolicy(policy);
    res.json({ ok: true, policy });
  } catch (err) {
    if (err instanceof InputError) return res.status(422).json({ error: err.message });
    throw err;
  }
});

app.delete('/api/agents/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  if (!store.listAgents().some((a) => a.agentId === agentId)) {
    return res.status(404).json({ error: `Unknown agent "${agentId}".` });
  }
  revokeAgentCredentials(agentId, (res.locals.principal as OperatorPrincipal).operatorId);
  store.deleteAgent(agentId);
  emit({ type: 'state' });
  res.json({ ok: true });
});

app.patch('/api/agents/:agentId/currency', (req, res) => {
  const agentId = req.params.agentId;
  const agent = store.listAgents().find((a) => a.agentId === agentId);
  if (!agent) return res.status(404).json({ error: `Unknown agent "${agentId}".` });
  const currency = String(req.body?.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(422).json({ error: 'currency must be a 3-letter ISO 4217 code.' });
  store.upsertAgent(agentId, agent.displayName, currency);
  emit({ type: 'state' });
  res.json({ ok: true, currency });
});

app.post('/api/agents', (req, res) => {
  try {
    const { agentId, currency } = req.body ?? {};
    if (typeof agentId !== 'string' || !/^[a-z0-9-]{2,64}$/.test(agentId)) {
      return res.status(422).json({ error: 'agentId must be 2–64 chars of a-z, 0-9, dash.' });
    }
    if (store.listAgents().some((a) => a.agentId === agentId)) {
      return res.status(409).json({ error: 'Agent already exists.' });
    }
    const displayName = cleanStr(req.body?.displayName, 'displayName', 80, true) ?? agentId;
    const cur = (currency ?? 'GBP').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new InputError('currency must be a 3-letter ISO 4217 code.');
    store.upsertAgent(agentId, displayName, cur);
    store.upsertPolicy({
      agentId,
      maxPerTxn: 5000,
      dailyBudget: 50000,
      approvalThreshold: 20000,
      allowedVendors: '*',
      blockedVendors: [],
      newVendorRequiresApproval: true,
      allowedDays: '*',
      allowedWindow: null,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err instanceof InputError) return res.status(422).json({ error: err.message });
    throw err;
  }
});

// ---------- MCP (Streamable HTTP, stateless) ----------
const activeMcp = new Map<express.Response, { credentialId: string; revoke(): void }>();
app.post('/mcp', requireAgent, async (req, res) => {
  try {
    // SSE mode (not JSON): escalations hold this stream open for minutes and
    // edge proxies (Fly included) kill connections idle ~60s. Heartbeat
    // comments below keep the stream alive until the decision lands.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    const principal = res.locals.principal;
    assertAgentActive(principal);
    activeMcp.set(res, { credentialId: principal.credentialId, revoke: () => {
      // End with a protocol error so SDK clients do not wait until their call timeout.
      if (req.body?.id !== undefined) {
        void transport.send({ jsonrpc: '2.0', id: req.body.id, error: { code: -32001, message: 'Credential revoked' } })
          .catch(() => undefined).finally(() => { res.end(); void transport.close(); });
      } else res.end();
    } });
    const server = buildMcpServer(principal);
    const heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); return; }
      const ct = res.getHeader('content-type');
      if (res.headersSent && typeof ct === 'string' && ct.includes('text/event-stream')) {
        res.write(': ping\n\n');
      }
    }, 20_000);
    res.on('close', () => {
      activeMcp.delete(res);
      clearInterval(heartbeat);
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    activeMcp.delete(res); // Never log transport payloads or bearer secrets.
    if (!res.headersSent) res.status(500).json({ error: 'MCP transport error' });
  }
});
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Stateless MCP endpoint: POST only.' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Stateless MCP endpoint: no sessions.' }));

// --- decision links (public one-time capability URLs for phone approvals) ---
app.get('/api/decide/:token', (req, res) => {
  const link = store.getApprovalLink(hashToken(req.params.token));
  if (!link) return res.status(404).json({ error: 'Unknown decision link.' });
  const approval = store.getApproval(link.approvalId);
  const now = new Date().toISOString();
  const state = link.usedAt ? 'used'
    : link.expiresAt <= now ? 'expired'
    : approval && approval.status !== 'pending' ? 'decided'
    : 'pending';
  res.json({
    state,
    action: link.action,
    approval: approval
      ? { id: approval.id, status: approval.status, rule: approval.rule, reason: approval.reason, intent: approval.intent, decidedBy: approval.decidedBy }
      : null,
  });
});

app.post('/api/decide/:token', (req, res) => {
  try {
    const outcome = decideByToken(req.params.token);
    const approval = store.getApproval(outcome.approvalId);
    if (notifier?.confirm && approval) {
      void notifier.confirm(approval, outcome.decision).catch(() => {
        console.error('[notify] decision confirmation failed');
      });
    }
    res.json(outcome);
  } catch (err) {
    if (err instanceof EngineError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
  if (err instanceof EngineError) return res.status(err.status).json({ error: err.message });
  if (err instanceof InputError) return res.status(422).json({ error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- static web build (single-port mode) ----------
const distDir = join(process.cwd(), '..', 'web', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')));
}

// ---------- WS live feed ----------
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sessions = new Map<WebSocket, { token: string; sessionId: string }>();
httpServer.on('upgrade', (req, socket, head) => {
  const token = sessionToken(req);
  const principal = authenticateSession(token, false);
  if (req.url !== '/ws' || !allowedOrigin(req) || !principal) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    sessions.set(ws, { token, sessionId: principal.sessionId });
    ws.on('close', () => sessions.delete(ws));
    ws.send(JSON.stringify({ type: 'state', state: buildState() }));
  });
});
function validSocket(ws: WebSocket): boolean {
  const session = sessions.get(ws);
  if (!session || !authenticateSession(session.token, false)) { ws.close(4001, 'Session expired'); return false; }
  return true;
}
const unsubscribe = onEvent(event => {
  const msg = JSON.stringify(event.type === 'state' ? { type: 'state', state: buildState() } : event);
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN && validSocket(client)) client.send(msg);
});
const expireSessions = setInterval(() => { for (const ws of wss.clients) validSocket(ws); }, 1000);
const expireApprovals = setInterval(expireStale, 15_000);
function revokeSession(id: string) { for (const [ws, session] of sessions) if (session.sessionId === id) ws.close(4001, 'Session revoked'); }
function revokeStream(id: string) { for (const stream of activeMcp.values()) if (stream.credentialId === id) stream.revoke(); }
authEvents.on('session-revoked', revokeSession);
authEvents.on('credential-revoked', revokeStream);
httpServer.on('close', () => {
  clearInterval(expireSessions); clearInterval(expireApprovals); unsubscribe(); detachNotifier();
  authEvents.off('session-revoked', revokeSession); authEvents.off('credential-revoked', revokeStream);
  for (const ws of wss.clients) ws.terminate();
  wss.close();
});
return httpServer;
}
