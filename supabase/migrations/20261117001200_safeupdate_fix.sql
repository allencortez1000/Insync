-- =============================================================================
-- Migration 12: payroll calculation fix for Supabase's "safeupdate" guard
--
-- Supabase rejects any DELETE / UPDATE without a WHERE clause on API connections
-- ("DELETE requires a WHERE clause"). The payroll engines cleared their temporary
-- work tables with a bare DELETE, so "Calculate" failed when run from the website.
-- This patches the installed functions in place (works on new and existing databases).
-- =============================================================================
do $$
declare
  r     record;
  v_def text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('_payroll_employee', '_payroll_employee_statutory', '_payroll_employee_construction') loop
    v_def := pg_get_functiondef(r.oid);
    if v_def like '%delete from _pay_seg;%' or v_def like '%delete from _con_day;%' then
      v_def := replace(v_def, 'delete from _pay_seg;', 'delete from _pay_seg where true;');
      v_def := replace(v_def, 'delete from _con_day;', 'delete from _con_day where true;');
      execute v_def;
    end if;
  end loop;
end $$;

revoke execute on function public._payroll_employee(uuid, uuid, uuid)              from public, anon, authenticated;
revoke execute on function public._payroll_employee_statutory(uuid, uuid, uuid)    from public, anon, authenticated;
revoke execute on function public._payroll_employee_construction(uuid, uuid, uuid) from public, anon, authenticated;
