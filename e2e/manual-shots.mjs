// Captures screenshots for the user manual (docs/manual/img). READ-ONLY: it types sample
// values into forms to illustrate them but never clicks Save / Create / Confirm.
//   set E2E_BASE=https://rhbc.online  E2E_EMAIL=...  E2E_PASSWORD=...  then: node manual-shots.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'docs', 'manual', 'img');
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.E2E_BASE ?? 'https://rhbc.online';
const { E2E_EMAIL: EMAIL, E2E_PASSWORD: PASSWORD } = process.env;
if (!EMAIL || !PASSWORD) { console.error('Set E2E_EMAIL and E2E_PASSWORD'); process.exit(2); }

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 780 }, deviceScaleFactor: 1.5 })).newPage();
let pending = 0;
page.on('request', () => { pending++; });
page.on('requestfinished', () => { pending = Math.max(0, pending - 1); });
page.on('requestfailed', () => { pending = Math.max(0, pending - 1); });
async function settle() {
  const deadline = Date.now() + 20000; let quiet = null;
  while (Date.now() < deadline) {
    const busy = pending > 0 || (await page.locator('.animate-spin').count()) > 0;
    if (busy) quiet = null; else if (quiet === null) quiet = Date.now(); else if (Date.now() - quiet >= 500) return;
    await page.waitForTimeout(100);
  }
}
const modal = () => page.locator('div.fixed.inset-0.z-40').last();
const card = () => modal().locator('> div').first();
const field = (label) => modal().locator('label').filter({ hasText: label }).locator('input, select, textarea').first();
const btn = (name, scope = page) => scope.getByRole('button', { name, exact: true });
const done = [];
async function shot(name, opts = {}) {
  await page.locator('.fixed.bottom-4 > div').first().waitFor({ state: 'detached', timeout: 500 }).catch(() => {});
  const file = path.join(out, `${name}.png`);
  // Hide the hosting badge so it does not cover the screen being documented.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && /Powered by\s*Netlify/i.test(el.textContent ?? '') && (el.textContent ?? '').length < 60) el.style.display = 'none';
    }
    for (const f of document.querySelectorAll('iframe[src*="netlify"], [data-netlify-badge]')) f.style.display = 'none';
  });
  if (opts.modal) await card().screenshot({ path: file });
  else if (opts.viewport) await page.screenshot({ path: file });
  else {
    // Content area only, cropped to the height of what is actually on the page.
    const clip = await page.evaluate(() => {
      const m = document.querySelector('main');
      const r = m.getBoundingClientRect();
      let bottom = r.top + 120;
      for (const el of m.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.height > 0) bottom = Math.max(bottom, b.bottom);
      }
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: Math.ceil(bottom - r.top + 22) };
    });
    await page.screenshot({ path: file, fullPage: true, clip });
  }
  done.push(name);
}
async function go(url) { await page.goto(BASE + url); await settle(); }
const closeModal = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(200); };
async function attempt(name, fn) { try { await fn(); } catch (e) { console.log(`! ${name}: ${e.message.split('\n')[0]}`); await closeModal().catch(() => {}); } }

// ---- login -------------------------------------------------------------------
await page.goto(BASE + '/'); await settle();
await page.getByLabel('Email').fill('you@company.com');
await shot('login', { viewport: true });
await page.getByLabel('Email').fill(EMAIL);
await page.getByLabel('Password').fill(PASSWORD);
await btn('Sign in').click();
await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 20000 });
await settle();
await shot('dashboard', { viewport: true });

// ---- sites ---------------------------------------------------------------------
await attempt('sites', async () => {
  await go('/sites');
  await page.locator('tbody tr').first().click(); await settle();
  await shot('sites', { full: true });
  await btn('Device sessions').click(); await settle();
  await shot('sites-devices', { full: true });
  await btn('New site').click();
  await field('Site name').fill('Makati Warehouse');
  await field('App password').fill('makati-site-2026');
  await field('Address').fill('123 Chino Roces Ave, Makati City');
  await field('Region').fill('NCR');
  await shot('sites-new', { modal: true });
  await closeModal();
  await btn('App sign-in').click(); await settle();
  await btn('Change password').click();
  await shot('sites-password', { modal: true });
  await closeModal();
});

// ---- employees -------------------------------------------------------------------
await attempt('employees', async () => {
  await go('/employees');
  await shot('employees');
  await btn('New employee').click();
  await field('First name').fill('Juan');
  await field('Middle name').fill('Santos');
  await field('Last name').fill('Dela Cruz');
  await field('Site').selectOption({ index: 1 });
  await field('Daily rate').fill('600');
  await field('Schedule').selectOption({ index: 1 });
  await shot('employees-new', { modal: true });
  await closeModal();
  await page.locator('tbody tr').first().click(); await settle();
  await shot('employee-profile', { full: true });
  await btn('Site & PIN').click(); await settle();
  await shot('employee-site-pin');
  await btn('Transfer').click();
  await shot('employee-transfer', { modal: true });
  await closeModal();
  await btn('Set PIN manually').click();
  await shot('employee-pin-manual', { modal: true });
  await closeModal();
  await btn('Rate & schedule').click(); await settle();
  await shot('employee-rate');
  await btn('Add rate').click();
  await field('Or enter a monthly salary').fill('15600');
  await shot('employee-rate-add', { modal: true });
  await closeModal();
  await btn('Deductions').click(); await settle();
  const rows = page.locator('tbody tr');
  await rows.nth(0).locator('input[type=checkbox]').check(); await rows.nth(0).locator('input[type=number]').fill('100');
  await rows.nth(1).locator('input[type=checkbox]').check(); await rows.nth(1).locator('input[type=number]').fill('75');
  await rows.nth(2).locator('input[type=checkbox]').check(); await rows.nth(2).locator('input[type=number]').fill('50');
  await shot('employee-deductions');
  await btn('Leave').click(); await settle();
  await shot('employee-leave');
  await btn('Grant / adjust').click();
  await shot('employee-leave-grant', { modal: true });
  await closeModal();
});

// ---- schedules -------------------------------------------------------------------
await attempt('schedules', async () => {
  await go('/schedules');
  await shot('schedules');
  await btn('Edit').first().click();
  await shot('schedules-edit', { modal: true });
  await closeModal();
});

// ---- attendance -------------------------------------------------------------------
await attempt('attendance', async () => {
  await go('/attendance');
  await page.locator('input[type=date]').first().fill('2026-11-09'); await settle();
  await page.getByLabel('Show voided').check().catch(() => {}); await settle();
  await shot('attendance', { full: true });
  await page.locator('tbody tr').first().click(); await settle();
  await shot('attendance-detail', { modal: true });
  await btn(/Close \/ correct|Correct times/, modal()).click().catch(() => {});
  await page.waitForTimeout(300);
  await shot('attendance-correct', { modal: true });
  await closeModal();
  await btn('Add missing session').click();
  await field('Employee').selectOption({ index: 1 });
  await field('Reason').fill('Phone was offline; time confirmed by site supervisor');
  await shot('attendance-add', { modal: true });
  await closeModal();
});

await attempt('overtime', async () => { await go('/overtime'); await shot('overtime'); });

await attempt('leave', async () => {
  await go('/leave');
  await shot('leave');
  await btn('Record leave').click();
  await field('Employee').selectOption({ index: 1 });
  await field('Leave type').selectOption({ index: 1 }); await settle();
  await shot('leave-record', { modal: true });
  await closeModal();
});

await attempt('allowances', async () => {
  await go('/allowances');
  await btn('New allowance').click();
  await field('Employee').selectOption({ index: 1 });
  await field('Name').fill('Meal allowance');
  await field('Amount').fill('50');
  await shot('allowances-new', { modal: true });
  await closeModal();
  await shot('allowances');
});

await attempt('advances', async () => {
  await go('/advances');
  await btn('Record advance').click();
  await field('Employee').selectOption({ index: 1 });
  await field('Principal').fill('2000');
  await field('Weekly installment').fill('500');
  await field('Reason').fill('Emergency — approved by the owner');
  await shot('advances-new', { modal: true });
  await closeModal();
  await shot('advances');
});

// ---- payroll -------------------------------------------------------------------
await attempt('payroll', async () => {
  await go('/payroll');
  await shot('payroll-runs');
  await btn('New payroll run').click();
  await field('Any date in the pay week').fill('2026-11-18'); await settle();
  await modal().locator('label').filter({ hasText: 'Balanga' }).locator('input[type=checkbox]').check().catch(() => {});
  await shot('payroll-new', { modal: true });
  await closeModal();
  if (await page.locator('tbody tr').count()) {
    await page.locator('tbody tr').first().click(); await settle();
    await shot('payroll-run-void');
  }
  await go('/payslips?void=1'); await settle();
  await shot('payslips');
  await go('/reports');
  await shot('reports', { full: true });
});

// ---- policies, users, audit --------------------------------------------------------
await attempt('policies', async () => {
  await go('/policies');
  await shot('policies-settings', { full: true });
  await btn('Statutory rules').click(); await settle();
  await shot('policies-rules', { full: true });
  await btn('Holidays').click(); await settle();
  await shot('policies-holidays');
  await btn('Add holiday').click();
  await shot('policies-holiday-add', { modal: true });
  await closeModal();
  await btn('Day multipliers').click(); await settle();
  await shot('policies-multipliers');
});
await attempt('users', async () => {
  await go('/users');
  await shot('users');
  await btn('Edit').first().click();
  await shot('users-edit', { modal: true });
  await closeModal();
});
await attempt('audit', async () => {
  await go('/audit');
  await shot('audit');
});

await browser.close();
console.log(`${done.length} screenshots: ${done.join(', ')}`);
