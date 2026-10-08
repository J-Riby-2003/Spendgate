// SpendGate server: REST console API + WebSocket live feed + MCP (Streamable HTTP).
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { seed } from './seed.js';
import { buildMcpServer } from './mcp.js';
import { decide, expireStale, onEvent, emit, EngineError } from './core/engine.js';
import { cleanHhmm, cleanMinor, cleanStr, cleanVendorList, InputError } from './core/sanitize.js';
import { store } from './core/store.js';
import { verifyLedger, ledgerToCsv } from './core/ledger.js';
import { requireToken, CONSOLE_TOKEN_FILE } from './auth.js';
import { mintDecisionLinks, decideByToken, hashToken } from './decide-links.js';
import type { Policy } from './core/types.js';

const PORT = Number(process.env.SPENDGATE_PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

seed();

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
app.get('/api/approvals/:id/links', requireToken, (req, res) => {
  const approval = store.getApproval(req.params.id);
  if (!approval) return res.status(404).json({ error: 'Unknown approval.' });
  if (approval.status !== 'pending') return res.status(409).json({ error: 'Approval is no longer pending.' });
  res.json({ approvalId: approval.id, links: mintDecisionLinks(approval) });
});

app.post('/api/approvals/:id/decide', requireToken, (req, res) => {
  try {
    const { approve } = req.body ?? {};
    if (typeof approve !== 'boolean') return res.status(422).json({ error: 'approve (boolean) is required' });
    const by = cleanStr(req.body?.by, 'by', 80, true) ?? 'operator';
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

app.put('/api/policies/:agentId', requireToken, (req, res) => {
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

app.delete('/api/agents/:agentId', requireToken, (req, res) => {
  const agentId = req.params.agentId;
  if (!store.listAgents().some((a) => a.agentId === agentId)) {
    return res.status(404).json({ error: `Unknown agent "${agentId}".` });
  }
  store.deleteAgent(agentId);
  emit({ type: 'state' });
  res.json({ ok: true });
});

app.patch('/api/agents/:agentId/currency', requireToken, (req, res) => {
  const agentId = req.params.agentId;
  const agent = store.listAgents().find((a) => a.agentId === agentId);
  if (!agent) return res.status(404).json({ error: `Unknown agent "${agentId}".` });
  const currency = String(req.body?.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(422).json({ error: 'currency must be a 3-letter ISO 4217 code.' });
  store.upsertAgent(agentId, agent.displayName, currency);
  emit({ type: 'state' });
  res.json({ ok: true, currency });
});

app.post('/api/agents', requireToken, (req, res) => {
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
app.post('/mcp', requireToken, async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcpServer();
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
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
    res.json(decideByToken(req.params.token));
  } catch (err) {
    if (err instanceof EngineError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof EngineError) return res.status(err.status).json({ error: err.message });
  if (err instanceof InputError) return res.status(422).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: String(err) });
});

// ---------- static web build (single-port mode) ----------
const distDir = join(process.cwd(), '..', 'web', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(join(distDir, 'index.html')));
}

// ---------- WS live feed ----------
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  ws.send(JSON.stringify({ type: 'state', state: buildState() }));
});

onEvent((event) => {
  const msg = JSON.stringify(event.type === 'state' ? { type: 'state', state: buildState() } : event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
});

// expire stale escalations every 15s
setInterval(expireStale, 15_000);

httpServer.listen(PORT, () => {
  console.log(`SpendGate server on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:  http://localhost:${PORT}/mcp`);
  console.log(`  Console API:   http://localhost:${PORT}/api/state`);
  console.log(`  WebSocket:     ws://localhost:${PORT}/ws`);
  console.log(`  Console token: ${CONSOLE_TOKEN_FILE} (Bearer auth required for mutations + MCP)`);
});
