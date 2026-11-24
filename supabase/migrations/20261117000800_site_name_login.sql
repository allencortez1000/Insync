-- =============================================================================
-- Migration 8: sign in to the attendance app with the SITE NAME + password
--
-- * The site account no longer needs a separate username. Devices sign in with the
--   site's name (case-insensitive; the site code also works).
-- * Admins set the password directly in the website's site form.
-- * Site names must be unique (case-insensitive) because they are the sign-in name.
-- =============================================================================

create unique index if not exists sites_name_unique_idx on public.sites (lower(btrim(name)));

-- Site code is generated automatically from the name when not supplied
-- (e.g. "Makati Warehouse" -> MAKATI-WAREHOUSE, duplicates get -2, -3, ...).
create or replace function public.site_code_default() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_base text;
  v_code text;
  n      integer := 1;
begin
  if new.code is not null and btrim(new.code) <> '' then
    new.code := upper(btrim(new.code));
    return new;
  end if;
  v_base := regexp_replace(translate(upper(coalesce(new.name, '')), 'ÑÁÉÍÓÚÜ', 'NAEIOUU'), '[^A-Z0-9]+', '-', 'g');
  v_base := btrim(left(btrim(v_base, '-'), 16), '-');
  if length(v_base) < 2 then
    v_base := 'SITE';
  end if;
  v_code := v_base;
  while exists (select 1 from public.sites where code = v_code and id <> new.id) loop
    n := n + 1;
    v_code := v_base || '-' || n;
  end loop;
  new.code := v_code;
  return new;
end $$;
drop trigger if exists trg_sites_code_default on public.sites;
create trigger trg_sites_code_default before insert on public.sites
  for each row execute function public.site_code_default();

-- The generated code cannot be edited afterwards.
create or replace function public.site_code_locked() returns trigger
language plpgsql as $$
begin
  new.code := old.code;
  return new;
end $$;
drop trigger if exists trg_sites_code_locked on public.sites;
create trigger trg_sites_code_locked before update of code on public.sites
  for each row execute function public.site_code_locked();

alter table public.site_accounts alter column username drop not null;

-- Create or change a site's attendance password (admin only). Existing devices are signed out
-- when the password changes.
create or replace function public.admin_set_site_password(p_site_id uuid, p_password text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := public.require_admin();
  v_id  uuid;
begin
  if not exists (select 1 from public.sites where id = p_site_id) then
    raise exception 'Site not found';
  end if;
  if p_password is null or length(p_password) < 10 then
    raise exception 'Site password must be at least 10 characters';
  end if;
  select id into v_id from public.site_accounts where site_id = p_site_id;
  if v_id is null then
    insert into public.site_accounts (site_id, username, password_hash, created_by)
    values (p_site_id, null, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), v_uid)
    returning id into v_id;
  else
    update public.site_accounts
       set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
           password_changed_at = now(), failed_attempts = 0, locked_until = null
     where id = v_id;
    update public.device_sessions set revoked_at = now(), revoked_by = v_uid, revoke_reason = 'Site password changed'
     where site_account_id = v_id and revoked_at is null;
  end if;
  insert into public.security_events (kind, site_id, actor_user_id) values ('site_credentials_set', p_site_id, v_uid);
  return v_id;
end $$;

-- site_login: p_username now means "site name" (or site code). Signature unchanged so
-- existing app builds keep working.
create or replace function public.site_login(
  p_username text, p_password text,
  p_device_label text default null, p_platform text default null, p_app_version text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_set      public.payroll_settings;
  v_acct     public.site_accounts;
  v_site     public.sites;
  v_name     text := lower(btrim(coalesce(p_username, '')));
  v_attempts integer;
  v_token    text;
  v_sess_id  uuid;
  v_expires  timestamptz;
begin
  select * into v_set from public.payroll_settings where id = 1;

  select sa.* into v_acct
  from public.site_accounts sa
  join public.sites s on s.id = sa.site_id
  where v_name <> '' and (lower(btrim(s.name)) = v_name or lower(s.code) = v_name)
  order by (lower(btrim(s.name)) = v_name) desc
  limit 1
  for update of sa;

  if v_acct.id is null then
    perform pg_sleep(0.25);
    return public._fail('INVALID_LOGIN', 'Wrong site name or password.');
  end if;

  if v_acct.locked_until is not null and v_acct.locked_until > now() then
    return public._fail('ACCOUNT_LOCKED', 'Too many failed sign-in attempts. Try again later.',
                        jsonb_build_object('locked_until', v_acct.locked_until));
  end if;

  if v_acct.password_hash <> extensions.crypt(coalesce(p_password, ''), v_acct.password_hash) then
    v_attempts := v_acct.failed_attempts + 1;
    if v_attempts >= v_set.site_login_max_attempts then
      update public.site_accounts
         set failed_attempts = 0,
             locked_until = now() + make_interval(mins => v_set.site_login_lockout_minutes)
       where id = v_acct.id;
      insert into public.security_events (kind, site_id, details)
      values ('site_login_locked', v_acct.site_id, '{}'::jsonb);
    else
      update public.site_accounts set failed_attempts = v_attempts where id = v_acct.id;
    end if;
    insert into public.security_events (kind, site_id, details)
    values ('site_login_failed', v_acct.site_id, jsonb_build_object('device', p_device_label));
    return public._fail('INVALID_LOGIN', 'Wrong site name or password.');
  end if;

  select * into v_site from public.sites where id = v_acct.site_id;
  if not v_acct.is_active or not v_site.is_active then
    return public._fail('ACCOUNT_DISABLED', 'This site account is disabled. Contact your administrator.');
  end if;

  update public.site_accounts set failed_attempts = 0, locked_until = null where id = v_acct.id;

  v_token   := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(days => v_set.device_session_days);
  insert into public.device_sessions (site_account_id, site_id, token_hash, device_label, platform, app_version, expires_at)
  values (v_acct.id, v_acct.site_id, extensions.digest(v_token, 'sha256'),
          left(p_device_label, 120), left(p_platform, 40), left(p_app_version, 40), v_expires)
  returning id into v_sess_id;

  insert into public.security_events (kind, site_id, device_session_id, details)
  values ('site_login', v_acct.site_id, v_sess_id, jsonb_build_object('device', p_device_label, 'platform', p_platform));

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'session_id', v_sess_id,
    'expires_at', v_expires,
    'site', jsonb_build_object('id', v_site.id, 'code', v_site.code, 'name', v_site.name),
    'policy', public._site_policy(),
    'server_time', now());
end $$;

-- Function privileges (same lockdown rules as migration 7).
revoke execute on function public.admin_set_site_password(uuid, text) from public, anon;
grant execute on function public.admin_set_site_password(uuid, text) to authenticated;
revoke execute on function public.site_login(text, text, text, text, text) from public;
grant execute on function public.site_login(text, text, text, text, text) to anon, authenticated;
