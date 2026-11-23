import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PASSWORD = 'Test-password-123!';
const sql = (query: string) => execFileSync('psql', [process.env.DB_URL!, '-Atqc', query], { encoding: 'utf8' }).trim();
mkdirSync('e2e-output', { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e-output/${name}.png`, fullPage: true });

async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
/** Sign in as owner and wait until the session is established before navigating. */
async function loginOwner(page: Page) {
  await login(page, 'owner@example.test');
  await expect(page.getByRole('heading', { name: 'Command Center' })).toBeVisible({ timeout: 20_000 });
}

test('rejects bad credentials and shows no data before login', async ({ page }) => {
  await login(page, 'owner@example.test', 'wrong-password');
  await expect(page.locator('.alert.bad')).toBeVisible();
  await expect(page.getByText('Confirmed revenue')).toHaveCount(0);
  await shot(page, '01-login-error');
});

test('a signed-in non-owner is refused', async ({ page }) => {
  await login(page, 'stranger@example.test');
  await expect(page.getByRole('heading', { name: 'Not authorized' })).toBeVisible();
  await shot(page, '02-not-authorized');
});

test('owner sees the real (empty) command center and every page loads without errors', async ({ page }) => {
  await loginOwner(page);
  await expect(page.getByText('Confirmed revenue').first()).toBeVisible();
  await expect(page.locator('.stat-value').first()).toHaveText('$0');   // no fabricated revenue
  await shot(page, '03-command-center');
  const pages = ['/approvals', '/live', '/opportunities', '/crm', '/clients', '/communications', '/projects', '/production', '/workforce', '/queue', '/tools', '/health', '/finance', '/performance', '/reports', '/settings'];
  for (const p of pages) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.getByText('Failed to load')).toHaveCount(0);
    await shot(page, `page${p.replace(/\//g, '-')}`);
  }
  await page.goto('/workforce');
  await expect(page.getByText('Research Analyst')).toBeVisible();   // agents come from the database
});

test('approval decided in the UI is enforced in the database', async ({ page }) => {
  const approvalId = sql(`select public.request_approval('test.ui', 'UI test approval', 'sales_agent', 'Testing the approval gate', 'Gated task is released', 'Gated task is cancelled')`);
  const taskId = sql(`select public.enqueue_task(p_type => 'x.ui', p_idempotency_key => 'ui-gated-${Date.now()}', p_approval_id => '${approvalId}')`);
  expect(sql(`select status from public.tasks where id = '${taskId}'`)).toBe('awaiting_approval');
  await loginOwner(page);
  await page.goto('/approvals');
  await expect(page.getByText('UI test approval')).toBeVisible();
  await expect(page.getByText('Gated task is released')).toBeVisible();
  await shot(page, '04-approval-pending');
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect.poll(() => sql(`select status from public.approvals where id = '${approvalId}'`)).toBe('approved');
  expect(sql(`select status from public.tasks where id = '${taskId}'`)).toBe('pending');
  expect(sql(`select count(*) from public.audit_log where entity_type = 'approvals' and entity_id = '${approvalId}' and actor_type = 'owner'`)).not.toBe('0');
});

test('kill switch toggles from Settings and is visible everywhere', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await loginOwner(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Tout arrêter' }).click();
  await expect.poll(() => sql(`select value::text from public.settings where key = 'system.kill_switch'`)).toBe('true');
  await page.goto('/');
  await expect(page.getByText('Kill switch is ON')).toBeVisible();
  await shot(page, '05-kill-switch-on');
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Relancer' }).click();
  await expect.poll(() => sql(`select value::text from public.settings where key = 'system.kill_switch'`)).toBe('false');
});

test('manual opportunity keeps its evidence and is queued for analysis', async ({ page }) => {
  await loginOwner(page);
  await page.goto('/opportunities');
  await page.getByRole('button', { name: 'Add manually' }).click();
  await page.getByLabel('Title').fill('Referral: invoice PDF extraction');
  await page.getByLabel('Buyer / company').fill('Referral Co');
  await page.getByLabel('Source URL (or reference)').fill('https://example.test/referral-1');
  await page.getByLabel('Request text (evidence)').fill('A referral needs a Python script that extracts totals from 200 invoice PDFs into CSV. Budget 400 USD.');
  await page.getByRole('button', { name: 'Save & analyse' }).click();
  await expect.poll(() => sql(`select count(*) from public.opportunities where title = 'Referral: invoice PDF extraction'`)).toBe('1');
  await page.locator('button.tab', { hasText: /^All$/ }).click();
  await page.getByText('Referral: invoice PDF extraction').click();
  await expect(page.getByText('Budget 400 USD')).toBeVisible();
  await shot(page, '06-opportunity-detail');
  expect(sql(`select count(*) from public.tasks where type = 'opportunity.analyze' and status = 'pending'`)).not.toBe('0');
});
