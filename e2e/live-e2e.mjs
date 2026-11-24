// Full "from the start" test through the real website UI and the app's API, against the
// Supabase project in admin/.env. It CREATES test records (a "ZZ Test Site", one test
// employee, attendance and one payroll run) and afterwards voids / deactivates them.
//   set E2E_BASE=http://localhost:5199  E2E_EMAIL=...  E2E_PASSWORD=...  then: node live-e2e.mjs
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screens', 'live');
fs.mkdirSync(shots, { recursive: true });
const env = Object.fromEntries(fs.readFileSync(path.join(here, '..', 'admin', '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_ANON_KEY;
const BASE = process.env.E2E_BASE ?? 'http://localhost:5199';
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('Set E2E_EMAIL and E2E_PASSWORD'); process.exit(2); }

const api = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });   // admin checks
const app = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });   // the phone (no login)
{
  const { error } = await api.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error) { console.error('Admin sign-in failed:', error.message); process.exit(2); }
}
const must = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER ?? 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
let pending = 0;
page.on('request', () => { pending++; });
page.on('requestfinished', () => { pending = Math.max(0, pending - 1); });
page.on('requestfailed', () => { pending = Math.max(0, pending - 1); });

async function settle() {
  const deadline = Date.now() + 25000;
  let quiet = null;
  while (Date.now() < deadline) {
    const busy = pending > 0 || (await page.locator('.animate-spin').count()) > 0;
    if (busy) quiet = null; else if (quiet === null) quiet = Date.now(); else if (Date.now() - quiet >= 500) return;
    await page.waitForTimeout(100);
  }
  throw new Error('page did not finish loading');
}
const modal = () => page.locator('div.fixed.inset-0.z-40').last();
const field = (label) => modal().locator('label').filter({ hasText: label }).locator('input, select, textarea').first();
const btn = (name, scope = page) => scope.getByRole('button', { name, exact: true });
const errorToasts = () => page.locator('.bg-red-600.text-white.shadow-lg').allInnerTexts();
async function toast(text) {
  const deadline = Date.now() + 30000;
  const wanted = page.locator('.fixed.bottom-4').getByText(text, { exact: false });
  while (Date.now() < deadline) {
    if (await wanted.count()) { await settle(); return; }
    const errs = await errorToasts();           // fail fast, before the error message fades
    if (errs.length) throw new Error(`expected "${text}" but the website showed: ${errs.join(' | ')}`);
    await page.waitForTimeout(150);
  }
  throw new Error(`expected message "${text}" but nothing was shown within 30 s`);
}
async function go(url) { await page.goto(BASE + url); await settle(); }
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });

const results = [];
let failed = false;
async function step(name, fn) {
  if (failed) { results.push(['skipped', name]); return; }
  try {
    await fn();
    const errs = await errorToasts();
    if (errs.length) throw new Error(`error message shown: ${errs.join(' | ')}`);
    results.push(['ok', name]);
    console.log(`✓ ${name}`);
  } catch (e) {
    failed = true;
    results.push(['FAILED', name, e.message]);
    console.log(`✗ ${name}\n    ${e.message}`);
    await shot(`FAILED-${results.length}`).catch(() => {});
  }
}

// ---- test data ---------------------------------------------------------------
const SITE = 'ZZ Test Site';
const SITE_PW = `zz-test-${randomUUID().slice(0, 8)}`;
const FIRST = 'Zztest';
const LAST = 'Worker';
const NAME = `${FIRST} ${LAST}`;
const WEEK = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-15']; // Mon–Fri + Sun
const ctx = {};

// Resume: if an earlier run already created the test site, employee and week of sessions,
// reuse them (reactivated) instead of creating more test records; start again at payroll.
let RESUME = false;
{
  const s = (await must(api.from('sites').select('id, code, is_active').eq('name', SITE)))[0];
  const e = s && (await must(api.from('employees').select('id, employee_code').eq('first_name', FIRST).eq('last_name', LAST)))[0];
  const sess = e ? await must(api.from('work_sessions').select('id').eq('employee_id', e.id).eq('source', 'correction').neq('status', 'voided')) : [];
  if (s && e && sess.length === 6) {
    RESUME = true;
    ctx.site = s; ctx.empId = e.id; ctx.code = e.employee_code;
    await must(api.from('sites').update({ is_active: true }).eq('id', s.id));
    await must(api.rpc('admin_set_site_password', { p_site_id: s.id, p_password: SITE_PW }));
    await must(api.rpc('admin_set_site_account_active', { p_site_id: s.id, p_active: true }));
    await must(api.from('employees').update({ is_active: true }).eq('id', e.id));
    const stale = await must(api.from('payroll_runs').select('id, status').contains('site_ids', [s.id]).in('status', ['draft', 'ready_for_review']));
    for (const r of stale) await must(api.rpc('payroll_delete_draft', { p_run_id: r.id }));
    console.log(`(resuming with existing test site ${s.code} and employee ${e.employee_code}; set-up and app steps passed in the earlier run)`);
  } else if (s) {
    console.error(`A site named "${SITE}" exists but is not in the expected state; not creating more test data.`);
    process.exit(2);
  }
}
const setup = (name, fn) => (RESUME ? (results.push(['ok', `${name} (passed in the earlier run)`]), undefined) : step(name, fn));

// ---- 1. sign in ----------------------------------------------------------------
await step('Website: admin signs in', async () => {
  await page.goto(BASE + '/');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await btn('Sign in').click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 20000 });
  await settle();
});

// ---- 2. site ---------------------------------------------------------------------
await setup(`Website: create site "${SITE}" with app password (code is automatic)`, async () => {
  await go('/sites');
  await btn('New site').click();
  await field('Site name').fill(SITE);
  await field('App password').fill(SITE_PW);
  await field('Address').fill('E2E test only');
  await field('Region').fill('Region III');
  await btn('Save', modal()).click();
  await toast('Site created');
  const s = (await must(api.from('sites').select('id, code, is_active').eq('name', SITE)))[0];
  assert.ok(s, 'site row exists');
  assert.match(s.code, /^ZZ-TEST-SITE/);
  ctx.site = s;
  const acct = await must(api.from('site_accounts').select('is_active').eq('site_id', s.id));
  assert.equal(acct.length, 1, 'app password was set');
  await shot('02-site-created');
});

// ---- 3. employee -----------------------------------------------------------------
await setup(`Website: create employee "${NAME}" (code is automatic) with rate, schedule and site`, async () => {
  await go('/employees');
  await btn('New employee').click();
  await field('First name').fill(FIRST);
  await field('Last name').fill(LAST);
  await field('Hire date').fill('2026-11-01');
  await field('Site').selectOption({ label: SITE });
  await field('Assigned from').fill('2026-11-01');
  await field('Daily rate').fill('600');
  await field('Rate effective from').fill('2026-11-01');
  await field('Schedule').selectOption({ index: 1 });
  await field('Schedule effective from').fill('2026-11-01');
  await btn('Create', modal()).click();
  await page.waitForURL(/\/employees\/[0-9a-f-]{36}$/, { timeout: 20000 });
  await settle();
  ctx.empId = page.url().split('/').pop();
  const e = (await must(api.from('v_employee_overview').select('employee_code, current_site_name, current_daily_rate, current_schedule_name').eq('id', ctx.empId)))[0];
  assert.match(e.employee_code, /^EMP-\d{4}$/);
  assert.equal(e.current_site_name, SITE);
  assert.equal(Number(e.current_daily_rate), 600);
  assert.ok(e.current_schedule_name, 'schedule assigned');
  ctx.code = e.employee_code;
  await shot('03-employee-created');
});

await setup('Website: generate the employee PIN (shown once)', async () => {
  await btn('Site & PIN').click(); await settle();
  await btn('Generate PIN').click();
  const pinEl = modal().locator('.font-mono.text-4xl');
  await pinEl.waitFor({ timeout: 20000 });
  ctx.pin = (await pinEl.innerText()).replace(/\D/g, '');
  assert.match(ctx.pin, /^\d{6}$/);
  await btn('I have handed it over', modal()).click();
  await settle();
});

await setup('Website: set weekly deductions (SSS ₱100 enabled)', async () => {
  await btn('Deductions').click(); await settle();
  const row = page.locator('tbody tr').first();
  await row.locator('input[type=checkbox]').check();
  await row.locator('input[type=number]').fill('100');
  await btn('Save deductions').click();
  await toast('Deductions saved');
  const p = (await must(api.from('employee_deduction_profiles').select('sss_enabled, sss_amount').eq('employee_id', ctx.empId)))[0];
  assert.equal(p.sss_enabled, true);
  assert.equal(Number(p.sss_amount), 100);
});

// ---- 4. the attendance app (exactly the calls app/src/lib/api.ts makes) -----------
const rpc = async (fn, args) => must(app.rpc(fn, args));
await setup('App: wrong password is rejected; sign in with the SITE NAME + password', async () => {
  const bad = await rpc('site_login', { p_username: SITE, p_password: 'wrong-password', p_device_label: 'E2E', p_platform: 'android', p_app_version: '1.0.0' });
  assert.equal(bad.code, 'INVALID_LOGIN');
  const ok = await rpc('site_login', { p_username: SITE.toLowerCase(), p_password: SITE_PW, p_device_label: 'E2E test phone', p_platform: 'android', p_app_version: '1.0.0' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.site.name, SITE);
  ctx.token = ok.token;
  const info = await rpc('site_session_info', { p_token: ctx.token });
  assert.equal(info.ok, true);
});

await setup('App: roster shows only this site\'s employee; wrong PIN refused; correct PIN → Clock In', async () => {
  const roster = await rpc('site_roster', { p_token: ctx.token });
  assert.deepEqual(roster.employees.map((e) => e.code), [ctx.code]);
  assert.ok(!('daily_rate' in roster.employees[0]), 'no salary in roster');
  const wrong = await rpc('site_verify_pin', { p_token: ctx.token, p_employee_id: ctx.empId, p_pin: ctx.pin === '000000' ? '000001' : '000000' });
  assert.equal(wrong.code, 'PIN_INVALID');
  const v = await rpc('site_verify_pin', { p_token: ctx.token, p_employee_id: ctx.empId, p_pin: ctx.pin });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.next_action, 'clock_in');
  ctx.req = randomUUID();
  const loc = { status: 'captured', latitude: 14.676, longitude: 120.536, accuracy_m: 9, captured_at: new Date().toISOString(), age_ms: 800 };
  const p = await rpc('site_punch', { p_token: ctx.token, p_auth_token: v.auth_token, p_action: 'clock_in', p_request_id: ctx.req, p_location: loc, p_client_time: new Date().toISOString() });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.location_status, 'captured');
  const again = await rpc('site_punch', { p_token: ctx.token, p_auth_token: v.auth_token, p_action: 'clock_in', p_request_id: ctx.req, p_location: loc, p_client_time: new Date().toISOString() });
  assert.equal(again.replayed, true, 'retry returns the original punch, no duplicate');
  assert.equal((await rpc('site_check_request', { p_token: ctx.token, p_request_id: ctx.req })).event_id, p.event_id);
});

await setup('App: second Clock In is refused; PIN again → Clock Out (location off → saved and flagged)', async () => {
  await page.waitForTimeout(1500);
  const v = await rpc('site_verify_pin', { p_token: ctx.token, p_employee_id: ctx.empId, p_pin: ctx.pin });
  assert.equal(v.next_action, 'clock_out');
  const dup = await rpc('site_punch', { p_token: ctx.token, p_auth_token: v.auth_token, p_action: 'clock_in', p_request_id: randomUUID(), p_location: { status: 'unavailable' }, p_client_time: new Date().toISOString() });
  assert.equal(dup.code, 'ALREADY_CLOCKED_IN');
  const v2 = await rpc('site_verify_pin', { p_token: ctx.token, p_employee_id: ctx.empId, p_pin: ctx.pin });
  const out = await rpc('site_punch', { p_token: ctx.token, p_auth_token: v2.auth_token, p_action: 'clock_out', p_request_id: randomUUID(), p_location: { status: 'permission_denied' }, p_client_time: new Date().toISOString() });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.location_status, 'permission_denied');
  ctx.todaySession = out.work_session_id;
  await rpc('site_logout', { p_token: ctx.token });
  assert.equal((await rpc('site_roster', { p_token: ctx.token })).code, 'SESSION_INVALID');
});

// ---- 5. attendance review -----------------------------------------------------------
await setup('Website: today\'s punches appear in Attendance with the location flag; mark reviewed', async () => {
  await go('/attendance');
  const row = page.locator('tbody tr', { hasText: NAME }).first();
  await row.waitFor({ timeout: 15000 });
  assert.match(await row.innerText(), /location exception/i);
  await row.click(); await settle();
  await shot('05-attendance-detail');
  await btn('Mark reviewed', modal()).click();
  await modal().locator('textarea').fill('E2E test: location was off on the test phone');
  await btn('Confirm', modal()).click();
  await toast('Marked reviewed');
});

await setup('Website: add the past week\'s sessions as documented corrections (Mon–Fri + Sunday)', async () => {
  const times = { '2026-11-09': ['07:00', '18:00'], '2026-11-15': ['07:00', '17:00'] };
  for (const d of WEEK) {
    const [tin, tout] = times[d] ?? ['07:00', '16:00'];
    await btn('Add missing session').click();
    await field('Employee').selectOption({ label: `${NAME} (${ctx.code})` });
    if (!(await field('Site').inputValue())) await field('Site').selectOption({ label: SITE });
    await field('Clock in').fill(`${d}T${tin}`);
    await field('Clock out').fill(`${d}T${tout}`);
    await field('Reason').fill('E2E test: paper timesheet');
    await btn('Save', modal()).click();
    await toast('Session added');
    await page.locator('.fixed.bottom-4 > div').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  }
  const rows = await must(api.from('v_work_sessions').select('work_date, elapsed_minutes, source').eq('employee_id', ctx.empId).gte('work_date', '2026-11-09').lte('work_date', '2026-11-15'));
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r) => r.source === 'correction'));
});

// ---- 6. payroll -----------------------------------------------------------------------
await step('Website: create the weekly payroll run for the test site and calculate it', async () => {
  await go('/payroll');
  await btn('New payroll run').click();
  await field('Any date in the pay week').fill('2026-11-11');
  await modal().getByText('Nov 09, 2026').waitFor({ timeout: 15000 });
  await modal().locator('label').filter({ hasText: new RegExp(`${ctx.site.code}\\s*$`) }).locator('input[type=checkbox]').check();
  await btn('Create draft run', modal()).click();
  await page.waitForURL(/\/payroll\/[0-9a-f-]{36}$/, { timeout: 20000 });
  await settle();
  ctx.runId = page.url().split('/').pop();
  await btn('Calculate').click();
  await toast('Payroll calculated');
  const run = (await must(api.from('v_payroll_runs').select('run_no, status, totals, blocking_count, start_date, end_date, payday').eq('id', ctx.runId)))[0];
  assert.equal(run.start_date, '2026-11-09');
  assert.equal(run.blocking_count, 0, 'no blocking exceptions');
  ctx.runNo = run.run_no;
});

await step('Payroll numbers match the PDF: 5 days + Sunday + 2h OT + 1h rest-day OT at ₱600 → gross 4,094.25, net 3,994.25', async () => {
  const r = (await must(api.from('payroll_results').select('id, gross_pay, total_deductions, net_pay').eq('run_id', ctx.runId).eq('employee_id', ctx.empId)))[0];
  const lines = await must(api.from('payroll_lines').select('code, amount, category').eq('result_id', r.id));
  const amt = (code) => Number(lines.find((l) => l.code === code)?.amount ?? NaN);
  assert.equal(amt('WAGE_NORMAL'), 3000);
  assert.equal(amt('WAGE_REST'), 780);
  assert.equal(amt('OT_NORMAL'), 187.5);
  assert.equal(amt('OT_REST'), 126.75);
  assert.equal(amt('SSS_EE'), 100);
  assert.equal(Number(r.gross_pay), 4094.25);
  assert.equal(Number(r.total_deductions), 100);
  assert.equal(Number(r.net_pay), 3994.25);
  const text = await page.locator('main').innerText();
  assert.ok(text.includes('4,094.25') && text.includes('3,994.25'), 'totals shown on the page');
  await page.locator('tbody tr', { hasText: NAME }).first().click(); await settle();
  assert.match(await page.locator('main').innerText(), /Normal wages/);
  await shot('06-payroll-calculated');
});

await step('Website: submit for review → finalize → payslip issued', async () => {
  await btn('Submit for review').click();
  await toast('Submitted for review');
  await btn('Finalize').click();
  await btn('Finalize payroll', modal()).click();
  await toast('Finalized');
  const slip = (await must(api.from('payslips').select('id, payslip_no, status').eq('run_id', ctx.runId).eq('employee_id', ctx.empId)))[0];
  assert.equal(slip.status, 'issued');
  ctx.slip = slip;
});

await step('Website: record the payment → run becomes Paid', async () => {
  await btn('Record payment').click();
  await field('Reference').fill('E2E test envelope');
  await modal().getByRole('button', { name: /Record 1 payment/ }).click();
  await toast('1 payment(s) recorded');
  const run = (await must(api.from('payroll_runs').select('status').eq('id', ctx.runId)))[0];
  assert.equal(run.status, 'paid');
});

await step('Website: printable payslip shows the employee, lines and net pay', async () => {
  await go(`/payslips?run=${ctx.runId}`);
  assert.match(await page.locator('main').innerText(), new RegExp(ctx.slip.payslip_no));
  await go(`/payslips/${ctx.slip.id}`);
  const text = await page.locator('body').innerText();
  for (const needle of [NAME, ctx.slip.payslip_no, '3,994.25', '4,094.25', 'SSS']) assert.ok(text.includes(needle), `payslip shows ${needle}`);
  await shot('07-payslip');
});

await step('Website: the four report CSV downloads work', async () => {
  await go('/reports');
  const card = (title) => page.locator('section').filter({ hasText: title }).first();
  const grab = async (title, prepare) => {
    const c = card(title);
    if (prepare) { await prepare(c); await settle(); }
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), btn('Download CSV', c).click()]);
    const text = fs.readFileSync(await dl.path(), 'utf8');
    return text.trim().split(/\r?\n/);
  };
  const reg = await grab('Payroll register', async (c) => {
    const sel = c.locator('select').first();
    const opt = await sel.locator('option').evaluateAll((os, no) => os.find((o) => o.textContent.includes(`#${no}`))?.value, ctx.runNo);
    assert.ok(opt, 'run is selectable');
    await sel.selectOption(opt);
  });
  assert.ok(reg.length >= 2 && reg.join('\n').includes(ctx.code), 'register has the employee');
  const contrib = await grab('Government contributions by month');
  assert.ok(contrib.join('\n').includes(ctx.code), 'contribution report has the employee');
  const att = await grab('Attendance sessions', async (c) => {
    await c.locator('input[type=date]').nth(0).fill('2026-11-09');
    await c.locator('input[type=date]').nth(1).fill('2026-11-15');
  });
  assert.ok(att.filter((l) => l.includes(ctx.code)).length === 6, 'attendance export has the 6 sessions');
  const pay = await grab('Recorded payments');
  assert.ok(pay.join('\n').includes('E2E test envelope'), 'payments export has the payment');
});

await step('Website: audit log recorded these changes with the admin as the actor', async () => {
  await go('/audit');
  assert.ok((await page.locator('tbody tr').count()) > 5);
  const n = await must(api.from('audit_events').select('id', { count: 'exact', head: false }).eq('entity', 'payroll_runs').eq('entity_id', ctx.runId));
  assert.ok(n.length >= 3, 'run lifecycle audited');
});

// ---- 7. clean up through the website (these are features too) ----------------------------
await step('Clean-up: void the test payroll run (payslip kept but marked void)', async () => {
  await go(`/payroll/${ctx.runId}`);
  await btn('Void').click();
  await modal().locator('textarea').fill('E2E test run — clean-up');
  await btn('Void run', modal()).click();
  await toast('Payroll run voided');
  assert.equal((await must(api.from('payslips').select('status').eq('id', ctx.slip.id)))[0].status, 'void');
});

await step('Clean-up: deactivate the test employee', async () => {
  await go(`/employees/${ctx.empId}`);
  await page.locator('label').filter({ hasText: /^Active$/ }).locator('input').uncheck();
  await btn('Save changes').click();
  await toast('Saved');
  assert.equal((await must(api.from('employees').select('is_active').eq('id', ctx.empId)))[0].is_active, false);
});

await step('Clean-up: disable the test site\'s app sign-in and deactivate the site', async () => {
  await go('/sites');
  await page.locator('tbody tr', { hasText: SITE }).first().click(); await settle();
  await btn('Disable sign-in').click();
  await btn('Disable', modal()).click();
  await toast('Sign-in disabled');
  await page.locator('tbody tr', { hasText: SITE }).first().getByRole('button', { name: 'Edit' }).click();
  await modal().locator('label').filter({ hasText: /^Active$/ }).locator('input').uncheck();
  await btn('Save', modal()).click();
  await toast('Site saved');
  const off = await rpc('site_login', { p_username: SITE, p_password: SITE_PW, p_device_label: 'E2E', p_platform: 'android', p_app_version: '1.0.0' });
  assert.equal(off.code, 'ACCOUNT_DISABLED');
});

await browser.close();

// ---- safety net: make sure nothing test-related stays active, whatever happened above ----
const leftovers = [];
try {
  if (ctx.runId) {
    const run = (await must(api.from('payroll_runs').select('status').eq('id', ctx.runId)))[0];
    if (run && ['draft', 'ready_for_review'].includes(run.status)) { await must(api.rpc('payroll_delete_draft', { p_run_id: ctx.runId })); leftovers.push('deleted draft run'); }
    else if (run && ['finalized', 'paid'].includes(run.status)) { await must(api.rpc('payroll_void', { p_run_id: ctx.runId, p_reason: 'E2E test run — clean-up' })); leftovers.push('voided run'); }
  }
  if (ctx.empId) {
    const open = await must(api.from('work_sessions').select('id').eq('employee_id', ctx.empId).eq('status', 'open'));
    for (const s of open) { await must(api.rpc('attendance_void_session', { p_session_id: s.id, p_reason: 'E2E test clean-up' })); leftovers.push('voided open session'); }
    const e = (await must(api.from('employees').select('is_active').eq('id', ctx.empId)))[0];
    if (e?.is_active) { await must(api.from('employees').update({ is_active: false }).eq('id', ctx.empId)); leftovers.push('deactivated employee'); }
  }
  if (ctx.site) {
    const acct = (await must(api.from('site_accounts').select('is_active').eq('site_id', ctx.site.id)))[0];
    if (acct?.is_active) { await must(api.rpc('admin_set_site_account_active', { p_site_id: ctx.site.id, p_active: false })); leftovers.push('disabled site sign-in'); }
    const s = (await must(api.from('sites').select('is_active').eq('id', ctx.site.id)))[0];
    if (s?.is_active) { await must(api.from('sites').update({ is_active: false }).eq('id', ctx.site.id)); leftovers.push('deactivated site'); }
  }
} catch (e) {
  console.log(`! clean-up safety net error: ${e.message}`);
}
if (leftovers.length) console.log(`(safety net: ${leftovers.join(', ')})`);

const ok = results.filter((r) => r[0] === 'ok').length;
console.log(`\n${ok}/${results.length} steps passed${pageErrors.length ? `; page errors: ${pageErrors.join(' | ')}` : ''}`);
console.log(`test records: site "${SITE}" (${ctx.site?.code ?? '-'}), employee ${NAME} (${ctx.code ?? '-'}), payroll run #${ctx.runNo ?? '-'}`);
for (const r of results.filter((x) => x[0] !== 'ok')) console.log(`- ${r[0]}: ${r[1]}${r[2] ? ` — ${r[2]}` : ''}`);
process.exit(ok === results.length && !pageErrors.length ? 0 : 1);
