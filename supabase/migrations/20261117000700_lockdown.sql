-- =============================================================================
-- Migration 7: final function-privilege lockdown
-- The attendance app (anon) may call ONLY the site_* entry points. Everything else
-- requires an authenticated website user (and its own role checks).
-- =============================================================================
revoke execute on all functions in schema public from public, anon;

grant execute on function
  public.site_login(text, text, text, text, text),
  public.site_session_info(text),
  public.site_logout(text),
  public.site_roster(text),
  public.site_verify_pin(text, uuid, text),
  public.site_punch(text, text, public.punch_action, uuid, jsonb, timestamptz),
  public.site_check_request(text, uuid)
to anon;

-- Internal helpers (leading underscore) are never callable through the API.
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like '\_%' escape '\' loop
    execute format('revoke execute on function %s from authenticated', f);
  end loop;
end $$;
revoke execute on function public.bootstrap_admin(text) from authenticated;
