import { expect, test, type Page } from '@playwright/test';
import { BASE, agentHeaders, operatorHeaders, signIn } from './helpers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function fixture(id: string, mode = 'hard-stop') {
  const headers = { ...await operatorHeaders(), 'Content-Type': 'application/json' };
  expect((await fetch(`${BASE}/api/agents`, { method:'POST', headers, body:JSON.stringify({agentId:id,displayName:'Review Agent',currency:'GBP'}) })).status).toBe(201);
  expect((await fetch(`${BASE}/api/policies/${id}`, {method:'PUT',headers,body:JSON.stringify({dailyBudget:10000,maxPerTxn:1000,budgetMode:mode,newVendorRequiresApproval:false})})).status).toBe(200);
  const client = new Client({name:'context-browser',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {requestInit:{headers:await agentHeaders(id)}}));
  async function spend(purpose: string, amount = 5000) {
    const response = await client.callTool({name:'spend',arguments:{amount,currency:'GBP',vendor:'review-vendor',purpose,rail:'mcp',deferred:true}});
    expect(response.isError).not.toBe(true);
    return response.structuredContent as {approvalId:string;requestId:string};
  }
  return {headers,client,spend};
}
async function openQueue(page: Page) {
  await signIn(page);
  if (await page.getByRole('button',{name:'Open menu'}).isVisible()) await page.getByRole('button',{name:'Open menu'}).click();
  await page.getByRole('button',{name:/^Approvals/}).click();
  if (await page.getByRole('button',{name:'Open menu'}).isVisible()) await expect(page.getByRole('button',{name:'Close menu'})).not.toBeInViewport();
}

test('queue has decision context and independent recorded notes with keyboard actions on mobile',async({page})=>{
  const f=await fixture('context-mobile');
  try {
    await f.spend('First mobile request'); await f.spend('Second mobile request');
    await page.setViewportSize({width:390,height:844}); await openQueue(page);
    const first=page.getByRole('region',{name:'Approval: First mobile request',exact:true});
    const second=page.getByRole('region',{name:'Approval: Second mobile request',exact:true});
    await expect(first.getByText('£50.00 GBP', {exact:true})).toBeVisible();
    await expect(first.getByText('Review Agent (context-mobile)',{exact:true})).toBeVisible();
    await expect(first.getByText('No previous vendor activity.',{exact:true})).toBeVisible();
    await expect(first.getByText('After authorisation: £50.00 GBP remaining',{exact:true})).toBeVisible();
    await expect(first.getByText(/Time remaining:/)).toBeVisible();
    await expect(first.getByText(/Notification: not configured/)).toBeVisible();
    await page.screenshot({path:'test-results/approval-context-mobile-pending.png',fullPage:true});
    await first.getByLabel('Decision note',{exact:true}).fill('First rationale');
    await second.getByLabel('Decision note',{exact:true}).fill('Second rationale');
    await first.getByRole('button',{name:'Approve',exact:true}).focus(); await page.keyboard.press('Enter');
    await expect(first).toHaveCount(0);
    await expect(page.getByRole('status').filter({hasText:'Request approved.'})).toBeVisible();
    await expect(second.getByLabel('Decision note',{exact:true})).toHaveValue('Second rationale');
    await second.getByRole('button',{name:'Reject',exact:true}).focus(); await page.keyboard.press('Enter');
    await expect(second).toHaveCount(0);
    await expect(page.getByText('First rationale',{exact:true})).toBeVisible();
    await expect(page.getByText('Second rationale',{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:'test-results/approval-context-mobile.png',fullPage:true});
  } finally {await f.client.close();}
});

test('budget competition disables hard-stop approval and explicit override requires a reason',async({page})=>{
  const f=await fixture('context-override','approval-override');
  try {
    await f.spend('Permission that holds funds',8000);
    const state=await(await fetch(`${BASE}/api/approvals`,{headers:f.headers})).json();
    const held=state.pending.find((a:any)=>a.intent.purpose==='Permission that holds funds');
    expect((await fetch(`${BASE}/api/approvals/${held.id}/decide`,{method:'POST',headers:f.headers,body:JSON.stringify({approve:true})})).status).toBe(200);
    await f.spend('Override request'); await openQueue(page);
    const card=page.getByRole('region',{name:'Approval: Override request',exact:true});
    await expect(card.getByText('After authorisation: −£30.00 GBP remaining',{exact:true})).toBeVisible();
    await expect(card.getByRole('button',{name:'Approve with budget override',exact:true})).toBeDisabled();
    await card.getByLabel('Decision note',{exact:true}).fill('Approved exception for operations');
    await expect(card.getByRole('button',{name:'Approve with budget override',exact:true})).toBeEnabled();
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:'test-results/approval-context-desktop.png',fullPage:true});
    // A newer policy closes the override. Submission must recheck even with the old preview.
    await fetch(`${BASE}/api/policies/context-override`,{method:'PUT',headers:f.headers,body:JSON.stringify({dailyBudget:10000,maxPerTxn:1000,budgetMode:'hard-stop'})});
    await page.reload(); await page.getByRole('button',{name:/^Approvals/}).click();
    await expect(card.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
    await expect(card.getByText(/Hard-stop mode does not permit an override/)).toBeVisible();
    await expect(card.getByRole('button',{name:'Reject',exact:true})).toBeEnabled();
  } finally {await f.client.close();}
});

test('stale competing decision recovers current state and unavailable history is not shown as new',async({page})=>{
  const f=await fixture('context-conflict');
  try {
    const a=await f.spend('Conflicting request');
    await page.route('**/api/state',async route=>{
      const response=await route.fetch(); const body=await response.json();
      for(const a of body.approvalsPending) if(a.intent.purpose==='Conflicting request'&&a.context) a.context.vendorHistory={status:'unavailable',isNewVendor:null,reason:'Vendor history is unavailable.'};
      await route.fulfill({response,json:body});
    });
    await openQueue(page);
    const card=page.getByRole('region',{name:'Approval: Conflicting request',exact:true});
    await expect(card.getByText('Vendor history is unavailable.',{exact:true})).toBeVisible();
    await expect(card.getByText(/New vendor/)).toHaveCount(0);
    // Hold background snapshots so the clicked card is genuinely stale.
    await page.route('**/api/state',route=>route.abort());
    expect((await fetch(`${BASE}/api/approvals/${a.approvalId}/decide`,{method:'POST',headers:f.headers,body:JSON.stringify({approve:false,note:'Decided elsewhere'})})).status).toBe(200);
    await card.getByRole('button',{name:'Approve',exact:true}).click();
    await expect(card.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
    await expect(card.getByRole('alert')).toContainText('no longer pending');
    await expect(card.getByText(/Decided elsewhere/)).toBeVisible();
  } finally {await f.client.close();}
});

test('persisted deadline disables both controls and server reconciles expiry at decision time', async({page})=>{
  const f=await fixture('context-expiry');
  try {
    const a=await f.spend('Expiring request');
    const {execFileSync}=await import('node:child_process');
    execFileSync(process.execPath,['--import','tsx','server/test/fixtures/approval-deadline.ts',a.approvalId],{cwd:process.cwd(),env:process.env,stdio:'pipe'});
    await openQueue(page);
    const card=page.getByRole('region',{name:'Approval: Expiring request',exact:true});
    await expect(card.getByRole('button',{name:'Approve',exact:true})).toBeDisabled({timeout:6000});
    await expect(card.getByRole('button',{name:'Reject',exact:true})).toBeDisabled();
    const res=await fetch(`${BASE}/api/approvals/${a.approvalId}/decide`,{method:'POST',headers:f.headers,body:JSON.stringify({approve:true})});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({code:'approval-not-pending',approval:{status:'expired'}});
  } finally {await f.client.close();}
});

test('ordinary approval cannot turn a prewritten note into an override when another reviewer consumes funds',async({page})=>{
  const f=await fixture('context-override-race','approval-override');
  try {
    const a=await f.spend('Ordinary approval');
    const b=await f.spend('Competing approval',8000);
    await openQueue(page);
    const card=page.getByRole('region',{name:'Approval: Ordinary approval',exact:true});
    await card.getByLabel('Decision note',{exact:true}).fill('Checked vendor invoice');
    await expect(card.getByRole('button',{name:'Approve',exact:true})).toBeEnabled();
    await page.route('**/api/state',route=>route.abort());
    expect((await fetch(`${BASE}/api/approvals/${b.approvalId}/decide`,{method:'POST',headers:f.headers,body:JSON.stringify({approve:true})})).status).toBe(200);
    await card.getByRole('button',{name:'Approve',exact:true}).click();
    await expect(card.getByRole('alert')).toContainText('explicitly approve the budget override');
    await expect(card.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
    await expect(card.getByRole('button',{name:'Approve with budget override',exact:true})).toBeEnabled();
    await expect(card.getByLabel('Decision note',{exact:true})).toHaveValue('Checked vendor invoice');
    const pending=await(await fetch(`${BASE}/api/approvals/${a.approvalId}/context`,{headers:f.headers})).json();
    expect(pending.status).toBe('pending');
    await card.getByLabel('Decision note',{exact:true}).fill('Necessary budget exception');
    await card.getByRole('button',{name:'Approve with budget override',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'Request approved.'})).toBeVisible();
    const final=await(await fetch(`${BASE}/api/approvals/${a.approvalId}/context`,{headers:f.headers})).json();
    expect(final.status).toBe('approved');
  } finally {await f.client.close();}
});

test('lost state refreshes disable stale actions while preserving the request note',async({page})=>{
  const f=await fixture('context-stale');
  try {
    await f.spend('Offline request');
    await page.clock.install(); await openQueue(page);
    const card=page.getByRole('region',{name:'Approval: Offline request',exact:true});
    await card.getByLabel('Decision note',{exact:true}).fill('Draft rationale');
    await expect(card.getByRole('button',{name:'Approve',exact:true})).toBeEnabled();
    await page.route('**/api/state',route=>route.abort());
    await page.clock.fastForward(31000);
    await expect(card.getByRole('button',{name:'Approve',exact:true})).toBeDisabled();
    await expect(card.getByRole('button',{name:'Reject',exact:true})).toBeDisabled();
    await expect(card.getByText('Context is stale. Refresh before deciding.',{exact:true})).toBeVisible();
    await expect(card.getByLabel('Decision note',{exact:true})).toHaveValue('Draft rationale');
  } finally {await f.client.close();}
});
