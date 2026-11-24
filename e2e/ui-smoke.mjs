// Read-only UI smoke test: signs in to the admin website and opens every page, tab and
// create/edit form (without saving), reporting failed requests, console errors and error boxes.
//   set E2E_BASE=http://localhost:5199  E2E_EMAIL=...  E2E_PASSWORD=...  then: node ui-smoke.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screens');
fs.mkdirSync(shots, { recursive: true });
const BASE = process.env.E2E_BASE ?? 'http://localhost:5199';
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('Set E2E_EMAIL and E2E_PASSWORD'); process.exit(2); }

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? 'msedge', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

let current = 'login';
const problems = [];
const note = (kind, detail) => problems.push({ where: current, kind, detail });
page.on('pageerror', (e) => note('page crash', e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) note('console error', m.text().slice(0, 300)); });
page.on('response', async (r) => {
  if (r.status() < 400 || /favicon/.test(r.url())) return;
  let body = '';
  try { body = (await r.text()).slice(0, 200); } catch { /* ignore */ }
  note(`HTTP ${r.status()}`, `${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 160)} ${body}`);
});

// Wait until no request has been in flight for 500 ms and no spinner is visible.
let pending = 0;
page.on('request', () => { pending++; });
page.on('requestfinished', () => { pending = Math.max(0, pending - 1); });
page.on('requestfailed', () => { pending = Math.max(0, pending - 1); });
async function settle() {
  const deadline = Date.now() + 20000;
  let quietSince = null;
  while (Date.now() < deadline) {
    const busy = pending > 0 || (await page.locator('.animate-spin').count()) > 0;
    if (busy) quietSince = null;
    else if (quietSince === null) quietSince = Date.now();
    else if (Date.now() - quietSince >= 500) break;
    await page.waitForTimeout(100);
  }
  if (Date.now() >= deadline) note('still loading', 'page did not finish loading within 20 s');
  // ErrorBox only (text-red-800); red informational notices such as "Void." use text-red-900.
  for (const t of await page.locator('.border-red-200.bg-red-50.text-red-800').allInnerTexts()) note('error box', t.slice(0, 200));
  for (const t of await page.locator('.bg-red-600.text-white.shadow-lg').allInnerTexts()) note('error toast', t.slice(0, 200));
}
async function shot(name) { await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); }
async function visit(name, url) {
  current = name;
  await page.goto(BASE + url);
  await settle();
  await shot(name.replace(/[^a-z0-9]+/gi, '-'));
}
async function clickIf(name, locator, after) {
  current = name;
  if (await locator.count() === 0) { note('skipped', 'control not found'); return false; }
  await locator.first().click();
  await settle();
  await shot(name.replace(/[^a-z0-9]+/gi, '-'));
  if (after) await after();
  return true;
}
const closeModal = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); };
const btn = (text) => page.getByRole('button', { name: text, exact: true });

// ---- sign in ---------------------------------------------------------------
await page.goto(BASE + '/');
await page.getByLabel('Email').fill(EMAIL);
await page.getByLabel('Password').fill(PASSWORD);
await btn('Sign in').click();
await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 20000 });
await settle();
await shot('dashboard');
console.log('signed in');

// ---- every page ------------------------------------------------------------
await visit('attendance', '/attendance');
await clickIf('attendance: add missing session form', btn('Add missing session'), closeModal);
current = 'attendance: open sessions view';
await page.locator('select').first().selectOption('open'); await settle(); await shot('attendance-open');
await clickIf('attendance: session detail', page.locator('tbody tr').first(), closeModal);

await visit('overtime', '/overtime');
await visit('employees', '/employees');
await clickIf('employees: new employee form', btn('New employee'), closeModal);
if (await clickIf('employee detail', page.locator('tbody tr').first())) {
  for (const tab of ['Site & PIN', 'Rate & schedule', 'Deductions', 'Leave', 'Attendance', 'Profile']) {
    await clickIf(`employee detail: ${tab}`, btn(tab));
  }
  await btn('Site & PIN').click(); await settle();
  await clickIf('employee: transfer form', btn('Transfer'), closeModal);
  await clickIf('employee: set PIN manually form', btn('Set PIN manually'), closeModal);
  await btn('Rate & schedule').click(); await settle();
  await clickIf('employee: add rate form', btn('Add rate'), closeModal);
  await clickIf('employee: assign schedule form', btn('Assign schedule'), closeModal);
  await btn('Leave').click(); await settle();
  await clickIf('employee: grant leave form', btn('Grant / adjust'), closeModal);
}
await visit('schedules', '/schedules');
await clickIf('schedules: new form', btn('New schedule'), closeModal);
await clickIf('schedules: edit form', btn('Edit'), closeModal);
await visit('leave', '/leave');
await clickIf('leave: record form', btn('Record leave'), closeModal);
await visit('allowances', '/allowances');
await clickIf('allowances: new form', btn('New allowance'), closeModal);
await visit('advances', '/advances');
await clickIf('advances: record form', btn('Record advance'), closeModal);

await visit('payroll runs', '/payroll');
await clickIf('payroll: new run form', btn('New payroll run'), closeModal);
if (await page.locator('tbody tr').count()) await clickIf('payroll run detail', page.locator('tbody tr').first());
await visit('payslips', '/payslips');
await visit('reports', '/reports');

await visit('sites', '/sites');
await clickIf('sites: new site form', btn('New site'), closeModal);
await clickIf('sites: edit form', btn('Edit'), closeModal);
if (await clickIf('sites: site panel', page.locator('tbody tr').first())) {
  await clickIf('sites: device sessions tab', btn('Device sessions'));
  await clickIf('sites: app sign-in tab', btn('App sign-in'));
  await clickIf('sites: change password form', btn('Change password'), closeModal);
}
await visit('policies', '/policies');
for (const tab of ['Statutory rules', 'Holidays', 'Day multipliers', 'Payroll & attendance settings']) {
  await clickIf(`policies: ${tab}`, btn(tab));
}
await btn('Statutory rules').click(); await settle();
await clickIf('policies: rule parameters', btn('Parameters'), closeModal);
await btn('Holidays').click(); await settle();
await clickIf('policies: add holiday form', btn('Add holiday'), closeModal);
await visit('users', '/users');
await clickIf('users: edit access form', btn('Edit'), closeModal);
await visit('audit', '/audit');
await clickIf('audit: details', btn('Details'), closeModal);

await browser.close();

// ---- report ----------------------------------------------------------------
const seen = new Set();
const unique = problems.filter((p) => { const k = `${p.where}|${p.kind}|${p.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
const real = unique.filter((p) => p.kind !== 'skipped');
console.log(`\n${real.length} problem(s), ${unique.length - real.length} control(s) not present`);
for (const p of unique) console.log(`- [${p.where}] ${p.kind}: ${p.detail}`);
process.exit(real.length ? 1 : 0);
