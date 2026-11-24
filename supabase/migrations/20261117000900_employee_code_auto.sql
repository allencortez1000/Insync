-- =============================================================================
-- Migration 9: employee codes are generated automatically and cannot be edited
--   New employees get EMP-0001, EMP-0002, ... (the code is shown on the roster to
--   tell identical names apart). Like site codes, a code never changes afterwards.
-- =============================================================================

create sequence if not exists public.employee_code_seq;

create or replace function public.employee_code_default() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if new.employee_code is not null and btrim(new.employee_code) <> '' then
    new.employee_code := upper(btrim(new.employee_code));   -- explicit codes (e.g. data import)
    return new;
  end if;
  loop
    v_code := 'EMP-' || lpad(nextval('public.employee_code_seq')::text, 4, '0');
    exit when not exists (select 1 from public.employees where employee_code = v_code);
  end loop;
  new.employee_code := v_code;
  return new;
end $$;
drop trigger if exists trg_employees_code_default on public.employees;
create trigger trg_employees_code_default before insert on public.employees
  for each row execute function public.employee_code_default();

create or replace function public.employee_code_locked() returns trigger
language plpgsql as $$
begin
  new.employee_code := old.employee_code;
  return new;
end $$;
drop trigger if exists trg_employees_code_locked on public.employees;
create trigger trg_employees_code_locked before update of employee_code on public.employees
  for each row execute function public.employee_code_locked();

revoke execute on function public.employee_code_default() from public, anon;
revoke execute on function public.employee_code_locked() from public, anon;
