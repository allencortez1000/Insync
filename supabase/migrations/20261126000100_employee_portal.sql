-- =============================================================================
-- Migration 14: employee accounts (self-service portal) and 13th month pay
--
-- Employee portal (website /employee, on the employee's own phone)
--   * Sign in with the employee's NAME (or employee code) + the same 6-digit PIN used on the
--     site attendance device. Every employee who has a PIN has an account; no separate password.
--   * View only: own clock in / clock out records, daily attendance status, overtime,
--     payslips, 13th month pay, leave balances and the status of leave requests.
--   * The only thing an employee can change: file / cancel a leave request.
--     Clock In / Clock Out stays on the shared SITE account (attendance app).
--   * Like the attendance app, the portal has NO table access. It may only call the
--     security-definer emp_* functions, which validate a portal session token and
--     always act on that one employee.
--   * Wrong PINs typed on the portal are counted separately from wrong PINs on the site device,
--     so nobody on the internet can lock an employee out of clocking in. When staff reset a
--     PIN, every portal session of that employee is signed out.
--
-- 13th month pay (P.D. 851)
--   = total BASIC salary earned in the calendar year / 12.
--   Basic salary = payroll lines' basic_amount (regular wages incl. paid leave and the
--   base part of rest-day work). Overtime, premiums, holiday pay and allowances are not
--   included. Only finalized / paid payroll runs whose pay period ends in the year count.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- Portal state per employee (created on first use). The credential itself is the attendance PIN.
create table if not exists public.employee_portal_accounts (
  employee_id      uuid primary key references public.employees (id) on delete cascade,
  is_enabled       boolean not null default true,
  failed_attempts  integer not null default 0,     -- wrong PINs on the portal only
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now()
);

create table if not exists public.employee_portal_sessions (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.employees (id) on delete cascade,
  token_hash    bytea not null unique,
  pin_version   integer not null default 0,       -- session ends when the PIN is reset
  device_label  text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index if not exists employee_portal_sessions_employee_idx on public.employee_portal_sessions (employee_id);

-- Upgrade from the first draft of this migration (separate portal password), if it was run.
drop function if exists public.emp_login(text, text, text);
drop function if exists public.emp_change_password(text, text, text);
drop function if exists public.generate_portal_password(uuid);
drop function if exists public.admin_set_portal_password(uuid, text, boolean);
drop function if exists public._portal_set_password(uuid, text, boolean, uuid);
alter table public.employee_portal_accounts
  drop column if exists password_hash, drop column if exists must_change,
  drop column if exists password_changed_at, drop column if exists set_by;
alter table public.employee_portal_sessions add column if not exists pin_version integer not null default 0;

-- Who filed a leave entry: staff on the website, or the employee from the portal.
alter table public.leave_entries
  add column if not exists source text not null default 'staff' check (source in ('staff', 'employee'));

alter table public.employee_portal_accounts enable row level security;
alter table public.employee_portal_sessions enable row level security;
revoke all on public.employee_portal_accounts, public.employee_portal_sessions from anon, authenticated;
-- Staff can see the account status; sessions are not readable through the API.
grant select (employee_id, is_enabled, failed_attempts, locked_until, last_login_at, created_at)
  on public.employee_portal_accounts to authenticated;
drop policy if exists portal_accounts_select on public.employee_portal_accounts;
create policy portal_accounts_select on public.employee_portal_accounts for select to authenticated
  using (public.can_access_employee(employee_id));

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
-- Employee id for a valid portal session token, or null.
create or replace function public._emp_session(p_token text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_s public.employee_portal_sessions;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;
  select s.* into v_s
  from public.employee_portal_sessions s
  join public.employees e on e.id = s.employee_id and e.is_active
  join public.pin_credentials pc on pc.employee_id = s.employee_id and pc.pin_version = s.pin_version
  where not exists (select 1 from public.employee_portal_accounts a where a.employee_id = s.employee_id and not a.is_enabled)
    and s.token_hash = extensions.digest(p_token, 'sha256') and s.revoked_at is null and s.expires_at > now();
  if v_s.id is null then
    return null;
  end if;
  if v_s.last_seen_at < now() - interval '5 minutes' then
    update public.employee_portal_sessions set last_seen_at = now() where id = v_s.id;
  end if;
  return v_s.employee_id;
end $$;

-- Basic salary earned in a calendar year (finalized / paid runs, by pay-period end date).
create or replace function public._thirteenth_basic(p_employee_id uuid, p_year integer)
returns table (basic numeric, runs integer, first_start date, last_end date)
language sql stable set search_path = public as $$
  select coalesce(sum(l.basic_amount), 0)::numeric, count(distinct u.id)::integer, min(p.start_date), max(p.end_date)
  from public.payroll_lines l
  join public.payroll_runs u on u.id = l.run_id and u.status in ('finalized', 'paid')
  join public.payroll_periods p on p.id = u.period_id
  where l.employee_id = p_employee_id and l.category = 'earning'
    and p.end_date between make_date(p_year, 1, 1) and make_date(p_year, 12, 31)
$$;

-- ---------------------------------------------------------------------------
-- Staff: manage portal accounts
-- ---------------------------------------------------------------------------
-- Turn an employee's portal access off / on. Turning it on also clears a portal lockout.
create or replace function public.admin_set_portal_enabled(p_employee_id uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_staff();
begin
  if not public.can_access_employee(p_employee_id) or not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'Employee not found';
  end if;
  insert into public.employee_portal_accounts (employee_id, is_enabled) values (p_employee_id, coalesce(p_enabled, false))
  on conflict (employee_id) do update set is_enabled = excluded.is_enabled, failed_attempts = 0, locked_until = null;
  if not coalesce(p_enabled, false) then
    update public.employee_portal_sessions set revoked_at = now() where employee_id = p_employee_id and revoked_at is null;
  end if;
  insert into public.security_events (kind, employee_id, actor_user_id, details)
  values ('portal_account_' || case when coalesce(p_enabled, false) then 'enabled' else 'disabled' end, p_employee_id, v_uid, '{}'::jsonb);
end $$;

-- 13th month pay for every employee the caller may see.
create or replace function public.thirteenth_month_report(p_year integer)
returns table (employee_id uuid, employee_code text, employee_name text, site_name text, is_active boolean,
               hire_date date, separation_date date, payroll_runs integer, first_period_start date,
               last_period_end date, basic_earned numeric, thirteenth_month numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_staff();
  if p_year is null or p_year < 2000 or p_year > 2100 then
    raise exception 'Choose a valid year';
  end if;
  return query
  select e.id, e.employee_code, e.display_name,
         (select s.name from public.employee_site_assignments a join public.sites s on s.id = a.site_id
           where a.employee_id = e.id order by a.effective_from desc limit 1),
         e.is_active, e.hire_date, e.separation_date, b.runs, b.first_start, b.last_end, b.basic, round(b.basic / 12, 2)
  from public.employees e
  cross join lateral public._thirteenth_basic(e.id, p_year) b
  where public.can_access_employee(e.id) and (b.basic > 0 or e.is_active)
  order by e.last_name, e.first_name;
end $$;

-- ---------------------------------------------------------------------------
-- Employee portal API (callable by the public website; every call needs a session token)
-- ---------------------------------------------------------------------------
-- Sign in with the employee's name (as on the payslip) or employee code, and the attendance PIN.
create or replace function public.emp_login(p_name text, p_pin text, p_device_label text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_in       text := lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  v_set      public.payroll_settings;
  r          record;
  v_found    integer := 0;
  v_hits     integer := 0;
  v_locked   timestamptz;
  v_disabled boolean := false;
  v_wrong    uuid[] := '{}';
  v_id       uuid;
  v_code     text;
  v_name     text;
  v_ver      integer;
  v_token    text;
  v_expires  timestamptz;
begin
  select * into v_set from public.payroll_settings where id = 1;
  if v_in = '' or coalesce(p_pin, '') !~ '^[0-9]{6}$' then
    perform pg_sleep(0.25);
    return public._fail('INVALID_LOGIN', 'Wrong name or PIN.');
  end if;

  for r in
    select e.id, e.employee_code, e.display_name, pc.pin_hash, pc.pin_version,
           coalesce(a.is_enabled, true) as is_enabled, a.locked_until
    from public.employees e
    join public.pin_credentials pc on pc.employee_id = e.id
    left join public.employee_portal_accounts a on a.employee_id = e.id
    where e.is_active
      and (lower(regexp_replace(btrim(e.display_name), '\s+', ' ', 'g')) = v_in or lower(e.employee_code) = v_in)
    order by e.employee_code
  loop
    v_found := v_found + 1;
    if r.locked_until is not null and r.locked_until > now() then
      v_locked := r.locked_until;
    elsif r.pin_hash = extensions.crypt(p_pin, r.pin_hash) then
      if r.is_enabled then
        v_hits := v_hits + 1;
        v_id := r.id; v_code := r.employee_code; v_name := r.display_name; v_ver := r.pin_version;
      else
        v_disabled := true;
      end if;
    else
      v_wrong := v_wrong || r.id;
    end if;
  end loop;

  if v_found = 0 then
    perform pg_sleep(0.25);
    return public._fail('INVALID_LOGIN', 'Wrong name or PIN.');
  end if;
  if v_hits > 1 then
    return public._fail('AMBIGUOUS', 'More than one employee has this name. Type your employee code (for example EMP-0001) instead of your name.');
  end if;

  if v_hits = 0 then
    if v_disabled then
      return public._fail('ACCOUNT_DISABLED', 'This account is disabled. Please contact the office.');
    end if;
    -- Count the wrong PIN on the portal only; the attendance device has its own counter.
    for r in
      insert into public.employee_portal_accounts as a (employee_id, failed_attempts)
      select w, 1 from unnest(v_wrong) w
      on conflict (employee_id) do update
        set locked_until    = case when a.failed_attempts + 1 >= v_set.pin_max_attempts
                                   then now() + make_interval(mins => v_set.pin_lockout_minutes) else a.locked_until end,
            failed_attempts = case when a.failed_attempts + 1 >= v_set.pin_max_attempts then 0 else a.failed_attempts + 1 end
      returning a.employee_id, a.locked_until
    loop
      if r.locked_until is not null and r.locked_until > now() then
        v_locked := r.locked_until;
        insert into public.security_events (kind, employee_id, details) values ('portal_login_locked', r.employee_id, '{}'::jsonb);
      end if;
    end loop;
    if v_locked is not null then
      return public._fail('ACCOUNT_LOCKED', 'Too many wrong PINs. Try again in a few minutes, or ask the office.',
                          jsonb_build_object('locked_until', v_locked));
    end if;
    return public._fail('INVALID_LOGIN', 'Wrong name or PIN.');
  end if;

  insert into public.employee_portal_accounts as a (employee_id, last_login_at) values (v_id, now())
  on conflict (employee_id) do update set failed_attempts = 0, locked_until = null, last_login_at = now();
  delete from public.employee_portal_sessions
   where employee_id = v_id and (expires_at < now() or revoked_at is not null);

  v_token   := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := now() + interval '30 days';
  insert into public.employee_portal_sessions (employee_id, token_hash, pin_version, device_label, expires_at)
  values (v_id, extensions.digest(v_token, 'sha256'), v_ver, left(p_device_label, 120), v_expires);

  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires,
    'employee', jsonb_build_object('id', v_id, 'employee_code', v_code, 'name', v_name));
end $$;

create or replace function public.emp_logout(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.employee_portal_sessions set revoked_at = now()
   where token_hash = extensions.digest(coalesce(p_token, ''), 'sha256') and revoked_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- Profile, current site and leave balances.
create or replace function public.emp_me(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := public._emp_session(p_token);
  v_e     public.employees;
  v_today date := public.ph_date(now());
  v_site  public.sites;
  v_open  public.work_sessions;
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  select * into v_e from public.employees where id = v_emp;
  select * into v_site from public.sites where id = public._site_on(v_emp, v_today);
  select * into v_open from public.work_sessions where employee_id = v_emp and status = 'open';
  return jsonb_build_object(
    'ok', true,
    'today', v_today,
    'employee', jsonb_build_object(
      'id', v_e.id, 'employee_code', v_e.employee_code, 'name', v_e.display_name, 'first_name', v_e.first_name,
      'classification', v_e.classification, 'hire_date', v_e.hire_date, 'site_name', v_site.name,
      'daily_rate', (public._rate_on(v_emp, v_today)).daily_rate,
      'schedule_name', (public._schedule_on(v_emp, v_today)).name),
    'open_session', case when v_open.id is not null then jsonb_build_object(
      'clock_in_at', v_open.clock_in_at, 'site_name', (select name from public.sites where id = v_open.site_id)) end,
    'leave_types', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'code', t.code, 'name', t.name, 'is_paid', t.is_paid, 'requires_balance', t.requires_balance,
               'balance_days', (select coalesce(sum(l.days), 0) from public.leave_ledger l
                                 where l.employee_id = v_emp and l.leave_type_id = t.id),
               'pending_days', (select coalesce(sum(x.hours) / 8, 0) from public.leave_entries x
                                 where x.employee_id = v_emp and x.leave_type_id = t.id and x.status = 'pending'))
             order by t.name)
      from public.leave_types t where t.is_active), '[]'::jsonb));
end $$;

-- Own clock in / clock out records, a status for every day, and overtime. Read only.
create or replace function public.emp_attendance(p_token text, p_from date default null, p_to date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp     uuid := public._emp_session(p_token);
  v_e       public.employees;
  v_set     public.payroll_settings;
  v_today   date := public.ph_date(now());
  v_to      date;
  v_from    date;
  v_first   date;
  v_d       date;
  v_s       public.schedules;
  v_dec     public.ot_decisions;
  v_wd      jsonb;
  v_sess    jsonb;
  v_first_in timestamptz;
  v_open    boolean;
  v_working boolean;
  v_leave   record;
  v_hol     text;
  v_status  text;
  v_late    integer;
  v_ot      integer;
  v_days    jsonb := '[]'::jsonb;
  n_present integer := 0;
  n_late    integer := 0;
  n_absent  integer := 0;
  n_leave   integer := 0;
  n_ot_rec  integer := 0;
  n_ot_ok   integer := 0;
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  select * into v_e from public.employees where id = v_emp;
  select * into v_set from public.payroll_settings where id = 1;
  v_to   := least(coalesce(p_to, v_today), v_today);
  v_from := greatest(coalesce(p_from, v_to - 30), v_to - 61);
  select public.ph_date(min(effective_from)) into v_first from public.employee_site_assignments where employee_id = v_emp;
  v_first := greatest(coalesce(v_first, v_today + 1), coalesce(v_e.hire_date, v_first));

  v_d := v_to;
  while v_d >= v_from and v_d >= v_first loop
    select jsonb_agg(jsonb_build_object(
             'clock_in_at', w.clock_in_at, 'clock_out_at', w.clock_out_at, 'status', w.status, 'site_name', s.name,
             'entered_by_staff', w.source = 'correction' or w.clock_out_event_id is null and w.status = 'closed')
             order by w.clock_in_at),
           min(w.clock_in_at), coalesce(bool_or(w.status = 'open'), false)
      into v_sess, v_first_in, v_open
    from public.work_sessions w join public.sites s on s.id = w.site_id
    where w.employee_id = v_emp and w.status <> 'voided' and public.ph_date(w.clock_in_at) = v_d;

    v_s := public._schedule_on(v_emp, v_d);
    v_working := case when v_s.id is null then extract(isodow from v_d) <> 7
                      else extract(isodow from v_d)::smallint = any (v_s.working_days) end;
    select h.name into v_hol from public.holidays h
     where h.holiday_date = v_d and h.kind = 'regular' and h.site_id is null limit 1;
    select le.status, lt.name, lt.is_paid, le.hours into v_leave
    from public.leave_entries le join public.leave_types lt on lt.id = le.leave_type_id
    where le.employee_id = v_emp and le.leave_date = v_d and le.status in ('approved', 'pending')
    order by (le.status = 'approved') desc limit 1;

    v_wd   := public._work_day(v_emp, v_d);
    v_ot   := (v_wd ->> 'ot')::integer;
    v_late := 0;
    select * into v_dec from public.ot_decisions where employee_id = v_emp and work_date = v_d;

    if v_sess is not null then
      v_status := case when v_open then 'clocked_in' else 'present' end;
      if v_s.id is not null and v_working then
        v_late := greatest(0, (extract(epoch from ((v_first_in at time zone 'Asia/Manila')::time - v_s.start_time)) / 60)::integer);
        if v_late <= v_s.grace_minutes then v_late := 0; end if;
      end if;
      n_present := n_present + 1;
      if v_late > 0 then n_late := n_late + 1; end if;
    elsif v_leave.status = 'approved' then
      v_status := 'on_leave';
      n_leave := n_leave + 1;
    elsif v_hol is not null then
      v_status := 'holiday';
    elsif not v_working then
      v_status := 'rest_day';
    elsif v_d = v_today then
      v_status := 'no_record_yet';
    elsif v_leave.status = 'pending' then
      v_status := 'leave_pending';
    else
      v_status := 'absent';
      n_absent := n_absent + 1;
    end if;

    if v_ot > 0 then
      n_ot_rec := n_ot_rec + v_ot;
      n_ot_ok  := n_ot_ok + case when v_dec.id is not null then
                                   case when v_dec.status = 'accepted' then least(v_dec.accepted_minutes, v_ot) else 0 end
                                 when v_set.ot_review_required then 0 else v_ot end;
    end if;

    v_days := v_days || jsonb_build_array(jsonb_build_object(
      'date', v_d, 'status', v_status, 'sessions', coalesce(v_sess, '[]'::jsonb),
      'is_working_day', v_working, 'holiday', v_hol,
      'leave', case when v_leave.status is not null then
                 jsonb_build_object('status', v_leave.status, 'type', v_leave.name, 'is_paid', v_leave.is_paid, 'hours', v_leave.hours) end,
      'elapsed_minutes', (v_wd ->> 'elapsed')::integer,
      'worked_minutes', (v_wd ->> 'worked')::integer,
      'late_minutes', v_late,
      'undertime', v_sess is not null and not v_open and v_working and (v_wd ->> 'worked')::integer < 480,
      'ot', case when v_ot > 0 or v_dec.id is not null then jsonb_build_object(
              'recorded_minutes', coalesce(v_dec.recorded_minutes, v_ot),
              'accepted_minutes', case when v_dec.id is not null then
                                         case when v_dec.status = 'accepted' then v_dec.accepted_minutes else 0 end
                                       when v_set.ot_review_required then 0 else v_ot end,
              'status', case when v_dec.id is not null then v_dec.status::text
                             when v_set.ot_review_required then 'pending' else 'counted' end,
              'reason', v_dec.reason) end));
    v_d := v_d - 1;
  end loop;

  return jsonb_build_object('ok', true, 'from', v_from, 'to', v_to, 'days', v_days,
    'summary', jsonb_build_object('present', n_present, 'late', n_late, 'absent', n_absent, 'on_leave', n_leave,
                                  'ot_recorded_minutes', n_ot_rec, 'ot_accepted_minutes', n_ot_ok));
end $$;

create or replace function public.emp_leave_list(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public._emp_session(p_token);
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  return jsonb_build_object('ok', true, 'entries', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.leave_date desc, x.created_at desc)
    from (select le.id, le.leave_date, le.hours, le.status, le.reason, le.decision_note, le.decided_at, le.created_at,
                 le.source, lt.name as type_name, lt.is_paid
          from public.leave_entries le join public.leave_types lt on lt.id = le.leave_type_id
          where le.employee_id = v_emp
          order by le.leave_date desc limit 120) x), '[]'::jsonb));
end $$;

-- File a leave request (pending until staff approve or reject it).
create or replace function public.emp_leave_request(
  p_token text, p_leave_type_id uuid, p_from date, p_to date, p_hours numeric default 8, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp     uuid := public._emp_session(p_token);
  v_t       public.leave_types;
  v_today   date := public.ph_date(now());
  v_d       date;
  v_s       public.schedules;
  v_days    date[] := '{}';
  v_bal     numeric;
  v_pending numeric;
  v_need    numeric;
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  select * into v_t from public.leave_types where id = p_leave_type_id and is_active;
  if v_t.id is null then
    return public._fail('BAD_REQUEST', 'Choose a leave type.');
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    return public._fail('BAD_REQUEST', 'Choose valid dates.');
  end if;
  if p_to - p_from > 13 then
    return public._fail('BAD_REQUEST', 'Request at most 14 days at a time.');
  end if;
  if p_from < v_today - 7 then
    return public._fail('BAD_REQUEST', 'Leave can be filed up to 7 days back. Please ask the office for older dates.');
  end if;
  if p_to > v_today + 180 then
    return public._fail('BAD_REQUEST', 'Leave can be filed up to 6 months ahead.');
  end if;
  if p_hours is null or p_hours not in (4, 8) then
    return public._fail('BAD_REQUEST', 'Choose a whole day or a half day.');
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 3 then
    return public._fail('BAD_REQUEST', 'Please write the reason for your leave.');
  end if;
  if (select count(*) from public.leave_entries where employee_id = v_emp and status = 'pending') >= 30 then
    return public._fail('BAD_REQUEST', 'You have many requests waiting. Please wait for the office to decide them first.');
  end if;

  for v_d in select g::date from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g loop
    v_s := public._schedule_on(v_emp, v_d);
    continue when (v_s.id is null and extract(isodow from v_d) = 7)
               or (v_s.id is not null and not (extract(isodow from v_d)::smallint = any (v_s.working_days)));
    if exists (select 1 from public.leave_entries
               where employee_id = v_emp and leave_date = v_d and status in ('pending', 'approved')) then
      return public._fail('DUPLICATE', format('You already have leave filed for %s.', to_char(v_d, 'Mon DD, YYYY')));
    end if;
    if public._finalized_run_for(v_emp, v_d) is not null then
      return public._fail('PAYROLL_CLOSED', format('Payroll for %s is already finalized. Please ask the office.', to_char(v_d, 'Mon DD, YYYY')));
    end if;
    v_days := v_days || v_d;
  end loop;
  if cardinality(v_days) = 0 then
    return public._fail('BAD_REQUEST', 'Those dates are not working days for you.');
  end if;

  v_need := cardinality(v_days) * p_hours / 8;
  if v_t.requires_balance then
    select coalesce(sum(days), 0) into v_bal from public.leave_ledger where employee_id = v_emp and leave_type_id = v_t.id;
    select coalesce(sum(hours) / 8, 0) into v_pending from public.leave_entries
     where employee_id = v_emp and leave_type_id = v_t.id and status = 'pending';
    if v_bal - v_pending < v_need then
      return public._fail('NO_BALANCE', format('Not enough %s balance: %s day(s) available, %s needed.',
                          v_t.name, round(v_bal - v_pending, 2)::float8, round(v_need, 2)::float8));
    end if;
  end if;

  insert into public.leave_entries (employee_id, leave_type_id, leave_date, hours, status, reason, source)
  select v_emp, v_t.id, d, p_hours, 'pending', btrim(p_reason), 'employee' from unnest(v_days) d;
  return jsonb_build_object('ok', true, 'days', cardinality(v_days));
exception
  when unique_violation then
    return public._fail('DUPLICATE', 'You already have leave filed for one of those dates.');
end $$;

-- An employee may withdraw a request that has not been decided yet.
create or replace function public.emp_leave_cancel(p_token text, p_entry_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public._emp_session(p_token);
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  update public.leave_entries
     set status = 'cancelled', decided_at = now(), decision_note = 'Cancelled by the employee'
   where id = p_entry_id and employee_id = v_emp and status = 'pending';
  if not found then
    return public._fail('NOT_PENDING', 'Only requests that are still pending can be cancelled.');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.emp_payslips(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public._emp_session(p_token);
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  return jsonb_build_object('ok', true, 'payslips', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.start_date desc, x.issued_at desc)
    from (select p.id, p.payslip_no, p.status, p.issued_at,
                 (p.snapshot -> 'period' ->> 'start_date')::date as start_date,
                 (p.snapshot -> 'period' ->> 'end_date')::date as end_date,
                 (p.snapshot -> 'period' ->> 'payday')::date as payday,
                 (p.snapshot -> 'totals' ->> 'gross_pay')::numeric as gross_pay,
                 (p.snapshot -> 'totals' ->> 'total_deductions')::numeric as total_deductions,
                 (p.snapshot -> 'totals' ->> 'net_pay')::numeric as net_pay,
                 (select r.paid_at from public.payment_records r where r.run_id = p.run_id and r.employee_id = p.employee_id) as paid_at
          from public.payslips p
          where p.employee_id = v_emp
          order by p.issued_at desc limit 120) x), '[]'::jsonb));
end $$;

create or replace function public.emp_payslip(p_token text, p_payslip_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp  uuid := public._emp_session(p_token);
  v_slip public.payslips;
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  select * into v_slip from public.payslips where id = p_payslip_id and employee_id = v_emp;
  if v_slip.id is null then
    return public._fail('NOT_FOUND', 'Payslip not found.');
  end if;
  return jsonb_build_object('ok', true, 'slip', to_jsonb(v_slip),
    'payment', (select to_jsonb(r) - 'recorded_by' from public.payment_records r
                 where r.run_id = v_slip.run_id and r.employee_id = v_emp));
end $$;

create or replace function public.emp_thirteenth_month(p_token text, p_year integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp  uuid := public._emp_session(p_token);
  v_year integer := coalesce(p_year, extract(year from public.ph_date(now()))::integer);
  v_b    record;
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  if v_year < 2000 or v_year > 2100 then
    return public._fail('BAD_REQUEST', 'Choose a valid year.');
  end if;
  select * into v_b from public._thirteenth_basic(v_emp, v_year);
  return jsonb_build_object('ok', true, 'year', v_year,
    'basic_earned', v_b.basic, 'thirteenth_month', round(v_b.basic / 12, 2),
    'payroll_runs', v_b.runs, 'first_period_start', v_b.first_start, 'last_period_end', v_b.last_end,
    'months', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'basic', m.basic) order by m.month)
      from (select date_trunc('month', p.end_date)::date as month, sum(l.basic_amount) as basic
            from public.payroll_lines l
            join public.payroll_runs u on u.id = l.run_id and u.status in ('finalized', 'paid')
            join public.payroll_periods p on p.id = u.period_id
            where l.employee_id = v_emp and l.category = 'earning'
              and p.end_date between make_date(v_year, 1, 1) and make_date(v_year, 12, 31)
            group by 1) m), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Privileges: the public website (anon) may call only the emp_* entry points.
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('_emp_session', '_thirteenth_basic', 'admin_set_portal_enabled', 'thirteenth_month_report',
                               'emp_login', 'emp_logout', 'emp_me', 'emp_attendance', 'emp_leave_list',
                               'emp_leave_request', 'emp_leave_cancel', 'emp_payslips', 'emp_payslip', 'emp_thirteenth_month') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function
  public.admin_set_portal_enabled(uuid, boolean),
  public.thirteenth_month_report(integer)
to authenticated;

grant execute on function
  public.emp_login(text, text, text),
  public.emp_logout(text),
  public.emp_me(text),
  public.emp_attendance(text, date, date),
  public.emp_leave_list(text),
  public.emp_leave_request(text, uuid, date, date, numeric, text),
  public.emp_leave_cancel(text, uuid),
  public.emp_payslips(text),
  public.emp_payslip(text, uuid),
  public.emp_thirteenth_month(text, integer)
to anon, authenticated;
