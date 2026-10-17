import { expect, type Page } from '@playwright/test';
export const BASE = `http://127.0.0.1:${process.env.SPENDLOCK_E2E_PORT ?? 18871}`;
export async function operatorHeaders() {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ username: 'test-operator', password: 'isolated test operator password' }) });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { Cookie: res.headers.get('set-cookie')!.split(';')[0], Origin: BASE, 'X-CSRF-Token': body.csrfToken };
}
export async function agentHeaders(agentId: string) {
  const res = await fetch(`${BASE}/api/agents/${agentId}/credentials`, { method: 'POST', headers: { ...await operatorHeaders(), 'Content-Type': 'application/json' }, body: '{}' });
  expect(res.status).toBe(201);
  return { Authorization: `Bearer ${(await res.json()).secret}` };
}
export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('test-operator');
  await page.getByLabel('Password', { exact: true }).fill('isolated test operator password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('aside')).toBeVisible();
}
