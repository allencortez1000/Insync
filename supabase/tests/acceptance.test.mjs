// Acceptance tests for the Insync Supabase schema, run on PGlite (Postgres in WASM).
// A small shim stands in for Supabase's auth schema and API roles.
//   cd supabase/tests && npm install && npm test
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'migrations');

const SHIM = `
  create schema if not exists extensions;
  create schema if not exists auth;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, extensions to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

// e2e/run-pg17.mjs injects a real Postgres 17 connection (already shimmed like Supabase).
const injected = globalThis.__INSYNC_DB__;
const db = injected ?? await PGlite.create({ extensions: { pgcrypto, btree_gist } });
if (!injected) await db.exec(SHIM);
for (const f of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
  try {
    await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  } catch (e) {
    console.error(`Migration ${f} failed: ${e.message}`);
    process.exit(1);
  }
}
console.log('✓ migrations applied');
// The PRD acceptance fixtures below exercise the DOLE/statutory engine; the construction
// engine (now the default) is tested at the end with the PDF's worked example.
await db.exec(`update public.payroll_settings set calc_mode = 'statutory', ot_review_required = true`);

// ---------------------------------------------------------------------------
async function run(role, uid, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    if (role) await tx.exec(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
}
const su = (sql, p) => run(null, null, sql, p);
const anon = (sql, p) => run('anon', null, sql, p);
const as = (uid) => (sql, p) => run('authenticated', uid, sql, p);
const one = async (rowsP) => (await rowsP)[0];
const val = async (rowsP) => Object.values((await rowsP)[0])[0];
async function rejects(promise, pattern, label) {
  try {
    await promise;
  } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`${label}: unexpected error "${e.message}"`);
    return;
  }
  throw new Error(`${label}: expected an error`);
}
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
const num = (v) => Number(v);

// ---------------------------------------------------------------------------
// Setup: users, sites, employees
// ---------------------------------------------------------------------------
const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const STAFF = '00000000-0000-0000-0000-0000000000b1';
await su(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'owner@example.com', '{"full_name":"Owner"}'),
          ($2, 'staff@example.com', '{"full_name":"Site A Staff"}')`, [ADMIN, STAFF]);
await su(`select public.bootstrap_admin('owner@example.com')`);
const admin = as(ADMIN);
const staff = as(STAFF);

const siteId = {};
for (const code of ['SITE-A', 'SITE-B', 'SITE-P', 'SITE-Q']) {
  siteId[code] = await val(admin(`insert into sites (code, name, region) values ($1, $2, 'NCR') returning id`, [code, `Site ${code.slice(5)}`]));
}
await admin(`select admin_set_site_password($1, 'site-a-password')`, [siteId['SITE-A']]);
await admin(`select admin_set_site_password($1, 'site-b-password')`, [siteId['SITE-B']]);
await admin(`select admin_set_user_access($1, 'staff', true, false, array[$2]::uuid[])`, [STAFF, siteId['SITE-A']]);

const schedPaidLunch = await val(admin(`select id from schedules where name like 'Day 08:00-16:00%'`));
async function makeEmployee(code, first, last, site, rate = 800, extra = {}) {
  const id = await val(admin(
    `insert into employees (employee_code, first_name, last_name, hire_date, is_minimum_wage_earner)
     values ($1, $2, $3, '2025-01-01', $4) returning id`, [code, first, last, extra.mwe ?? false]));
  await admin(`insert into employee_rates (employee_id, daily_rate, effective_from) values ($1, $2, '2025-01-01')`, [id, rate]);
  await admin(`insert into employee_schedules (employee_id, schedule_id, effective_from) values ($1, $2, '2025-01-01')`, [id, schedPaidLunch]);
  await admin(`select employee_assign_site($1, $2, '2025-12-01T00:00:00+08:00', 'initial')`, [id, siteId[site]]);
  return id;
}
const E1 = await makeEmployee('A-001', 'Juan', 'Dela Cruz', 'SITE-A');
const E2 = await makeEmployee('A-002', 'Maria', 'Santos', 'SITE-A');
const E3 = await makeEmployee('B-001', 'Jose', 'Reyes', 'SITE-B');
await admin(`select set_employee_pin($1, '482913')`, [E1]);
await admin(`select set_employee_pin($1, '730194')`, [E2]);
await admin(`select set_employee_pin($1, '590317')`, [E3]);
console.log('✓ setup complete');

// ---------------------------------------------------------------------------
// Attendance device API
// ---------------------------------------------------------------------------
let token;
await test('site login by site name (any case) or code; bad password rejected; names unique', async () => {
  const auto = await one(admin(`insert into sites (name) values ('Parañaque Main Office') returning code`));
  assert.equal(auto.code, 'PARANAQUE-MAIN-O');
  const auto2 = await one(admin(`insert into sites (name) values ('Parañaque Main Office 2') returning code`));
  assert.equal(auto2.code, 'PARANAQUE-MAIN-O-2');
  await rejects(admin(`insert into sites (name) values ('  site a ')`), /sites_name_unique_idx/, 'duplicate site name');
  const kept = await val(admin(`update sites set code = 'HACKED', region = 'NCR' where code = 'PARANAQUE-MAIN-O-2' returning code`));
  assert.equal(kept, 'PARANAQUE-MAIN-O-2', 'code cannot be edited');
  const e1 = await one(admin(`insert into employees (first_name, last_name) values ('Auto', 'One') returning id, employee_code`));
  const e2 = await one(admin(`insert into employees (first_name, last_name) values ('Auto', 'Two') returning employee_code`));
  assert.match(e1.employee_code, /^EMP-\d{4}$/);
  assert.notEqual(e1.employee_code, e2.employee_code);
  const ek = await val(admin(`update employees set employee_code = 'X-1', notes = 'n' where id = $1 returning employee_code`, [e1.id]));
  assert.equal(ek, e1.employee_code, 'employee code cannot be edited');
  const bad = await val(anon(`select site_login('Site A', 'nope')`));
  assert.equal(bad.code, 'INVALID_LOGIN');
  const ok = await val(anon(`select site_login('  site a ', 'site-a-password', 'Tablet 1', 'android')`));
  assert.equal(ok.ok, true);
  assert.equal(ok.site.code, 'SITE-A');
  token = ok.token;
});

await test('AC-01 roster returns only Site A active employees; anon cannot read tables', async () => {
  const r = await val(anon(`select site_roster($1)`, [token]));
  const codes = r.employees.map((e) => e.code).sort();
  assert.deepEqual(codes, ['A-001', 'A-002']);
  assert.ok(!('daily_rate' in r.employees[0]));
  await rejects(anon(`select * from employees`), /permission denied/, 'anon select employees');
  await rejects(anon(`select payroll_calculate(gen_random_uuid())`), /permission denied/, 'anon payroll');
  const other = await val(anon(`select site_verify_pin($1, $2, '590317')`, [token, E3]));
  assert.equal(other.code, 'NOT_ON_ROSTER');
});

await test('AC-03 wrong PIN saves nothing; five failures lock the PIN; staff unlock works', async () => {
  const r = await val(anon(`select site_verify_pin($1, $2, '000001')`, [token, E2]));
  assert.equal(r.code, 'PIN_INVALID');
  assert.equal(r.attempts_remaining, 4);
  for (let i = 0; i < 3; i++) await anon(`select site_verify_pin($1, $2, '000001')`, [token, E2]);
  const locked = await val(anon(`select site_verify_pin($1, $2, '000001')`, [token, E2]));
  assert.equal(locked.code, 'PIN_LOCKED');
  const stillLocked = await val(anon(`select site_verify_pin($1, $2, '730194')`, [token, E2]));
  assert.equal(stillLocked.code, 'PIN_LOCKED');
  assert.equal(num(await val(su(`select count(*) from attendance_events`))), 0);
  assert.equal(num(await val(su(`select count(*) from security_events where kind = 'pin_lockout'`))), 1);
  await staff(`select unlock_employee_pin($1)`, [E2]);
  const ok = await val(anon(`select site_verify_pin($1, $2, '730194')`, [token, E2]));
  assert.equal(ok.ok, true);
});

let req1;
await test('AC-04 correct PIN → one Clock In with server time and location; replay is idempotent', async () => {
  const v = await val(anon(`select site_verify_pin($1, $2, '482913')`, [token, E1]));
  assert.equal(v.next_action, 'clock_in');
  req1 = await val(su(`select gen_random_uuid()`));
  const loc = { status: 'captured', latitude: 14.5995, longitude: 120.9842, accuracy_m: 12.5, age_ms: 1500 };
  const p = await val(anon(`select site_punch($1, $2, 'clock_in', $3, $4::jsonb)`, [token, v.auth_token, req1, JSON.stringify(loc)]));
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.action, 'clock_in');
  assert.equal(p.location_status, 'captured');
  const replay = await val(anon(`select site_punch($1, $2, 'clock_in', $3, $4::jsonb)`, [token, v.auth_token, req1, JSON.stringify(loc)]));
  assert.equal(replay.replayed, true);
  assert.equal(replay.event_id, p.event_id);
  const chk = await val(anon(`select site_check_request($1, $2)`, [token, req1]));
  assert.equal(chk.event_id, p.event_id);
  assert.equal(num(await val(su(`select count(*) from attendance_events`))), 1);
  // single-use authorization
  const reuse = await val(anon(`select site_punch($1, $2, 'clock_out', gen_random_uuid())`, [token, v.auth_token]));
  assert.equal(reuse.code, 'PIN_EXPIRED');
});

await test('AC-05 second device cannot open a second session; next action is Clock Out', async () => {
  const t2 = (await val(anon(`select site_login('Site A', 'site-a-password', 'Phone 2')`))).token;
  const v = await val(anon(`select site_verify_pin($1, $2, '482913')`, [t2, E1]));
  assert.equal(v.next_action, 'clock_out');
  const dup = await val(anon(`select site_punch($1, $2, 'clock_in', gen_random_uuid())`, [t2, v.auth_token]));
  assert.equal(dup.code, 'ALREADY_CLOCKED_IN');
  assert.equal(num(await val(su(`select count(*) from work_sessions where employee_id = $1 and status = 'open'`, [E1]))), 1);
  await rejects(su(`insert into work_sessions (employee_id, site_id, clock_in_at) values ($1, $2, now())`, [E1, siteId['SITE-A']]),
    /duplicate key|conflicting key|exclusion/, 'db-level one open session');
});

await test('AC-06 permission denied → saved with exception, no fabricated coordinates; stale fix flagged', async () => {
  const v = await val(anon(`select site_verify_pin($1, $2, '482913')`, [token, E1]));
  const p = await val(anon(`select site_punch($1, $2, 'clock_out', gen_random_uuid(), '{"status":"permission_denied"}')`, [token, v.auth_token]));
  assert.equal(p.ok, true);
  assert.equal(p.location_status, 'permission_denied');
  const ev = await one(su(`select latitude, longitude from attendance_events where id = $1`, [p.event_id]));
  assert.equal(ev.latitude, null);
  const flags = await val(su(`select review_flags from work_sessions where id = $1`, [p.work_session_id]));
  assert.deepEqual(flags, ['location_exception']);
  const n = await val(anon(`select site_verify_pin($1, $2, '730194')`, [token, E2]));
  const stale = await val(anon(`select site_punch($1, $2, 'clock_in', gen_random_uuid(), '{"status":"captured","latitude":14.6,"longitude":121.0,"age_ms":900000}')`, [token, n.auth_token]));
  assert.equal(stale.location_status, 'stale');
  const none = await val(anon(`select site_verify_pin($1, $2, '482913')`, [token, E1]));
  const notIn = await val(anon(`select site_punch($1, $2, 'clock_out', gen_random_uuid())`, [token, none.auth_token]));
  assert.equal(notIn.code, 'NOT_CLOCKED_IN');
});

await test('FR-02 PIN reset invalidates pending authorization', async () => {
  const v = await val(anon(`select site_verify_pin($1, $2, '482913')`, [token, E1]));
  await staff(`select set_employee_pin($1, '615283')`, [E1]);
  const p = await val(anon(`select site_punch($1, $2, 'clock_in', gen_random_uuid())`, [token, v.auth_token]));
  assert.equal(p.code, 'PIN_EXPIRED');
  await rejects(staff(`select set_employee_pin($1, '111111')`, [E1]), /too easy/, 'weak pin');
});

await test('AC-02 transfer with open session requires permission; roster follows assignment', async () => {
  // E2 is clocked in at Site A (stale test above).
  await rejects(admin(`select employee_assign_site($1, $2, now(), 'transfer')`, [E2, siteId['SITE-B']]), /open session/, 'transfer blocked');
  await admin(`select employee_assign_site($1, $2, now(), 'transfer', true)`, [E2, siteId['SITE-B']]);
  const ra = await val(anon(`select site_roster($1)`, [token]));
  assert.ok(ra.employees.some((e) => e.code === 'A-002'), 'origin site keeps employee to close the session');
  const v = await val(anon(`select site_verify_pin($1, $2, '730194')`, [token, E2]));
  assert.equal(v.next_action, 'clock_out');
  const p = await val(anon(`select site_punch($1, $2, 'clock_out', gen_random_uuid())`, [token, v.auth_token]));
  assert.equal(p.ok, true);
  const rb = await val(anon(`select site_roster($1)`, [token]));
  assert.ok(!rb.employees.some((e) => e.code === 'A-002'));
  const tb = (await val(anon(`select site_login('SITE-B', 'site-b-password')`))).token;
  const rbb = await val(anon(`select site_roster($1)`, [tb]));
  assert.deepEqual(rbb.employees.map((e) => e.code).sort(), ['A-002', 'B-001']);
});

await test('AC-20 RLS: scoped staff, secrets hidden, audit admin-only, site logout revokes', async () => {
  const seen = (await staff(`select employee_code from employees order by 1`)).map((r) => r.employee_code);
  assert.ok(seen.includes('A-001') && !seen.includes('B-001'), `staff sees ${seen}`);
  await rejects(staff(`select pin_hash from pin_credentials`), /permission denied/, 'pin hash');
  await rejects(staff(`select password_hash from site_accounts`), /permission denied/, 'site password hash');
  assert.equal((await staff(`select * from audit_events`)).length, 0);
  assert.ok((await admin(`select * from audit_events`)).length > 0);
  await rejects(staff(`insert into sites (code, name) values ('SITE-X', 'X')`), /row-level security/, 'staff create site');
  await rejects(staff(`insert into attendance_events (request_id) values (gen_random_uuid())`), /permission denied/, 'forge event');
  await anon(`select site_logout($1)`, [token]);
  const r = await val(anon(`select site_roster($1)`, [token]));
  assert.equal(r.code, 'SESSION_INVALID');
});

// ---------------------------------------------------------------------------
// Payroll fixtures (site P, week Mon 2026-01-12 .. Sun 2026-01-18, payday Fri 2026-01-23)
// ---------------------------------------------------------------------------
const P = 'SITE-P';
const F = {};
for (const [k, code, first] of [
  ['f1', 'P-001', 'Ana'], ['f2', 'P-002', 'Ben'], ['f3', 'P-003', 'Carla'], ['f4', 'P-004', 'Dan'],
  ['f8', 'P-008', 'Hana'], ['f11', 'P-011', 'Kiko']]) {
  F[k] = await makeEmployee(code, first, 'Fixture', P);
}
const t = (d, hm) => `2026-${d}T${hm}:00+08:00`;
async function session(emp, site, d1, h1, d2, h2) {
  return val(admin(`select attendance_create_session($1, $2, $3, $4, 'fixture')`, [emp, siteId[site], t(d1, h1), d2 ? t(d2, h2) : null]));
}
await session(F.f1, P, '01-12', '08:00', '01-12', '16:00');            // AC-09
await session(F.f2, P, '01-12', '08:00', '01-12', '15:00');            // AC-10
await session(F.f3, P, '01-12', '08:00', '01-12', '18:00');            // AC-11
for (const d of ['12', '13', '14', '15']) await session(F.f4, P, `01-${d}`, '08:00', `01-${d}`, '16:00');
await session(F.f4, P, '01-16', '08:00', '01-16', '18:00');            // AC-13
const openSess = await session(F.f11, P, '01-14', '08:00', null, null); // AC-08
const sil = await val(admin(`select id from leave_types where code = 'SIL'`));
await admin(`insert into leave_ledger (employee_id, leave_type_id, days, kind, note, created_by) values ($1, $2, 5, 'grant', '2026 SIL', $3)`, [F.f8, sil, ADMIN]);
const leaveId = await val(admin(`insert into leave_entries (employee_id, leave_type_id, leave_date, hours, created_by) values ($1, $2, '2026-01-13', 8, $3) returning id`, [F.f8, sil, ADMIN]));
await admin(`select leave_decide($1, true, 'ok')`, [leaveId]);

const periodJan12 = await val(admin(`select payroll_ensure_period('2026-01-14')`));
const runP = await val(admin(`select payroll_create_run($1, array[$2]::uuid[])`, [periodJan12, siteId[P]]));
const lines = (run, emp) => admin(`select code, category, quantity, amount, work_date from payroll_lines where run_id = $1 and employee_id = $2 order by id`, [run, emp]);
const sumEarn = async (run, emp, prefix = '') =>
  (await lines(run, emp)).filter((l) => l.category === 'earning' && l.code.startsWith(prefix)).reduce((s, l) => s + num(l.amount), 0);
const exc = (run, emp) => admin(`select code, blocking from payroll_exceptions where run_id = $1 and ($2::uuid is null or employee_id = $2) order by id`, [run, emp ?? null]);

await test('period alignment: Monday–Sunday with Friday payday', async () => {
  const p = await one(admin(`select start_date::text, end_date::text, payday::text from payroll_periods where id = $1`, [periodJan12]));
  assert.deepEqual(p, { start_date: '2026-01-12', end_date: '2026-01-18', payday: '2026-01-23' });
});

await admin(`select payroll_calculate($1)`, [runP]);

await test('draft statutory rules block finalization (approve-before-use gate)', async () => {
  const codes = (await exc(runP)).map((e) => e.code);
  assert.ok(codes.includes('RULE_NOT_APPROVED'));
});

await test('AC-08 missing clock-out is flagged and blocks; no automatic 8-hour pay', async () => {
  const e = await exc(runP, F.f11);
  assert.ok(e.some((x) => x.code === 'MISSING_CLOCK_OUT' && x.blocking));
  assert.equal(await sumEarn(runP, F.f11), 0);
});

await test('AC-09 PHP 800/day, 8 payable hours → PHP 800 regular', async () => {
  assert.equal(await sumEarn(runP, F.f1, 'WORK_'), 800);
});

await test('AC-10 7 hours → PHP 700, undertime informational only', async () => {
  const l = await lines(runP, F.f2);
  assert.equal(await sumEarn(runP, F.f2, 'WORK_'), 700);
  const ut = l.find((x) => x.code === 'UNDERTIME');
  assert.equal(num(ut.quantity), 60);
  assert.equal(num(ut.amount), 0);
  assert.ok(!l.some((x) => x.category === 'deduction' && /UNDER/.test(x.code)));
});

await test('AC-11 8h + 2h OT → 800 + 250 once OT is accepted (pending OT blocks)', async () => {
  assert.ok((await exc(runP, F.f3)).some((x) => x.code === 'OT_PENDING' && x.blocking));
  await staff(`select 1`); // staff is site A only; admin decides
  await admin(`select ot_decide($1, '2026-01-12', 'accepted', 120, null)`, [F.f3]);
  await admin(`select payroll_calculate($1)`, [runP]);
  assert.equal(await sumEarn(runP, F.f3, 'WORK_'), 800);
  assert.equal(await sumEarn(runP, F.f3, 'OT_'), 250);
});

await test('AC-13 five 8h days + 2h OT → 4,000 + 250 = 4,250', async () => {
  await admin(`select ot_decide($1, '2026-01-16', 'accepted', 120, null)`, [F.f4]);
  await admin(`select payroll_calculate($1)`, [runP]);
  assert.equal(await sumEarn(runP, F.f4, 'WORK_'), 4000);
  assert.equal(await sumEarn(runP, F.f4, 'OT_'), 250);
  assert.equal(await sumEarn(runP, F.f4), 4250);
});

await test('AC-14 paid leave without punches → leave pay, balance reduced, no absence for that day', async () => {
  const l = await lines(runP, F.f8);
  assert.equal(await sumEarn(runP, F.f8, 'LEAVE_PAID'), 800);
  assert.ok(!l.some((x) => x.code === 'ABSENT' && x.work_date && x.work_date.toISOString?.().startsWith('2026-01-13')));
  const bal = await val(admin(`select balance_days from v_leave_balances where employee_id = $1`, [F.f8]));
  assert.equal(num(bal), 4);
});

let payslipNo;
await test('finalize after resolving exceptions and approving rules; payslips snapshot; staff scoped out', async () => {
  for (const r of await admin(`select id from statutory_rule_versions where status = 'draft'`)) {
    await admin(`select rule_approve($1)`, [r.id]);
  }
  await admin(`select attendance_edit_session($1, $2, $3, 'forgot to clock out — confirmed with supervisor')`,
    [openSess, t('01-14', '08:00'), t('01-14', '16:00')]);
  await admin(`select payroll_calculate($1)`, [runP]);
  const blocking = (await exc(runP)).filter((e) => e.blocking);
  assert.equal(blocking.length, 0, JSON.stringify(blocking));
  await rejects(staff(`select payroll_calculate($1)`, [runP]), /not accessible/, 'staff outside scope');
  await admin(`select payroll_submit($1)`, [runP]);
  const net = (await one(admin(`select totals from payroll_runs where id = $1`, [runP]))).totals.net;
  const wrong = await val(admin(`select payroll_finalize($1, $2)`, [runP, num(net) + 1]));
  assert.equal(wrong.code, 'CHANGED');
  await admin(`select payroll_submit($1)`, [runP]);
  const fin = await val(admin(`select payroll_finalize($1, $2)`, [runP, net]));
  assert.equal(fin.ok, true, JSON.stringify(fin));
  payslipNo = await val(admin(`select payslip_no from payslips where run_id = $1 and employee_id = $2`, [runP, F.f1]));
  assert.match(payslipNo, /^PS-2026-\d{6}$/);
  await rejects(su(`update payroll_lines set amount = 0 where run_id = '${runP}'`), /immutable/, 'immutable finalized lines');
});

await test('AC-18 correction after finalization → original payslip preserved; impact listed; void/reissue', async () => {
  const sess = await val(admin(`select id from work_sessions where employee_id = $1`, [F.f1]));
  await admin(`select attendance_edit_session($1, $2, $3, 'supervisor reported early leave')`, [sess, t('01-12', '08:00'), t('01-12', '12:00')]);
  const impacts = await admin(`select * from v_payroll_impacts where employee_id = $1`, [F.f1]);
  assert.equal(impacts.length, 1);
  await rejects(admin(`insert into employee_rates (employee_id, daily_rate, effective_from) values ($1, 900, '2026-01-15')`, [F.f1]),
    /finalized through/, 'rate change in finalized period');
  await admin(`select payroll_void($1, 'attendance correction after finalization')`, [runP]);
  const ps = await one(admin(`select status, snapshot from payslips where payslip_no = $1`, [payslipNo]));
  assert.equal(ps.status, 'void');
  assert.ok(ps.snapshot.lines.some((l) => l.code === 'WORK_ORDINARY' && num(l.amount) === 800));
  const re = await val(admin(`select payroll_reissue($1)`, [runP]));
  await admin(`select payroll_calculate($1)`, [re]);
  assert.equal(await sumEarn(re, F.f1, 'WORK_'), 400);
  await admin(`select payroll_submit($1)`, [re]);
  const net = (await one(admin(`select totals from payroll_runs where id = $1`, [re]))).totals.net;
  assert.equal((await val(admin(`select payroll_finalize($1, $2)`, [re, net]))).ok, true);
});

// ---------------------------------------------------------------------------
// Holidays and midnight crossing (week Mon 2026-04-06 .. Sun 04-12; Apr 9 regular holiday)
// ---------------------------------------------------------------------------
for (const [k, code, first] of [['f5', 'P-005', 'Ela'], ['f6', 'P-006', 'Fe'], ['f7', 'P-007', 'Gino'], ['f9', 'P-009', 'Ivy']]) {
  F[k] = await makeEmployee(code, first, 'Fixture', P);
}
await session(F.f5, P, '04-09', '08:00', '04-09', '16:00');          // AC-12 worked holiday
await session(F.f6, P, '04-08', '08:00', '04-08', '16:00');          // unworked holiday, eligible
await session(F.f7, P, '04-07', '08:00', '04-07', '16:00');          // absent Apr 8 → not eligible
await session(F.f9, P, '04-08', '22:00', '04-09', '06:00');          // AC-19 crosses midnight into holiday
const periodApr = await val(admin(`select payroll_ensure_period('2026-04-09')`));
const runApr = await val(admin(`select payroll_create_run($1, array[$2]::uuid[])`, [periodApr, siteId[P]]));
await admin(`select payroll_calculate($1)`, [runApr]);

await test('AC-12 8 hours on a regular holiday → PHP 1,600 total (no extra 800)', async () => {
  assert.equal(await sumEarn(runApr, F.f5), 1600);
});

await test('eligible unworked regular holiday → 100% pay; absent preceding day → not paid', async () => {
  assert.equal(await sumEarn(runApr, F.f6, 'HOLIDAY_PAY'), 800);
  assert.equal(await sumEarn(runApr, F.f7, 'HOLIDAY_PAY'), 0);
  assert.ok((await lines(runApr, F.f7)).some((l) => l.code === 'HOLIDAY_NOT_ELIGIBLE'));
});

await test('AC-19 shift across midnight into a holiday: minutes split by date, none lost or duplicated', async () => {
  const l = await lines(runApr, F.f9);
  const work = l.filter((x) => x.code.startsWith('WORK_'));
  assert.equal(work.reduce((s, x) => s + num(x.quantity), 0), 480);
  const ord = work.find((x) => x.code === 'WORK_ORDINARY');
  const hol = work.find((x) => x.code === 'WORK_REGULAR_HOLIDAY');
  assert.equal(num(ord.quantity), 120);
  assert.equal(num(hol.quantity), 360);
  assert.equal(num(ord.amount) + num(hol.amount), 200 + 1200);
  assert.ok((await exc(runApr, F.f9)).some((e) => e.code === 'NIGHT_WORK' && e.blocking), 'night work flagged');
  await admin(`update payroll_settings set night_diff_mode = 'pay'`);
  await admin(`select payroll_calculate($1)`, [runApr]);
  assert.equal(await sumEarn(runApr, F.f9, 'NIGHT_DIFF'), 140);
  await admin(`update payroll_settings set night_diff_mode = 'flag'`);
});

// ---------------------------------------------------------------------------
// Monthly reconciliation with five weekly paydays (January 2026: Fridays 2, 9, 16, 23, 30)
// plus cash advance posting, transfers and mid-week rate change.
// ---------------------------------------------------------------------------
const Q = 'SITE-Q';
const F10 = await makeEmployee('Q-010', 'Lito', 'Fixture', Q, 1000);
const F12 = await makeEmployee('Q-012', 'Mila', 'Fixture', P, 800);
await admin(`insert into employee_rates (employee_id, daily_rate, effective_from) values ($1, 1000, '2026-01-14')`, [F12]);
await admin(`select employee_assign_site($1, $2, '2026-01-14T00:00:00+08:00', 'transfer')`, [F12, siteId[Q]]);
for (const d of ['12', '13']) await session(F12, P, `01-${d}`, '08:00', `01-${d}`, '16:00');
for (const d of ['14', '15', '16']) await session(F12, Q, `01-${d}`, '08:00', `01-${d}`, '16:00');

const weekStarts = ['2025-12-22', '2025-12-29', '2026-01-05', '2026-01-12', '2026-01-19'];
const days = (start) => [0, 1, 2, 3, 4].map((i) => {
  const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10);
});
for (const ws of weekStarts) {
  for (const d of days(ws)) {
    if (d === '2026-01-01') continue; // regular holiday, not worked
    await val(admin(`select attendance_create_session($1, $2, $3, $4, 'fixture')`,
      [F10, siteId[Q], `${d}T08:00:00+08:00`, `${d}T16:00:00+08:00`]));
  }
}
const adv = await val(admin(`insert into cash_advances (employee_id, principal, released_on, installment_amount, first_deduction_date, authorized_by, created_by, reason)
  values ($1, 1000, '2025-12-20', 300, '2025-12-20', $2, $2, 'emergency') returning id`, [F10, ADMIN]));

const qRuns = [];
await test('AC-15/16/17 five paydays reconcile exactly; advance posts once per run; rate change + transfer consolidate', async () => {
  for (const ws of weekStarts) {
    const per = await val(admin(`select payroll_ensure_period($1)`, [ws]));
    const run = await val(admin(`select payroll_create_run($1, array[$2]::uuid[])`, [per, siteId[Q]]));
    qRuns.push(run);
    await admin(`select payroll_calculate($1)`, [run]);
    await admin(`select payroll_calculate($1)`, [run]); // recalculation must not duplicate anything
    const blocking = (await exc(run)).filter((e) => e.blocking);
    assert.equal(blocking.length, 0, `${ws}: ${JSON.stringify(blocking)}`);
    if (ws === '2026-01-12') {
      // AC-17: 2 days at 800 + 3 days at 1000, both sites, one result in one run
      assert.equal(await sumEarn(run, F12, 'WORK_'), 800 * 2 + 1000 * 3);
      const sites = new Set((await admin(`select site_id from payroll_lines where run_id = $1 and employee_id = $2 and code like 'WORK_%'`, [run, F12])).map((r) => r.site_id));
      assert.equal(sites.size, 2);
      assert.equal(num(await val(admin(`select count(*) from payroll_results where employee_id = $1`, [F12]))), 1);
    }
    await admin(`select payroll_submit($1)`, [run]);
    const net = (await one(admin(`select totals from payroll_runs where id = $1`, [run]))).totals.net;
    const fin = await val(admin(`select payroll_finalize($1, $2)`, [run, net]));
    assert.equal(fin.ok, true, `${ws}: ${JSON.stringify(fin)}`);
  }
  // AC-15: every agency's January collections equal the obligation on the actual monthly basis.
  for (const agency of ['sss', 'philhealth', 'pagibig']) {
    const rows = await admin(`select basis_amount, employee_amount, employer_amount, obligation_employee, kind
                              from contribution_ledger where employee_id = $1 and agency = $2 and contribution_month = '2026-01-01'
                              order by created_at`, [F10, agency]);
    assert.equal(rows.length, 5, `${agency} rows`);
    const basis = rows.reduce((s, r) => s + num(r.basis_amount), 0);
    const ee = rows.reduce((s, r) => s + num(r.employee_amount), 0);
    const rule = await one(admin(`select params from statutory_rule_versions where agency = $1 and status = 'approved'`, [agency]));
    const expected = await val(su(`select (public._contrib_compute($1, $2::jsonb, $3) ->> 'ee')::numeric`, [agency, JSON.stringify(rule.params), basis]));
    assert.equal(Math.round(ee * 100), Math.round(num(expected) * 100), `${agency}: collected ${ee} vs obligation ${expected} on basis ${basis}`);
    assert.equal(rows[4].kind, 'true_up');
  }
  // AC-16: 1000 advance at 300/run → 300, 300, 300, 100 posted once each; then completed.
  const repay = await admin(`select amount from advance_ledger where advance_id = $1 and kind = 'repayment' order by created_at`, [adv]);
  assert.deepEqual(repay.map((r) => num(r.amount)), [-300, -300, -300, -100]);
  const a = await one(admin(`select balance, status from v_advance_balances where id = $1`, [adv]));
  assert.equal(num(a.balance), 0);
  assert.equal(a.status, 'completed');
});

await test('payments: recording all payments moves the run to Paid', async () => {
  const run = qRuns[0];
  const n = await val(admin(`select payroll_record_payment($1, null, 'cash', 'Envelope batch 1')`, [run]));
  assert.ok(n >= 1);
  assert.equal(await val(admin(`select status from payroll_runs where id = $1`, [run])), 'paid');
  await rejects(staff(`select payroll_void($1, 'test void')`, [run]), /not accessible|admin/, 'staff void paid');
});

await test('withholding table and SSS MSC brackets', async () => {
  const bir = await one(admin(`select params from statutory_rule_versions where agency = 'bir_withholding' and status = 'approved'`));
  const w = async (x) => num(await val(su(`select public._withholding($1::jsonb, $2)`, [JSON.stringify(bir.params), x])));
  assert.equal(await w(4808), 0);
  assert.equal(await w(7692), 432.6);
  assert.equal(await w(10000), 432.6 + 0.2 * (10000 - 7692));
  const sss = await one(admin(`select params from statutory_rule_versions where agency = 'sss' and status = 'approved'`));
  const s = async (x) => (await val(su(`select public._contrib_compute('sss', $1::jsonb, $2)`, [JSON.stringify(sss.params), x])));
  assert.equal(num((await s(5249.99)).credit), 5000);
  assert.equal(num((await s(5250)).credit), 5500);
  assert.equal(num((await s(50000)).credit), 35000);
  assert.equal(num((await s(20000)).ee), 1000);
});

// ---------------------------------------------------------------------------
// Construction mode (Construction_Computations_Only.pdf)
// ---------------------------------------------------------------------------
await test('construction: PDF worked example ₱600 → gross 4,094.25, net 3,594.25', async () => {
  await admin(`update payroll_settings set calc_mode = 'construction', ot_review_required = false`);
  siteId['SITE-C'] = await val(admin(`insert into sites (name) values ('Construction C') returning id`));
  const C1 = await makeEmployee('C-001', 'Rico', 'Builder', 'SITE-C', 600);
  const C2 = await makeEmployee('C-002', 'Nena', 'Builder', 'SITE-C', 600);
  // Week Mon 2026-02-02 .. Sun 02-08. Mon 07:00-18:00 = 2 h OT; Tue-Fri 07:00-16:00; Sun 07:00-17:00 = rest day + 1 h OT.
  await session(C1, 'SITE-C', '02-02', '07:00', '02-02', '18:00');
  for (const d of ['03', '04', '05', '06']) await session(C1, 'SITE-C', `02-${d}`, '07:00', `02-${d}`, '16:00');
  await session(C1, 'SITE-C', '02-08', '07:00', '02-08', '17:00');
  await admin(`insert into employee_deduction_profiles (employee_id, sss_enabled, sss_amount, philhealth_enabled, philhealth_amount, pagibig_enabled, pagibig_amount)
               values ($1, true, 200, true, 150, true, 150)`, [C1]);
  // C2: 07:00-15:30 (gross 8.5 → lunch 1 → floor 7.5 = 7 h) and 07:00-14:45 (gross 7.75 → no lunch → 7 h).
  await session(C2, 'SITE-C', '02-02', '07:00', '02-02', '15:30');
  await session(C2, 'SITE-C', '02-03', '07:00', '02-03', '14:45');
  await admin(`insert into employee_deduction_profiles (employee_id, additional_enabled, additional_amount, additional_label) values ($1, true, 5000, 'Tools')`, [C2]);

  const per = await val(admin(`select payroll_ensure_period('2026-02-04')`));
  const run = await val(admin(`select payroll_create_run($1, array[$2]::uuid[])`, [per, siteId['SITE-C']]));
  await admin(`select payroll_calculate($1)`, [run]);
  const byCode = async (emp) => Object.fromEntries((await lines(run, emp)).filter((l) => l.category !== 'info')
    .map((l) => [l.code, num(l.amount)]));
  const c1 = await byCode(C1);
  assert.equal(c1.WAGE_NORMAL, 3000);
  assert.equal(c1.WAGE_REST, 780);
  assert.equal(c1.OT_NORMAL, 187.5);
  assert.equal(c1.OT_REST, 126.75);
  const r1 = await one(admin(`select gross_pay, total_deductions, net_pay from payroll_results where run_id = $1 and employee_id = $2`, [run, C1]));
  assert.equal(num(r1.gross_pay), 4094.25);
  assert.equal(num(r1.total_deductions), 500);
  assert.equal(num(r1.net_pay), 3594.25);
  // C2: 14 regular hours = 1.75 days × 600 = 1,050; 5,000 deduction capped at gross → net 0 with a warning.
  const r2 = await one(admin(`select gross_pay, total_deductions, net_pay, regular_minutes from payroll_results where run_id = $1 and employee_id = $2`, [run, C2]));
  assert.equal(num(r2.regular_minutes), 14 * 60);
  assert.equal(num(r2.gross_pay), 1050);
  assert.equal(num(r2.net_pay), 0);
  assert.equal(num(r2.total_deductions), 1050);
  assert.ok((await exc(run, C2)).some((e) => e.code === 'DEDUCTION_CAPPED' && !e.blocking));
  // Finalize: contribution ledger receives the fixed profile amounts.
  assert.equal((await exc(run)).filter((e) => e.blocking).length, 0);
  await admin(`select payroll_submit($1)`, [run]);
  const net = (await one(admin(`select totals from payroll_runs where id = $1`, [run]))).totals.net;
  assert.equal((await val(admin(`select payroll_finalize($1, $2)`, [run, net]))).ok, true);
  const sss = await val(admin(`select employee_amount from contribution_ledger where employee_id = $1 and agency = 'sss'`, [C1]));
  assert.equal(num(sss), 200);
});

await test('from the start (construction): new site → employee → PIN → app sign-in → Clock In/Out → payroll → payslip → paid', async () => {
  // 1. Admin creates the site with its app password (code is automatic) and an employee (code automatic).
  const site = await one(admin(`insert into sites (name, region) values ('Bataan Project', 'Region III') returning id, code`));
  assert.equal(site.code, 'BATAAN-PROJECT');
  await admin(`select admin_set_site_password($1, 'bataan-pass-2026')`, [site.id]);
  const emp = await one(admin(`insert into employees (first_name, last_name, hire_date) values ('Pedro', 'Mason', '2026-01-01') returning id, employee_code`));
  assert.match(emp.employee_code, /^EMP-\d{4}$/);
  await admin(`insert into employee_rates (employee_id, daily_rate, effective_from) values ($1, 800, '2026-01-01')`, [emp.id]);
  await admin(`select employee_assign_site($1, $2, '2026-01-01T00:00:00+08:00', 'initial')`, [emp.id, site.id]);
  const pin = await val(admin(`select generate_employee_pin($1)`, [emp.id]));
  assert.match(pin, /^\d{6}$/);
  await admin(`insert into employee_deduction_profiles (employee_id, sss_enabled, sss_amount) values ($1, true, 100)`, [emp.id]);

  // 2. The attendance app signs in with the site NAME, lists the roster, checks the PIN, clocks in.
  const login = await val(anon(`select site_login('bataan project', 'bataan-pass-2026', 'Test phone', 'android', '1.0.0')`));
  assert.equal(login.ok, true, JSON.stringify(login));
  const roster = await val(anon(`select site_roster($1)`, [login.token]));
  assert.deepEqual(roster.employees.map((e) => e.code), [emp.employee_code]);
  const v1 = await val(anon(`select site_verify_pin($1, $2, $3)`, [login.token, emp.id, pin]));
  assert.equal(v1.next_action, 'clock_in');
  const loc = JSON.stringify({ status: 'captured', latitude: 14.6760, longitude: 120.5360, accuracy_m: 8, age_ms: 900 });
  const pIn = await val(anon(`select site_punch($1, $2, 'clock_in', gen_random_uuid(), $3::jsonb, now())`, [login.token, v1.auth_token, loc]));
  assert.equal(pIn.ok, true, JSON.stringify(pIn));

  // 3. Ten hours pass (simulated by moving the clock-in back), then the employee clocks out.
  await su(`update work_sessions set clock_in_at = clock_in_at - interval '10 hours' where id = $1`, [pIn.work_session_id]);
  const v2 = await val(anon(`select site_verify_pin($1, $2, $3)`, [login.token, emp.id, pin]));
  assert.equal(v2.next_action, 'clock_out');
  const pOut = await val(anon(`select site_punch($1, $2, 'clock_out', gen_random_uuid(), $3::jsonb, now())`, [login.token, v2.auth_token, loc]));
  assert.equal(pOut.ok, true, JSON.stringify(pOut));

  // 4. Staff sees it in attendance review: closed, ~10 h, location captured, no flags.
  const w = await one(admin(`select status, elapsed_minutes, in_location_status, out_location_status, review_flags, work_date::text as work_date,
                                    extract(isodow from work_date)::int as dow from v_work_sessions where id = $1`, [pIn.work_session_id]));
  assert.equal(w.status, 'closed');
  assert.ok(w.elapsed_minutes >= 599 && w.elapsed_minutes <= 601, `elapsed ${w.elapsed_minutes}`);
  assert.equal(w.out_location_status, 'captured');
  assert.deepEqual(w.review_flags, []);

  // 5. Weekly payroll: 10 h gross − 1 h lunch = 9 h → 8 h regular + 1 h automatic OT.
  const per = await val(admin(`select payroll_ensure_period($1::date)`, [w.work_date]));
  const run = await val(admin(`select payroll_create_run($1, array[$2]::uuid[])`, [per, site.id]));
  const calc = await val(admin(`select payroll_calculate($1)`, [run]));
  assert.equal(num(calc.blocking), 0, JSON.stringify(await exc(run)));
  const sunday = w.dow === 7;
  const expectedGross = sunday ? 1040 + 169 : 800 + 125;
  const res = await one(admin(`select gross_pay, total_deductions, net_pay, ot_minutes_paid from payroll_results where run_id = $1 and employee_id = $2`, [run, emp.id]));
  assert.equal(num(res.gross_pay), expectedGross);
  assert.equal(num(res.ot_minutes_paid), 60);
  assert.equal(num(res.total_deductions), 100);
  assert.equal(num(res.net_pay), expectedGross - 100);

  // 6. Review → finalize → payslip → payment recorded → run is Paid.
  await admin(`select payroll_submit($1)`, [run]);
  const fin = await val(admin(`select payroll_finalize($1, $2)`, [run, expectedGross - 100]));
  assert.equal(fin.ok, true, JSON.stringify(fin));
  const slip = await one(admin(`select payslip_no, status, snapshot from payslips where run_id = $1 and employee_id = $2`, [run, emp.id]));
  assert.equal(slip.status, 'issued');
  assert.equal(num(slip.snapshot.totals.net_pay), expectedGross - 100);
  assert.ok(slip.snapshot.lines.some((l) => l.code === 'SSS_EE' && num(l.amount) === 100));
  await admin(`select payroll_record_payment($1, array[$2]::uuid[], 'cash', 'Envelope 1')`, [run, emp.id]);
  assert.equal(await val(admin(`select status from payroll_runs where id = $1`, [run])), 'paid');

  // 7. The site account still cannot see any of it; signing out revokes the device.
  await rejects(anon(`select * from payslips`), /permission denied/, 'anon payslips');
  await anon(`select site_logout($1)`, [login.token]);
  assert.equal((await val(anon(`select site_roster($1)`, [login.token]))).code, 'SESSION_INVALID');
  const audit = await val(admin(`select count(*) from audit_events where entity in ('sites', 'employees', 'payroll_runs', 'employee_deduction_profiles')`));
  assert.ok(num(audit) > 0);
});

// ---------------------------------------------------------------------------
// Employee accounts (self-service portal) and 13th month pay
// ---------------------------------------------------------------------------
await test('employee portal: account → sign in → attendance, leave request, payslip, 13th month; view-only and isolated', async () => {
  await su(`update payroll_settings set calc_mode = 'construction', ot_review_required = false`);
  const iso = (d) => d.toISOString().slice(0, 10);
  const ph = new Date(Date.now() + 8 * 3600 * 1000);                       // Manila wall clock as a UTC date
  const work = new Date(ph); work.setUTCDate(work.getUTCDate() - 2);
  if (work.getUTCDay() === 0) work.setUTCDate(work.getUTCDate() - 1);      // not a Sunday
  const leaveDay = new Date(ph); leaveDay.setUTCDate(leaveDay.getUTCDate() + 10);
  while (leaveDay.getUTCDay() !== 3) leaveDay.setUTCDate(leaveDay.getUTCDate() + 1);   // a Wednesday
  const workDate = iso(work), leaveDate = iso(leaveDay);

  const site = await one(admin(`insert into sites (name) values ('Portal Test Site') returning id`));
  const mk = async (first) => {
    const e = await one(admin(`insert into employees (first_name, last_name, hire_date) values ($1, 'Portal', '2025-01-01') returning id, employee_code`, [first]));
    await admin(`insert into employee_rates (employee_id, daily_rate, effective_from) values ($1, 800, '2025-01-01')`, [e.id]);
    await admin(`select employee_assign_site($1, $2, '2026-01-01T00:00:00+08:00', 'initial')`, [e.id, site.id]);
    return e;
  };
  const emp = await mk('Ana');
  const other = await mk('Ben');
  for (const e of [emp, other]) {
    await admin(`select attendance_create_session($1, $2, $3, $4, 'portal test')`,
      [e.id, site.id, `${workDate}T08:00:00+08:00`, `${workDate}T19:00:00+08:00`]);
  }
  const sil = await val(admin(`select id from leave_types where code = 'SIL'`));
  await admin(`insert into leave_ledger (employee_id, leave_type_id, days, kind, created_by) values ($1, $2, 5, 'grant', $3)`, [emp.id, sil, ADMIN]);

  // The account is the employee's name + attendance PIN: no PIN yet → no sign-in.
  const PIN_ANA = '482915', PIN_BEN = '739164', PIN_TWIN = '615243';
  assert.equal((await val(anon(`select emp_login('Ana Portal', $1)`, [PIN_ANA]))).code, 'INVALID_LOGIN');
  await admin(`select set_employee_pin($1, $2)`, [emp.id, PIN_ANA]);
  await admin(`select set_employee_pin($1, $2)`, [other.id, PIN_BEN]);
  assert.equal((await val(anon(`select emp_login('Ana Portal', '111112')`))).code, 'INVALID_LOGIN');
  assert.equal((await val(anon(`select emp_login('Nobody Here', $1)`, [PIN_ANA]))).code, 'INVALID_LOGIN');
  const login = await val(anon(`select emp_login('  ana   PORTAL ', $1, 'Test phone')`, [PIN_ANA]));
  assert.equal(login.ok, true, JSON.stringify(login));
  assert.equal(login.employee.id, emp.id);
  const tok = login.token;
  assert.equal((await val(anon(`select emp_login($1, $2)`, [emp.employee_code.toLowerCase(), PIN_ANA]))).ok, true, 'employee code also works');

  // Two employees with the same name: the PIN tells them apart, and the other one is not penalised.
  const twin = await mk('Ana');
  await admin(`select set_employee_pin($1, $2)`, [twin.id, PIN_TWIN]);
  assert.equal((await val(anon(`select emp_login('Ana Portal', $1)`, [PIN_TWIN]))).employee.id, twin.id);
  assert.equal((await val(anon(`select emp_login('Ana Portal', $1)`, [PIN_ANA]))).employee.id, emp.id);
  assert.equal(num(await val(admin(`select coalesce(sum(failed_attempts), 0) from employee_portal_accounts where employee_id in ($1, $2)`, [emp.id, twin.id]))), 0);

  const me = await val(anon(`select emp_me($1)`, [tok]));
  assert.equal(me.employee.name, 'Ana Portal');
  assert.equal(me.employee.site_name, 'Portal Test Site');
  assert.equal(num(me.leave_types.find((t) => t.code === 'SIL').balance_days), 5);

  // Attendance is visible (read only): the day, both times, 2 h of overtime.
  const att = await val(anon(`select emp_attendance($1)`, [tok]));
  const day = att.days.find((d) => d.date === workDate);
  assert.equal(day.status, 'present');
  assert.equal(day.sessions.length, 1);
  assert.equal(day.worked_minutes, 600);
  assert.equal(day.ot.recorded_minutes, 120);
  assert.equal(day.ot.status, 'counted');
  assert.equal(att.summary.present, 1);
  await rejects(anon(`select * from work_sessions`), /permission denied/, 'portal has no table access');
  await rejects(anon(`select * from employee_portal_accounts`), /permission denied/, 'accounts not readable by anon');
  assert.equal(num(await val(admin(`select count(*) from employee_portal_accounts where employee_id = $1 and is_enabled`, [emp.id]))), 1);

  // Leave: request → staff sees it as filed by the employee → approve → employee sees the status.
  assert.equal((await val(anon(`select emp_leave_request($1, $2, $3, $3, 8, '')`, [tok, sil, leaveDate]))).code, 'BAD_REQUEST');
  const req = await val(anon(`select emp_leave_request($1, $2, $3, $3, 8, 'Family event')`, [tok, sil, leaveDate]));
  assert.equal(req.ok, true, JSON.stringify(req));
  assert.equal(req.days, 1);
  assert.equal((await val(anon(`select emp_leave_request($1, $2, $3, $3, 8, 'Again')`, [tok, sil, leaveDate]))).code, 'DUPLICATE');
  const entry = await one(admin(`select id, status, source, created_by from leave_entries where employee_id = $1 and leave_date = $2`, [emp.id, leaveDate]));
  assert.equal(entry.status, 'pending');
  assert.equal(entry.source, 'employee');
  await admin(`select leave_decide($1, true, 'Enjoy')`, [entry.id]);
  const mine = await val(anon(`select emp_leave_list($1)`, [tok]));
  assert.equal(mine.entries[0].status, 'approved');
  assert.equal(mine.entries[0].decision_note, 'Enjoy');
  assert.equal((await val(anon(`select emp_leave_cancel($1, $2)`, [tok, entry.id]))).code, 'NOT_PENDING');
  assert.equal(num((await val(anon(`select emp_me($1)`, [tok]))).leave_types.find((t) => t.code === 'SIL').balance_days), 4);

  // Payroll → own payslip only; 13th month = basic salary ÷ 12 (overtime is not basic).
  const per = await val(admin(`select payroll_ensure_period($1::date)`, [workDate]));
  const year = Number(String(await val(admin(`select end_date::text from payroll_periods where id = $1`, [per]))).slice(0, 4));
  const run = await val(admin(`select payroll_create_run($1, array[$2]::uuid[])`, [per, site.id]));
  const calc = await val(admin(`select payroll_calculate($1)`, [run]));
  assert.equal(num(calc.blocking), 0, JSON.stringify(await exc(run)));
  assert.equal(num((await val(anon(`select emp_thirteenth_month($1, $2)`, [tok, year]))).basic_earned), 0, 'draft payroll does not count');
  await admin(`select payroll_submit($1)`, [run]);
  assert.equal((await val(admin(`select payroll_finalize($1, $2)`, [run, calc.net]))).ok, true);
  const slips = await val(anon(`select emp_payslips($1)`, [tok]));
  assert.equal(slips.payslips.length, 1);
  assert.equal(num(slips.payslips[0].net_pay), 1050);                      // 800 + 2 h × 125
  const slip = await val(anon(`select emp_payslip($1, $2)`, [tok, slips.payslips[0].id]));
  assert.equal(slip.slip.snapshot.employee.name, 'Ana Portal');
  const otherSlip = await val(admin(`select id from payslips where run_id = $1 and employee_id = $2`, [run, other.id]));
  assert.equal((await val(anon(`select emp_payslip($1, $2)`, [tok, otherSlip]))).code, 'NOT_FOUND');
  const tm = await val(anon(`select emp_thirteenth_month($1, $2)`, [tok, year]));
  assert.equal(num(tm.basic_earned), 800);
  assert.equal(num(tm.thirteenth_month), 66.67);
  const rep = await admin(`select * from thirteenth_month_report($1) where employee_id = $2`, [year, emp.id]);
  assert.equal(num(rep[0].basic_earned), 800);
  assert.equal(num(rep[0].thirteenth_month), 66.67);
  assert.equal(rep[0].site_name, 'Portal Test Site');
  assert.equal((await staff(`select * from thirteenth_month_report($1) where employee_id = $2`, [year, emp.id])).length, 0, 'staff outside the site scope');
  await rejects(anon(`select * from thirteenth_month_report($1)`, [year]), /permission denied/, 'anon report');

  // Wrong PINs on the portal lock only the portal; the attendance PIN itself is never locked by it.
  for (let i = 0; i < 4; i++) assert.equal((await val(anon(`select emp_login('Ben Portal', '000001')`))).code, 'INVALID_LOGIN');
  assert.equal((await val(anon(`select emp_login('Ben Portal', '000001')`))).code, 'ACCOUNT_LOCKED');
  assert.equal((await val(anon(`select emp_login('Ben Portal', $1)`, [PIN_BEN]))).code, 'ACCOUNT_LOCKED');
  assert.equal(num(await val(admin(`select count(*) from pin_credentials where locked_until is not null or failed_attempts > 0`))), 0);
  await admin(`select admin_set_portal_enabled($1, true)`, [other.id]);                    // staff unlock
  assert.equal((await val(anon(`select emp_login('Ben Portal', $1)`, [PIN_BEN]))).ok, true);

  // Disabling ends the session; enabling restores access. Resetting the PIN signs the portal out too.
  await admin(`select admin_set_portal_enabled($1, false)`, [emp.id]);
  assert.equal((await val(anon(`select emp_me($1)`, [tok]))).code, 'SESSION_INVALID');
  assert.equal((await val(anon(`select emp_login('Ana Portal', $1)`, [PIN_ANA]))).code, 'ACCOUNT_DISABLED');
  await admin(`select admin_set_portal_enabled($1, true)`, [emp.id]);
  const again = await val(anon(`select emp_login('Ana Portal', $1)`, [PIN_ANA]));
  assert.equal(again.ok, true);
  await admin(`select set_employee_pin($1, '905173')`, [emp.id]);
  assert.equal((await val(anon(`select emp_me($1)`, [again.token]))).code, 'SESSION_INVALID');
  assert.equal((await val(anon(`select emp_login('Ana Portal', $1)`, [PIN_ANA]))).code, 'INVALID_LOGIN');
  assert.equal((await val(anon(`select emp_login('Ana Portal', '905173')`))).ok, true);
});

// ---------------------------------------------------------------------------
// Face recognition for Clock In / Clock Out
// ---------------------------------------------------------------------------
await test('face recognition: enroll in the employee account → Clock In by face on the site device; PIN still works; templates stay private', async () => {
  // Deterministic stand-ins for face templates (128 numbers): one "person" = a base vector, each picture = base + small noise.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const person = () => Array.from({ length: 128 }, () => (rnd() - 0.5) * 0.3);
  const picture = (base) => base.map((v) => v + (rnd() - 0.5) * 0.02);
  const ana = person(), stranger = person();

  const site = await one(admin(`insert into sites (name) values ('Face Test Site') returning id`));
  await admin(`select admin_set_site_password($1, 'face-site-pass-1')`, [site.id]);
  const emp = await one(admin(`insert into employees (first_name, last_name, hire_date) values ('Carla', 'Facetest', '2025-01-01') returning id`));
  await admin(`insert into employee_rates (employee_id, daily_rate, effective_from) values ($1, 700, '2025-01-01')`, [emp.id]);
  await admin(`select employee_assign_site($1, $2, '2026-01-01T00:00:00+08:00', 'initial')`, [emp.id, site.id]);
  await admin(`select set_employee_pin($1, '583927')`, [emp.id]);

  // The employee records the face in their own account (name + PIN).
  const me = await val(anon(`select emp_login('Carla Facetest', '583927')`));
  assert.equal(me.ok, true, JSON.stringify(me));
  assert.equal((await val(anon(`select emp_face_status($1)`, [me.token]))).enrolled, false);
  assert.equal((await val(anon(`select emp_face_enroll($1, $2::jsonb)`, [me.token, JSON.stringify([picture(ana), picture(ana)])]))).code, 'BAD_REQUEST');
  assert.equal((await val(anon(`select emp_face_enroll($1, $2::jsonb)`, [me.token, JSON.stringify([picture(ana), picture(ana), [1, 2, 3]])]))).code, 'BAD_REQUEST');
  assert.equal((await val(anon(`select emp_face_enroll($1, $2::jsonb)`, [me.token, JSON.stringify([picture(ana), picture(ana), picture(stranger)])]))).code, 'FACE_INCONSISTENT');
  const enrolled = await val(anon(`select emp_face_enroll($1, $2::jsonb)`, [me.token, JSON.stringify([picture(ana), picture(ana), picture(ana)])]));
  assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
  assert.equal(num(enrolled.samples), 3);
  assert.equal((await val(anon(`select emp_face_status($1)`, [me.token]))).enrolled, true);

  // Templates are never readable; staff only see that a face exists.
  await rejects(anon(`select * from employee_faces`), /permission denied/, 'anon faces');
  await rejects(admin(`select descriptor from employee_faces`), /permission denied/, 'staff cannot read templates');
  assert.equal(num(await val(admin(`select count(id) from employee_faces where employee_id = $1`, [emp.id]))), 3);

  // Site device: the roster marks the employee; a stranger's face is refused, the right face is accepted.
  const dev = await val(anon(`select site_login('Face Test Site', 'face-site-pass-1', 'Test phone', 'web', '1.0.0')`));
  const roster = await val(anon(`select site_roster($1)`, [dev.token]));
  assert.equal(roster.employees[0].has_face, true);
  assert.equal(roster.employees[0].has_pin, true);
  assert.equal((await val(anon(`select site_verify_face($1, $2, $3::jsonb)`, [dev.token, emp.id, JSON.stringify([picture(stranger), picture(stranger)])]))).code, 'FACE_MISMATCH');
  assert.equal((await val(anon(`select site_verify_face($1, $2, $3::jsonb)`, [dev.token, emp.id, JSON.stringify([picture(ana), picture(stranger)])]))).code, 'FACE_MISMATCH', 'every frame must match');
  assert.equal((await val(anon(`select site_verify_face($1, $2, $3::jsonb)`, [dev.token, emp.id, JSON.stringify(picture(ana))]))).code, 'BAD_REQUEST', 'one frame is not enough');
  const own = await val(anon(`select emp_face_check($1, $2::jsonb)`, [me.token, JSON.stringify(picture(ana))]));
  assert.equal(own.match, true, JSON.stringify(own));
  assert.equal(num(own.limit), 0.45);
  assert.equal((await val(anon(`select emp_face_check($1, $2::jsonb)`, [me.token, JSON.stringify(picture(stranger))]))).match, false);
  assert.equal((await val(anon(`select site_verify_face($1, $2, $3::jsonb)`, [dev.token, emp.id, JSON.stringify([0.1, 0.2])]))).code, 'BAD_REQUEST');
  const v = await val(anon(`select site_verify_face($1, $2, $3::jsonb)`, [dev.token, emp.id, JSON.stringify([picture(ana), picture(ana)])]));
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.next_action, 'clock_in');
  assert.equal(v.method, 'face');
  assert.equal(num(await val(admin(`select count(*) from security_events where kind = 'face_verified' and employee_id = $1 and (details ->> 'distance') is not null`, [emp.id]))), 1);
  const loc = JSON.stringify({ status: 'captured', latitude: 14.676, longitude: 120.536, accuracy_m: 8, age_ms: 900 });
  const pIn = await val(anon(`select site_punch($1, $2, 'clock_in', gen_random_uuid(), $3::jsonb, now())`, [dev.token, v.auth_token, loc]));
  assert.equal(pIn.ok, true, JSON.stringify(pIn));
  assert.equal((await val(anon(`select site_punch($1, $2, 'clock_in', gen_random_uuid(), $3::jsonb, now())`, [dev.token, v.auth_token, loc]))).code, 'PIN_EXPIRED', 'authorization is single use');

  // Clock Out with the PIN still works (fallback), and each punch records how it was verified.
  await su(`update work_sessions set clock_in_at = clock_in_at - interval '9 hours' where id = $1`, [pIn.work_session_id]);
  const v2 = await val(anon(`select site_verify_pin($1, $2, '583927')`, [dev.token, emp.id]));
  assert.equal(v2.next_action, 'clock_out');
  const pOut = await val(anon(`select site_punch($1, $2, 'clock_out', gen_random_uuid(), $3::jsonb, now())`, [dev.token, v2.auth_token, loc]));
  assert.equal(pOut.ok, true, JSON.stringify(pOut));
  const w = await one(admin(`select in_auth_method, out_auth_method, status from v_work_sessions where id = $1`, [pIn.work_session_id]));
  assert.deepEqual([w.in_auth_method, w.out_auth_method, w.status], ['face', 'pin', 'closed']);

  // A face authorization does not depend on the PIN, and staff can remove the face.
  await admin(`select set_employee_pin($1, '274916')`, [emp.id]);            // resetting the PIN does not affect the face
  const v3 = await val(anon(`select site_verify_face($1, $2, $3::jsonb)`, [dev.token, emp.id, JSON.stringify([picture(ana), picture(ana)])]));
  assert.equal((await val(anon(`select site_punch($1, $2, 'clock_in', gen_random_uuid(), $3::jsonb, now())`, [dev.token, v3.auth_token, loc]))).ok, true);
  await rejects(anon(`select admin_clear_face($1)`, [emp.id]), /permission denied/, 'anon cannot remove faces');
  await admin(`select admin_clear_face($1)`, [emp.id]);
  assert.equal((await val(anon(`select site_verify_face($1, $2, $3::jsonb)`, [dev.token, emp.id, JSON.stringify([picture(ana), picture(ana)])]))).code, 'FACE_NOT_ENROLLED');
  assert.equal((await val(anon(`select site_roster($1)`, [dev.token]))).employees[0].has_face, false);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
