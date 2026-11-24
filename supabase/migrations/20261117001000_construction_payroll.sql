-- =============================================================================
-- Migration 10: "Construction" payroll computation (Construction_Computations_Only.pdf)
--
-- Per work date (date of clock-in, Philippine time):
--   gross hours  = (time-out − time-in) in minutes ÷ 60
--   lunch        = 1 h if gross ≥ 8 h, else 0
--   worked hours = floor(gross − lunch)            regular hours = min(worked, 8)
--   auto OT      = R2(max(0, gross − 9))
--   Sunday (by calendar date) is the rest day.
-- Per pay period and daily rate D:
--   normal days = non-Sunday regular hours ÷ 8 (+ paid leave hours ÷ 8)
--   rest days   = Sunday regular hours ÷ 8
--   normal wages = R2(D × normal days)        rest-day rate  = R2(D × 1.30)
--   rest wages   = R2(rest-day rate × rest days)
--   normal OT rate = R2(D ÷ 8 × 1.25)         rest OT rate  = R2(R2(rest-day rate ÷ 8) × 1.30)
--   gross = wages + OT pay + holiday pay (manual) + allowances / manual earnings
--   deductions = enabled per-employee amounts (SSS, PhilHealth, Pag-IBIG, tax, SSS loan,
--                additional) + manual deductions + cash advance installments
--   net = gross − deductions, never below zero (deductions that do not fit are capped
--         and flagged instead of silently disappearing).
-- Deliberately NOT copied from the old software (listed there as defects): 8-hour fallback
-- for records without valid hours, ₱600 default rate, unprorated monthly contributions.
-- =============================================================================

alter table public.payroll_settings
  add column if not exists calc_mode text not null default 'construction'
  check (calc_mode in ('construction', 'statutory'));
update public.payroll_settings set calc_mode = 'construction', ot_review_required = false where id = 1;

alter table public.payroll_adjustments
  add column if not exists adj_type text not null default 'other' check (adj_type in ('holiday', 'other'));

-- Per-employee deduction profile (amounts are per weekly payroll; only enabled ones apply).
create table if not exists public.employee_deduction_profiles (
  employee_id         uuid primary key references public.employees (id) on delete cascade,
  sss_enabled         boolean not null default false,
  sss_amount          numeric(12, 2) not null default 0 check (sss_amount >= 0),
  philhealth_enabled  boolean not null default false,
  philhealth_amount   numeric(12, 2) not null default 0 check (philhealth_amount >= 0),
  pagibig_enabled     boolean not null default false,
  pagibig_amount      numeric(12, 2) not null default 0 check (pagibig_amount >= 0),
  tax_enabled         boolean not null default false,
  tax_amount          numeric(12, 2) not null default 0 check (tax_amount >= 0),
  sss_loan_enabled    boolean not null default false,
  sss_loan_amount     numeric(12, 2) not null default 0 check (sss_loan_amount >= 0),
  additional_enabled  boolean not null default false,
  additional_amount   numeric(12, 2) not null default 0 check (additional_amount >= 0),
  additional_label    text,
  updated_by          uuid references public.app_users (id),
  updated_at          timestamptz not null default now()
);
drop trigger if exists trg_deduction_profiles_updated on public.employee_deduction_profiles;
create trigger trg_deduction_profiles_updated before update on public.employee_deduction_profiles
  for each row execute function public.set_updated_at();
drop trigger if exists trg_audit_employee_deduction_profiles on public.employee_deduction_profiles;
create trigger trg_audit_employee_deduction_profiles after insert or update or delete on public.employee_deduction_profiles
  for each row execute function public.audit_row();

alter table public.employee_deduction_profiles enable row level security;
drop policy if exists deduction_profiles_select on public.employee_deduction_profiles;
drop policy if exists deduction_profiles_insert on public.employee_deduction_profiles;
drop policy if exists deduction_profiles_update on public.employee_deduction_profiles;
create policy deduction_profiles_select on public.employee_deduction_profiles for select to authenticated
  using (public.can_access_employee(employee_id));
create policy deduction_profiles_insert on public.employee_deduction_profiles for insert to authenticated
  with check (public.can_access_employee(employee_id));
create policy deduction_profiles_update on public.employee_deduction_profiles for update to authenticated
  using (public.can_access_employee(employee_id)) with check (public.can_access_employee(employee_id));
revoke all on public.employee_deduction_profiles from anon;
grant select, insert, update on public.employee_deduction_profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Work-day minutes used by OT review: follows the active calculation mode.
-- ---------------------------------------------------------------------------
create or replace function public._work_day(p_employee_id uuid, p_work_date date) returns jsonb
language plpgsql stable as $$
declare
  v_elapsed integer;
  v_break   integer := 0;
  v_s       public.schedules;
begin
  select coalesce(sum(extract(epoch from (date_trunc('minute', clock_out_at) - date_trunc('minute', clock_in_at))) / 60), 0)::integer
    into v_elapsed
  from public.work_sessions
  where employee_id = p_employee_id and status = 'closed' and public.ph_date(clock_in_at) = p_work_date;

  if (select calc_mode from public.payroll_settings where id = 1) = 'construction' then
    v_break := case when v_elapsed >= 480 then 60 else 0 end;
    return jsonb_build_object('elapsed', v_elapsed, 'break', v_break,
      'worked', floor((v_elapsed - v_break) / 60.0)::integer * 60, 'ot', greatest(v_elapsed - 540, 0));
  end if;

  v_s := public._schedule_on(p_employee_id, p_work_date);
  if v_s.id is not null and v_elapsed > v_s.break_applies_after_minutes then
    v_break := least(v_s.unpaid_break_minutes, v_elapsed);
  end if;
  return jsonb_build_object('elapsed', v_elapsed, 'break', v_break, 'worked', v_elapsed - v_break,
                            'ot', greatest(v_elapsed - v_break - 480, 0));
end $$;

-- ---------------------------------------------------------------------------
-- Construction calculation for one employee
-- ---------------------------------------------------------------------------
create or replace function public._payroll_employee_construction(p_run_id uuid, p_employee_id uuid, p_primary_site uuid)
returns void
language plpgsql set search_path = public, extensions as $$
declare
  v_run     public.payroll_runs;
  v_per     public.payroll_periods;
  v_set     public.payroll_settings;
  v_emp     public.employees;
  v_rate    public.employee_rates;
  v_dec     public.ot_decisions;
  v_prof    public.employee_deduction_profiles;
  v_res     uuid;
  v_d       date;
  s         record;
  r         record;
  v_elapsed integer;
  v_lunch   integer;
  v_worked  integer;
  v_reg     numeric;
  v_ot_rec  integer;
  v_ot_paid integer;
  v_sunday  boolean;
  v_rest_rate numeric;
  v_ot_rate   numeric;
  v_rest_ot   numeric;
  v_hours   numeric;
  v_days    numeric;
  v_days_worked integer := 0;
  v_reg_min     integer := 0;
  v_ot_rec_tot  integer := 0;
  v_ot_paid_tot integer := 0;
  v_leave_hours numeric := 0;
  v_gross   numeric := 0;
  v_avail   numeric := 0;
  v_ded     numeric := 0;
  v_net     numeric := 0;
  v_amt     numeric;
  v_month   date;
  v_stat    jsonb := '[]'::jsonb;
  v_item    record;
begin
  select * into v_run from public.payroll_runs where id = p_run_id;
  select * into v_per from public.payroll_periods where id = v_run.period_id;
  select * into v_set from public.payroll_settings where id = 1;
  select * into v_emp from public.employees where id = p_employee_id;
  select * into v_prof from public.employee_deduction_profiles where employee_id = p_employee_id;
  v_rate := public._rate_on(p_employee_id, v_per.end_date);
  v_month := date_trunc('month', v_per.payday)::date;

  insert into public.payroll_results (run_id, employee_id, primary_site_id, employee_snapshot)
  select p_run_id, p_employee_id, p_primary_site, jsonb_build_object(
           'employee_code', v_emp.employee_code, 'name', v_emp.display_name,
           'first_name', v_emp.first_name, 'middle_name', v_emp.middle_name, 'last_name', v_emp.last_name,
           'classification', v_emp.classification, 'calc_mode', 'construction',
           'tin', v_emp.tin, 'sss_number', v_emp.sss_number,
           'philhealth_number', v_emp.philhealth_number, 'pagibig_number', v_emp.pagibig_number,
           'site_id', st.id, 'site_code', st.code, 'site_name', st.name,
           'daily_rate', v_rate.daily_rate, 'hourly_rate', round(v_rate.daily_rate / 8, 2))
  from (select 1) x left join public.sites st on st.id = p_primary_site
  returning id into v_res;

  -- Attendance integrity checks (same as the statutory engine).
  for s in select * from public.work_sessions
           where employee_id = p_employee_id and status = 'open' and clock_in_at < public.ph_ts(v_per.end_date + 1) loop
    perform public._add_exception(p_run_id, p_employee_id, public.ph_date(s.clock_in_at), 'MISSING_CLOCK_OUT',
      format('Clock-in at %s has no clock-out. Close or correct the session.',
             to_char(s.clock_in_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI')), true,
      jsonb_build_object('work_session_id', s.id));
  end loop;
  for s in select * from public.work_sessions
           where employee_id = p_employee_id and status = 'closed'
             and public.ph_date(clock_in_at) between v_per.start_date and v_per.end_date and reviewed_at is null loop
    if 'long_session' = any (s.review_flags)
       or extract(epoch from (s.clock_out_at - s.clock_in_at)) / 60 > v_set.max_session_minutes then
      perform public._add_exception(p_run_id, p_employee_id, public.ph_date(s.clock_in_at), 'LONG_SESSION',
        format('Session of %s h needs review (implausibly long).',
               round(extract(epoch from (s.clock_out_at - s.clock_in_at)) / 3600, 1)), true,
        jsonb_build_object('work_session_id', s.id));
    end if;
    if 'location_exception' = any (s.review_flags) then
      perform public._add_exception(p_run_id, p_employee_id, public.ph_date(s.clock_in_at), 'LOCATION_EXCEPTION',
        'Location was not captured for a punch; review the attendance record.', false,
        jsonb_build_object('work_session_id', s.id));
    end if;
  end loop;

  create temp table if not exists _con_day (
    work_date  date not null,
    daily_rate numeric not null,
    is_sunday  boolean not null,
    reg_hours  numeric not null,
    ot_hours   numeric not null,
    is_leave   boolean not null default false
  ) on commit drop;
  delete from _con_day;

  -- Per work date: gross, lunch, worked (floored), regular, automatic OT.
  for v_d in select g::date from generate_series(v_per.start_date, v_per.end_date, interval '1 day') g loop
    select coalesce(sum(extract(epoch from (date_trunc('minute', clock_out_at) - date_trunc('minute', clock_in_at))) / 60), 0)::integer
      into v_elapsed
    from public.work_sessions
    where employee_id = p_employee_id and status = 'closed' and public.ph_date(clock_in_at) = v_d;
    continue when v_elapsed = 0;

    v_rate := public._rate_on(p_employee_id, v_d);
    if v_rate.id is null then
      perform public._add_exception(p_run_id, p_employee_id, v_d, 'NO_RATE', format('No daily rate effective on %s.', v_d), true);
      continue;
    end if;

    v_lunch  := case when v_elapsed >= 480 then 60 else 0 end;
    v_worked := floor((v_elapsed - v_lunch) / 60.0)::integer;
    v_reg    := least(greatest(v_worked, 0), 8);
    v_ot_rec := greatest(v_elapsed - 540, 0);
    v_sunday := extract(isodow from v_d) = 7;

    v_ot_paid := v_ot_rec;
    if v_ot_rec > 0 then
      v_ot_rec_tot := v_ot_rec_tot + v_ot_rec;
      if v_set.ot_review_required then
        v_ot_paid := 0;
        select * into v_dec from public.ot_decisions where employee_id = p_employee_id and work_date = v_d;
        if v_dec.id is null then
          insert into public.ot_decisions (employee_id, work_date, recorded_minutes)
          values (p_employee_id, v_d, v_ot_rec) on conflict (employee_id, work_date) do nothing;
          perform public._add_exception(p_run_id, p_employee_id, v_d, 'OT_PENDING',
            format('%s h of OT awaits a decision.', round(v_ot_rec / 60.0, 2)), true);
        elsif v_dec.recorded_minutes <> v_ot_rec and v_dec.status <> 'pending' then
          perform public._add_exception(p_run_id, p_employee_id, v_d, 'OT_CHANGED',
            'Recorded OT changed after the decision; decide again.', true);
        elsif v_dec.status = 'accepted' then
          v_ot_paid := least(v_dec.accepted_minutes, v_ot_rec);
        elsif v_dec.status = 'rejected' then
          v_ot_paid := 0;
        else
          if v_dec.status = 'pending' and v_dec.recorded_minutes <> v_ot_rec then
            update public.ot_decisions set recorded_minutes = v_ot_rec where id = v_dec.id;
          end if;
          perform public._add_exception(p_run_id, p_employee_id, v_d,
            case when v_dec.status = 'disputed' then 'OT_DISPUTED' else 'OT_PENDING' end,
            format('%s h of OT awaits a decision.', round(v_ot_rec / 60.0, 2)), true);
        end if;
      end if;
      v_ot_paid_tot := v_ot_paid_tot + v_ot_paid;
    end if;

    if v_reg > 0 then v_days_worked := v_days_worked + 1; end if;
    v_reg_min := v_reg_min + (v_reg * 60)::integer;

    insert into _con_day (work_date, daily_rate, is_sunday, reg_hours, ot_hours)
    values (v_d, v_rate.daily_rate, v_sunday, v_reg, round(v_ot_paid / 60.0, 2));

    perform public._add_line(v_res, 'info', 'DAY',
      format('%s%s: gross %s h − lunch %s h → worked %s h (regular %s h), OT %s h',
             to_char(v_d, 'Dy'), case when v_sunday then ' (rest day)' else '' end,
             round(v_elapsed / 60.0, 2), v_lunch / 60, v_worked, v_reg, round(v_ot_paid / 60.0, 2)),
      0, v_d, null, v_reg, 'hours');
  end loop;

  -- Paid leave contributes its hours as ordinary days.
  for r in select le.*, lt.name as type_name, lt.is_paid
           from public.leave_entries le join public.leave_types lt on lt.id = le.leave_type_id
           where le.employee_id = p_employee_id and le.status = 'approved'
             and le.leave_date between v_per.start_date and v_per.end_date order by le.leave_date loop
    if not r.is_paid then
      perform public._add_line(v_res, 'info', 'LEAVE_UNPAID', r.type_name || ' (unpaid)', 0, r.leave_date, null, r.hours, 'hours');
      continue;
    end if;
    v_rate := public._rate_on(p_employee_id, r.leave_date);
    if v_rate.id is null then
      perform public._add_exception(p_run_id, p_employee_id, r.leave_date, 'NO_RATE', format('No daily rate effective on %s.', r.leave_date), true);
      continue;
    end if;
    if coalesce((select sum(reg_hours) from _con_day where work_date = r.leave_date), 0) + r.hours > 8 then
      perform public._add_exception(p_run_id, p_employee_id, r.leave_date, 'LEAVE_OVERLAP',
        'Worked hours plus paid leave exceed 8 hours on the same day.', true);
    end if;
    v_leave_hours := v_leave_hours + r.hours;
    insert into _con_day (work_date, daily_rate, is_sunday, reg_hours, ot_hours, is_leave)
    values (r.leave_date, v_rate.daily_rate, false, r.hours, 0, true);
    perform public._add_line(v_res, 'info', 'LEAVE', format('%s: %s h paid leave (counted as ordinary days)', r.type_name, r.hours),
      0, r.leave_date, null, r.hours, 'hours');
  end loop;

  -- Wages and OT per daily rate (handles a mid-period rate change).
  for r in select daily_rate,
                  coalesce(sum(reg_hours) filter (where not is_sunday), 0) / 8 as normal_days,
                  coalesce(sum(reg_hours) filter (where is_sunday), 0) / 8     as rest_days,
                  coalesce(sum(reg_hours) filter (where is_leave), 0) / 8      as leave_days,
                  coalesce(sum(ot_hours) filter (where not is_sunday), 0)      as normal_ot,
                  coalesce(sum(ot_hours) filter (where is_sunday), 0)          as rest_ot
           from _con_day group by daily_rate order by daily_rate loop
    v_rest_rate := round(r.daily_rate * 1.30, 2);
    v_ot_rate   := round(r.daily_rate / 8 * 1.25, 2);
    v_rest_ot   := round(round(v_rest_rate / 8, 2) * 1.30, 2);
    if r.normal_days > 0 then
      perform public._add_line(v_res, 'earning', 'WAGE_NORMAL',
        format('Normal wages (%s day(s) × ₱%s%s)', trim(to_char(r.normal_days, 'FM999990.###')), r.daily_rate,
               case when r.leave_days > 0 then format(', incl. %s leave day(s)', trim(to_char(r.leave_days, 'FM999990.###'))) else '' end),
        round(r.daily_rate * r.normal_days, 2), null, null, r.normal_days, 'days', r.daily_rate, 1,
        round(r.daily_rate * r.normal_days, 2), true, jsonb_build_object('daily_rate', r.daily_rate));
    end if;
    if r.rest_days > 0 then
      perform public._add_line(v_res, 'earning', 'WAGE_REST',
        format('Rest-day wages (%s day(s) × ₱%s)', trim(to_char(r.rest_days, 'FM999990.###')), v_rest_rate),
        round(v_rest_rate * r.rest_days, 2), null, null, r.rest_days, 'days', v_rest_rate, 1.30,
        round(r.daily_rate * r.rest_days, 2), true, jsonb_build_object('daily_rate', r.daily_rate, 'rest_day_rate', v_rest_rate));
    end if;
    if r.normal_ot > 0 then
      perform public._add_line(v_res, 'earning', 'OT_NORMAL',
        format('Overtime (%s h × ₱%s)', r.normal_ot, v_ot_rate),
        round(v_ot_rate * r.normal_ot, 2), null, null, r.normal_ot, 'hours', v_ot_rate, 1.25, 0, true,
        jsonb_build_object('daily_rate', r.daily_rate));
    end if;
    if r.rest_ot > 0 then
      perform public._add_line(v_res, 'earning', 'OT_REST',
        format('Rest-day overtime (%s h × ₱%s)', r.rest_ot, v_rest_ot),
        round(v_rest_ot * r.rest_ot, 2), null, null, r.rest_ot, 'hours', v_rest_ot, 1.30, 0, true,
        jsonb_build_object('daily_rate', r.daily_rate, 'rest_day_rate', v_rest_rate));
    end if;
  end loop;

  -- Allowances (if configured).
  for r in select * from public.allowance_rules
           where employee_id = p_employee_id and is_active
             and effective_from <= v_per.end_date and (effective_to is null or effective_to >= v_per.start_date) loop
    if r.frequency = 'per_day_worked' then
      select count(distinct work_date) into v_worked from _con_day
       where not is_leave and reg_hours > 0
         and work_date between greatest(v_per.start_date, r.effective_from) and least(v_per.end_date, coalesce(r.effective_to, v_per.end_date));
      if v_worked > 0 then
        perform public._add_line(v_res, 'earning', 'ALLOWANCE', r.name, v_worked * r.amount, null, null, v_worked, 'days',
          r.amount, 1, 0, r.taxable, jsonb_build_object('allowance_rule_id', r.id));
      end if;
    elsif not r.requires_attendance or v_days_worked > 0 or v_leave_hours > 0 then
      perform public._add_line(v_res, 'earning', 'ALLOWANCE', r.name, r.amount, null, null, 1, 'week',
        r.amount, 1, 0, r.taxable, jsonb_build_object('allowance_rule_id', r.id));
    end if;
  end loop;

  -- Manual earnings: holiday pay (entered by staff) and other adjustments.
  for r in select * from public.payroll_adjustments
           where employee_id = p_employee_id and period_id = v_per.id and kind = 'earning' order by created_at loop
    perform public._add_line(v_res, 'earning', case when r.adj_type = 'holiday' then 'HOLIDAY_PAY' else 'ADJ_EARN' end,
      r.description, r.amount, null, null, null, null, null, null, 0, r.taxable,
      jsonb_build_object('adjustment_id', r.id, 'reason', r.reason, 'created_by', r.created_by));
  end loop;

  select coalesce(sum(amount), 0) into v_gross from public.payroll_lines where result_id = v_res and category = 'earning';
  v_avail := v_gross;

  if exists (select 1 from public.payroll_results r2
             join public.payroll_runs u on u.id = r2.run_id
             join public.payroll_periods p2 on p2.id = u.period_id
             where r2.employee_id = p_employee_id and u.id <> p_run_id
               and u.status in ('draft', 'ready_for_review') and p2.start_date < v_per.start_date) then
    perform public._add_exception(p_run_id, p_employee_id, null, 'PRIOR_RUN_OPEN',
      'An earlier payroll run for this employee is not finalized yet; finalize it first.', true);
  end if;

  -- Enabled deductions in order; each is capped so net never goes below zero.
  if v_gross > 0 then
    for v_item in
      select * from (values
        (1, 'SSS_EE',   'SSS contribution',        'sss',        coalesce(v_prof.sss_enabled, false),        coalesce(v_prof.sss_amount, 0)),
        (2, 'PHIC_EE',  'PhilHealth contribution', 'philhealth', coalesce(v_prof.philhealth_enabled, false), coalesce(v_prof.philhealth_amount, 0)),
        (3, 'HDMF_EE',  'Pag-IBIG contribution',   'pagibig',    coalesce(v_prof.pagibig_enabled, false),    coalesce(v_prof.pagibig_amount, 0)),
        (4, 'TAX_WH',   'Withholding tax',         null,         coalesce(v_prof.tax_enabled, false),        coalesce(v_prof.tax_amount, 0)),
        (5, 'SSS_LOAN', 'SSS loan',                null,         coalesce(v_prof.sss_loan_enabled, false),   coalesce(v_prof.sss_loan_amount, 0)),
        (6, 'ADD_DED',  coalesce(nullif(btrim(v_prof.additional_label), ''), 'Additional deduction'),
                                                   null,         coalesce(v_prof.additional_enabled, false), coalesce(v_prof.additional_amount, 0))
      ) t(ord, code, label, agency, enabled, amount)
      order by ord
    loop
      continue when not v_item.enabled or v_item.amount <= 0;
      v_amt := least(v_item.amount, greatest(v_avail, 0));
      if v_amt < v_item.amount then
        perform public._add_exception(p_run_id, p_employee_id, null, 'DEDUCTION_CAPPED',
          format('%s of ₱%s reduced to ₱%s so net pay does not go below zero.', v_item.label, v_item.amount, v_amt), false);
      end if;
      continue when v_amt <= 0;
      perform public._add_line(v_res, 'deduction', v_item.code, v_item.label, v_amt, null, null, null, null, null, null, 0, false,
        jsonb_build_object('profile_amount', v_item.amount));
      v_avail := v_avail - v_amt;
      if v_item.agency is not null then
        v_stat := v_stat || jsonb_build_array(jsonb_build_object(
          'agency', v_item.agency, 'month', v_month, 'basis', v_gross, 'month_basis', v_gross, 'projected_basis', v_gross,
          'final', false, 'ee', v_amt, 'er', 0, 'ec', 0, 'obligation_ee', v_amt, 'obligation_er', 0, 'obligation_ec', 0,
          'credit', 0, 'prior_ee', 0, 'prior_er', 0, 'prior_runs', 0, 'paydays_in_month', 0, 'payday_index', 0,
          'rule_version_id', null, 'mode', 'fixed_profile'));
      end if;
    end loop;

    for r in select * from public.payroll_adjustments
             where employee_id = p_employee_id and period_id = v_per.id and kind = 'deduction' order by created_at loop
      v_amt := least(r.amount, greatest(v_avail, 0));
      if v_amt < r.amount then
        perform public._add_exception(p_run_id, p_employee_id, null, 'DEDUCTION_CAPPED',
          format('%s of ₱%s reduced to ₱%s so net pay does not go below zero.', r.description, r.amount, v_amt), false);
      end if;
      continue when v_amt <= 0;
      perform public._add_line(v_res, 'deduction', 'ADJ_DED', r.description, v_amt, null, null, null, null, null, null, 0, false,
        jsonb_build_object('adjustment_id', r.id, 'reason', r.reason, 'created_by', r.created_by));
      v_avail := v_avail - v_amt;
    end loop;

    for r in select a.*, (select coalesce(sum(l.amount), 0) from public.advance_ledger l where l.advance_id = a.id) as balance
             from public.cash_advances a
             where a.employee_id = p_employee_id and a.status = 'active' and a.first_deduction_date <= v_per.payday
             order by a.released_on, a.created_at loop
      continue when r.balance <= 0;
      v_amt := least(r.installment_amount, r.balance);
      if v_avail <= 0 then
        perform public._add_exception(p_run_id, p_employee_id, null, 'ADVANCE_DEFERRED',
          format('Cash advance installment ₱%s deferred: no net pay left. Balance stays in the advance ledger.', v_amt), false,
          jsonb_build_object('advance_id', r.id));
        continue;
      end if;
      if v_amt > v_avail then
        perform public._add_exception(p_run_id, p_employee_id, null, 'ADVANCE_PARTIAL',
          format('Cash advance installment reduced from ₱%s to ₱%s (insufficient net pay).', v_amt, round(v_avail, 2)), false,
          jsonb_build_object('advance_id', r.id));
        v_amt := round(v_avail, 2);
      end if;
      perform public._add_line(v_res, 'deduction', 'ADVANCE', 'Cash advance repayment', v_amt, null, null, null, null, null, null, 0,
        false, jsonb_build_object('advance_id', r.id, 'balance_before', r.balance, 'balance_after', r.balance - v_amt,
                                  'installment', r.installment_amount));
      v_avail := v_avail - v_amt;
    end loop;
  end if;

  select coalesce(sum(amount), 0) into v_ded from public.payroll_lines where result_id = v_res and category = 'deduction';
  v_net := greatest(round(v_gross - v_ded, 2), 0);

  update public.payroll_results set
    days_worked = v_days_worked, regular_minutes = v_reg_min, ot_minutes_recorded = v_ot_rec_tot,
    ot_minutes_paid = v_ot_paid_tot, leave_hours = v_leave_hours,
    gross_pay = round(v_gross, 2), total_deductions = v_ded, net_pay = v_net, employer_contributions = 0,
    statutory = v_stat,
    blocking_count = (select count(*) from public.payroll_exceptions where run_id = p_run_id and employee_id = p_employee_id and blocking),
    warning_count  = (select count(*) from public.payroll_exceptions where run_id = p_run_id and employee_id = p_employee_id and not blocking)
  where id = v_res;

  if v_gross = 0 and v_ded = 0
     and not exists (select 1 from public.payroll_exceptions where run_id = p_run_id and employee_id = p_employee_id and blocking) then
    delete from public.payroll_exceptions where run_id = p_run_id and employee_id = p_employee_id;
    delete from public.payroll_results where id = v_res;
  end if;
end $$;

-- Dispatcher: keep the DOLE/statutory engine available, pick by setting.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = '_payroll_employee_statutory') then
    alter function public._payroll_employee(uuid, uuid, uuid) rename to _payroll_employee_statutory;
  end if;
end $$;

create or replace function public._payroll_employee(p_run_id uuid, p_employee_id uuid, p_primary_site uuid)
returns void
language plpgsql set search_path = public, extensions as $$
begin
  if (select calc_mode from public.payroll_settings where id = 1) = 'construction' then
    perform public._payroll_employee_construction(p_run_id, p_employee_id, p_primary_site);
  else
    perform public._payroll_employee_statutory(p_run_id, p_employee_id, p_primary_site);
  end if;
end $$;

-- Internal helpers are never callable through the API.
revoke execute on function public._payroll_employee(uuid, uuid, uuid)              from public, anon, authenticated;
revoke execute on function public._payroll_employee_statutory(uuid, uuid, uuid)    from public, anon, authenticated;
revoke execute on function public._payroll_employee_construction(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public._work_day(uuid, date)                            from public, anon, authenticated;
