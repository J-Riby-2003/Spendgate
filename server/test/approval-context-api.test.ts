import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { once } from 'node:events';
vi.hoisted(() => { process.env.SPENDLOCK_DATA = `/tmp/spendlock-context-api-${Date.now()}-${Math.random()}`; });
import { createApplication } from '../src/app.js';
import { provisionOperator, issueCredential } from '../src/auth.js';
import { store } from '../src/core/store.js';
import { submitRequest } from '../src/core/engine.js';
import { verifyLedger } from '../src/core/ledger.js';
let server: ReturnType<typeof createApplication>, base: string, headers: Record<string,string>, operatorId: string;
beforeAll(async () => {
  operatorId = (await provisionOperator('operator', 'test context password 123')).operatorId;
  server = createApplication(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SPENDLOCK_PUBLIC_BASE_URL = base;
  const response = await fetch(base+'/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type':'application/json' }, body: JSON.stringify({ username:'operator', password:'test context password 123' }) });
  headers = { Origin:base, 'Content-Type':'application/json', Cookie:response.headers.get('set-cookie')!.split(';')[0], 'X-CSRF-Token':(await response.json()).csrfToken };
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
function pending() { return submitRequest({ agentId:'procurement-02', amount:6000, currency:'GBP', vendor:'context-vendor', purpose:'Context API', rail:'mcp' }); }
it('protects approval context and exposes it consistently in queue and state', async () => {
  const a = pending(), path = `/api/approvals/${a.approvalId}/context`;
  expect((await fetch(base+path)).status).toBe(401);
  const credential = issueCredential('procurement-02', operatorId);
  expect((await fetch(base+path, {headers:{Authorization:`Bearer ${credential.secret}`}})).status).toBe(401);
  const res = await fetch(base+path, {headers}); expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toMatchObject({ requestId:a.requestId, context:{budget:{status:'available'}, vendorHistory:{status:'available'}} });
  for (const path of ['/api/state','/api/approvals']) {
    const body = await (await fetch(base+path, {headers})).json();
    expect((body.pending ?? body.approvalsPending).find((row:any) => row.id===a.approvalId)).toHaveProperty('context.serverNow');
  }
  expect((await fetch(base+'/api/approvals/missing/context', {headers})).status).toBe(404);
});
it('returns current context on competing decisions and retains authenticated attribution and signed note', async () => {
  const a = pending(), path = `/api/approvals/${a.approvalId}/decide`;
  const first = await fetch(base+path, {method:'POST', headers, body:JSON.stringify({approve:false,note:'Recorded note',by:'forged'})});
  expect(first.status).toBe(200);
  const second = await fetch(base+path, {method:'POST',headers,body:JSON.stringify({approve:true})});
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({code:'approval-not-pending',approval:{status:'rejected',context:{actions:{approve:{enabled:false}}}}});
  const entry = store.fullLedger().find(e=>e.intentId===a.requestId)!;
  expect(entry.decidedBy).toBe(`human:${operatorId}`);
  expect(entry.details?.note).toBe('Recorded note');
  expect(verifyLedger().valid).toBe(true);
});
it('rechecks budget after a preview and returns a pending conflict rather than authorising stale funds', async () => {
  const a=pending();
  const preview=await(await fetch(base+`/api/approvals/${a.approvalId}/context`,{headers})).json();
  expect(preview.context.actions.approve.enabled).toBe(true);
  const p=store.getPolicy('procurement-02')!;
  store.upsertPolicy({...p,dailyBudget:0,budgetMode:'hard-stop'});
  try {
    const res=await fetch(base+`/api/approvals/${a.approvalId}/decide`,{method:'POST',headers,body:JSON.stringify({approve:true,note:'Not an override'})});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({code:'approval-budget-conflict',approval:{status:'pending',context:{actions:{approve:{enabled:false},reject:{enabled:true}}}}});
    expect(store.fullLedger().find(e=>e.intentId===a.requestId)).toBeUndefined();
  } finally {store.upsertPolicy(p);}
});
it('requires renewed explicit override consent when competing approvals exhaust an ordinary preview', async () => {
  const original=store.getPolicy('procurement-02')!;
  store.upsertPolicy({...original,dailyBudget:10000,budgetMode:'approval-override'});
  try {
    const a=pending();
    const preview=await(await fetch(base+`/api/approvals/${a.approvalId}/context`,{headers})).json();
    expect(preview.context.budget.overrideRequired).toBe(false);
    const b=pending();
    expect((await fetch(base+`/api/approvals/${b.approvalId}/decide`,{method:'POST',headers,body:JSON.stringify({approve:true})})).status).toBe(200);
    const path=base+`/api/approvals/${a.approvalId}/decide`;
    const refused=await fetch(path,{method:'POST',headers,body:JSON.stringify({approve:true,note:'Checked vendor invoice'})});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({code:'approval-budget-conflict',approval:{status:'pending',context:{budget:{overrideRequired:true}}}});
    expect(store.fullLedger().find(e=>e.intentId===a.requestId)).toBeUndefined();
    const explicit=await fetch(path,{method:'POST',headers,body:JSON.stringify({approve:true,overrideBudget:true,note:'Approved necessary budget exception'})});
    expect(explicit.status).toBe(200);
    const entry=store.fullLedger().find(e=>e.intentId===a.requestId)!;
    expect(entry.details).toMatchObject({actor:{kind:'operator',id:operatorId},budgetRecheck:{overrideReason:'Approved necessary budget exception',overrideConsent:true}});
    expect(verifyLedger().valid).toBe(true);
  } finally {store.upsertPolicy(original);}
});
it('never permits a phone capability to request a budget override and leaves rejection usable', async () => {
  const original=store.getPolicy('procurement-02')!;
  store.upsertPolicy({...original,dailyBudget:100,budgetMode:'approval-override'});
  try {
    const a=pending();
    const links=await(await fetch(base+`/api/approvals/${a.approvalId}/links`,{headers})).json();
    const approve=links.links.find((link:any)=>link.action==='approve');
    const reject=links.links.find((link:any)=>link.action==='reject');
    const res=await fetch(base+`/api/decide/${approve.token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({overrideBudget:true,note:'Forged exception',by:operatorId})});
    expect(res.status).toBe(409);
    expect(store.getApproval(a.approvalId!)!.status).toBe('pending');
    expect(store.fullLedger().find(e=>e.intentId===a.requestId)).toBeUndefined();
    expect((await fetch(base+`/api/decide/${reject.token}`,{method:'POST'})).status).toBe(200);
    expect(store.getApproval(a.approvalId!)!.status).toBe('rejected');
  } finally {store.upsertPolicy(original);}
});
