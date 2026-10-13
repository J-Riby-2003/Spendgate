// SpendGate server: REST console API + WebSocket live feed + MCP (Streamable HTTP).
import './config.js'; // loads .spendgate/env — must run before any env reads
import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { seed } from './seed.js';
import { registerAgent } from './core/agents.js';
import { startJourney, listJourneys, ownedJourney, journeyView, saveDraft, abandonJourney, OnboardingError } from './core/onboarding-store.js';
import { createChallenge, testJourney, completeJourney } from './core/onboarding.js';
import { buildMcpServer } from './mcp.js';
import { decide, expireStale, onEvent, emit, EngineError } from './core/engine.js';
import { cleanStr, InputError } from './core/sanitize.js';
import { store, db, withImmediateTransaction } from './core/store.js';
import { verifyLedger, ledgerToCsv } from './core/ledger.js';
import { requireOperator, requireAgent, requireCsrf, requireOrigin, allowedOrigin, sessionToken, authenticateSession, assertAgentActive, authEvents, login, logout, csrfToken, SESSION_COOKIE, cookieOptions, AuthError, issueCredential, listCredentials, rotateCredential, revokeCredential, deleteAgentWithCredentials, type OperatorPrincipal } from './auth.js';
import { mintDecisionLinks, decideByToken, hashToken } from './decide-links.js';
import { attachNotifier, resolveNotifier, notificationStatus } from './notify.js';
import { budget } from './core/budget-state.js';
import { BudgetError, type ReconcileInput } from './core/budget.js';
import { isSupportedCurrency } from '../../shared/currency.js';
import { parsePolicy } from './core/policy-input.js';
import { PolicyConflict } from './core/policy-history.js';
import { preview, replay, requestEvidence, requireVersion } from './core/simulation.js';

export function createApplication() {
const app = express();
app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '256kb' }));

if (process.env.SPENDGATE_SEED_DEMO !== 'false') seed();
expireStale(); // reconcile overdue durable requests before accepting traffic or delivering links

// push a decision-link pair to Telegram (if configured) for every new escalation
const notifier = resolveNotifier();
const detachNotifier = attachNotifier(onEvent, notifier);

// ---------- state snapshot for the console ----------
function approvalProjection(a: ReturnType<typeof store.pendingApprovals>[number]) {
  return { ...a, requestId: a.intent.id, notification: { ...notificationStatus(a.id), configured: notifier !== null } };
}
function buildState() {
  const agents = store.listAgents().map((a) => ({
    ...a,
    policy: store.getPolicy(a.agentId),
    policyVersion: store.getPolicyVersion(a.agentId),
    spentToday: budget.getBudgetSnapshot(a.agentId).spentMinor,
    budget: budget.getBudgetSnapshot(a.agentId),
  }));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const allToday = store.fullLedger().filter((e) => e.ts >= today.toISOString());
  return {
    agents,
    ledger: store.recentLedger(50),
    approvalsPending: store.pendingApprovals().map(approvalProjection),
    approvalsRecent: store.recentDecidedApprovals(20).map(approvalProjection),
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
  const operatorId = (res.locals.principal as OperatorPrincipal).operatorId;
  res.status(201).json(req.body?.onboardingId === undefined ? issueCredential(req.params.agentId, operatorId) : issueCredential(req.params.agentId, operatorId, req.body.onboardingId));
});
app.post('/api/agents/:agentId/credentials/:credentialId/rotate', (req, res) => {
  const operatorId = (res.locals.principal as OperatorPrincipal).operatorId;
  res.status(201).json(req.body?.onboardingId === undefined ? rotateCredential(req.params.agentId, req.params.credentialId, operatorId) : rotateCredential(req.params.agentId, req.params.credentialId, operatorId, req.body.onboardingId));
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

app.get('/api/approval-recovery', (_req, res) => {
  res.json({ requests: db.prepare('SELECT * FROM spend_requests WHERE reconciliation_required=1').all(),
    orphanedKeys: db.prepare('SELECT agent_id,key,created_at FROM idempotency_keys WHERE request_id IS NULL').all(),
    audit: db.prepare('SELECT * FROM approval_recovery_audit ORDER BY seq DESC LIMIT 200').all() });
});

app.get('/api/approvals', (_req, res) => {
  expireStale();
  res.json({ pending: store.pendingApprovals().map(approvalProjection), recent: store.recentDecidedApprovals(20).map(approvalProjection) });
});

// Mint (or fetch fresh) phone-decision links for a pending approval.
// Bearer-protected: raw capability tokens must only go to the operator.
app.get('/api/approvals/:id/links', (req, res) => {
  expireStale();
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
  res.json(store.listAgents().map((a) => ({ agentId: a.agentId, policy: store.getPolicy(a.agentId), policyVersion: store.getPolicyVersion(a.agentId) })));
});

app.get('/api/policies/:agentId/history', (req, res) => {
  if (!store.getPolicy(req.params.agentId)) throw new BudgetError('Unknown agent.', 404);
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new InputError('History limit must be 1 to 200.');
  res.json({ revisions: store.policyHistory(req.params.agentId, limit) });
});
app.post('/api/policies/:agentId/preview', (req, res) => {
  res.json(preview(req.params.agentId, req.body?.policy, req.body?.sample));
});
app.post('/api/policies/:agentId/replay', (req, res) => {
  res.json(replay(req.params.agentId, req.body?.policy, req.body?.expectedVersion, req.body?.limit === undefined ? 50 : req.body.limit));
});
app.get('/api/requests/:requestId/evidence', (req, res) => {
  if (!db.prepare('SELECT 1 FROM spend_requests WHERE request_id=?').get(req.params.requestId)) throw new BudgetError('Unknown request.', 404);
  res.json(requestEvidence(req.params.requestId) ?? { integrity: 'unavailable', digest: null, envelope: null });
});
app.put('/api/policies/:agentId', (req, res) => {
  const expectedVersion = requireVersion(req.body?.expectedVersion);
  const result = withImmediateTransaction(() => {
    const current = store.getPolicy(req.params.agentId);
    if (!current) throw new BudgetError('Unknown agent.', 404);
    const policy = parsePolicy(req.params.agentId, req.body, current.budgetMode);
    const policyVersion = store.upsertPolicy(policy, { expectedVersion, changedBy: (res.locals.principal as OperatorPrincipal).operatorId, source: 'operator' });
    return { policy, policyVersion };
  });
  emit({ type: 'state' });
  res.json({ ok: true, ...result });
});

app.delete('/api/agents/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  if (!store.listAgents().some((a) => a.agentId === agentId)) {
    return res.status(404).json({ error: `Unknown agent "${agentId}".` });
  }
  deleteAgentWithCredentials(agentId, (res.locals.principal as OperatorPrincipal).operatorId);
  emit({ type: 'state' });
  res.json({ ok: true });
});

app.patch('/api/agents/:agentId/currency', (req, res) => {
  const agentId = req.params.agentId;
  const agent = store.listAgents().find((a) => a.agentId === agentId);
  if (!agent) return res.status(404).json({ error: `Unknown agent "${agentId}".` });
  const currency = String(req.body?.currency ?? '').toUpperCase();
  if (!isSupportedCurrency(currency)) return res.status(422).json({ error: 'Unsupported currency.' });
  withImmediateTransaction(() => store.upsertAgent(agentId, agent.displayName, currency));
  emit({ type: 'state' });
  res.json({ ok: true, currency });
});

app.post('/api/agents', (req, res) => {
  const result = registerAgent(req.body ?? {}, (res.locals.principal as OperatorPrincipal).operatorId);
  emit({ type: 'state' });
  res.status(result.created ? 201 : 200).json({ ok: true, ...result });
});

app.get('/api/onboarding', (_req, res) => res.json(listJourneys((res.locals.principal as OperatorPrincipal).operatorId)));
app.post('/api/onboarding', (req, res) => res.json(startJourney((res.locals.principal as OperatorPrincipal).operatorId, req.body?.requestId)));
app.get('/api/onboarding/:id', (req, res) => res.json(journeyView(ownedJourney(req.params.id, (res.locals.principal as OperatorPrincipal).operatorId))));
app.patch('/api/onboarding/:id', (req, res) => res.json(saveDraft(req.params.id, (res.locals.principal as OperatorPrincipal).operatorId, req.body?.expectedRevision, req.body?.draft)));
app.post('/api/onboarding/:id/challenge', (req, res) => res.json(createChallenge(req.params.id, (res.locals.principal as OperatorPrincipal).operatorId)));
app.post('/api/onboarding/:id/test', (req, res) => res.json(testJourney(req.params.id, (res.locals.principal as OperatorPrincipal).operatorId, req.body?.sample)));
app.post('/api/onboarding/:id/abandon', (req, res) => res.json(abandonJourney(req.params.id, (res.locals.principal as OperatorPrincipal).operatorId)));
app.post('/api/onboarding/:id/complete', (req, res) => res.json(completeJourney(req.params.id, (res.locals.principal as OperatorPrincipal).operatorId)));

// Operator-only preview and evidence-backed recovery; no generic operator payment-completion API.
app.get('/api/agents/:agentId/budget/reconciliation', (req, res) => {
  res.json({ budget: budget.getBudgetSnapshot(req.params.agentId), obligations: budget.legacyObligations(req.params.agentId), events: budget.accountingEvents(req.params.agentId) });
});
app.post('/api/agents/:agentId/budget/reconciliation', (req, res) => {
  const input = req.body ?? {};
  if (!Number.isSafeInteger(input.ledgerSeq) || input.ledgerSeq < 1) throw new BudgetError('A legacy ledger sequence is required.', 422);
  if (!budget.legacyObligations(req.params.agentId).some(o => o.ledgerSeq === input.ledgerSeq)) throw new BudgetError('Unknown legacy obligation.', 404);
  const review: ReconcileInput = { ledgerSeq: input.ledgerSeq, action: input.action, eventId: input.eventId,
    evidence: input.evidence, reason: input.reason, operatorId: (res.locals.principal as OperatorPrincipal).operatorId };
  withImmediateTransaction(() => budget.reconcileLegacy(review));
  emit({ type: 'state' });
  res.json({ budget: budget.getBudgetSnapshot(req.params.agentId), obligations: budget.legacyObligations(req.params.agentId) });
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
    const connection = new AbortController();
    const server = buildMcpServer(principal, connection.signal);
    const heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); return; }
      const ct = res.getHeader('content-type');
      if (res.headersSent && typeof ct === 'string' && ct.includes('text/event-stream')) {
        res.write(': ping\n\n');
      }
    }, 20_000);
    res.on('close', () => {
      connection.abort();
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
  expireStale();
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
      ? { id: approval.id, status: approval.status, rule: approval.rule, reason: approval.reason, intent: approval.intent, decidedBy: approval.decidedBy, expiresAt: approval.expiresAt, requestId: approval.intent.id }
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
  if (err instanceof OnboardingError) return res.status(err.status).json({ error: err.message });
  if (err instanceof PolicyConflict) return res.status(err.status).json({ error: err.message });
  if (err instanceof BudgetError) return res.status(err.status).json({ error: err.message });
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
