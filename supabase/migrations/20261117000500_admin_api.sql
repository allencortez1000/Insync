-- =============================================================================
-- Migration 5: admin / staff website API, integrity guards, and views
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Finalized-period helpers and guards
-- ---------------------------------------------------------------------------
-- Finalized / paid run that contains this employee for the period covering p_date.
create or replace function public._finalized_run_for(p_employee_id uuid, p_date date) returns uuid
language sql stable as $$
  select u.id
  from public.payroll_results r
  join public.payroll_runs u on u.id = r.run_id and u.status in ('finalized', 'paid')
  join public.payroll_periods p on p.id = u.period_id
  where r.employee_id = p_employee_id and p_date between p.start_date and p.end_date
  limit 1
$$;

create or replace function public._finalized_through(p_employee_id uuid) returns date
language sql stable as $$
  select max(p.end_date)
  from public.payroll_results r
  join public.payroll_runs u on u.id = r.run_id and u.status in ('finalized', 'paid')
  join public.payroll_periods p on p.id = u.period_id
  where r.employee_id = p_employee_id
$$;

-- Rate / schedule history cannot change on dates already covered by finalized payroll.
create or replace function public.guard_effective_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_emp  uuid := coalesce(new.employee_id, old.employee_id);
  v_thru date := public._finalized_through(v_emp);
  v_from date;
begin
  if tg_op = 'DELETE' then v_from := old.effective_from;
  elsif tg_op = 'INSERT' then v_from := new.effective_from;
  else v_from := least(old.effective_from, new.effective_from);
  end if;
  if v_thru is not null and v_from <= v_thru then
    raise exception 'Payroll is finalized through % for this employee. Changes effective on or before that date require voiding and reissuing the affected payroll.', v_thru;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_guard_rates before insert or update or delete on public.employee_rates
  for each row execute function public.guard_effective_history();
create trigger trg_guard_emp_schedules before insert or update or delete on public.employee_schedules
  for each row execute function public.guard_effective_history();

create or replace function public.guard_payroll_adjustment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_row public.payroll_adjustments := coalesce(new, old);
begin
  if exists (select 1 from public.payroll_results r
             join public.payroll_runs u on u.id = r.run_id and u.status in ('finalized', 'paid')
             where u.period_id = v_row.period_id and r.employee_id = v_row.employee_id) then
    raise exception 'Payroll for this period is finalized; use void and reissue to change it';
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_guard_adjustments before insert or update or delete on public.payroll_adjustments
  for each row execute function public.guard_payroll_adjustment();

-- Deactivating an employee with an open session requires staff resolution first.
create or replace function public.guard_employee_deactivation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.is_active and not new.is_active
     and exists (select 1 from public.work_sessions where employee_id = new.id and status = 'open') then
    raise exception 'Employee has an open attendance session. Close or correct it before deactivating.';
  end if;
  if not new.is_active then
    delete from public.pin_authorizations where employee_id = new.id and used_at is null;
  end if;
  return new;
end $$;
create trigger trg_guard_employee_deactivation before update of is_active on public.employees
  for each row execute function public.guard_employee_deactivation();

-- ---------------------------------------------------------------------------
-- Site accounts and device sessions
-- ---------------------------------------------------------------------------
create or replace function public.admin_upsert_site_account(p_site_id uuid, p_username text, p_password text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid  uuid := public.require_admin();
  v_user text := lower(trim(p_username));
  v_id   uuid;
begin
  if p_password is null or length(p_password) < 10 then
    raise exception 'Site password must be at least 10 characters';
  end if;
  select id into v_id from public.site_accounts where site_id = p_site_id;
  if v_id is null then
    insert into public.site_accounts (site_id, username, password_hash, created_by)
    values (p_site_id, v_user, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), v_uid)
    returning id into v_id;
  else
    update public.site_accounts
       set username = v_user, password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
           password_changed_at = now(), failed_attempts = 0, locked_until = null
     where id = v_id;
    update public.device_sessions set revoked_at = now(), revoked_by = v_uid, revoke_reason = 'Site credentials changed'
     where site_account_id = v_id and revoked_at is null;
  end if;
  insert into public.security_events (kind, site_id, actor_user_id, details)
  values ('site_credentials_set', p_site_id, v_uid, jsonb_build_object('username', v_user));
  return v_id;
end $$;

create or replace function public.admin_set_site_account_active(p_site_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_admin();
begin
  update public.site_accounts set is_active = p_active, failed_attempts = 0, locked_until = null where site_id = p_site_id;
  if not found then raise exception 'Site has no attendance account'; end if;
  if not p_active then
    update public.device_sessions set revoked_at = now(), revoked_by = v_uid, revoke_reason = 'Site account disabled'
     where site_id = p_site_id and revoked_at is null;
  end if;
end $$;

create or replace function public.revoke_device_session(p_session_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := public.require_staff();
  v_site uuid;
begin
  select site_id into v_site from public.device_sessions where id = p_session_id;
  if v_site is null or not public.can_access_site(v_site) then
    raise exception 'Device session not found';
  end if;
  update public.device_sessions set revoked_at = now(), revoked_by = v_uid, revoke_reason = coalesce(p_reason, 'Revoked by staff')
   where id = p_session_id and revoked_at is null;
  delete from public.pin_authorizations where device_session_id = p_session_id and used_at is null;
  insert into public.security_events (kind, site_id, device_session_id, actor_user_id, details)
  values ('session_revoked', v_site, p_session_id, v_uid, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------------
-- Employee PINs (stored only as bcrypt hashes; never readable)
-- ---------------------------------------------------------------------------
create or replace function public._pin_is_weak(p_pin text) returns boolean
language sql immutable as $$
  select p_pin ~ '^(\d)\1{5}$'
      or p_pin in ('012345','123456','234567','345678','456789','567890',
                   '987654','876543','765432','654321','543210','098765','121212','112233')
$$;

create or replace function public.set_employee_pin(p_employee_id uuid, p_pin text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := public.require_staff();
begin
  if not public.can_access_employee(p_employee_id) then
    raise exception 'Employee not found';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN must be exactly 6 digits';
  end if;
  if public._pin_is_weak(p_pin) then
    raise exception 'PIN is too easy to guess; choose another';
  end if;
  insert into public.pin_credentials (employee_id, pin_hash, pin_version, failed_attempts, locked_until, set_at, set_by)
  values (p_employee_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), 1, 0, null, now(), v_uid)
  on conflict (employee_id) do update
    set pin_hash = excluded.pin_hash, pin_version = public.pin_credentials.pin_version + 1,
        failed_attempts = 0, locked_until = null, set_at = now(), set_by = v_uid;
  delete from public.pin_authorizations where employee_id = p_employee_id and used_at is null;
  insert into public.security_events (kind, employee_id, actor_user_id, site_id)
  values ('pin_reset', p_employee_id, v_uid, public._site_on(p_employee_id, public.ph_date(now())));
end $$;

-- Generates a random non-trivial PIN, sets it, and returns it once for secure handover.
create or replace function public.generate_employee_pin(p_employee_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_pin text;
begin
  perform public.require_staff();
  loop
    v_pin := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
    exit when not public._pin_is_weak(v_pin);
  end loop;
  perform public.set_employee_pin(p_employee_id, v_pin);
  return v_pin;
end $$;

create or replace function public.unlock_employee_pin(p_employee_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_staff();
begin
  if not public.can_access_employee(p_employee_id) then
    raise exception 'Employee not found';
  end if;
  update public.pin_credentials set failed_attempts = 0, locked_until = null where employee_id = p_employee_id;
  insert into public.security_events (kind, employee_id, actor_user_id) values ('pin_unlocked', p_employee_id, v_uid);
end $$;

-- ---------------------------------------------------------------------------
-- Site assignments (one active at a time, effective-dated)
-- ---------------------------------------------------------------------------
create or replace function public.employee_assign_site(
  p_employee_id uuid, p_site_id uuid, p_effective_from timestamptz default now(),
  p_reason text default null, p_permit_origin_close boolean default false)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := public.require_staff();
  v_from timestamptz := coalesce(p_effective_from, now());
  v_cur  public.employee_site_assignments;
  v_open public.work_sessions;
  v_id   uuid;
begin
  if not public.can_access_employee(p_employee_id) or not public.can_access_site(p_site_id) then
    raise exception 'Employee or site not accessible';
  end if;
  if not exists (select 1 from public.employees where id = p_employee_id and is_active) then
    raise exception 'Employee is inactive';
  end if;
  if exists (select 1 from public.employee_site_assignments where employee_id = p_employee_id and effective_from >= v_from) then
    raise exception 'A later assignment already exists; transfers must be after the latest assignment start';
  end if;

  select * into v_cur from public.employee_site_assignments
   where employee_id = p_employee_id and (effective_to is null or effective_to > v_from)
   order by effective_from desc limit 1;
  if v_cur.id is not null and v_cur.site_id = p_site_id then
    raise exception 'Employee is already assigned to this site';
  end if;

  select * into v_open from public.work_sessions where employee_id = p_employee_id and status = 'open';
  if v_open.id is not null and v_open.site_id <> p_site_id then
    if not p_permit_origin_close then
      raise exception 'Employee has an open session at the current site. Close it first, or permit closing it at the original site.';
    end if;
    update public.work_sessions set allow_origin_close = true where id = v_open.id;
  end if;

  if v_cur.id is not null then
    update public.employee_site_assignments set effective_to = v_from where id = v_cur.id;
  end if;
  insert into public.employee_site_assignments (employee_id, site_id, effective_from, reason, created_by)
  values (p_employee_id, p_site_id, v_from, p_reason, v_uid)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.employee_end_assignment(p_employee_id uuid, p_effective_to timestamptz default now(), p_reason text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_staff();
  v_cur public.employee_site_assignments;
begin
  select * into v_cur from public.employee_site_assignments
   where employee_id = p_employee_id and (effective_to is null or effective_to > coalesce(p_effective_to, now()))
   order by effective_from desc limit 1;
  if v_cur.id is null then raise exception 'No active assignment'; end if;
  if not public.can_access_site(v_cur.site_id) then raise exception 'Not authorized'; end if;
  if coalesce(p_effective_to, now()) <= v_cur.effective_from then
    raise exception 'End time must be after the assignment start';
  end if;
  if exists (select 1 from public.work_sessions where employee_id = p_employee_id and status = 'open' and not allow_origin_close) then
    raise exception 'Employee has an open session. Close or correct it first.';
  end if;
  update public.employee_site_assignments
     set effective_to = coalesce(p_effective_to, now()),
         reason = coalesce(reason || '; ', '') || coalesce('ended: ' || p_reason, 'ended')
   where id = v_cur.id;
end $$;

-- ---------------------------------------------------------------------------
-- Attendance corrections (original events are never changed)
-- ---------------------------------------------------------------------------
create or replace function public._session_flags(p_in timestamptz, p_out timestamptz, p_existing text[]) returns text[]
language sql stable set search_path = public as $$
  select coalesce(array_agg(distinct f), '{}') from unnest(
    array_remove(coalesce(p_existing, '{}'), 'long_session') ||
    case when p_out is not null and extract(epoch from (p_out - p_in)) / 60 >
              (select max_session_minutes from public.payroll_settings where id = 1)
         then array['long_session'] else '{}'::text[] end) f
$$;

create or replace function public.attendance_create_session(
  p_employee_id uuid, p_site_id uuid, p_clock_in timestamptz, p_clock_out timestamptz, p_reason text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_staff();
  v_id  uuid;
  v_row public.work_sessions;
begin
  if not public.can_access_site(p_site_id) or not public.can_access_employee(p_employee_id) then
    raise exception 'Employee or site not accessible';
  end if;
  if p_clock_in is null or p_clock_in > now() or (p_clock_out is not null and p_clock_out > now()) then
    raise exception 'Times must be in the past';
  end if;
  begin
    insert into public.work_sessions (employee_id, site_id, status, clock_in_at, clock_out_at, source, review_flags,
                                      reviewed_at, reviewed_by, review_note)
    values (p_employee_id, p_site_id, case when p_clock_out is null then 'open' else 'closed' end::public.session_status,
            p_clock_in, p_clock_out, 'correction', public._session_flags(p_clock_in, p_clock_out, '{}'),
            now(), v_uid, p_reason)
    returning * into v_row;
  exception
    when exclusion_violation then raise exception 'The session overlaps another attendance session for this employee';
    when unique_violation then raise exception 'Employee already has an open session';
    when check_violation then raise exception 'Clock-out must be after clock-in';
  end;
  v_id := v_row.id;
  insert into public.attendance_corrections (work_session_id, employee_id, site_id, kind, before, after, reason,
                                             affects_finalized_run_id, created_by)
  values (v_id, p_employee_id, p_site_id, 'create_session', null, to_jsonb(v_row), p_reason,
          public._finalized_run_for(p_employee_id, public.ph_date(p_clock_in)), v_uid);
  return v_id;
end $$;

create or replace function public.attendance_edit_session(
  p_session_id uuid, p_clock_in timestamptz, p_clock_out timestamptz, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := public.require_staff();
  v_before public.work_sessions;
  v_after  public.work_sessions;
begin
  select * into v_before from public.work_sessions where id = p_session_id for update;
  if v_before.id is null or not public.can_access_site(v_before.site_id) then
    raise exception 'Session not found';
  end if;
  if v_before.status = 'voided' then raise exception 'Voided sessions cannot be edited'; end if;
  if p_clock_in is null or p_clock_in > now() or (p_clock_out is not null and p_clock_out > now()) then
    raise exception 'Times must be in the past';
  end if;
  begin
    update public.work_sessions set
      clock_in_at = p_clock_in,
      clock_out_at = p_clock_out,
      status = case when p_clock_out is null then 'open' else 'closed' end::public.session_status,
      review_flags = public._session_flags(p_clock_in, p_clock_out, review_flags),
      reviewed_at = now(), reviewed_by = v_uid, review_note = p_reason,
      allow_origin_close = case when p_clock_out is null then allow_origin_close else false end
    where id = p_session_id
    returning * into v_after;
  exception
    when exclusion_violation then raise exception 'The edited session overlaps another attendance session';
    when unique_violation then raise exception 'Employee already has another open session';
    when check_violation then raise exception 'Clock-out must be after clock-in';
  end;
  insert into public.attendance_corrections (work_session_id, employee_id, site_id, kind, before, after, reason,
                                             affects_finalized_run_id, created_by)
  values (p_session_id, v_before.employee_id, v_before.site_id,
          case when v_before.status = 'open' and v_after.status = 'closed' then 'close_session' else 'edit_times' end,
          to_jsonb(v_before), to_jsonb(v_after), p_reason,
          coalesce(public._finalized_run_for(v_before.employee_id, public.ph_date(v_before.clock_in_at)),
                   public._finalized_run_for(v_before.employee_id, public.ph_date(p_clock_in))),
          v_uid);
end $$;

create or replace function public.attendance_void_session(p_session_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := public.require_staff();
  v_before public.work_sessions;
  v_after  public.work_sessions;
begin
  select * into v_before from public.work_sessions where id = p_session_id for update;
  if v_before.id is null or not public.can_access_site(v_before.site_id) then
    raise exception 'Session not found';
  end if;
  if v_before.status = 'voided' then raise exception 'Session is already voided'; end if;
  update public.work_sessions set status = 'voided', reviewed_at = now(), reviewed_by = v_uid, review_note = p_reason
   where id = p_session_id returning * into v_after;
  insert into public.attendance_corrections (work_session_id, employee_id, site_id, kind, before, after, reason,
                                             affects_finalized_run_id, created_by)
  values (p_session_id, v_before.employee_id, v_before.site_id, 'void_session', to_jsonb(v_before), to_jsonb(v_after), p_reason,
          public._finalized_run_for(v_before.employee_id, public.ph_date(v_before.clock_in_at)), v_uid);
end $$;

create or replace function public.attendance_mark_reviewed(p_session_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := public.require_staff();
  v_before public.work_sessions;
  v_after  public.work_sessions;
begin
  select * into v_before from public.work_sessions where id = p_session_id for update;
  if v_before.id is null or not public.can_access_site(v_before.site_id) then
    raise exception 'Session not found';
  end if;
  update public.work_sessions set reviewed_at = now(), reviewed_by = v_uid, review_note = p_note
   where id = p_session_id returning * into v_after;
  insert into public.attendance_corrections (work_session_id, employee_id, site_id, kind, before, after, reason, created_by)
  values (p_session_id, v_before.employee_id, v_before.site_id, 'mark_reviewed', to_jsonb(v_before), to_jsonb(v_after), p_note, v_uid);
end $$;

-- ---------------------------------------------------------------------------
-- Overtime review
-- ---------------------------------------------------------------------------
-- Refreshes pending OT candidates (extra time beyond 8 worked hours) for a date range.
create or replace function public.ot_refresh(p_from date, p_to date) returns integer
language plpgsql security definer set search_path = public as $$
declare
  r       record;
  v_w     jsonb;
  v_count integer := 0;
begin
  perform public.require_staff();
  if p_to < p_from or p_to - p_from > 62 then raise exception 'Choose a range of up to 62 days'; end if;
  for r in select distinct w.employee_id, public.ph_date(w.clock_in_at) as work_date
           from public.work_sessions w
           where w.status = 'closed' and public.can_access_site(w.site_id)
             and public.ph_date(w.clock_in_at) between p_from and p_to loop
    v_w := public._work_day(r.employee_id, r.work_date);
    if (v_w ->> 'ot')::integer > 0 then
      insert into public.ot_decisions (employee_id, work_date, recorded_minutes)
      values (r.employee_id, r.work_date, (v_w ->> 'ot')::integer)
      on conflict (employee_id, work_date) do update
        set recorded_minutes = excluded.recorded_minutes, accepted_minutes = 0
        where public.ot_decisions.status = 'pending' and public.ot_decisions.recorded_minutes <> excluded.recorded_minutes;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

create or replace function public.ot_decide(
  p_employee_id uuid, p_work_date date, p_status public.ot_status, p_accepted_minutes integer, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_staff();
  v_w   jsonb;
  v_rec integer;
  v_acc integer;
begin
  if not public.can_access_employee(p_employee_id) then raise exception 'Employee not found'; end if;
  if public._finalized_run_for(p_employee_id, p_work_date) is not null then
    raise exception 'Payroll for this date is finalized; use void and reissue to change OT';
  end if;
  v_w := public._work_day(p_employee_id, p_work_date);
  v_rec := (v_w ->> 'ot')::integer;
  if v_rec <= 0 then raise exception 'No extra time recorded beyond 8 hours on %', p_work_date; end if;
  v_acc := case p_status when 'accepted' then least(coalesce(p_accepted_minutes, v_rec), v_rec) else 0 end;
  if v_acc < 0 then raise exception 'Accepted minutes cannot be negative'; end if;
  if (p_status in ('rejected', 'disputed') or (p_status = 'accepted' and v_acc < v_rec))
     and coalesce(length(trim(p_reason)), 0) < 3 then
    raise exception 'A reason is required when OT is not fully accepted';
  end if;
  insert into public.ot_decisions (employee_id, work_date, recorded_minutes, accepted_minutes, status, reason, decided_by, decided_at)
  values (p_employee_id, p_work_date, v_rec, v_acc, p_status, nullif(trim(p_reason), ''), v_uid, now())
  on conflict (employee_id, work_date) do update
    set recorded_minutes = excluded.recorded_minutes, accepted_minutes = excluded.accepted_minutes,
        status = excluded.status, reason = excluded.reason, decided_by = v_uid, decided_at = now();
end $$;

-- ---------------------------------------------------------------------------
-- Leave decisions and balance ledger
-- ---------------------------------------------------------------------------
create or replace function public.leave_decide(p_entry_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := public.require_staff();
  v_e    public.leave_entries;
  v_t    public.leave_types;
  v_bal  numeric;
  v_days numeric;
begin
  select * into v_e from public.leave_entries where id = p_entry_id for update;
  if v_e.id is null or not public.can_access_employee(v_e.employee_id) then raise exception 'Leave entry not found'; end if;
  if v_e.status <> 'pending' then raise exception 'Leave entry is already %', v_e.status; end if;
  if public._finalized_run_for(v_e.employee_id, v_e.leave_date) is not null then
    raise exception 'Payroll for this date is finalized; use void and reissue';
  end if;
  select * into v_t from public.leave_types where id = v_e.leave_type_id;
  v_days := round(v_e.hours / 8, 3);

  if p_approve then
    if v_t.requires_balance then
      select coalesce(sum(days), 0) into v_bal from public.leave_ledger
       where employee_id = v_e.employee_id and leave_type_id = v_e.leave_type_id;
      if v_bal < v_days then
        raise exception 'Insufficient % balance: % day(s) available, % needed', v_t.name, v_bal, v_days;
      end if;
    end if;
    update public.leave_entries set status = 'approved', decided_by = v_uid, decided_at = now(), decision_note = p_note
     where id = p_entry_id;
    if v_t.requires_balance then
      insert into public.leave_ledger (employee_id, leave_type_id, entry_date, days, kind, leave_entry_id, note, created_by)
      values (v_e.employee_id, v_e.leave_type_id, v_e.leave_date, -v_days, 'use', p_entry_id, p_note, v_uid);
    end if;
  else
    if coalesce(length(trim(p_note)), 0) < 3 then raise exception 'A reason is required to reject leave'; end if;
    update public.leave_entries set status = 'rejected', decided_by = v_uid, decided_at = now(), decision_note = p_note
     where id = p_entry_id;
  end if;
end $$;

create or replace function public.leave_cancel(p_entry_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_staff();
  v_e   public.leave_entries;
begin
  select * into v_e from public.leave_entries where id = p_entry_id for update;
  if v_e.id is null or not public.can_access_employee(v_e.employee_id) then raise exception 'Leave entry not found'; end if;
  if v_e.status not in ('pending', 'approved') then raise exception 'Leave entry is already %', v_e.status; end if;
  if coalesce(length(trim(p_reason)), 0) < 3 then raise exception 'A reason is required'; end if;
  if v_e.status = 'approved' and public._finalized_run_for(v_e.employee_id, v_e.leave_date) is not null then
    raise exception 'Payroll for this date is finalized; use void and reissue';
  end if;
  update public.leave_entries set status = 'cancelled', decided_by = v_uid, decided_at = now(), decision_note = p_reason
   where id = p_entry_id;
  insert into public.leave_ledger (employee_id, leave_type_id, entry_date, days, kind, leave_entry_id, note, created_by)
  select employee_id, leave_type_id, current_date, -days, 'reversal', p_entry_id, p_reason, v_uid
  from public.leave_ledger where leave_entry_id = p_entry_id and kind = 'use';
end $$;

-- ---------------------------------------------------------------------------
-- Cash advances
-- ---------------------------------------------------------------------------
create or replace function public.advance_adjust(p_advance_id uuid, p_amount numeric, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_staff();
  v_a   public.cash_advances;
  v_bal numeric;
begin
  select * into v_a from public.cash_advances where id = p_advance_id for update;
  if v_a.id is null or not public.can_access_employee(v_a.employee_id) then raise exception 'Advance not found'; end if;
  if coalesce(length(trim(p_note)), 0) < 3 then raise exception 'A reason is required'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Amount must not be zero'; end if;
  select coalesce(sum(amount), 0) into v_bal from public.advance_ledger where advance_id = p_advance_id;
  if v_bal + p_amount < 0 then raise exception 'Adjustment would make the balance negative (balance %)', v_bal; end if;
  insert into public.advance_ledger (advance_id, kind, amount, note, created_by)
  values (p_advance_id, 'adjustment', p_amount, p_note, v_uid);
  update public.cash_advances set status = case when v_bal + p_amount = 0 then 'completed' else 'active' end
   where id = p_advance_id and status <> 'cancelled';
end $$;

-- Prevent direct edits of advance terms that would desynchronize the ledger.
create or replace function public.guard_cash_advance() returns trigger
language plpgsql as $$
begin
  if new.principal is distinct from old.principal or new.employee_id is distinct from old.employee_id
     or new.released_on is distinct from old.released_on then
    raise exception 'Principal, employee and release date cannot be changed; record an adjustment instead';
  end if;
  return new;
end $$;
create trigger trg_guard_cash_advance before update on public.cash_advances
  for each row execute function public.guard_cash_advance();

-- ---------------------------------------------------------------------------
-- Statutory rule lifecycle
-- ---------------------------------------------------------------------------
create or replace function public.rule_approve(p_rule_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_admin();
  v_r   public.statutory_rule_versions;
  v_req text[];
  v_k   text;
begin
  select * into v_r from public.statutory_rule_versions where id = p_rule_id for update;
  if v_r.id is null then raise exception 'Rule not found'; end if;
  if v_r.status <> 'draft' then raise exception 'Only draft rules can be approved'; end if;
  v_req := case v_r.agency
    when 'sss'        then array['basis','employee_rate','employer_rate','msc_min','msc_max','msc_step','ec_threshold','ec_low','ec_high']
    when 'philhealth' then array['basis','rate','employee_share','floor','ceiling']
    when 'pagibig'    then array['basis','employee_rate','employee_rate_low','employer_rate','low_threshold','max_fund_salary']
    else array['period','brackets'] end;
  foreach v_k in array v_req loop
    if not (v_r.params ? v_k) then raise exception 'Rule parameters are missing "%"', v_k; end if;
  end loop;
  if v_r.agency = 'bir_withholding' and v_r.params ->> 'period' <> 'weekly' then
    raise exception 'Withholding table must be the weekly table for weekly payroll';
  end if;
  if exists (select 1 from public.statutory_rule_versions o
             where o.agency = v_r.agency and o.status = 'approved' and o.id <> v_r.id
               and daterange(o.effective_from, o.effective_to, '[]') && daterange(v_r.effective_from, v_r.effective_to, '[]')) then
    raise exception 'Another approved % rule overlaps these dates; set its end date first', v_r.agency;
  end if;
  update public.statutory_rule_versions set status = 'approved', approved_by = v_uid, approved_at = now() where id = p_rule_id;
end $$;

create or replace function public.rule_retire(p_rule_id uuid, p_effective_to date default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if p_effective_to is null then
    update public.statutory_rule_versions set status = 'retired' where id = p_rule_id and status <> 'retired';
  else
    update public.statutory_rule_versions set effective_to = p_effective_to where id = p_rule_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Website users and access
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user_access(
  p_user_id uuid, p_role public.app_role, p_is_active boolean, p_all_sites boolean,
  p_site_ids uuid[] default '{}', p_full_name text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.app_users set
    role = p_role, is_active = p_is_active,
    all_sites = case when p_role = 'admin' then true else coalesce(p_all_sites, false) end,
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name)
  where id = p_user_id;
  if not found then raise exception 'User not found'; end if;
  delete from public.staff_site_scopes where user_id = p_user_id;
  if p_role = 'staff' and not coalesce(p_all_sites, false) then
    insert into public.staff_site_scopes (user_id, site_id)
    select p_user_id, unnest(coalesce(p_site_ids, '{}')) on conflict do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Views (security_invoker: row-level security of the caller applies)
-- ---------------------------------------------------------------------------
create or replace view public.v_employee_overview with (security_invoker = true) as
select e.*,
       a.site_id      as current_site_id,
       s.name         as current_site_name,
       s.code         as current_site_code,
       a.effective_from as assigned_since,
       r.daily_rate   as current_daily_rate,
       r.effective_from as rate_since,
       sc.name        as current_schedule_name,
       pc.set_at      as pin_set_at,
       pc.locked_until as pin_locked_until,
       (pc.employee_id is not null) as has_pin,
       ws.id          as open_session_id,
       ws.clock_in_at as open_since
from public.employees e
left join lateral (select * from public.employee_site_assignments x
                   where x.employee_id = e.id and x.effective_from <= now() and (x.effective_to is null or x.effective_to > now())
                   limit 1) a on true
left join public.sites s on s.id = a.site_id
left join lateral (select * from public.employee_rates x
                   where x.employee_id = e.id and x.effective_from <= public.ph_date(now())
                   order by x.effective_from desc limit 1) r on true
left join lateral (select sch.name from public.employee_schedules x join public.schedules sch on sch.id = x.schedule_id
                   where x.employee_id = e.id and x.effective_from <= public.ph_date(now())
                   order by x.effective_from desc limit 1) sc on true
left join lateral (select p.employee_id, p.set_at, p.locked_until from public.pin_credentials p where p.employee_id = e.id) pc on true
left join lateral (select w.id, w.clock_in_at from public.work_sessions w where w.employee_id = e.id and w.status = 'open') ws on true;

create or replace view public.v_work_sessions with (security_invoker = true) as
select w.*,
       public.ph_date(w.clock_in_at) as work_date,
       e.employee_code, e.display_name as employee_name,
       s.code as site_code, s.name as site_name,
       case when w.clock_out_at is not null
            then (extract(epoch from (date_trunc('minute', w.clock_out_at) - date_trunc('minute', w.clock_in_at))) / 60)::integer end
         as elapsed_minutes,
       ein.location_status as in_location_status, ein.latitude as in_latitude, ein.longitude as in_longitude,
       ein.accuracy_m as in_accuracy_m,
       eout.location_status as out_location_status, eout.latitude as out_latitude, eout.longitude as out_longitude,
       eout.accuracy_m as out_accuracy_m,
       ds_in.device_label as in_device_label
from public.work_sessions w
join public.employees e on e.id = w.employee_id
join public.sites s on s.id = w.site_id
left join public.attendance_events ein on ein.id = w.clock_in_event_id
left join public.attendance_events eout on eout.id = w.clock_out_event_id
left join public.device_sessions ds_in on ds_in.id = ein.device_session_id;

create or replace view public.v_leave_balances with (security_invoker = true) as
select l.employee_id, l.leave_type_id, t.code as leave_code, t.name as leave_name, sum(l.days) as balance_days
from public.leave_ledger l join public.leave_types t on t.id = l.leave_type_id
group by l.employee_id, l.leave_type_id, t.code, t.name;

create or replace view public.v_advance_balances with (security_invoker = true) as
select a.*, e.display_name as employee_name, e.employee_code,
       coalesce((select sum(l.amount) from public.advance_ledger l where l.advance_id = a.id), 0) as balance,
       coalesce((select -sum(l.amount) from public.advance_ledger l where l.advance_id = a.id and l.kind in ('repayment', 'reversal')), 0) as repaid
from public.cash_advances a join public.employees e on e.id = a.employee_id;

-- Attendance corrections recorded after the affected payroll was finalized.
create or replace view public.v_payroll_impacts with (security_invoker = true) as
select c.id as correction_id, c.created_at, c.kind, c.reason, c.employee_id, e.display_name as employee_name,
       c.affects_finalized_run_id as run_id, u.run_no, u.status as run_status, p.start_date, p.end_date
from public.attendance_corrections c
join public.payroll_runs u on u.id = c.affects_finalized_run_id
join public.payroll_periods p on p.id = u.period_id
join public.employees e on e.id = c.employee_id
where u.status in ('finalized', 'paid');

create or replace view public.v_payroll_runs with (security_invoker = true) as
select u.*, p.start_date, p.end_date, p.payday,
       (select string_agg(s.name, ', ' order by s.name) from public.sites s where s.id = any (u.site_ids)) as site_names
from public.payroll_runs u join public.payroll_periods p on p.id = u.period_id;

-- Dashboard counters (caller's scope applies).
create or replace function public.dashboard_summary() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'open_sessions',        (select count(*) from public.work_sessions where status = 'open'),
    'stale_open_sessions',  (select count(*) from public.work_sessions where status = 'open'
                               and clock_in_at < now() - make_interval(mins => (select max_session_minutes from public.payroll_settings))),
    'punches_today',        (select count(*) from public.attendance_events where public.ph_date(server_time) = public.ph_date(now())),
    'unreviewed_flags',     (select count(*) from public.work_sessions where cardinality(review_flags) > 0 and reviewed_at is null and status <> 'voided'),
    'pending_ot',           (select count(*) from public.ot_decisions where status in ('pending', 'disputed')),
    'pending_leave',        (select count(*) from public.leave_entries where status = 'pending'),
    'lockouts_24h',         (select count(*) from public.security_events where kind in ('pin_lockout', 'site_login_locked') and created_at > now() - interval '24 hours'),
    'failed_pins_24h',      (select count(*) from public.security_events where kind = 'pin_failed' and created_at > now() - interval '24 hours'),
    'runs_in_progress',     (select count(*) from public.payroll_runs where status in ('draft', 'ready_for_review')),
    'runs_awaiting_payment',(select count(*) from public.payroll_runs where status = 'finalized'),
    'payroll_impacts',      (select count(*) from public.v_payroll_impacts),
    'draft_rules',          (select count(*) from public.statutory_rule_versions where status = 'draft'),
    'active_employees',     (select count(*) from public.employees where is_active),
    'active_devices',       (select count(*) from public.device_sessions where revoked_at is null and expires_at > now()
                               and last_seen_at > now() - interval '1 day'))
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like '\_%' escape '\' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant select on public.v_employee_overview, public.v_work_sessions, public.v_leave_balances,
                public.v_advance_balances, public.v_payroll_impacts, public.v_payroll_runs to authenticated;
revoke all on public.v_employee_overview, public.v_work_sessions, public.v_leave_balances,
              public.v_advance_balances, public.v_payroll_impacts, public.v_payroll_runs from anon;

grant execute on function
  public.admin_upsert_site_account(uuid, text, text),
  public.admin_set_site_account_active(uuid, boolean),
  public.revoke_device_session(uuid, text),
  public.set_employee_pin(uuid, text),
  public.generate_employee_pin(uuid),
  public.unlock_employee_pin(uuid),
  public.employee_assign_site(uuid, uuid, timestamptz, text, boolean),
  public.employee_end_assignment(uuid, timestamptz, text),
  public.attendance_create_session(uuid, uuid, timestamptz, timestamptz, text),
  public.attendance_edit_session(uuid, timestamptz, timestamptz, text),
  public.attendance_void_session(uuid, text),
  public.attendance_mark_reviewed(uuid, text),
  public.ot_refresh(date, date),
  public.ot_decide(uuid, date, public.ot_status, integer, text),
  public.leave_decide(uuid, boolean, text),
  public.leave_cancel(uuid, text),
  public.advance_adjust(uuid, numeric, text),
  public.rule_approve(uuid),
  public.rule_retire(uuid, date),
  public.admin_set_user_access(uuid, public.app_role, boolean, boolean, uuid[], text),
  public.dashboard_summary(),
  public.is_admin(), public.is_staff(), public.current_role_name()
to authenticated;
