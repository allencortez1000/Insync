-- =============================================================================
-- Insync — Site Attendance and Weekly Payroll
-- Migration 1: core schema (tables, types, constraints, integrity triggers)
-- Target: Supabase Postgres 15+. Timezone for payroll: Asia/Manila.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.app_role        as enum ('admin', 'staff');
create type public.punch_action    as enum ('clock_in', 'clock_out');
create type public.location_status as enum ('captured', 'permission_denied', 'unavailable', 'timeout', 'stale');
create type public.session_status  as enum ('open', 'closed', 'voided');
create type public.holiday_kind    as enum ('regular', 'special_non_working', 'special_working');
create type public.ot_status       as enum ('pending', 'accepted', 'rejected', 'disputed');
create type public.leave_status    as enum ('pending', 'approved', 'rejected', 'cancelled');
create type public.payroll_status  as enum ('draft', 'ready_for_review', 'finalized', 'paid', 'void');
create type public.statutory_agency as enum ('sss', 'philhealth', 'pagibig', 'bir_withholding');
create type public.rule_status     as enum ('draft', 'approved', 'retired');

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Philippine calendar date of an instant.
create or replace function public.ph_date(p_ts timestamptz) returns date
language sql immutable parallel safe as $$
  select (p_ts at time zone 'Asia/Manila')::date
$$;

-- Instant for a Philippine local date + time.
create or replace function public.ph_ts(p_date date, p_time time default '00:00') returns timestamptz
language sql immutable parallel safe as $$
  select (p_date + p_time) at time zone 'Asia/Manila'
$$;

-- ---------------------------------------------------------------------------
-- Admin / staff website users (individual accounts, Supabase Auth)
-- ---------------------------------------------------------------------------
create table public.app_users (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  role        public.app_role,                -- null = awaiting admin approval
  is_active   boolean not null default false,
  all_sites   boolean not null default false, -- staff with access to every site
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_app_users_updated before update on public.app_users
  for each row execute function public.set_updated_at();

-- New Supabase Auth sign-ups get a pending, inactive profile. An admin activates them.
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_users (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Sites and the shared site attendance account
-- ---------------------------------------------------------------------------
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  name        text not null,
  address     text,
  region      text,
  latitude    numeric(9, 6) check (latitude between -90 and 90),
  longitude   numeric(9, 6) check (longitude between -180 and 180),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_sites_updated before update on public.sites
  for each row execute function public.set_updated_at();

create table public.staff_site_scopes (
  user_id  uuid not null references public.app_users (id) on delete cascade,
  site_id  uuid not null references public.sites (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, site_id)
);

create table public.site_accounts (
  id                  uuid primary key default gen_random_uuid(),
  site_id             uuid not null unique references public.sites (id),
  username            text not null unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  password_hash       text not null,
  is_active           boolean not null default true,
  failed_attempts     integer not null default 0,
  locked_until        timestamptz,
  password_changed_at timestamptz not null default now(),
  created_by          uuid references public.app_users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_site_accounts_updated before update on public.site_accounts
  for each row execute function public.set_updated_at();

create table public.device_sessions (
  id               uuid primary key default gen_random_uuid(),
  site_account_id  uuid not null references public.site_accounts (id),
  site_id          uuid not null references public.sites (id),
  token_hash       bytea not null unique,
  device_label     text,
  platform         text,
  app_version      text,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoked_by       uuid references public.app_users (id),
  revoke_reason    text
);
create index device_sessions_site_idx on public.device_sessions (site_id, revoked_at);

-- ---------------------------------------------------------------------------
-- Employees, assignments, rates, schedules
-- ---------------------------------------------------------------------------
create table public.employees (
  id                       uuid primary key default gen_random_uuid(),
  employee_code            text not null unique check (employee_code ~ '^[A-Z0-9-]{2,20}$'),
  first_name               text not null check (length(trim(first_name)) > 0),
  middle_name              text,
  last_name                text not null check (length(trim(last_name)) > 0),
  display_name             text generated always as (trim(first_name || ' ' || last_name)) stored,
  is_active                boolean not null default true,
  hire_date                date,
  separation_date          date,
  classification           text not null default 'regular'
                           check (classification in ('regular','probationary','project','seasonal','casual','fixed_term')),
  is_minimum_wage_earner   boolean not null default false,
  labor_standards_covered  boolean not null default true,  -- OT / holiday / rest-day / night rules apply
  statutory_covered        boolean not null default true,  -- SSS / PhilHealth / Pag-IBIG apply
  tin                      text,
  sss_number               text,
  philhealth_number        text,
  pagibig_number           text,
  notes                    text,
  created_by               uuid references public.app_users (id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (separation_date is null or hire_date is null or separation_date >= hire_date)
);
create trigger trg_employees_updated before update on public.employees
  for each row execute function public.set_updated_at();
create index employees_name_idx on public.employees (last_name, first_name);

-- One active site assignment at a time, effective-dated (half-open ranges, no overlap).
create table public.employee_site_assignments (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees (id),
  site_id         uuid not null references public.sites (id),
  effective_from  timestamptz not null,
  effective_to    timestamptz,
  reason          text,
  created_by      uuid references public.app_users (id),
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  constraint employee_site_assignments_no_overlap exclude using gist (
    employee_id with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  )
);
create index esa_site_idx on public.employee_site_assignments (site_id, effective_from);

create table public.employee_rates (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees (id),
  daily_rate      numeric(12, 2) not null check (daily_rate > 0),
  effective_from  date not null,
  reason          text,
  created_by      uuid references public.app_users (id),
  created_at      timestamptz not null default now(),
  unique (employee_id, effective_from)
);

create table public.schedules (
  id                           uuid primary key default gen_random_uuid(),
  name                         text not null unique,
  start_time                   time not null,
  end_time                     time not null,
  working_days                 smallint[] not null default '{1,2,3,4,5,6}'
                               check (working_days <@ array[1,2,3,4,5,6,7]::smallint[]),  -- ISO: 1 = Monday
  unpaid_break_minutes         integer not null default 0 check (unpaid_break_minutes between 0 and 240),
  break_applies_after_minutes  integer not null default 300 check (break_applies_after_minutes >= 0),
  grace_minutes                integer not null default 0 check (grace_minutes between 0 and 120),
  is_active                    boolean not null default true,
  notes                        text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
create trigger trg_schedules_updated before update on public.schedules
  for each row execute function public.set_updated_at();

create table public.employee_schedules (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees (id),
  schedule_id     uuid not null references public.schedules (id),
  effective_from  date not null,
  created_by      uuid references public.app_users (id),
  created_at      timestamptz not null default now(),
  unique (employee_id, effective_from)
);

-- ---------------------------------------------------------------------------
-- Holidays (national when site_id is null; local otherwise)
-- ---------------------------------------------------------------------------
create table public.holidays (
  id                uuid primary key default gen_random_uuid(),
  holiday_date      date not null,
  name              text not null,
  kind              public.holiday_kind not null,
  site_id           uuid references public.sites (id),
  source_reference  text not null,
  published_on      date,
  notes             text,
  created_by        uuid references public.app_users (id),
  created_at        timestamptz not null default now()
);
create unique index holidays_unique_idx
  on public.holidays (holiday_date, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
create index holidays_date_idx on public.holidays (holiday_date);

-- Day-classification multipliers (total rates on the basic hourly rate). Versioned by effective date.
create table public.day_type_multipliers (
  id                  uuid primary key default gen_random_uuid(),
  day_type            text not null check (day_type in
                        ('ordinary','rest_day','special_non_working','special_rest','regular_holiday','regular_holiday_rest')),
  effective_from      date not null,
  regular_multiplier  numeric(6, 4) not null check (regular_multiplier >= 1),
  ot_multiplier       numeric(6, 4) not null check (ot_multiplier >= 1),
  source_reference    text not null,
  created_at          timestamptz not null default now(),
  unique (day_type, effective_from)
);

-- ---------------------------------------------------------------------------
-- PIN credentials and device-side PIN authorizations
-- ---------------------------------------------------------------------------
create table public.pin_credentials (
  employee_id      uuid primary key references public.employees (id) on delete cascade,
  pin_hash         text not null,
  pin_version      integer not null default 1,
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  set_at           timestamptz not null default now(),
  set_by           uuid references public.app_users (id)
);

-- A successful PIN check yields a single-use, short-lived authorization for one action.
create table public.pin_authorizations (
  id                 uuid primary key default gen_random_uuid(),
  token_hash         bytea not null unique,
  employee_id        uuid not null references public.employees (id) on delete cascade,
  device_session_id  uuid not null references public.device_sessions (id),
  pin_version        integer not null,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  used_at            timestamptz
);
create index pin_auth_employee_idx on public.pin_authorizations (employee_id, used_at);

create table public.security_events (
  id                 bigint generated always as identity primary key,
  kind               text not null,
  site_id            uuid references public.sites (id),
  employee_id        uuid references public.employees (id),
  device_session_id  uuid references public.device_sessions (id),
  actor_user_id      uuid references public.app_users (id),
  details            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create index security_events_lookup_idx on public.security_events (kind, created_at desc);
create index security_events_device_idx on public.security_events (device_session_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Attendance: immutable events (evidence) + derived work sessions
-- ---------------------------------------------------------------------------
create table public.work_sessions (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees (id),
  site_id             uuid not null references public.sites (id),
  status              public.session_status not null default 'open',
  clock_in_at         timestamptz not null,
  clock_out_at        timestamptz,
  clock_in_event_id   uuid,
  clock_out_event_id  uuid,
  source              text not null default 'device' check (source in ('device', 'correction')),
  review_flags        text[] not null default '{}',
  reviewed_at         timestamptz,
  reviewed_by         uuid references public.app_users (id),
  review_note         text,
  allow_origin_close  boolean not null default false,  -- set when transferred with an open session
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (clock_out_at is null or clock_out_at > clock_in_at),
  check (status <> 'open'   or clock_out_at is null),
  check (status <> 'closed' or clock_out_at is not null),
  constraint work_sessions_no_overlap exclude using gist (
    employee_id with =,
    tstzrange(clock_in_at, coalesce(clock_out_at, 'infinity'::timestamptz), '[)') with &&
  ) where (status <> 'voided')
);
create unique index work_sessions_one_open_idx on public.work_sessions (employee_id) where status = 'open';
create index work_sessions_site_time_idx on public.work_sessions (site_id, clock_in_at desc);
create index work_sessions_employee_time_idx on public.work_sessions (employee_id, clock_in_at desc);
create trigger trg_work_sessions_updated before update on public.work_sessions
  for each row execute function public.set_updated_at();

create table public.attendance_events (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid not null unique,              -- idempotency key from the device
  employee_id           uuid not null references public.employees (id),
  site_id               uuid not null references public.sites (id),
  device_session_id     uuid not null references public.device_sessions (id),
  work_session_id       uuid not null references public.work_sessions (id),
  action                public.punch_action not null,
  server_time           timestamptz not null default now(),  -- authoritative
  client_time           timestamptz,                         -- informational only
  location_status       public.location_status not null,
  latitude              numeric(9, 6),
  longitude             numeric(9, 6),
  accuracy_m            numeric(10, 2),
  location_captured_at  timestamptz,
  location_age_ms       integer,
  created_at            timestamptz not null default now(),
  check (location_status <> 'captured' or (latitude is not null and longitude is not null))
);
create index attendance_events_site_time_idx on public.attendance_events (site_id, server_time desc);
create index attendance_events_employee_time_idx on public.attendance_events (employee_id, server_time desc);

alter table public.work_sessions
  add constraint work_sessions_clock_in_event_fk  foreign key (clock_in_event_id)  references public.attendance_events (id),
  add constraint work_sessions_clock_out_event_fk foreign key (clock_out_event_id) references public.attendance_events (id);

-- Attendance events are original evidence: never updated or deleted.
create or replace function public.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are immutable', tg_table_name using errcode = 'P0001';
end $$;
create trigger trg_attendance_events_immutable before update or delete on public.attendance_events
  for each row execute function public.forbid_mutation();

create table public.attendance_corrections (
  id                         uuid primary key default gen_random_uuid(),
  work_session_id            uuid references public.work_sessions (id),
  employee_id                uuid not null references public.employees (id),
  site_id                    uuid not null references public.sites (id),
  kind                       text not null check (kind in
                               ('create_session','edit_times','close_session','void_session','mark_reviewed')),
  before                     jsonb,
  after                      jsonb,
  reason                     text not null check (length(trim(reason)) >= 3),
  affects_finalized_run_id   uuid,
  created_by                 uuid not null references public.app_users (id),
  created_at                 timestamptz not null default now()
);
create index attendance_corrections_session_idx on public.attendance_corrections (work_session_id);
create trigger trg_attendance_corrections_immutable before update or delete on public.attendance_corrections
  for each row execute function public.forbid_mutation();

create table public.ot_decisions (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references public.employees (id),
  work_date         date not null,
  recorded_minutes  integer not null check (recorded_minutes >= 0),
  accepted_minutes  integer not null default 0 check (accepted_minutes >= 0),
  status            public.ot_status not null default 'pending',
  reason            text,
  decided_by        uuid references public.app_users (id),
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (employee_id, work_date),
  check (accepted_minutes <= recorded_minutes),
  check (status in ('pending','accepted') or reason is not null)
);
create trigger trg_ot_decisions_updated before update on public.ot_decisions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------------
create table public.leave_types (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null unique,
  name                     text not null,
  is_paid                  boolean not null,
  requires_balance         boolean not null default true,
  annual_entitlement_days  numeric(6, 2) not null default 0,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now()
);

create table public.leave_entries (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees (id),
  leave_type_id  uuid not null references public.leave_types (id),
  leave_date     date not null,
  hours          numeric(4, 2) not null default 8 check (hours > 0 and hours <= 8),
  status         public.leave_status not null default 'pending',
  reason         text,
  created_by     uuid references public.app_users (id),
  created_at     timestamptz not null default now(),
  decided_by     uuid references public.app_users (id),
  decided_at     timestamptz,
  decision_note  text
);
create unique index leave_entries_one_per_day_idx
  on public.leave_entries (employee_id, leave_date) where status in ('pending', 'approved');

create table public.leave_ledger (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees (id),
  leave_type_id   uuid not null references public.leave_types (id),
  entry_date      date not null default current_date,
  days            numeric(7, 3) not null check (days <> 0),
  kind            text not null check (kind in ('grant','use','reversal','adjustment','carryover','expiry')),
  leave_entry_id  uuid references public.leave_entries (id),
  note            text,
  created_by      uuid references public.app_users (id),
  created_at      timestamptz not null default now(),
  check (kind not in ('adjustment','expiry') or note is not null)
);
create unique index leave_ledger_use_once_idx on public.leave_ledger (leave_entry_id, kind) where leave_entry_id is not null;
create trigger trg_leave_ledger_immutable before update or delete on public.leave_ledger
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Allowances, cash advances, manual payroll adjustments
-- ---------------------------------------------------------------------------
create table public.allowance_rules (
  id                   uuid primary key default gen_random_uuid(),
  employee_id          uuid not null references public.employees (id),
  name                 text not null,
  amount               numeric(12, 2) not null check (amount > 0),
  frequency            text not null check (frequency in ('per_day_worked', 'per_week')),
  taxable              boolean not null default false,
  requires_attendance  boolean not null default true,
  effective_from       date not null,
  effective_to         date,
  is_active            boolean not null default true,
  created_by           uuid references public.app_users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create trigger trg_allowance_rules_updated before update on public.allowance_rules
  for each row execute function public.set_updated_at();

create table public.cash_advances (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references public.employees (id),
  principal             numeric(12, 2) not null check (principal > 0),
  released_on           date not null,
  installment_amount    numeric(12, 2) not null check (installment_amount > 0),
  first_deduction_date  date not null,
  status                text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  authorized_by         uuid not null references public.app_users (id),
  reason                text,
  created_by            uuid references public.app_users (id),
  created_at            timestamptz not null default now()
);

-- Balance = sum(amount). Release is positive (owed); repayments are negative.
create table public.advance_ledger (
  id              uuid primary key default gen_random_uuid(),
  advance_id      uuid not null references public.cash_advances (id),
  entry_date      date not null default current_date,
  kind            text not null check (kind in ('release', 'repayment', 'adjustment', 'reversal')),
  amount          numeric(12, 2) not null check (amount <> 0),
  payroll_run_id  uuid,
  note            text,
  created_by      uuid references public.app_users (id),
  created_at      timestamptz not null default now(),
  check (kind <> 'adjustment' or note is not null)
);
create unique index advance_ledger_repay_once_idx  on public.advance_ledger (advance_id, payroll_run_id) where kind = 'repayment';
create unique index advance_ledger_reverse_once_idx on public.advance_ledger (advance_id, payroll_run_id) where kind = 'reversal';
create trigger trg_advance_ledger_immutable before update or delete on public.advance_ledger
  for each row execute function public.forbid_mutation();

create or replace function public.cash_advance_release_entry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.advance_ledger (advance_id, entry_date, kind, amount, note, created_by)
  values (new.id, new.released_on, 'release', new.principal, new.reason, new.created_by);
  return new;
end $$;
create trigger trg_cash_advance_release after insert on public.cash_advances
  for each row execute function public.cash_advance_release_entry();

-- ---------------------------------------------------------------------------
-- Statutory rules and the monthly contribution ledger
-- ---------------------------------------------------------------------------
create table public.statutory_rule_versions (
  id                uuid primary key default gen_random_uuid(),
  agency            public.statutory_agency not null,
  name              text not null,
  effective_from    date not null,
  effective_to      date,
  status            public.rule_status not null default 'draft',
  params            jsonb not null,
  source_reference  text not null,
  notes             text,
  approved_by       uuid references public.app_users (id),
  approved_at       timestamptz,
  created_by        uuid references public.app_users (id),
  created_at        timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index statutory_rule_lookup_idx on public.statutory_rule_versions (agency, status, effective_from desc);

-- Approved rule versions are immutable except for retirement (status / effective_to).
create or replace function public.guard_statutory_rule() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'Only draft rule versions can be deleted'; end if;
    return old;
  end if;
  if old.status = 'approved' and (
       new.params is distinct from old.params or new.agency is distinct from old.agency
    or new.effective_from is distinct from old.effective_from or new.source_reference is distinct from old.source_reference) then
    raise exception 'Approved rule versions cannot be edited; create a new version';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'Retired rule versions cannot be reactivated';
  end if;
  return new;
end $$;
create trigger trg_statutory_rule_guard before update or delete on public.statutory_rule_versions
  for each row execute function public.guard_statutory_rule();

create table public.contribution_ledger (
  id                    uuid primary key default gen_random_uuid(),
  employee_id           uuid not null references public.employees (id),
  agency                public.statutory_agency not null check (agency <> 'bir_withholding'),
  contribution_month    date not null check (extract(day from contribution_month) = 1),
  payroll_run_id        uuid not null,
  kind                  text not null check (kind in ('collection', 'true_up')),
  basis_amount          numeric(14, 2) not null,
  employee_amount       numeric(12, 2) not null,
  employer_amount       numeric(12, 2) not null,
  ec_amount             numeric(12, 2) not null default 0,
  obligation_employee   numeric(12, 2),
  obligation_employer   numeric(12, 2),
  obligation_ec         numeric(12, 2),
  rule_version_id       uuid references public.statutory_rule_versions (id),
  created_at            timestamptz not null default now(),
  unique (employee_id, agency, payroll_run_id)
);
create index contribution_ledger_month_idx on public.contribution_ledger (employee_id, agency, contribution_month);
create trigger trg_contribution_ledger_immutable before update or delete on public.contribution_ledger
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Settings (singleton). Open PRD decisions are configurable here.
-- ---------------------------------------------------------------------------
create table public.payroll_settings (
  id                          smallint primary key default 1 check (id = 1),
  period_start_dow            smallint not null default 1 check (period_start_dow between 1 and 7), -- ISO weekday
  payday_offset_days          smallint not null default 5 check (payday_offset_days between 0 and 14), -- after period end
  ot_review_required          boolean not null default true,
  night_diff_mode             text not null default 'flag' check (night_diff_mode in ('flag', 'pay')),
  night_diff_rate             numeric(5, 4) not null default 0.10,
  max_session_minutes         integer not null default 960,
  pin_max_attempts            integer not null default 5,
  pin_lockout_minutes         integer not null default 15,
  device_max_failed_pins      integer not null default 15,   -- per device per 15 minutes
  pin_auth_ttl_seconds        integer not null default 90,
  device_session_days         integer not null default 180,
  site_login_max_attempts     integer not null default 10,
  site_login_lockout_minutes  integer not null default 15,
  location_stale_ms           integer not null default 120000,
  location_failure_policy     text not null default 'save_and_flag' check (location_failure_policy in ('save_and_flag', 'block')),
  holiday_lookback_days       integer not null default 7,
  policies_confirmed_at       timestamptz,
  policy_notes                text,
  updated_by                  uuid references public.app_users (id),
  updated_at                  timestamptz not null default now()
);
create trigger trg_payroll_settings_updated before update on public.payroll_settings
  for each row execute function public.set_updated_at();
insert into public.payroll_settings (id) values (1);

-- ---------------------------------------------------------------------------
-- Payroll periods, runs, results, lines, exceptions, payslips, payments
-- ---------------------------------------------------------------------------
create table public.payroll_periods (
  id          uuid primary key default gen_random_uuid(),
  start_date  date not null unique,
  end_date    date not null,
  payday      date not null,
  created_at  timestamptz not null default now(),
  check (end_date = start_date + 6),
  check (payday >= end_date)
);

create table public.payroll_runs (
  id                 uuid primary key default gen_random_uuid(),
  run_no             bigint generated always as identity unique,
  period_id          uuid not null references public.payroll_periods (id),
  site_ids           uuid[],          -- null = all sites
  status             public.payroll_status not null default 'draft',
  reissue_of_run_id  uuid references public.payroll_runs (id),
  notes              text,
  totals             jsonb not null default '{}'::jsonb,
  blocking_count     integer not null default 0,
  warning_count      integer not null default 0,
  calculated_at      timestamptz,
  calculated_by      uuid references public.app_users (id),
  submitted_at       timestamptz,
  submitted_by       uuid references public.app_users (id),
  finalized_at       timestamptz,
  finalized_by       uuid references public.app_users (id),
  paid_at            timestamptz,
  voided_at          timestamptz,
  voided_by          uuid references public.app_users (id),
  void_reason        text,
  created_by         uuid references public.app_users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger trg_payroll_runs_updated before update on public.payroll_runs
  for each row execute function public.set_updated_at();

alter table public.attendance_corrections
  add constraint attendance_corrections_run_fk foreign key (affects_finalized_run_id) references public.payroll_runs (id);
alter table public.advance_ledger
  add constraint advance_ledger_run_fk foreign key (payroll_run_id) references public.payroll_runs (id);
alter table public.contribution_ledger
  add constraint contribution_ledger_run_fk foreign key (payroll_run_id) references public.payroll_runs (id);

create table public.payroll_results (
  id                      uuid primary key default gen_random_uuid(),
  run_id                  uuid not null references public.payroll_runs (id) on delete cascade,
  employee_id             uuid not null references public.employees (id),
  primary_site_id         uuid references public.sites (id),
  employee_snapshot       jsonb not null default '{}'::jsonb,
  days_worked             integer not null default 0,
  regular_minutes         integer not null default 0,
  ot_minutes_recorded     integer not null default 0,
  ot_minutes_paid         integer not null default 0,
  undertime_minutes       integer not null default 0,
  late_minutes            integer not null default 0,
  night_minutes           integer not null default 0,
  leave_hours             numeric(6, 2) not null default 0,
  gross_pay               numeric(14, 2) not null default 0,
  total_deductions        numeric(14, 2) not null default 0,
  net_pay                 numeric(14, 2) not null default 0,
  employer_contributions  numeric(14, 2) not null default 0,
  blocking_count          integer not null default 0,
  warning_count           integer not null default 0,
  unique (run_id, employee_id)
);

create table public.payroll_lines (
  id            bigint generated always as identity primary key,
  run_id        uuid not null references public.payroll_runs (id) on delete cascade,
  result_id     uuid not null references public.payroll_results (id) on delete cascade,
  employee_id   uuid not null references public.employees (id),
  category      text not null check (category in ('earning', 'deduction', 'employer', 'info')),
  code          text not null,
  description   text not null,
  work_date     date,
  site_id       uuid references public.sites (id),
  quantity      numeric(14, 4),
  unit          text,
  rate          numeric(14, 6),
  multiplier    numeric(8, 4),
  amount        numeric(14, 2) not null default 0,
  basic_amount  numeric(14, 2) not null default 0,  -- portion counted as basic salary
  taxable       boolean not null default true,
  source        jsonb not null default '{}'::jsonb,
  sort_order    integer not null default 0
);
create index payroll_lines_result_idx on public.payroll_lines (result_id, sort_order);

create table public.payroll_exceptions (
  id           bigint generated always as identity primary key,
  run_id       uuid not null references public.payroll_runs (id) on delete cascade,
  employee_id  uuid references public.employees (id),
  work_date    date,
  code         text not null,
  message      text not null,
  blocking     boolean not null,
  source       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index payroll_exceptions_run_idx on public.payroll_exceptions (run_id, blocking);

create sequence public.payslip_seq;
create table public.payslips (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.payroll_runs (id),
  employee_id  uuid not null references public.employees (id),
  payslip_no   text not null unique,
  snapshot     jsonb not null,
  status       text not null default 'issued' check (status in ('issued', 'void')),
  issued_at    timestamptz not null default now(),
  voided_at    timestamptz,
  void_reason  text,
  unique (run_id, employee_id)
);

create table public.payment_records (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.payroll_runs (id),
  employee_id  uuid not null references public.employees (id),
  amount       numeric(14, 2) not null,
  method       text not null,
  reference    text,
  paid_at      timestamptz not null,
  recorded_by  uuid not null references public.app_users (id),
  created_at   timestamptz not null default now(),
  unique (run_id, employee_id)
);

create table public.payroll_adjustments (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.employees (id),
  period_id    uuid not null references public.payroll_periods (id),
  kind         text not null check (kind in ('earning', 'deduction')),
  description  text not null,
  amount       numeric(12, 2) not null check (amount > 0),
  taxable      boolean not null default true,
  reason       text not null check (length(trim(reason)) >= 3),
  created_by   uuid not null references public.app_users (id),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  actor_user_id  uuid,
  actor_kind     text not null default 'user',
  action         text not null,
  entity         text not null,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  context        jsonb not null default '{}'::jsonb
);
create index audit_events_entity_idx on public.audit_events (entity, entity_id, occurred_at desc);
create index audit_events_time_idx on public.audit_events (occurred_at desc);
create trigger trg_audit_events_immutable before update or delete on public.audit_events
  for each row execute function public.forbid_mutation();
