-- =============================================================================
-- Migration 4: weekly payroll engine (FR-05 .. FR-10)
--
-- Calculation conventions (documented policy)
--   * D = daily rate effective on the work date, M = D / 480 (minute rate), H = D / 8.
--   * Punch times are truncated to the minute. Minutes are split at Philippine
--     midnight and at 06:00 / 22:00 (night window) so every minute is classified by
--     its own calendar date (holiday / rest day) and night status.
--   * Work date of a shift = Philippine date of its clock-in. The first 480 worked
--     minutes of a work date are regular; the remainder is OT *candidate* time.
--     Daily caps are never netted across the week.
--   * Unpaid break: deducted once per work date only when the schedule defines it and
--     elapsed time exceeds break_applies_after_minutes.
--   * Multipliers are TOTAL rates on the basic rate (day_type_multipliers).
--   * Regular holiday: worked minutes are paid at the holiday multiplier; if fewer than
--     480 regular minutes were worked and the employee is eligible, the unworked
--     balance is paid at 100% (so 8 h worked = 200% total, 0 h worked = 100%).
--   * Every line amount is rounded half-up to the centavo; quantities are minutes.
--   * Statutory contributions are reconciled monthly (by payday month): installments
--     are projected per payday and the final payday of the month trues up to the
--     actual monthly obligation.
-- =============================================================================

alter table public.payroll_periods
  add constraint payroll_periods_no_overlap exclude using gist (daterange(start_date, end_date, '[]') with &&);

alter table public.payroll_results add column statutory jsonb not null default '[]'::jsonb;

-- Computed payroll rows are immutable once a run leaves draft / ready-for-review.
create or replace function public.guard_payroll_mutation() returns trigger
language plpgsql as $$
declare v_status public.payroll_status;
begin
  select status into v_status from public.payroll_runs where id = coalesce(new.run_id, old.run_id);
  if v_status is not null and v_status not in ('draft', 'ready_for_review') then
    raise exception 'Payroll run is %; its computed results are immutable', v_status;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_guard_payroll_results    before insert or update or delete on public.payroll_results
  for each row execute function public.guard_payroll_mutation();
create trigger trg_guard_payroll_lines      before insert or update or delete on public.payroll_lines
  for each row execute function public.guard_payroll_mutation();
create trigger trg_guard_payroll_exceptions before insert or update or delete on public.payroll_exceptions
  for each row execute function public.guard_payroll_mutation();

-- ---------------------------------------------------------------------------
-- Lookup helpers (security invoker: they run with the caller's rights)
-- ---------------------------------------------------------------------------
create or replace function public._rate_on(p_employee_id uuid, p_date date) returns public.employee_rates
language sql stable as $$
  select * from public.employee_rates
  where employee_id = p_employee_id and effective_from <= p_date
  order by effective_from desc limit 1
$$;

create or replace function public._schedule_on(p_employee_id uuid, p_date date) returns public.schedules
language sql stable as $$
  select s.* from public.employee_schedules es
  join public.schedules s on s.id = es.schedule_id
  where es.employee_id = p_employee_id and es.effective_from <= p_date
  order by es.effective_from desc limit 1
$$;

create or replace function public._site_on(p_employee_id uuid, p_date date) returns uuid
language sql stable as $$
  select site_id from public.employee_site_assignments
  where employee_id = p_employee_id
    and tstzrange(effective_from, effective_to, '[)') @> public.ph_ts(p_date, '12:00')
  limit 1
$$;

create or replace function public._multiplier(p_day_type text, p_date date) returns public.day_type_multipliers
language sql stable as $$
  select * from public.day_type_multipliers
  where day_type = p_day_type and effective_from <= p_date
  order by effective_from desc limit 1
$$;

create or replace function public._day_label(p_day_type text) returns text
language sql immutable as $$
  select case p_day_type
    when 'ordinary'             then 'ordinary day'
    when 'rest_day'             then 'rest day'
    when 'special_non_working'  then 'special non-working day'
    when 'special_rest'         then 'special non-working day + rest day'
    when 'regular_holiday'      then 'regular holiday'
    when 'regular_holiday_rest' then 'regular holiday + rest day'
    else p_day_type end
$$;

-- Day classification for one employee / site / calendar date.
create or replace function public._day_info(p_employee_id uuid, p_site_id uuid, p_date date) returns jsonb
language plpgsql stable as $$
declare
  v_s     public.schedules;
  v_rest  boolean;
  v_reg   integer;
  v_spec  integer;
  v_names text[];
begin
  v_s := public._schedule_on(p_employee_id, p_date);
  v_rest := v_s.id is not null and not (extract(isodow from p_date)::smallint = any (v_s.working_days));
  select count(*) filter (where kind = 'regular'),
         count(*) filter (where kind = 'special_non_working'),
         array_agg(name order by name) filter (where kind <> 'special_working')
    into v_reg, v_spec, v_names
  from public.holidays
  where holiday_date = p_date and (site_id is null or site_id = p_site_id);

  return jsonb_build_object(
    'day_type', case
                  when v_reg > 0 and v_rest  then 'regular_holiday_rest'
                  when v_reg > 0             then 'regular_holiday'
                  when v_spec > 0 and v_rest then 'special_rest'
                  when v_spec > 0            then 'special_non_working'
                  when v_rest                then 'rest_day'
                  else 'ordinary' end,
    'is_rest', v_rest,
    'has_schedule', v_s.id is not null,
    'is_working_day', v_s.id is not null and not v_rest,
    'holiday_count', v_reg + v_spec,
    'regular_count', v_reg,
    'special_count', v_spec,
    'holidays', coalesce(to_jsonb(v_names), '[]'::jsonb));
end $$;

-- Elapsed / break / worked minutes for a work date (shared by OT review and payroll).
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

  v_s := public._schedule_on(p_employee_id, p_work_date);
  if v_s.id is not null and v_elapsed > v_s.break_applies_after_minutes then
    v_break := least(v_s.unpaid_break_minutes, v_elapsed);
  end if;
  return jsonb_build_object('elapsed', v_elapsed, 'break', v_break, 'worked', v_elapsed - v_break,
                            'ot', greatest(v_elapsed - v_break - 480, 0));
end $$;

-- Regular-holiday pay eligibility: present or on paid leave on the nearest preceding
-- scheduled working day (rest days / non-working days / holidays are skipped).
create or replace function public._holiday_eligibility(p_employee_id uuid, p_date date, p_site_id uuid, p_lookback integer)
returns text
language plpgsql stable as $$
declare
  v_emp  public.employees;
  v_p    date;
  v_info jsonb;
begin
  select * into v_emp from public.employees where id = p_employee_id;
  for i in 1 .. p_lookback loop
    v_p := p_date - i;
    if v_emp.hire_date is not null and v_p < v_emp.hire_date then
      return 'not_employed';
    end if;
    if exists (select 1 from public.work_sessions w
               where w.employee_id = p_employee_id and w.status = 'closed'
                 and w.clock_in_at < public.ph_ts(v_p + 1) and w.clock_out_at > public.ph_ts(v_p)) then
      return 'eligible';
    end if;
    if exists (select 1 from public.leave_entries le join public.leave_types lt on lt.id = le.leave_type_id
               where le.employee_id = p_employee_id and le.leave_date = v_p and le.status = 'approved' and lt.is_paid) then
      return 'eligible';
    end if;
    v_info := public._day_info(p_employee_id, coalesce(public._site_on(p_employee_id, v_p), p_site_id), v_p);
    if not (v_info ->> 'has_schedule')::boolean then
      return 'no_schedule';
    end if;
    if (v_info ->> 'is_working_day')::boolean and (v_info ->> 'holiday_count')::integer = 0 then
      return 'absent';
    end if;
  end loop;
  return 'undetermined';
end $$;

-- Applicable statutory rule version for a date: approved first, else newest draft.
create or replace function public._rule_for(p_agency public.statutory_agency, p_date date)
returns public.statutory_rule_versions
language sql stable as $$
  select * from public.statutory_rule_versions
  where agency = p_agency and status in ('approved', 'draft')
    and effective_from <= p_date and (effective_to is null or effective_to >= p_date)
  order by (status = 'approved') desc, effective_from desc, created_at desc
  limit 1
$$;

-- Monthly contribution for a monthly basis. Returns {ee, er, ec, credit}.
create or replace function public._contrib_compute(p_agency text, p_params jsonb, p_basis numeric) returns jsonb
language plpgsql immutable as $$
declare
  v_credit numeric;
  v_ee numeric := 0;
  v_er numeric := 0;
  v_ec numeric := 0;
  v_prem numeric;
  v_step numeric;
begin
  if p_basis is null or p_basis <= 0 then
    return jsonb_build_object('ee', 0, 'er', 0, 'ec', 0, 'credit', 0);
  end if;
  if p_agency = 'sss' then
    v_step   := (p_params ->> 'msc_step')::numeric;
    v_credit := least((p_params ->> 'msc_max')::numeric,
                      greatest((p_params ->> 'msc_min')::numeric, floor((p_basis + v_step / 2) / v_step) * v_step));
    v_ee := round(v_credit * (p_params ->> 'employee_rate')::numeric, 2);
    v_er := round(v_credit * (p_params ->> 'employer_rate')::numeric, 2);
    v_ec := case when v_credit < (p_params ->> 'ec_threshold')::numeric
                 then (p_params ->> 'ec_low')::numeric else (p_params ->> 'ec_high')::numeric end;
  elsif p_agency = 'philhealth' then
    v_credit := least(greatest(p_basis, (p_params ->> 'floor')::numeric), (p_params ->> 'ceiling')::numeric);
    v_prem := round(v_credit * (p_params ->> 'rate')::numeric, 2);
    v_ee := round(v_prem * (p_params ->> 'employee_share')::numeric, 2);
    v_er := v_prem - v_ee;
  elsif p_agency = 'pagibig' then
    v_credit := least(p_basis, (p_params ->> 'max_fund_salary')::numeric);
    v_ee := round(v_credit * case when p_basis <= (p_params ->> 'low_threshold')::numeric
                                  then (p_params ->> 'employee_rate_low')::numeric
                                  else (p_params ->> 'employee_rate')::numeric end, 2);
    v_er := round(v_credit * (p_params ->> 'employer_rate')::numeric, 2);
  else
    raise exception 'Unknown agency %', p_agency;
  end if;
  return jsonb_build_object('ee', v_ee, 'er', v_er, 'ec', v_ec, 'credit', v_credit);
end $$;

-- Withholding from a bracket table: base + (taxable - over) * rate for the top bracket.
create or replace function public._withholding(p_params jsonb, p_taxable numeric) returns numeric
language sql immutable as $$
  select coalesce((
    select round((b ->> 'base')::numeric + (p_taxable - (b ->> 'over')::numeric) * (b ->> 'rate')::numeric, 2)
    from jsonb_array_elements(p_params -> 'brackets') b
    where p_taxable > (b ->> 'over')::numeric
    order by (b ->> 'over')::numeric desc
    limit 1), 0)
$$;

-- ---------------------------------------------------------------------------
-- Line / exception writers
-- ---------------------------------------------------------------------------
create or replace function public._add_line(
  p_result_id uuid, p_category text, p_code text, p_description text, p_amount numeric,
  p_work_date date default null, p_site_id uuid default null, p_quantity numeric default null,
  p_unit text default null, p_rate numeric default null, p_multiplier numeric default null,
  p_basic numeric default 0, p_taxable boolean default true, p_source jsonb default '{}'::jsonb)
returns void
language sql as $$
  insert into public.payroll_lines (run_id, result_id, employee_id, category, code, description, work_date, site_id,
                                    quantity, unit, rate, multiplier, amount, basic_amount, taxable, source, sort_order)
  select r.run_id, r.id, r.employee_id, p_category, p_code, p_description, p_work_date, p_site_id,
         p_quantity, p_unit, p_rate, p_multiplier, round(coalesce(p_amount, 0), 2), round(coalesce(p_basic, 0), 2),
         p_taxable, coalesce(p_source, '{}'::jsonb),
         case p_category when 'earning' then 100 when 'deduction' then 500 when 'employer' then 800 else 900 end
  from public.payroll_results r where r.id = p_result_id
$$;

create or replace function public._add_exception(
  p_run_id uuid, p_employee_id uuid, p_work_date date, p_code text, p_message text, p_blocking boolean,
  p_source jsonb default '{}'::jsonb)
returns void
language sql as $$
  insert into public.payroll_exceptions (run_id, employee_id, work_date, code, message, blocking, source)
  select p_run_id, p_employee_id, p_work_date, p_code, p_message, p_blocking, coalesce(p_source, '{}'::jsonb)
  where not exists (select 1 from public.payroll_exceptions x
                    where x.run_id = p_run_id and x.employee_id is not distinct from p_employee_id
                      and x.work_date is not distinct from p_work_date and x.code = p_code)
$$;

-- ---------------------------------------------------------------------------
-- Per-employee calculation
-- ---------------------------------------------------------------------------
create or replace function public._payroll_employee(p_run_id uuid, p_employee_id uuid, p_primary_site uuid)
returns void
language plpgsql set search_path = public, extensions as $$
declare
  v_run      public.payroll_runs;
  v_per      public.payroll_periods;
  v_set      public.payroll_settings;
  v_emp      public.employees;
  v_rate     public.employee_rates;
  v_sched    public.schedules;
  v_mult     public.day_type_multipliers;
  v_dec      public.ot_decisions;
  v_rule     public.statutory_rule_versions;
  v_res      uuid;
  v_d        date;
  v_site     uuid;
  v_info     jsonb;
  v_type     text;
  v_seg_no   integer := 0;
  v_t        timestamptz;
  v_t_end    timestamptz;
  v_nb       timestamptz;
  v_local    timestamp;
  v_elapsed  integer;
  v_break    integer;
  v_worked   integer;
  v_left     integer;
  v_take     integer;
  v_cap      integer;
  v_ot_rec   integer;
  v_ot_paid  integer;
  v_leave_min integer;
  v_under    integer;
  v_late     integer;
  v_first_in timestamptz;
  v_mr       numeric;          -- minute rate
  v_reg_mult numeric;
  v_ot_mult  numeric;
  v_amount   numeric;
  v_n        integer;
  v_elig     text;
  v_covered  boolean;
  s          record;
  r          record;
  -- totals
  v_days_worked integer := 0;
  v_reg_total   integer := 0;
  v_ot_rec_tot  integer := 0;
  v_ot_paid_tot integer := 0;
  v_under_tot   integer := 0;
  v_late_tot    integer := 0;
  v_night_tot   integer := 0;
  v_leave_hours numeric := 0;
  -- money
  v_gross     numeric := 0;
  v_basic_sum numeric := 0;
  v_comp_sum  numeric := 0;
  v_avail     numeric := 0;
  v_ded       numeric := 0;
  v_er_total  numeric := 0;
  v_net       numeric := 0;
  v_stat_ee   numeric := 0;
  v_stat      jsonb := '[]'::jsonb;
  -- statutory
  v_month     date;
  v_n_paydays integer;
  v_k         integer;
  v_after     integer;
  v_final     boolean;
  v_agency    text;
  v_basis     numeric;
  v_p_basis   numeric;
  v_p_ee      numeric;
  v_p_er      numeric;
  v_p_ec      numeric;
  v_p_runs    integer;
  v_m_basis   numeric;
  v_proj      numeric;
  v_ob        jsonb;
  v_ee        numeric;
  v_er        numeric;
  v_ec        numeric;
  v_taxable   numeric;
  v_tax       numeric;
  v_inst      numeric;
  v_codes     text[];
begin
  select * into v_run from public.payroll_runs where id = p_run_id;
  select * into v_per from public.payroll_periods where id = v_run.period_id;
  select * into v_set from public.payroll_settings where id = 1;
  select * into v_emp from public.employees where id = p_employee_id;
  v_covered := v_emp.labor_standards_covered;
  v_rate := public._rate_on(p_employee_id, v_per.end_date);

  insert into public.payroll_results (run_id, employee_id, primary_site_id, employee_snapshot)
  select p_run_id, p_employee_id, p_primary_site, jsonb_build_object(
           'employee_code', v_emp.employee_code,
           'name', v_emp.display_name,
           'first_name', v_emp.first_name, 'middle_name', v_emp.middle_name, 'last_name', v_emp.last_name,
           'classification', v_emp.classification,
           'is_minimum_wage_earner', v_emp.is_minimum_wage_earner,
           'labor_standards_covered', v_emp.labor_standards_covered,
           'statutory_covered', v_emp.statutory_covered,
           'tin', v_emp.tin, 'sss_number', v_emp.sss_number,
           'philhealth_number', v_emp.philhealth_number, 'pagibig_number', v_emp.pagibig_number,
           'site_id', st.id, 'site_code', st.code, 'site_name', st.name,
           'daily_rate', v_rate.daily_rate, 'hourly_rate', round(v_rate.daily_rate / 8, 4))
  from (select 1) x left join public.sites st on st.id = p_primary_site
  returning id into v_res;

  -- ---- Session-level exceptions ------------------------------------------
  for s in select * from public.work_sessions
           where employee_id = p_employee_id and status = 'open' and clock_in_at < public.ph_ts(v_per.end_date + 1) loop
    perform public._add_exception(p_run_id, p_employee_id, public.ph_date(s.clock_in_at), 'MISSING_CLOCK_OUT',
      format('Clock-in at %s has no clock-out. Close or correct the session.',
             to_char(s.clock_in_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI')), true,
      jsonb_build_object('work_session_id', s.id));
  end loop;

  for s in select * from public.work_sessions
           where employee_id = p_employee_id and status = 'closed'
             and public.ph_date(clock_in_at) between v_per.start_date and v_per.end_date
           order by clock_in_at loop
    if s.reviewed_at is null then
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
    end if;
    if public._site_on(p_employee_id, public.ph_date(s.clock_in_at)) is distinct from s.site_id then
      perform public._add_exception(p_run_id, p_employee_id, public.ph_date(s.clock_in_at), 'SITE_MISMATCH',
        'Worked at a site other than the assigned site for that date.', false,
        jsonb_build_object('work_session_id', s.id));
    end if;
  end loop;

  -- ---- Build minute segments ----------------------------------------------
  delete from _pay_seg;
  for s in select * from public.work_sessions
           where employee_id = p_employee_id and status = 'closed'
             and public.ph_date(clock_in_at) between v_per.start_date and v_per.end_date
           order by clock_in_at loop
    v_t     := date_trunc('minute', s.clock_in_at);
    v_t_end := date_trunc('minute', s.clock_out_at);
    while v_t < v_t_end loop
      v_local := v_t at time zone 'Asia/Manila';
      v_nb := least(v_t_end,
                    case when v_local::time < '06:00' then public.ph_ts(v_local::date, '06:00')
                         when v_local::time < '22:00' then public.ph_ts(v_local::date, '22:00')
                         else public.ph_ts(v_local::date + 1, '00:00') end);
      v_seg_no := v_seg_no + 1;
      insert into _pay_seg (seg_no, work_date, session_id, site_id, seg_start, cal_date, is_night, minutes)
      values (v_seg_no, public.ph_date(s.clock_in_at), s.id, s.site_id, v_t, v_local::date,
              v_local::time < '06:00' or v_local::time >= '22:00',
              (extract(epoch from (v_nb - v_t)) / 60)::integer);
      v_t := v_nb;
    end loop;
  end loop;

  -- ---- Worked days --------------------------------------------------------
  for v_d in select g::date from generate_series(v_per.start_date, v_per.end_date, interval '1 day') g loop
    select coalesce(sum(minutes), 0) into v_elapsed from _pay_seg where work_date = v_d;
    continue when v_elapsed = 0;

    select coalesce(sum(le.hours * 60), 0)::integer into v_leave_min
    from public.leave_entries le join public.leave_types lt on lt.id = le.leave_type_id
    where le.employee_id = p_employee_id and le.leave_date = v_d and le.status = 'approved' and lt.is_paid;

    v_rate  := public._rate_on(p_employee_id, v_d);
    v_sched := public._schedule_on(p_employee_id, v_d);
    if v_rate.id is null then
      perform public._add_exception(p_run_id, p_employee_id, v_d, 'NO_RATE',
        format('No daily rate effective on %s.', v_d), true);
    end if;
    if v_sched.id is null then
      perform public._add_exception(p_run_id, p_employee_id, v_d, 'NO_SCHEDULE',
        'No work schedule assigned; rest days, breaks and holiday eligibility cannot be determined.', true);
    end if;
    v_mr := coalesce(v_rate.daily_rate, 0) / 480;

    -- Unpaid break, deducted from the longest segments of the day.
    v_break := case when v_sched.id is not null and v_elapsed > v_sched.break_applies_after_minutes
                    then least(v_sched.unpaid_break_minutes, v_elapsed) else 0 end;
    v_left := v_break;
    for r in select seg_no, minutes from _pay_seg where work_date = v_d order by minutes desc, seg_start loop
      exit when v_left <= 0;
      v_take := least(v_left, r.minutes);
      update _pay_seg set minutes = minutes - v_take, break_minutes = v_take where seg_no = r.seg_no;
      v_left := v_left - v_take;
    end loop;
    v_worked := v_elapsed - v_break;

    -- First 480 worked minutes (chronological) are regular; the rest are OT candidates.
    v_cap := 480;
    for r in select seg_no, minutes from _pay_seg where work_date = v_d order by seg_start loop
      v_take := least(v_cap, r.minutes);
      update _pay_seg set reg_minutes = v_take, ot_minutes = r.minutes - v_take where seg_no = r.seg_no;
      v_cap := v_cap - v_take;
    end loop;
    v_ot_rec := greatest(v_worked - 480, 0);
    if v_worked > 0 then v_days_worked := v_days_worked + 1; end if;
    v_reg_total := v_reg_total + least(v_worked, 480);

    -- Overtime decision.
    v_ot_paid := 0;
    if v_ot_rec > 0 then
      v_ot_rec_tot := v_ot_rec_tot + v_ot_rec;
      if not v_covered then
        perform public._add_line(v_res, 'info', 'OT_NOT_COVERED', 'Extra time (employee not covered by OT rules)', 0,
          v_d, null, v_ot_rec, 'minutes');
      elsif not v_set.ot_review_required then
        v_ot_paid := v_ot_rec;
      else
        select * into v_dec from public.ot_decisions where employee_id = p_employee_id and work_date = v_d;
        if v_dec.id is null then
          insert into public.ot_decisions (employee_id, work_date, recorded_minutes)
          values (p_employee_id, v_d, v_ot_rec) on conflict (employee_id, work_date) do nothing;
          perform public._add_exception(p_run_id, p_employee_id, v_d, 'OT_PENDING',
            format('%s min of extra time awaits an OT decision.', v_ot_rec), true);
        elsif v_dec.recorded_minutes <> v_ot_rec then
          if v_dec.status = 'pending' then
            update public.ot_decisions set recorded_minutes = v_ot_rec, accepted_minutes = 0 where id = v_dec.id;
            perform public._add_exception(p_run_id, p_employee_id, v_d, 'OT_PENDING',
              format('%s min of extra time awaits an OT decision.', v_ot_rec), true);
          else
            perform public._add_exception(p_run_id, p_employee_id, v_d, 'OT_CHANGED',
              format('Recorded extra time changed from %s to %s min after the OT decision; decide again.',
                     v_dec.recorded_minutes, v_ot_rec), true);
          end if;
        elsif v_dec.status = 'accepted' then
          v_ot_paid := least(v_dec.accepted_minutes, v_ot_rec);
          if v_ot_paid < v_ot_rec then
            perform public._add_line(v_res, 'info', 'OT_NOT_ACCEPTED',
              'Extra time not accepted as OT: ' || coalesce(v_dec.reason, ''), 0, v_d, null, v_ot_rec - v_ot_paid, 'minutes');
          end if;
        elsif v_dec.status = 'rejected' then
          perform public._add_line(v_res, 'info', 'OT_NOT_ACCEPTED',
            'Extra time not accepted as OT: ' || coalesce(v_dec.reason, ''), 0, v_d, null, v_ot_rec, 'minutes');
        elsif v_dec.status = 'disputed' then
          perform public._add_exception(p_run_id, p_employee_id, v_d, 'OT_DISPUTED',
            'OT is disputed: ' || coalesce(v_dec.reason, ''), true);
        else
          perform public._add_exception(p_run_id, p_employee_id, v_d, 'OT_PENDING',
            format('%s min of extra time awaits an OT decision.', v_ot_rec), true);
        end if;
      end if;

      v_left := v_ot_paid;
      for r in select seg_no, ot_minutes from _pay_seg where work_date = v_d and ot_minutes > 0 order by seg_start loop
        exit when v_left <= 0;
        v_take := least(v_left, r.ot_minutes);
        update _pay_seg set ot_paid_minutes = v_take where seg_no = r.seg_no;
        v_left := v_left - v_take;
      end loop;
      v_ot_paid_tot := v_ot_paid_tot + v_ot_paid;
    end if;

    -- Earnings by calendar date (holiday / rest-day classification per minute).
    for r in select cal_date, site_id,
                    sum(reg_minutes) as reg, sum(ot_paid_minutes) as otp,
                    sum(case when is_night then reg_minutes else 0 end) as reg_n,
                    sum(case when is_night then ot_paid_minutes else 0 end) as ot_n
             from _pay_seg where work_date = v_d
             group by cal_date, site_id order by cal_date loop
      v_info := public._day_info(p_employee_id, r.site_id, r.cal_date);
      if (v_info ->> 'holiday_count')::integer > 1 then
        perform public._add_exception(p_run_id, p_employee_id, r.cal_date, 'DOUBLE_HOLIDAY',
          'More than one holiday falls on this date; a documented rule is required.', true, v_info);
      end if;
      v_type := case when v_covered then v_info ->> 'day_type' else 'ordinary' end;
      v_mult := public._multiplier(v_type, r.cal_date);
      if v_mult.id is null then
        perform public._add_exception(p_run_id, p_employee_id, r.cal_date, 'NO_MULTIPLIER',
          format('No multiplier configured for %s.', public._day_label(v_type)), true);
      end if;
      v_reg_mult := case when v_covered then coalesce(v_mult.regular_multiplier, 1) else 1 end;
      v_ot_mult  := coalesce(v_mult.ot_multiplier, 1.25);

      if r.reg > 0 then
        perform public._add_line(v_res, 'earning', 'WORK_' || upper(v_type),
          case when v_type = 'ordinary' then 'Regular time' else 'Work on ' || public._day_label(v_type) end,
          r.reg * v_mr * v_reg_mult, r.cal_date, r.site_id, r.reg, 'minutes',
          round(coalesce(v_rate.daily_rate, 0) / 8, 6), v_reg_mult, r.reg * v_mr, true,
          jsonb_build_object('work_date', v_d, 'day_type', v_type, 'holidays', v_info -> 'holidays',
                             'rate_id', v_rate.id, 'multiplier_id', v_mult.id));
      end if;
      if r.otp > 0 then
        perform public._add_line(v_res, 'earning', 'OT_' || upper(v_type),
          'Overtime — ' || public._day_label(v_type),
          r.otp * v_mr * v_ot_mult, r.cal_date, r.site_id, r.otp, 'minutes',
          round(coalesce(v_rate.daily_rate, 0) / 8, 6), v_ot_mult, 0, true,
          jsonb_build_object('work_date', v_d, 'day_type', v_type, 'rate_id', v_rate.id, 'multiplier_id', v_mult.id));
      end if;
      v_n := r.reg_n + r.ot_n;
      if v_n > 0 and v_covered then
        v_night_tot := v_night_tot + v_n;
        if v_set.night_diff_mode = 'pay' then
          perform public._add_line(v_res, 'earning', 'NIGHT_DIFF', 'Night shift differential (10 PM – 6 AM)',
            (r.reg_n * v_reg_mult + r.ot_n * v_ot_mult) * v_mr * v_set.night_diff_rate,
            r.cal_date, r.site_id, v_n, 'minutes', round(coalesce(v_rate.daily_rate, 0) / 8, 6), v_set.night_diff_rate, 0, true,
            jsonb_build_object('work_date', v_d, 'regular_night_minutes', r.reg_n, 'ot_night_minutes', r.ot_n));
        else
          perform public._add_exception(p_run_id, p_employee_id, r.cal_date, 'NIGHT_WORK',
            format('%s min worked between 10 PM and 6 AM. Configure night differential before paying this payroll.', v_n), true);
        end if;
      end if;
    end loop;

    -- Informational undertime / lateness on ordinary scheduled working days.
    if v_sched.id is not null then
      v_info := public._day_info(p_employee_id, coalesce(public._site_on(p_employee_id, v_d), p_primary_site), v_d);
      if (v_info ->> 'is_working_day')::boolean and v_info ->> 'day_type' = 'ordinary' then
        if v_worked + v_leave_min < 480 then
          v_under := 480 - v_worked - v_leave_min;
          v_under_tot := v_under_tot + v_under;
          perform public._add_line(v_res, 'info', 'UNDERTIME',
            'Undertime (informational — regular earnings already reflect time worked)', 0, v_d, null, v_under, 'minutes');
        end if;
        select min(clock_in_at) into v_first_in from public.work_sessions
         where employee_id = p_employee_id and status = 'closed' and public.ph_date(clock_in_at) = v_d;
        v_late := floor(extract(epoch from (date_trunc('minute', v_first_in) - public.ph_ts(v_d, v_sched.start_time))) / 60);
        if v_late > v_sched.grace_minutes then
          v_late_tot := v_late_tot + v_late;
          perform public._add_line(v_res, 'info', 'LATE', 'Late arrival (informational)', 0, v_d, null, v_late, 'minutes');
        end if;
      end if;
    end if;
  end loop;

  -- ---- Regular holidays (unworked balance), absences ---------------------
  for v_d in select g::date from generate_series(v_per.start_date, v_per.end_date, interval '1 day') g loop
    v_site := public._site_on(p_employee_id, v_d);
    continue when v_site is null;                                     -- not assigned that day
    continue when v_emp.hire_date is not null and v_d < v_emp.hire_date;
    continue when v_emp.separation_date is not null and v_d > v_emp.separation_date;
    v_info := public._day_info(p_employee_id, v_site, v_d);

    if (v_info ->> 'holiday_count')::integer > 1 then
      perform public._add_exception(p_run_id, p_employee_id, v_d, 'DOUBLE_HOLIDAY',
        'More than one holiday falls on this date; a documented rule is required.', true, v_info);
    end if;

    select coalesce(sum(reg_minutes), 0) into v_n from _pay_seg where cal_date = v_d;

    if v_info ->> 'day_type' in ('regular_holiday', 'regular_holiday_rest') and v_covered then
      if exists (select 1 from public.leave_entries where employee_id = p_employee_id and leave_date = v_d and status = 'approved') then
        continue;  -- handled in the leave section (blocking exception)
      end if;
      if v_n >= 480 then
        continue;  -- full day worked: holiday multiplier already covers the day
      end if;
      v_elig := case when v_n > 0 then 'eligible'
                     else public._holiday_eligibility(p_employee_id, v_d, v_site, v_set.holiday_lookback_days) end;
      if v_elig = 'eligible' then
        v_rate := public._rate_on(p_employee_id, v_d);
        if v_rate.id is null then
          perform public._add_exception(p_run_id, p_employee_id, v_d, 'NO_RATE', format('No daily rate effective on %s.', v_d), true);
        else
          perform public._add_line(v_res, 'earning', 'HOLIDAY_PAY',
            case when v_n = 0 then 'Regular holiday pay (unworked)' else 'Regular holiday pay (unworked hours)' end,
            (480 - v_n) * v_rate.daily_rate / 480, v_d, v_site, 480 - v_n, 'minutes',
            round(v_rate.daily_rate / 8, 6), 1, (480 - v_n) * v_rate.daily_rate / 480, true,
            jsonb_build_object('holidays', v_info -> 'holidays', 'rate_id', v_rate.id, 'worked_minutes', v_n));
        end if;
      elsif v_elig in ('no_schedule', 'undetermined') then
        perform public._add_exception(p_run_id, p_employee_id, v_d, 'HOLIDAY_ELIGIBILITY',
          'Regular-holiday pay eligibility cannot be determined (schedule / preceding working day).', true);
      else
        perform public._add_line(v_res, 'info', 'HOLIDAY_NOT_ELIGIBLE',
          case v_elig when 'absent' then 'Regular holiday not paid: absent without paid leave on the preceding working day'
                      else 'Regular holiday not paid: not yet employed on the preceding working day' end,
          0, v_d, v_site);
      end if;
    elsif (v_info ->> 'is_working_day')::boolean and v_info ->> 'day_type' = 'ordinary'
          and not exists (select 1 from _pay_seg where work_date = v_d or cal_date = v_d)
          and not exists (select 1 from public.leave_entries where employee_id = p_employee_id and leave_date = v_d and status = 'approved') then
      perform public._add_line(v_res, 'info', 'ABSENT', 'Absent on a scheduled working day (no work, no pay)', 0, v_d, v_site, 1, 'days');
    end if;
  end loop;

  -- ---- Leave ---------------------------------------------------------------
  for r in select le.*, lt.code as type_code, lt.name as type_name, lt.is_paid
           from public.leave_entries le join public.leave_types lt on lt.id = le.leave_type_id
           where le.employee_id = p_employee_id and le.status = 'approved'
             and le.leave_date between v_per.start_date and v_per.end_date
           order by le.leave_date loop
    if not r.is_paid then
      perform public._add_line(v_res, 'info', 'LEAVE_UNPAID', r.type_name || ' (unpaid)', 0, r.leave_date, null, r.hours * 60, 'minutes');
      continue;
    end if;
    v_site := coalesce(public._site_on(p_employee_id, r.leave_date), p_primary_site);
    v_info := public._day_info(p_employee_id, v_site, r.leave_date);
    if v_info ->> 'day_type' in ('regular_holiday', 'regular_holiday_rest') then
      perform public._add_exception(p_run_id, p_employee_id, r.leave_date, 'LEAVE_ON_HOLIDAY',
        'Paid leave recorded on a regular holiday; cancel the leave or document the rule (no double payment).', true);
      continue;
    end if;
    if (v_info ->> 'is_rest')::boolean then
      perform public._add_exception(p_run_id, p_employee_id, r.leave_date, 'LEAVE_ON_REST_DAY',
        'Paid leave recorded on a scheduled rest day.', false);
    end if;
    select coalesce(sum(reg_minutes), 0) into v_n from _pay_seg where work_date = r.leave_date;
    if v_n + r.hours * 60 > 480 then
      perform public._add_exception(p_run_id, p_employee_id, r.leave_date, 'LEAVE_OVERLAP',
        'Worked time plus paid leave exceeds 8 hours on the same day.', true);
    end if;
    v_rate := public._rate_on(p_employee_id, r.leave_date);
    if v_rate.id is null then
      perform public._add_exception(p_run_id, p_employee_id, r.leave_date, 'NO_RATE', format('No daily rate effective on %s.', r.leave_date), true);
      continue;
    end if;
    v_leave_hours := v_leave_hours + r.hours;
    perform public._add_line(v_res, 'earning', 'LEAVE_PAID', r.type_name || ' (paid leave)',
      r.hours * 60 * v_rate.daily_rate / 480, r.leave_date, v_site, r.hours * 60, 'minutes',
      round(v_rate.daily_rate / 8, 6), 1, r.hours * 60 * v_rate.daily_rate / 480, true,
      jsonb_build_object('leave_entry_id', r.id, 'rate_id', v_rate.id));
  end loop;

  -- ---- Allowances ----------------------------------------------------------
  for r in select * from public.allowance_rules
           where employee_id = p_employee_id and is_active
             and effective_from <= v_per.end_date and (effective_to is null or effective_to >= v_per.start_date)
           order by name loop
    if r.frequency = 'per_day_worked' then
      select count(distinct work_date) into v_n from _pay_seg
       where reg_minutes + ot_minutes > 0
         and work_date between greatest(v_per.start_date, r.effective_from) and least(v_per.end_date, coalesce(r.effective_to, v_per.end_date));
      if v_n > 0 then
        perform public._add_line(v_res, 'earning', 'ALLOWANCE', r.name, v_n * r.amount, null, null, v_n, 'days',
          r.amount, 1, 0, r.taxable, jsonb_build_object('allowance_rule_id', r.id));
      end if;
    else
      if not r.requires_attendance or v_days_worked > 0 or v_leave_hours > 0 then
        perform public._add_line(v_res, 'earning', 'ALLOWANCE', r.name, r.amount, null, null, 1, 'week',
          r.amount, 1, 0, r.taxable, jsonb_build_object('allowance_rule_id', r.id));
      end if;
    end if;
  end loop;

  -- ---- Manual earning adjustments -----------------------------------------
  for r in select * from public.payroll_adjustments
           where employee_id = p_employee_id and period_id = v_per.id and kind = 'earning' order by created_at loop
    perform public._add_line(v_res, 'earning', 'ADJ_EARN', r.description, r.amount, null, null, null, null, null, null, 0,
      r.taxable, jsonb_build_object('adjustment_id', r.id, 'reason', r.reason, 'created_by', r.created_by));
  end loop;

  select coalesce(sum(amount), 0), coalesce(sum(basic_amount), 0),
         coalesce(sum(amount) filter (where not (code = 'ALLOWANCE' and not taxable)), 0)
    into v_gross, v_basic_sum, v_comp_sum
  from public.payroll_lines where result_id = v_res and category = 'earning';
  v_avail := v_gross;

  -- ---- Sequencing guard: earlier periods must be finalized first ---------
  if exists (select 1 from public.payroll_results r2
             join public.payroll_runs u on u.id = r2.run_id
             join public.payroll_periods p2 on p2.id = u.period_id
             where r2.employee_id = p_employee_id and u.id <> p_run_id
               and u.status in ('draft', 'ready_for_review') and p2.start_date < v_per.start_date) then
    perform public._add_exception(p_run_id, p_employee_id, null, 'PRIOR_RUN_OPEN',
      'An earlier payroll run for this employee is not finalized yet; finalize it first.', true);
  end if;

  -- ---- Statutory contributions with monthly reconciliation ---------------
  v_month := date_trunc('month', v_per.payday)::date;
  select count(*), count(*) filter (where g::date <= v_per.payday)
    into v_n_paydays, v_k
  from generate_series(v_month, (v_month + interval '1 month' - interval '1 day')::date, interval '1 day') g
  where extract(isodow from g) = extract(isodow from v_per.payday);
  v_after := v_n_paydays - v_k;
  v_final := v_after = 0 or (v_emp.separation_date is not null and v_emp.separation_date <= v_per.end_date);

  if v_emp.statutory_covered and v_gross > 0 then
    foreach v_agency in array array['sss', 'philhealth', 'pagibig'] loop
      v_rule := public._rule_for(v_agency::public.statutory_agency, v_per.payday);
      if v_rule.id is null then
        perform public._add_exception(p_run_id, p_employee_id, null, 'NO_RULE',
          format('No %s rule version covers payday %s.', upper(v_agency), v_per.payday), true);
        continue;
      end if;
      if v_rule.status <> 'approved' then
        perform public._add_exception(p_run_id, p_employee_id, null, 'RULE_NOT_APPROVED',
          format('%s rule "%s" is a draft; an admin must review and approve it.', upper(v_agency), v_rule.name), true,
          jsonb_build_object('rule_version_id', v_rule.id));
      end if;
      v_basis := case v_rule.params ->> 'basis' when 'basic' then v_basic_sum when 'gross' then v_gross else v_comp_sum end;

      select coalesce(sum(cl.basis_amount), 0), coalesce(sum(cl.employee_amount), 0),
             coalesce(sum(cl.employer_amount), 0), coalesce(sum(cl.ec_amount), 0), count(distinct cl.payroll_run_id)
        into v_p_basis, v_p_ee, v_p_er, v_p_ec, v_p_runs
      from public.contribution_ledger cl
      join public.payroll_runs u on u.id = cl.payroll_run_id
      where cl.employee_id = p_employee_id and cl.agency = v_agency::public.statutory_agency
        and cl.contribution_month = v_month and u.status in ('finalized', 'paid');

      v_m_basis := v_p_basis + v_basis;
      v_proj := case when v_final then v_m_basis
                     else round(v_m_basis / (v_p_runs + 1) * (v_p_runs + 1 + v_after), 2) end;
      v_ob := public._contrib_compute(v_agency, v_rule.params, v_proj);
      if v_final then
        v_ee := (v_ob ->> 'ee')::numeric - v_p_ee;
        v_er := (v_ob ->> 'er')::numeric - v_p_er;
        v_ec := (v_ob ->> 'ec')::numeric - v_p_ec;
      else
        v_ee := greatest(round(((v_ob ->> 'ee')::numeric - v_p_ee) / (v_after + 1), 2), 0);
        v_er := greatest(round(((v_ob ->> 'er')::numeric - v_p_er) / (v_after + 1), 2), 0);
        v_ec := greatest(round(((v_ob ->> 'ec')::numeric - v_p_ec) / (v_after + 1), 2), 0);
      end if;
      if v_ee > v_avail then
        perform public._add_exception(p_run_id, p_employee_id, null, 'STATUTORY_SHORTFALL',
          format('%s employee share %s exceeds available pay %s; only %s collected.',
                 upper(v_agency), v_ee, v_avail, greatest(v_avail, 0)), false);
        v_ee := greatest(v_avail, 0);
      end if;
      v_avail := v_avail - v_ee;
      v_stat_ee := v_stat_ee + v_ee;

      v_stat := v_stat || jsonb_build_array(jsonb_build_object(
        'agency', v_agency, 'month', v_month, 'basis', v_basis, 'month_basis', v_m_basis,
        'projected_basis', v_proj, 'final', v_final, 'ee', v_ee, 'er', v_er, 'ec', v_ec,
        'obligation_ee', v_ob -> 'ee', 'obligation_er', v_ob -> 'er', 'obligation_ec', v_ob -> 'ec',
        'credit', v_ob -> 'credit', 'prior_ee', v_p_ee, 'prior_er', v_p_er, 'prior_runs', v_p_runs,
        'paydays_in_month', v_n_paydays, 'payday_index', v_k, 'rule_version_id', v_rule.id));

      v_codes := case v_agency when 'sss' then array['SSS_EE', 'SSS_ER', 'SSS_EC']
                               when 'philhealth' then array['PHIC_EE', 'PHIC_ER', null]
                               else array['HDMF_EE', 'HDMF_ER', null] end;
      if v_ee <> 0 then
        perform public._add_line(v_res, 'deduction', v_codes[1],
          case v_agency when 'sss' then 'SSS contribution' when 'philhealth' then 'PhilHealth contribution'
                        else 'Pag-IBIG contribution' end
          || case when v_final then ' (month-end reconciliation)' else format(' (installment %s of %s)', v_k, v_n_paydays) end,
          v_ee, null, null, null, null, null, null, 0, false, v_stat -> -1);
      end if;
      if v_er <> 0 then
        perform public._add_line(v_res, 'employer', v_codes[2],
          case v_agency when 'sss' then 'SSS employer share' when 'philhealth' then 'PhilHealth employer share'
                        else 'Pag-IBIG employer share' end, v_er, null, null, null, null, null, null, 0, false, v_stat -> -1);
      end if;
      if v_ec <> 0 and v_codes[3] is not null then
        perform public._add_line(v_res, 'employer', v_codes[3], 'SSS employees'' compensation (EC, employer only)',
          v_ec, null, null, null, null, null, null, 0, false, v_stat -> -1);
      end if;
    end loop;
  end if;

  -- ---- Withholding tax ------------------------------------------------------
  if v_gross > 0 then
    v_rule := public._rule_for('bir_withholding', v_per.payday);
    if v_rule.id is null then
      perform public._add_exception(p_run_id, p_employee_id, null, 'NO_RULE',
        format('No BIR withholding rule version covers payday %s.', v_per.payday), true);
    else
      if v_rule.status <> 'approved' then
        perform public._add_exception(p_run_id, p_employee_id, null, 'RULE_NOT_APPROVED',
          format('BIR withholding rule "%s" is a draft; an admin must review and approve it.', v_rule.name), true,
          jsonb_build_object('rule_version_id', v_rule.id));
      end if;
      if v_emp.is_minimum_wage_earner then
        select coalesce(sum(amount), 0) into v_taxable from public.payroll_lines
         where result_id = v_res and category = 'earning' and taxable and code in ('ALLOWANCE', 'ADJ_EARN');
      else
        select coalesce(sum(amount), 0) - v_stat_ee into v_taxable from public.payroll_lines
         where result_id = v_res and category = 'earning' and taxable;
      end if;
      v_tax := public._withholding(v_rule.params, v_taxable);
      if v_tax > v_avail then
        perform public._add_exception(p_run_id, p_employee_id, null, 'TAX_SHORTFALL',
          format('Withholding tax %s exceeds available pay %s.', v_tax, v_avail), true);
      end if;
      if v_tax > 0 then
        perform public._add_line(v_res, 'deduction', 'TAX_WH', 'Withholding tax', v_tax, null, null,
          v_taxable, 'peso', null, null, 0, false,
          jsonb_build_object('rule_version_id', v_rule.id, 'taxable_compensation', v_taxable,
                             'minimum_wage_earner', v_emp.is_minimum_wage_earner));
        v_avail := v_avail - v_tax;
      end if;
    end if;
  end if;

  -- ---- Other authorized deductions ---------------------------------------
  for r in select * from public.payroll_adjustments
           where employee_id = p_employee_id and period_id = v_per.id and kind = 'deduction' order by created_at loop
    perform public._add_line(v_res, 'deduction', 'ADJ_DED', r.description, r.amount, null, null, null, null, null, null, 0,
      false, jsonb_build_object('adjustment_id', r.id, 'reason', r.reason, 'created_by', r.created_by));
    v_avail := v_avail - r.amount;
  end loop;

  -- ---- Cash advance installments (posted to the ledger only on finalize) --
  for r in select a.*, (select coalesce(sum(l.amount), 0) from public.advance_ledger l where l.advance_id = a.id) as balance
           from public.cash_advances a
           where a.employee_id = p_employee_id and a.status = 'active' and a.first_deduction_date <= v_per.payday
           order by a.released_on, a.created_at loop
    continue when r.balance <= 0;
    v_inst := least(r.installment_amount, r.balance);
    if v_avail <= 0 then
      perform public._add_exception(p_run_id, p_employee_id, null, 'ADVANCE_DEFERRED',
        format('Cash advance installment %s deferred: insufficient net pay. Balance stays in the advance ledger.', v_inst), false,
        jsonb_build_object('advance_id', r.id));
      continue;
    end if;
    if v_inst > v_avail then
      perform public._add_exception(p_run_id, p_employee_id, null, 'ADVANCE_PARTIAL',
        format('Cash advance installment reduced from %s to %s due to insufficient net pay.', v_inst, round(v_avail, 2)), false,
        jsonb_build_object('advance_id', r.id));
      v_inst := round(v_avail, 2);
    end if;
    perform public._add_line(v_res, 'deduction', 'ADVANCE', 'Cash advance repayment', v_inst, null, null, null, null, null, null, 0,
      false, jsonb_build_object('advance_id', r.id, 'balance_before', r.balance, 'balance_after', r.balance - v_inst,
                                'installment', r.installment_amount));
    v_avail := v_avail - v_inst;
  end loop;

  -- ---- Totals ---------------------------------------------------------------
  select coalesce(sum(amount) filter (where category = 'deduction'), 0),
         coalesce(sum(amount) filter (where category = 'employer'), 0)
    into v_ded, v_er_total
  from public.payroll_lines where result_id = v_res;
  v_net := v_gross - v_ded;
  if v_net < 0 then
    perform public._add_exception(p_run_id, p_employee_id, null, 'NEGATIVE_NET',
      format('Deductions exceed gross pay (net %s).', v_net), true);
  end if;

  update public.payroll_results set
    days_worked = v_days_worked, regular_minutes = v_reg_total, ot_minutes_recorded = v_ot_rec_tot,
    ot_minutes_paid = v_ot_paid_tot, undertime_minutes = v_under_tot, late_minutes = v_late_tot,
    night_minutes = v_night_tot, leave_hours = v_leave_hours,
    gross_pay = v_gross, total_deductions = v_ded, net_pay = v_net, employer_contributions = v_er_total,
    statutory = v_stat,
    blocking_count = (select count(*) from public.payroll_exceptions where run_id = p_run_id and employee_id = p_employee_id and blocking),
    warning_count  = (select count(*) from public.payroll_exceptions where run_id = p_run_id and employee_id = p_employee_id and not blocking)
  where id = v_res;

  -- Nothing payable and nothing to resolve: leave the employee out of the run.
  if v_gross = 0 and v_ded = 0
     and not exists (select 1 from public.payroll_exceptions where run_id = p_run_id and employee_id = p_employee_id and blocking) then
    delete from public.payroll_exceptions where run_id = p_run_id and employee_id = p_employee_id;
    delete from public.payroll_results where id = v_res;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Whole-run calculation (internal)
-- ---------------------------------------------------------------------------
create or replace function public._payroll_calculate(p_run_id uuid, p_actor uuid) returns void
language plpgsql set search_path = public, extensions as $$
declare
  v_run  public.payroll_runs;
  v_per  public.payroll_periods;
  v_from timestamptz;
  v_to   timestamptz;
  c      record;
  v_other bigint;
begin
  select * into v_run from public.payroll_runs where id = p_run_id;
  select * into v_per from public.payroll_periods where id = v_run.period_id;
  v_from := public.ph_ts(v_per.start_date);
  v_to   := public.ph_ts(v_per.end_date + 1);

  create temp table if not exists _pay_seg (
    seg_no          integer primary key,
    work_date       date not null,
    session_id      uuid not null,
    site_id         uuid not null,
    seg_start       timestamptz not null,
    cal_date        date not null,
    is_night        boolean not null,
    minutes         integer not null,
    break_minutes   integer not null default 0,
    reg_minutes     integer not null default 0,
    ot_minutes      integer not null default 0,
    ot_paid_minutes integer not null default 0
  ) on commit drop;

  delete from public.payroll_lines      where run_id = p_run_id;
  delete from public.payroll_exceptions where run_id = p_run_id;
  delete from public.payroll_results    where run_id = p_run_id;

  for c in
    select x.employee_id, x.primary_site from (
      select e.id as employee_id,
             coalesce(
               (select a.site_id from public.employee_site_assignments a
                 where a.employee_id = e.id
                   and tstzrange(a.effective_from, a.effective_to, '[)') && tstzrange(v_from, v_to, '[)')
                 order by a.effective_from desc limit 1),
               (select w.site_id from public.work_sessions w
                 where w.employee_id = e.id and w.status <> 'voided' and w.clock_in_at >= v_from and w.clock_in_at < v_to
                 order by w.clock_in_at desc limit 1)) as primary_site,
             e.last_name, e.first_name
      from public.employees e) x
    where x.primary_site is not null
      and (v_run.site_ids is null or x.primary_site = any (v_run.site_ids))
    order by x.last_name, x.first_name
  loop
    select u.run_no into v_other
    from public.payroll_results r2 join public.payroll_runs u on u.id = r2.run_id
    where r2.employee_id = c.employee_id and u.period_id = v_run.period_id and u.id <> p_run_id and u.status <> 'void'
    limit 1;
    if v_other is not null then
      perform public._add_exception(p_run_id, c.employee_id, null, 'IN_OTHER_RUN',
        format('Already included in payroll run #%s for this period; excluded here to avoid duplicate pay.', v_other), false);
      continue;
    end if;
    perform public._payroll_employee(p_run_id, c.employee_id, c.primary_site);
  end loop;

  update public.payroll_runs set
    totals = (select jsonb_build_object(
                'employees', count(*),
                'gross', coalesce(sum(gross_pay), 0),
                'deductions', coalesce(sum(total_deductions), 0),
                'net', coalesce(sum(net_pay), 0),
                'employer', coalesce(sum(employer_contributions), 0))
              from public.payroll_results where run_id = p_run_id),
    blocking_count = (select count(*) from public.payroll_exceptions where run_id = p_run_id and blocking),
    warning_count  = (select count(*) from public.payroll_exceptions where run_id = p_run_id and not blocking),
    calculated_at = now(),
    calculated_by = p_actor
  where id = p_run_id;
end $$;

-- ---------------------------------------------------------------------------
-- Public payroll API (website)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_ensure_period(p_date date) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_set   public.payroll_settings;
  v_start date;
  v_id    uuid;
begin
  perform public.require_staff();
  select * into v_set from public.payroll_settings where id = 1;
  v_start := p_date - ((extract(isodow from p_date)::integer - v_set.period_start_dow + 7) % 7);
  select id into v_id from public.payroll_periods where p_date between start_date and end_date;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.payroll_periods (start_date, end_date, payday)
  values (v_start, v_start + 6, v_start + 6 + v_set.payday_offset_days)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.payroll_create_run(p_period_id uuid, p_site_ids uuid[] default null, p_notes text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := public.require_staff();
  v_sites uuid[] := case when p_site_ids is null or cardinality(p_site_ids) = 0 then null else p_site_ids end;
  v_conf  bigint;
  v_id    uuid;
begin
  if not public.can_access_run(v_sites) then
    raise exception 'You can only create payroll runs for sites in your scope';
  end if;
  if not exists (select 1 from public.payroll_periods where id = p_period_id) then
    raise exception 'Payroll period not found';
  end if;
  select run_no into v_conf from public.payroll_runs
  where period_id = p_period_id and status <> 'void'
    and (site_ids is null or v_sites is null or site_ids && v_sites)
  limit 1;
  if v_conf is not null then
    raise exception 'Payroll run #% already covers this period for one of these sites', v_conf;
  end if;
  insert into public.payroll_runs (period_id, site_ids, notes, created_by)
  values (p_period_id, v_sites, p_notes, v_uid)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public._lock_run(p_run_id uuid) returns public.payroll_runs
language plpgsql set search_path = public as $$
declare v public.payroll_runs;
begin
  select * into v from public.payroll_runs where id = p_run_id for update;
  if v.id is null or not public.can_access_run(v.site_ids) then
    raise exception 'Payroll run not found or not accessible';
  end if;
  return v;
end $$;

create or replace function public.payroll_calculate(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public.require_staff();
  v_run public.payroll_runs;
begin
  v_run := public._lock_run(p_run_id);
  if v_run.status not in ('draft', 'ready_for_review') then
    raise exception 'Only draft or ready-for-review payroll can be recalculated (status: %)', v_run.status;
  end if;
  perform public._payroll_calculate(p_run_id, v_uid);
  update public.payroll_runs set status = 'draft', submitted_at = null, submitted_by = null where id = p_run_id;
  select * into v_run from public.payroll_runs where id = p_run_id;
  return v_run.totals || jsonb_build_object('blocking', v_run.blocking_count, 'warnings', v_run.warning_count);
end $$;

create or replace function public.payroll_submit(p_run_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_staff();
  v_run public.payroll_runs;
begin
  v_run := public._lock_run(p_run_id);
  if v_run.status <> 'draft' or v_run.calculated_at is null then
    raise exception 'Calculate the draft payroll before submitting it for review';
  end if;
  update public.payroll_runs set status = 'ready_for_review', submitted_at = now(), submitted_by = v_uid where id = p_run_id;
end $$;

create or replace function public.payroll_return_to_draft(p_run_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_run public.payroll_runs;
begin
  perform public.require_staff();
  v_run := public._lock_run(p_run_id);
  if v_run.status <> 'ready_for_review' then
    raise exception 'Only ready-for-review payroll can be returned to draft';
  end if;
  update public.payroll_runs set status = 'draft', submitted_at = null, submitted_by = null where id = p_run_id;
end $$;

create or replace function public.payroll_delete_draft(p_run_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_run public.payroll_runs;
begin
  perform public.require_staff();
  v_run := public._lock_run(p_run_id);
  if v_run.status not in ('draft', 'ready_for_review') then
    raise exception 'Only draft payroll can be deleted; finalized payroll must be voided';
  end if;
  delete from public.payroll_runs where id = p_run_id;
end $$;

-- Finalize: recalculates from current data, verifies the reviewed net total, then
-- snapshots payslips and posts contribution and cash-advance ledgers exactly once.
create or replace function public.payroll_finalize(p_run_id uuid, p_expected_net numeric) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid   uuid := public.require_staff();
  v_run   public.payroll_runs;
  v_per   public.payroll_periods;
  v_net   numeric;
  v_dup   text;
  v_count integer;
begin
  v_run := public._lock_run(p_run_id);
  if v_run.status <> 'ready_for_review' then
    raise exception 'Submit the payroll for review before finalizing (status: %)', v_run.status;
  end if;
  select * into v_per from public.payroll_periods where id = v_run.period_id;

  perform public._payroll_calculate(p_run_id, v_run.calculated_by);
  select * into v_run from public.payroll_runs where id = p_run_id;
  v_net := (v_run.totals ->> 'net')::numeric;

  if v_run.blocking_count > 0 then
    update public.payroll_runs set status = 'draft', submitted_at = null where id = p_run_id;
    return jsonb_build_object('ok', false, 'code', 'BLOCKING',
      'message', format('%s blocking exception(s) must be resolved before finalizing.', v_run.blocking_count));
  end if;
  if p_expected_net is null or round(p_expected_net, 2) <> round(v_net, 2) then
    update public.payroll_runs set status = 'draft', submitted_at = null where id = p_run_id;
    return jsonb_build_object('ok', false, 'code', 'CHANGED',
      'message', format('Payroll data changed since review (reviewed net %s, current net %s). Review again.',
                        p_expected_net, v_net));
  end if;

  select string_agg(distinct e.display_name, ', ') into v_dup
  from public.payroll_results r
  join public.payroll_results r2 on r2.employee_id = r.employee_id and r2.run_id <> r.run_id
  join public.payroll_runs u on u.id = r2.run_id and u.period_id = v_run.period_id and u.status in ('finalized', 'paid')
  join public.employees e on e.id = r.employee_id
  where r.run_id = p_run_id;
  if v_dup is not null then
    raise exception 'Already paid in another finalized run for this period: %', v_dup;
  end if;

  -- Monthly contribution ledger.
  insert into public.contribution_ledger (employee_id, agency, contribution_month, payroll_run_id, kind, basis_amount,
         employee_amount, employer_amount, ec_amount, obligation_employee, obligation_employer, obligation_ec, rule_version_id)
  select r.employee_id, (s ->> 'agency')::public.statutory_agency, (s ->> 'month')::date, p_run_id,
         case when (s ->> 'final')::boolean then 'true_up' else 'collection' end,
         (s ->> 'basis')::numeric, (s ->> 'ee')::numeric, (s ->> 'er')::numeric, (s ->> 'ec')::numeric,
         (s ->> 'obligation_ee')::numeric, (s ->> 'obligation_er')::numeric, (s ->> 'obligation_ec')::numeric,
         (s ->> 'rule_version_id')::uuid
  from public.payroll_results r, jsonb_array_elements(r.statutory) s
  where r.run_id = p_run_id;

  -- Cash advance repayments (idempotent per advance + run).
  insert into public.advance_ledger (advance_id, entry_date, kind, amount, payroll_run_id, note, created_by)
  select (l.source ->> 'advance_id')::uuid, v_per.payday, 'repayment', -l.amount, p_run_id,
         format('Payroll run #%s', v_run.run_no), v_uid
  from public.payroll_lines l
  where l.run_id = p_run_id and l.code = 'ADVANCE' and l.amount > 0
  on conflict do nothing;
  update public.cash_advances a set status = 'completed'
  where a.status = 'active'
    and a.id in (select (l.source ->> 'advance_id')::uuid from public.payroll_lines l where l.run_id = p_run_id and l.code = 'ADVANCE')
    and (select coalesce(sum(amount), 0) from public.advance_ledger where advance_id = a.id) <= 0;

  -- Immutable payslip snapshots.
  insert into public.payslips (run_id, employee_id, payslip_no, snapshot)
  select r.run_id, r.employee_id,
         'PS-' || to_char(v_per.payday, 'YYYY') || '-' || lpad(nextval('public.payslip_seq')::text, 6, '0'),
         jsonb_build_object(
           'run_no', v_run.run_no,
           'period', jsonb_build_object('start_date', v_per.start_date, 'end_date', v_per.end_date, 'payday', v_per.payday),
           'employee', r.employee_snapshot,
           'totals', jsonb_build_object(
              'gross_pay', r.gross_pay, 'total_deductions', r.total_deductions, 'net_pay', r.net_pay,
              'employer_contributions', r.employer_contributions, 'days_worked', r.days_worked,
              'regular_minutes', r.regular_minutes, 'ot_minutes_paid', r.ot_minutes_paid,
              'undertime_minutes', r.undertime_minutes, 'late_minutes', r.late_minutes,
              'night_minutes', r.night_minutes, 'leave_hours', r.leave_hours),
           'statutory', r.statutory,
           'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                        'category', l.category, 'code', l.code, 'description', l.description, 'work_date', l.work_date,
                        'quantity', l.quantity, 'unit', l.unit, 'rate', l.rate, 'multiplier', l.multiplier,
                        'amount', l.amount) order by l.sort_order, l.work_date nulls last, l.id), '[]'::jsonb)
                     from public.payroll_lines l where l.result_id = r.id),
           'finalized_at', now(),
           'finalized_by', v_uid)
  from public.payroll_results r where r.run_id = p_run_id
  order by r.employee_snapshot ->> 'name';
  get diagnostics v_count = row_count;

  update public.payroll_runs set status = 'finalized', finalized_at = now(), finalized_by = v_uid where id = p_run_id;
  return jsonb_build_object('ok', true, 'payslips', v_count, 'net', v_net);
end $$;

create or replace function public.payroll_record_payment(
  p_run_id uuid, p_employee_ids uuid[], p_method text, p_reference text, p_paid_at timestamptz default now())
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := public.require_staff();
  v_run   public.payroll_runs;
  v_count integer;
begin
  v_run := public._lock_run(p_run_id);
  if v_run.status not in ('finalized', 'paid') then
    raise exception 'Payments can only be recorded for finalized payroll';
  end if;
  if coalesce(trim(p_method), '') = '' then
    raise exception 'Payment method is required';
  end if;
  insert into public.payment_records (run_id, employee_id, amount, method, reference, paid_at, recorded_by)
  select r.run_id, r.employee_id, r.net_pay, trim(p_method), nullif(trim(p_reference), ''), coalesce(p_paid_at, now()), v_uid
  from public.payroll_results r
  where r.run_id = p_run_id and (p_employee_ids is null or r.employee_id = any (p_employee_ids))
  on conflict (run_id, employee_id) do nothing;
  get diagnostics v_count = row_count;

  if not exists (select 1 from public.payroll_results r
                 where r.run_id = p_run_id
                   and not exists (select 1 from public.payment_records p where p.run_id = r.run_id and p.employee_id = r.employee_id)) then
    update public.payroll_runs set status = 'paid',
           paid_at = (select max(paid_at) from public.payment_records where run_id = p_run_id)
    where id = p_run_id;
  end if;
  return v_count;
end $$;

-- Void a finalized / paid run: payslips are kept but marked void, cash-advance
-- repayments are reversed, contribution rows stop counting (run status = void).
create or replace function public.payroll_void(p_run_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_staff();
  v_run public.payroll_runs;
begin
  v_run := public._lock_run(p_run_id);
  if v_run.status not in ('finalized', 'paid') then
    raise exception 'Only finalized or paid payroll can be voided (delete drafts instead)';
  end if;
  if v_run.status = 'paid' and not public.is_admin() then
    raise exception 'Only an admin can void payroll that has been paid';
  end if;
  if coalesce(length(trim(p_reason)), 0) < 5 then
    raise exception 'A void reason is required';
  end if;
  if exists (select 1 from public.payroll_runs u
             join public.payroll_periods p on p.id = u.period_id
             join public.payroll_periods p0 on p0.id = v_run.period_id
             where u.status in ('finalized', 'paid') and u.id <> p_run_id and p.start_date > p0.start_date
               and date_trunc('month', p.payday) = date_trunc('month', p0.payday)
               and exists (select 1 from public.payroll_results a join public.payroll_results b on a.employee_id = b.employee_id
                           where a.run_id = u.id and b.run_id = p_run_id)) then
    raise exception 'A later payroll in the same contribution month is finalized for these employees; void the later run first';
  end if;

  insert into public.advance_ledger (advance_id, entry_date, kind, amount, payroll_run_id, note, created_by)
  select l.advance_id, current_date, 'reversal', -l.amount, p_run_id, 'Void of payroll run #' || v_run.run_no || ': ' || p_reason, v_uid
  from public.advance_ledger l where l.payroll_run_id = p_run_id and l.kind = 'repayment'
  on conflict do nothing;
  update public.cash_advances a set status = 'active'
  where a.status = 'completed'
    and a.id in (select advance_id from public.advance_ledger where payroll_run_id = p_run_id)
    and (select coalesce(sum(amount), 0) from public.advance_ledger where advance_id = a.id) > 0;

  update public.payslips set status = 'void', voided_at = now(), void_reason = p_reason
  where run_id = p_run_id and status = 'issued';
  update public.payroll_runs set status = 'void', voided_at = now(), voided_by = v_uid, void_reason = p_reason where id = p_run_id;
end $$;

-- Reissue: new draft run for the same period / sites, linked to the voided run.
create or replace function public.payroll_reissue(p_run_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_staff();
  v_run public.payroll_runs;
  v_id  uuid;
begin
  v_run := public._lock_run(p_run_id);
  if v_run.status <> 'void' then
    raise exception 'Void the payroll run before reissuing it';
  end if;
  if exists (select 1 from public.payroll_runs where reissue_of_run_id = p_run_id and status <> 'void') then
    raise exception 'This run has already been reissued';
  end if;
  insert into public.payroll_runs (period_id, site_ids, reissue_of_run_id, notes, created_by)
  values (v_run.period_id, v_run.site_ids, p_run_id, 'Reissue of run #' || v_run.run_no || ' (' || v_run.void_reason || ')', v_uid)
  returning id into v_id;
  return v_id;
end $$;

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

grant execute on function
  public.payroll_ensure_period(date),
  public.payroll_create_run(uuid, uuid[], text),
  public.payroll_calculate(uuid),
  public.payroll_submit(uuid),
  public.payroll_return_to_draft(uuid),
  public.payroll_delete_draft(uuid),
  public.payroll_finalize(uuid, numeric),
  public.payroll_record_payment(uuid, uuid[], text, text, timestamptz),
  public.payroll_void(uuid, text),
  public.payroll_reissue(uuid)
to authenticated;
