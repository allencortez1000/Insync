-- =============================================================================
-- Migration 2: access helpers, row-level security, grants, audit trail
--
-- Access model
--   * anon (the attendance app) has NO table access. It may only call the
--     security-definer site_* functions, which validate a device-session token.
--   * authenticated website users must have an active app_users row with a role.
--     Admin: everything. Staff: sites in staff_site_scopes (or all_sites = true).
--   * Secrets (PIN hashes, site password hashes, device token hashes) are never
--     readable through the API; column-level grants hide them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Access helper functions
-- ---------------------------------------------------------------------------
create or replace function public.current_role_name() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.app_users where id = auth.uid() and is_active
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where id = auth.uid() and is_active and role = 'admin')
$$;

create or replace function public.is_staff() returns boolean   -- admin or staff
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where id = auth.uid() and is_active and role is not null)
$$;

create or replace function public.has_all_sites() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users
                 where id = auth.uid() and is_active and (role = 'admin' or (role = 'staff' and all_sites)))
$$;

create or replace function public.can_access_site(p_site_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_all_sites()
      or exists (select 1 from public.staff_site_scopes s
                 join public.app_users u on u.id = s.user_id
                 where s.user_id = auth.uid() and u.is_active and u.role = 'staff' and s.site_id = p_site_id)
$$;

-- Staff can access an employee who is unassigned, or whose current/recent (35 days)
-- assignment is at one of their sites. Admin / all-site staff can access everyone.
create or replace function public.can_access_employee(p_employee_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_all_sites()
      or (public.is_staff() and (
            not exists (select 1 from public.employee_site_assignments a where a.employee_id = p_employee_id)
         or exists (select 1 from public.employee_site_assignments a
                    where a.employee_id = p_employee_id
                      and (a.effective_to is null or a.effective_to > now() - interval '35 days')
                      and public.can_access_site(a.site_id))))
$$;

create or replace function public.can_access_run(p_site_ids uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_all_sites()
      or (public.is_staff() and p_site_ids is not null and cardinality(p_site_ids) > 0
          and not exists (select 1 from unnest(p_site_ids) s(site_id) where not public.can_access_site(s.site_id)))
$$;

create or replace function public.can_access_run_id(p_run_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.can_access_run(site_ids) from public.payroll_runs where id = p_run_id), false)
$$;

create or replace function public.require_staff() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create or replace function public.require_admin() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

-- Keep at least one active admin.
create or replace function public.guard_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.is_active
     and (new.role is distinct from 'admin' or not new.is_active)
     and not exists (select 1 from public.app_users where id <> old.id and role = 'admin' and is_active) then
    raise exception 'At least one active admin is required';
  end if;
  return new;
end $$;
create trigger trg_app_users_last_admin before update on public.app_users
  for each row execute function public.guard_last_admin();

-- Run once from the Supabase SQL editor after the first admin signs up.
create or replace function public.bootstrap_admin(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update public.app_users set role = 'admin', is_active = true, all_sites = true
  where lower(email) = lower(p_email);
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'No signed-up user with email % (sign up on the admin website first)', p_email;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Audit trail (generic row trigger). Secret columns are stripped.
-- ---------------------------------------------------------------------------
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_before jsonb;
  v_after  jsonb;
  v_id     text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_before := to_jsonb(old) - 'pin_hash' - 'password_hash' - 'token_hash';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_after := to_jsonb(new) - 'pin_hash' - 'password_hash' - 'token_hash';
  end if;
  if tg_op = 'UPDATE' and v_before - 'updated_at' = v_after - 'updated_at' then
    return new;  -- no material change
  end if;
  v_id := coalesce(v_after ->> 'id', v_before ->> 'id', v_after ->> 'employee_id', v_before ->> 'employee_id');
  insert into public.audit_events (actor_user_id, actor_kind, action, entity, entity_id, before, after)
  values (auth.uid(), case when auth.uid() is null then 'system' else 'user' end,
          lower(tg_op), tg_table_name, v_id, v_before, v_after);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'app_users','staff_site_scopes','sites','site_accounts','employees','employee_site_assignments',
    'employee_rates','schedules','employee_schedules','holidays','day_type_multipliers','pin_credentials',
    'ot_decisions','leave_types','leave_entries','allowance_rules','cash_advances','advance_ledger',
    'statutory_rule_versions','payroll_settings','payroll_runs','payroll_adjustments','payment_records'
  ] loop
    execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
                    for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: anon gets nothing on tables; authenticated is governed by RLS.
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon, public;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;
-- PUBLIC's EXECUTE on new functions is a global default; per-schema rules cannot remove it.
alter default privileges revoke execute on functions from public;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.bootstrap_admin(text) from authenticated;

-- Secret-bearing tables: hide secret columns and make them read-only for the API.
revoke all on public.pin_credentials, public.site_accounts, public.device_sessions, public.pin_authorizations
  from authenticated;
grant select (employee_id, pin_version, failed_attempts, locked_until, set_at, set_by)
  on public.pin_credentials to authenticated;
grant select (id, site_id, username, is_active, failed_attempts, locked_until, password_changed_at, created_by, created_at, updated_at)
  on public.site_accounts to authenticated;
grant select (id, site_account_id, site_id, device_label, platform, app_version, created_at, last_seen_at,
              expires_at, revoked_at, revoked_by, revoke_reason)
  on public.device_sessions to authenticated;

-- Evidence / ledgers / computed payroll are written only by security-definer functions.
revoke insert, update, delete on
  public.attendance_events, public.work_sessions, public.attendance_corrections, public.security_events,
  public.contribution_ledger, public.payroll_results, public.payroll_lines, public.payroll_exceptions,
  public.payslips, public.payment_records, public.audit_events, public.employee_site_assignments,
  public.ot_decisions, public.advance_ledger, public.payroll_runs, public.payroll_periods
  from authenticated;
revoke update, delete on public.leave_ledger, public.leave_entries from authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- app_users
create policy app_users_select on public.app_users for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy app_users_update on public.app_users for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- staff_site_scopes
create policy scopes_select on public.staff_site_scopes for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy scopes_write on public.staff_site_scopes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- sites
create policy sites_select on public.sites for select to authenticated using (public.can_access_site(id));
create policy sites_insert on public.sites for insert to authenticated with check (public.is_admin());
create policy sites_update on public.sites for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- site accounts / device sessions (read-only via API)
create policy site_accounts_select on public.site_accounts for select to authenticated
  using (public.is_staff() and public.can_access_site(site_id));
create policy device_sessions_select on public.device_sessions for select to authenticated
  using (public.is_staff() and public.can_access_site(site_id));

-- employees
create policy employees_select on public.employees for select to authenticated
  using (public.can_access_employee(id));
create policy employees_insert on public.employees for insert to authenticated
  with check (public.is_staff());
create policy employees_update on public.employees for update to authenticated
  using (public.can_access_employee(id)) with check (public.can_access_employee(id));

-- assignments (writes via employee_assign_site / employee_end_assignment)
create policy esa_select on public.employee_site_assignments for select to authenticated
  using (public.can_access_employee(employee_id) or public.can_access_site(site_id));

-- rates, schedules, employee schedules
create policy rates_select on public.employee_rates for select to authenticated
  using (public.can_access_employee(employee_id));
create policy rates_insert on public.employee_rates for insert to authenticated
  with check (public.can_access_employee(employee_id));
create policy rates_update on public.employee_rates for update to authenticated
  using (public.can_access_employee(employee_id)) with check (public.can_access_employee(employee_id));
create policy rates_delete on public.employee_rates for delete to authenticated
  using (public.can_access_employee(employee_id));

create policy schedules_select on public.schedules for select to authenticated using (public.is_staff());
create policy schedules_write on public.schedules for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy emp_sched_select on public.employee_schedules for select to authenticated
  using (public.can_access_employee(employee_id));
create policy emp_sched_insert on public.employee_schedules for insert to authenticated
  with check (public.can_access_employee(employee_id));
create policy emp_sched_update on public.employee_schedules for update to authenticated
  using (public.can_access_employee(employee_id)) with check (public.can_access_employee(employee_id));
create policy emp_sched_delete on public.employee_schedules for delete to authenticated
  using (public.can_access_employee(employee_id));

-- holidays: admin manages national; staff may manage local holidays for their sites
create policy holidays_select on public.holidays for select to authenticated using (public.is_staff());
create policy holidays_insert on public.holidays for insert to authenticated
  with check (public.is_admin() or (site_id is not null and public.can_access_site(site_id)));
create policy holidays_update on public.holidays for update to authenticated
  using (public.is_admin() or (site_id is not null and public.can_access_site(site_id)))
  with check (public.is_admin() or (site_id is not null and public.can_access_site(site_id)));
create policy holidays_delete on public.holidays for delete to authenticated
  using (public.is_admin() or (site_id is not null and public.can_access_site(site_id)));

create policy multipliers_select on public.day_type_multipliers for select to authenticated using (public.is_staff());
create policy multipliers_write on public.day_type_multipliers for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- PIN status (hash column is not granted)
create policy pin_select on public.pin_credentials for select to authenticated
  using (public.can_access_employee(employee_id));

-- security events
create policy security_events_select on public.security_events for select to authenticated
  using (public.is_admin() or (site_id is not null and public.can_access_site(site_id)));

-- attendance
create policy events_select on public.attendance_events for select to authenticated
  using (public.is_staff() and public.can_access_site(site_id));
create policy sessions_select on public.work_sessions for select to authenticated
  using (public.is_staff() and public.can_access_site(site_id));
create policy corrections_select on public.attendance_corrections for select to authenticated
  using (public.is_staff() and public.can_access_site(site_id));
create policy ot_select on public.ot_decisions for select to authenticated
  using (public.can_access_employee(employee_id));

-- leave
create policy leave_types_select on public.leave_types for select to authenticated using (public.is_staff());
create policy leave_types_write on public.leave_types for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy leave_entries_select on public.leave_entries for select to authenticated
  using (public.can_access_employee(employee_id));
create policy leave_entries_insert on public.leave_entries for insert to authenticated
  with check (public.can_access_employee(employee_id) and status = 'pending' and decided_by is null);
create policy leave_ledger_select on public.leave_ledger for select to authenticated
  using (public.can_access_employee(employee_id));
create policy leave_ledger_insert on public.leave_ledger for insert to authenticated
  with check (public.can_access_employee(employee_id) and leave_entry_id is null
              and kind in ('grant','adjustment','carryover','expiry') and created_by = auth.uid());

-- allowances
create policy allowances_select on public.allowance_rules for select to authenticated
  using (public.can_access_employee(employee_id));
create policy allowances_insert on public.allowance_rules for insert to authenticated
  with check (public.can_access_employee(employee_id));
create policy allowances_update on public.allowance_rules for update to authenticated
  using (public.can_access_employee(employee_id)) with check (public.can_access_employee(employee_id));

-- cash advances
create policy advances_select on public.cash_advances for select to authenticated
  using (public.can_access_employee(employee_id));
create policy advances_insert on public.cash_advances for insert to authenticated
  with check (public.can_access_employee(employee_id) and created_by = auth.uid() and status = 'active');
create policy advances_update on public.cash_advances for update to authenticated
  using (public.can_access_employee(employee_id)) with check (public.can_access_employee(employee_id));
create policy advance_ledger_select on public.advance_ledger for select to authenticated
  using (exists (select 1 from public.cash_advances a where a.id = advance_id and public.can_access_employee(a.employee_id)));

-- statutory rules / ledger
create policy rules_select on public.statutory_rule_versions for select to authenticated using (public.is_staff());
create policy rules_insert on public.statutory_rule_versions for insert to authenticated
  with check (public.is_admin() and status = 'draft');
create policy rules_update on public.statutory_rule_versions for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy rules_delete on public.statutory_rule_versions for delete to authenticated using (public.is_admin());
create policy contrib_select on public.contribution_ledger for select to authenticated
  using (public.can_access_employee(employee_id) or public.can_access_run_id(payroll_run_id));

-- settings
create policy settings_select on public.payroll_settings for select to authenticated using (public.is_staff());
create policy settings_update on public.payroll_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- payroll
create policy periods_select on public.payroll_periods for select to authenticated using (public.is_staff());
create policy runs_select on public.payroll_runs for select to authenticated using (public.can_access_run(site_ids));
create policy results_select on public.payroll_results for select to authenticated using (public.can_access_run_id(run_id));
create policy lines_select on public.payroll_lines for select to authenticated using (public.can_access_run_id(run_id));
create policy exceptions_select on public.payroll_exceptions for select to authenticated using (public.can_access_run_id(run_id));
create policy payslips_select on public.payslips for select to authenticated using (public.can_access_run_id(run_id));
create policy payments_select on public.payment_records for select to authenticated using (public.can_access_run_id(run_id));

create policy adjustments_select on public.payroll_adjustments for select to authenticated
  using (public.can_access_employee(employee_id));
create policy adjustments_insert on public.payroll_adjustments for insert to authenticated
  with check (public.can_access_employee(employee_id) and created_by = auth.uid());
create policy adjustments_delete on public.payroll_adjustments for delete to authenticated
  using (public.can_access_employee(employee_id));

-- audit: admin only
create policy audit_select on public.audit_events for select to authenticated using (public.is_admin());
