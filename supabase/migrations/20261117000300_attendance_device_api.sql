-- =============================================================================
-- Migration 3: attendance device API (called by the Expo app with the anon key)
--
-- Every function validates the opaque device-session token issued by site_login.
-- They return JSON objects: { ok: true, ... } or { ok: false, code, message, ... }.
-- Failures are returned (not raised) so that lockout counters are committed.
--
-- Error codes the app must handle:
--   INVALID_LOGIN, ACCOUNT_LOCKED, ACCOUNT_DISABLED, SESSION_INVALID, NOT_ON_ROSTER,
--   PIN_FORMAT, PIN_NOT_SET, PIN_INVALID, PIN_LOCKED, DEVICE_LOCKED, PIN_EXPIRED,
--   OPEN_AT_OTHER_SITE, ALREADY_CLOCKED_IN, NOT_CLOCKED_IN, LOCATION_REQUIRED,
--   REQUEST_CONFLICT, BAD_REQUEST, RETRY, NOT_FOUND
-- =============================================================================

create or replace function public._fail(p_code text, p_message text, p_extra jsonb default '{}'::jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'message', p_message) || coalesce(p_extra, '{}'::jsonb)
$$;

-- Resolve a valid device session from its token (null id when invalid).
create or replace function public._device_session(p_token text) returns public.device_sessions
language plpgsql security definer set search_path = public, extensions as $$
declare v public.device_sessions;
begin
  if p_token is null or length(p_token) < 32 then
    return v;
  end if;
  select ds.* into v
  from public.device_sessions ds
  join public.site_accounts sa on sa.id = ds.site_account_id
  join public.sites s on s.id = ds.site_id
  where ds.token_hash = extensions.digest(p_token, 'sha256')
    and ds.revoked_at is null
    and ds.expires_at > now()
    and sa.is_active and s.is_active;
  if found and v.last_seen_at < now() - interval '1 minute' then
    update public.device_sessions set last_seen_at = now() where id = v.id;
  end if;
  return v;
end $$;

-- 'assigned' when currently assigned to the site; 'origin_close' when the employee
-- was transferred away but may still close an open session here; otherwise null.
create or replace function public._site_eligibility(p_employee_id uuid, p_site_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.employee_site_assignments a
                 where a.employee_id = p_employee_id and a.site_id = p_site_id
                   and a.effective_from <= now() and (a.effective_to is null or a.effective_to > now()))
      then 'assigned'
    when exists (select 1 from public.work_sessions w
                 where w.employee_id = p_employee_id and w.site_id = p_site_id
                   and w.status = 'open' and w.allow_origin_close)
      then 'origin_close'
  end
$$;

create or replace function public._site_policy() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'location_failure_policy', location_failure_policy,
    'pin_length', 6,
    'pin_auth_ttl_seconds', pin_auth_ttl_seconds,
    'location_stale_ms', location_stale_ms)
  from public.payroll_settings where id = 1
$$;

-- ---------------------------------------------------------------------------
-- site_login: shared site credentials -> device session token
-- ---------------------------------------------------------------------------
create or replace function public.site_login(
  p_username text, p_password text,
  p_device_label text default null, p_platform text default null, p_app_version text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_set      public.payroll_settings;
  v_acct     public.site_accounts;
  v_site     public.sites;
  v_attempts integer;
  v_token    text;
  v_sess_id  uuid;
  v_expires  timestamptz;
begin
  select * into v_set from public.payroll_settings where id = 1;

  select * into v_acct from public.site_accounts where username = lower(trim(coalesce(p_username, ''))) for update;
  if not found then
    perform pg_sleep(0.25);
    return public._fail('INVALID_LOGIN', 'Invalid username or password.');
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
      values ('site_login_locked', v_acct.site_id, jsonb_build_object('username', v_acct.username));
    else
      update public.site_accounts set failed_attempts = v_attempts where id = v_acct.id;
    end if;
    insert into public.security_events (kind, site_id, details)
    values ('site_login_failed', v_acct.site_id, jsonb_build_object('username', v_acct.username, 'device', p_device_label));
    return public._fail('INVALID_LOGIN', 'Invalid username or password.');
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

-- ---------------------------------------------------------------------------
-- site_session_info: validate a stored token on app start
-- ---------------------------------------------------------------------------
create or replace function public.site_session_info(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sess public.device_sessions;
  v_site public.sites;
begin
  v_sess := public._device_session(p_token);
  if v_sess.id is null then
    return public._fail('SESSION_INVALID', 'Site session expired or was revoked. Please sign in again.');
  end if;
  select * into v_site from public.sites where id = v_sess.site_id;
  return jsonb_build_object(
    'ok', true,
    'session_id', v_sess.id,
    'expires_at', v_sess.expires_at,
    'site', jsonb_build_object('id', v_site.id, 'code', v_site.code, 'name', v_site.name),
    'policy', public._site_policy(),
    'server_time', now());
end $$;

-- ---------------------------------------------------------------------------
-- site_logout: revoke this device session
-- ---------------------------------------------------------------------------
create or replace function public.site_logout(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_sess public.device_sessions;
begin
  v_sess := public._device_session(p_token);
  if v_sess.id is null then
    return jsonb_build_object('ok', true);
  end if;
  update public.device_sessions
     set revoked_at = now(), revoke_reason = 'Signed out on device'
   where id = v_sess.id;
  delete from public.pin_authorizations where device_session_id = v_sess.id and used_at is null;
  insert into public.security_events (kind, site_id, device_session_id) values ('site_logout', v_sess.site_id, v_sess.id);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- site_roster: active employees assigned to this site (no salary / IDs / PINs)
-- ---------------------------------------------------------------------------
create or replace function public.site_roster(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sess  public.device_sessions;
  v_list  jsonb;
begin
  v_sess := public._device_session(p_token);
  if v_sess.id is null then
    return public._fail('SESSION_INVALID', 'Site session expired or was revoked. Please sign in again.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id,
           'code', e.employee_code,
           'name', e.display_name,
           'first_name', e.first_name,
           'last_name', e.last_name)
         order by e.last_name, e.first_name, e.employee_code), '[]'::jsonb)
    into v_list
  from public.employees e
  where e.is_active
    and public._site_eligibility(e.id, v_sess.site_id) is not null;

  return jsonb_build_object('ok', true, 'employees', v_list, 'server_time', now());
end $$;

-- ---------------------------------------------------------------------------
-- site_verify_pin: employee selected their name and entered a PIN
-- ---------------------------------------------------------------------------
create or replace function public.site_verify_pin(p_token text, p_employee_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sess      public.device_sessions;
  v_set       public.payroll_settings;
  v_emp       public.employees;
  v_cred      public.pin_credentials;
  v_open      public.work_sessions;
  v_open_site public.sites;
  v_elig      text;
  v_failures  integer;
  v_attempts  integer;
  v_until     timestamptz;
  v_auth      text;
  v_expires   timestamptz;
begin
  v_sess := public._device_session(p_token);
  if v_sess.id is null then
    return public._fail('SESSION_INVALID', 'Site session expired or was revoked. Please sign in again.');
  end if;
  select * into v_set from public.payroll_settings where id = 1;

  -- Device-level throttling.
  select count(*) into v_failures
  from public.security_events
  where device_session_id = v_sess.id and kind = 'pin_failed' and created_at > now() - interval '15 minutes';
  if v_failures >= v_set.device_max_failed_pins then
    return public._fail('DEVICE_LOCKED', 'Too many wrong PINs on this device. Wait 15 minutes or contact staff.');
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  v_elig := public._site_eligibility(p_employee_id, v_sess.site_id);
  if v_emp.id is null or not v_emp.is_active or v_elig is null then
    return public._fail('NOT_ON_ROSTER', 'This employee is not on this site''s roster.');
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    return public._fail('PIN_FORMAT', 'PIN must be 6 digits.');
  end if;

  select * into v_cred from public.pin_credentials where employee_id = p_employee_id for update;
  if not found then
    return public._fail('PIN_NOT_SET', 'No PIN is set for this employee. Ask staff to set your PIN.');
  end if;
  if v_cred.locked_until is not null and v_cred.locked_until > now() then
    return public._fail('PIN_LOCKED', 'PIN is temporarily locked. Try again later or ask staff.',
                        jsonb_build_object('locked_until', v_cred.locked_until));
  end if;

  if v_cred.pin_hash <> extensions.crypt(p_pin, v_cred.pin_hash) then
    v_attempts := v_cred.failed_attempts + 1;
    insert into public.security_events (kind, site_id, employee_id, device_session_id, details)
    values ('pin_failed', v_sess.site_id, p_employee_id, v_sess.id, jsonb_build_object('attempt', v_attempts));
    if v_attempts >= v_set.pin_max_attempts then
      v_until := now() + make_interval(mins => v_set.pin_lockout_minutes);
      update public.pin_credentials set failed_attempts = 0, locked_until = v_until where employee_id = p_employee_id;
      insert into public.security_events (kind, site_id, employee_id, device_session_id, details)
      values ('pin_lockout', v_sess.site_id, p_employee_id, v_sess.id, jsonb_build_object('locked_until', v_until));
      return public._fail('PIN_LOCKED', 'Too many wrong PINs. Your PIN is locked for a while. Ask staff if you forgot it.',
                          jsonb_build_object('locked_until', v_until));
    end if;
    update public.pin_credentials set failed_attempts = v_attempts where employee_id = p_employee_id;
    return public._fail('PIN_INVALID', 'Wrong PIN.',
                        jsonb_build_object('attempts_remaining', v_set.pin_max_attempts - v_attempts));
  end if;

  update public.pin_credentials set failed_attempts = 0, locked_until = null where employee_id = p_employee_id;

  select * into v_open from public.work_sessions where employee_id = p_employee_id and status = 'open';
  if found and v_open.site_id <> v_sess.site_id then
    select * into v_open_site from public.sites where id = v_open.site_id;
    return public._fail('OPEN_AT_OTHER_SITE',
      format('You are still clocked in at %s. Clock out there or ask staff.', v_open_site.name),
      jsonb_build_object('open_session', jsonb_build_object(
        'clock_in_at', v_open.clock_in_at, 'site_name', v_open_site.name)));
  end if;

  -- Single-use, short-lived authorization for exactly one action.
  delete from public.pin_authorizations where employee_id = p_employee_id and used_at is null;
  v_auth    := encode(extensions.gen_random_bytes(24), 'hex');
  v_expires := now() + make_interval(secs => v_set.pin_auth_ttl_seconds);
  insert into public.pin_authorizations (token_hash, employee_id, device_session_id, pin_version, expires_at)
  values (extensions.digest(v_auth, 'sha256'), p_employee_id, v_sess.id, v_cred.pin_version, v_expires);

  return jsonb_build_object(
    'ok', true,
    'auth_token', v_auth,
    'expires_at', v_expires,
    'employee', jsonb_build_object('id', v_emp.id, 'code', v_emp.employee_code, 'name', v_emp.display_name),
    'next_action', case when v_open.id is not null then 'clock_out' else 'clock_in' end,
    'open_session', case when v_open.id is not null
                         then jsonb_build_object('id', v_open.id, 'clock_in_at', v_open.clock_in_at) end,
    'policy', public._site_policy(),
    'server_time', now());
end $$;

-- ---------------------------------------------------------------------------
-- Result of a saved punch (used for idempotent replays)
-- ---------------------------------------------------------------------------
create or replace function public._punch_result(p_request_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ok', true,
    'event_id', ev.id,
    'request_id', ev.request_id,
    'device_session_id', ev.device_session_id,
    'action', ev.action,
    'server_time', ev.server_time,
    'location_status', ev.location_status,
    'work_session_id', ev.work_session_id,
    'employee', jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.display_name),
    'site', jsonb_build_object('id', s.id, 'name', s.name))
  from public.attendance_events ev
  join public.employees e on e.id = ev.employee_id
  join public.sites s on s.id = ev.site_id
  where ev.request_id = p_request_id
$$;

-- ---------------------------------------------------------------------------
-- site_punch: record Clock In / Clock Out after a successful PIN check
--   p_location: { status, latitude, longitude, accuracy_m, captured_at, age_ms }
-- ---------------------------------------------------------------------------
create or replace function public.site_punch(
  p_token text, p_auth_token text, p_action public.punch_action, p_request_id uuid,
  p_location jsonb default '{}'::jsonb, p_client_time timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sess       public.device_sessions;
  v_set        public.payroll_settings;
  v_auth       public.pin_authorizations;
  v_emp        public.employees;
  v_open       public.work_sessions;
  v_open_site  public.sites;
  v_prior      jsonb;
  v_elig       text;
  v_pin_ver    integer;
  v_loc_status text;
  v_lat        numeric;
  v_lng        numeric;
  v_acc        numeric;
  v_cap_at     timestamptz;
  v_age        integer;
  v_flags      text[] := '{}';
  v_session_id uuid;
  v_event_id   uuid;
  v_now        timestamptz := now();
begin
  v_sess := public._device_session(p_token);
  if v_sess.id is null then
    return public._fail('SESSION_INVALID', 'Site session expired or was revoked. Please sign in again.');
  end if;
  if p_request_id is null or p_action is null then
    return public._fail('BAD_REQUEST', 'Missing request id or action.');
  end if;

  -- 1. Idempotent replay: the same request returns the original result.
  v_prior := public._punch_result(p_request_id);
  if v_prior is not null then
    if (v_prior ->> 'device_session_id')::uuid <> v_sess.id then
      return public._fail('REQUEST_CONFLICT', 'Request id already used by another device.');
    end if;
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  select * into v_set from public.payroll_settings where id = 1;

  -- 2. Single-use PIN authorization bound to this device session.
  select * into v_auth from public.pin_authorizations
   where token_hash = extensions.digest(coalesce(p_auth_token, ''), 'sha256')
     and device_session_id = v_sess.id
   for update;
  if v_auth.id is null or v_auth.used_at is not null or v_auth.expires_at <= v_now then
    return public._fail('PIN_EXPIRED', 'Please enter your PIN again.');
  end if;

  -- 3. Serialize all punches for this employee (across devices and sites).
  select * into v_emp from public.employees where id = v_auth.employee_id for update;

  -- Re-check replay after acquiring the lock (concurrent duplicate submission).
  v_prior := public._punch_result(p_request_id);
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  select pin_version into v_pin_ver from public.pin_credentials where employee_id = v_emp.id;
  if v_pin_ver is distinct from v_auth.pin_version then
    delete from public.pin_authorizations where id = v_auth.id;
    return public._fail('PIN_EXPIRED', 'PIN was reset. Please enter your new PIN.');
  end if;

  v_elig := public._site_eligibility(v_emp.id, v_sess.site_id);
  if not v_emp.is_active or v_elig is null then
    return public._fail('NOT_ON_ROSTER', 'This employee is not on this site''s roster.');
  end if;

  -- 4. Location status (never fabricate coordinates; never reuse a stale fix as current).
  v_loc_status := coalesce(p_location ->> 'status', 'unavailable');
  if v_loc_status not in ('captured', 'permission_denied', 'unavailable', 'timeout', 'stale') then
    v_loc_status := 'unavailable';
  end if;
  begin
    v_lat    := nullif(p_location ->> 'latitude', '')::numeric;
    v_lng    := nullif(p_location ->> 'longitude', '')::numeric;
    v_acc    := nullif(p_location ->> 'accuracy_m', '')::numeric;
    v_cap_at := nullif(p_location ->> 'captured_at', '')::timestamptz;
    v_age    := nullif(p_location ->> 'age_ms', '')::numeric::integer;
  exception when others then
    v_lat := null; v_lng := null; v_loc_status := 'unavailable';
  end;
  if v_lat is not null and (v_lat not between -90 and 90 or v_lng is null or v_lng not between -180 and 180) then
    v_lat := null; v_lng := null; v_loc_status := 'unavailable';
  end if;
  if v_loc_status = 'captured' and (v_lat is null or v_lng is null) then
    v_loc_status := 'unavailable';
  end if;
  if v_loc_status = 'captured' and v_age is not null and v_age > v_set.location_stale_ms then
    v_loc_status := 'stale';
  end if;
  if v_loc_status <> 'captured' then
    if v_set.location_failure_policy = 'block' then
      return public._fail('LOCATION_REQUIRED', 'Location is required to record attendance. Turn on location and try again.');
    end if;
    v_flags := array['location_exception'];
  end if;
  v_lat := round(v_lat, 6);
  v_lng := round(v_lng, 6);

  -- 5. Attendance state machine. Never toggles automatically.
  select * into v_open from public.work_sessions where employee_id = v_emp.id and status = 'open' for update;

  if p_action = 'clock_in' then
    if v_open.id is not null then
      update public.pin_authorizations set used_at = v_now where id = v_auth.id;
      select * into v_open_site from public.sites where id = v_open.site_id;
      return public._fail('ALREADY_CLOCKED_IN',
        format('Already clocked in at %s.', v_open_site.name),
        jsonb_build_object('open_session', jsonb_build_object('clock_in_at', v_open.clock_in_at, 'site_name', v_open_site.name)));
    end if;
    if v_elig <> 'assigned' then
      return public._fail('NOT_ON_ROSTER', 'This employee is no longer assigned to this site.');
    end if;

    insert into public.work_sessions (employee_id, site_id, status, clock_in_at, source, review_flags)
    values (v_emp.id, v_sess.site_id, 'open', v_now, 'device', v_flags)
    returning id into v_session_id;
  else
    if v_open.id is null then
      update public.pin_authorizations set used_at = v_now where id = v_auth.id;
      return public._fail('NOT_CLOCKED_IN', 'No open Clock In found. Clock In first or ask staff.');
    end if;
    if v_open.site_id <> v_sess.site_id then
      select * into v_open_site from public.sites where id = v_open.site_id;
      return public._fail('OPEN_AT_OTHER_SITE', format('You are clocked in at %s. Clock out there or ask staff.', v_open_site.name));
    end if;
    v_session_id := v_open.id;
  end if;

  insert into public.attendance_events (
    request_id, employee_id, site_id, device_session_id, work_session_id, action, server_time, client_time,
    location_status, latitude, longitude, accuracy_m, location_captured_at, location_age_ms)
  values (
    p_request_id, v_emp.id, v_sess.site_id, v_sess.id, v_session_id, p_action, v_now, p_client_time,
    v_loc_status::public.location_status,
    case when v_loc_status in ('captured', 'stale') then v_lat end,
    case when v_loc_status in ('captured', 'stale') then v_lng end,
    case when v_loc_status in ('captured', 'stale') then v_acc end,
    v_cap_at, v_age)
  returning id into v_event_id;

  if p_action = 'clock_in' then
    update public.work_sessions set clock_in_event_id = v_event_id where id = v_session_id;
  else
    update public.work_sessions
       set status = 'closed',
           clock_out_at = v_now,
           clock_out_event_id = v_event_id,
           review_flags = (select coalesce(array_agg(distinct f), '{}') from unnest(
                             review_flags || v_flags ||
                             case when extract(epoch from (v_now - clock_in_at)) / 60 > v_set.max_session_minutes
                                  then array['long_session'] else '{}'::text[] end) f),
           allow_origin_close = false
     where id = v_session_id;
  end if;

  update public.pin_authorizations set used_at = v_now where id = v_auth.id;

  return public._punch_result(p_request_id) || jsonb_build_object('replayed', false);
exception
  when unique_violation or exclusion_violation then
    return public._fail('RETRY', 'Attendance changed at the same moment. Please try again.');
end $$;

-- ---------------------------------------------------------------------------
-- site_check_request: after a network failure, ask whether a request was saved
-- ---------------------------------------------------------------------------
create or replace function public.site_check_request(p_token text, p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sess  public.device_sessions;
  v_prior jsonb;
begin
  v_sess := public._device_session(p_token);
  if v_sess.id is null then
    return public._fail('SESSION_INVALID', 'Site session expired or was revoked. Please sign in again.');
  end if;
  v_prior := public._punch_result(p_request_id);
  if v_prior is null or (v_prior ->> 'device_session_id')::uuid <> v_sess.id then
    return public._fail('NOT_FOUND', 'No saved attendance for this request.');
  end if;
  return v_prior || jsonb_build_object('replayed', true);
end $$;

-- ---------------------------------------------------------------------------
-- Grants: only these entry points are callable by the attendance app (anon).
-- ---------------------------------------------------------------------------
revoke execute on function public._fail(text, text, jsonb)          from public, anon, authenticated;
revoke execute on function public._device_session(text)             from public, anon, authenticated;
revoke execute on function public._site_eligibility(uuid, uuid)     from public, anon, authenticated;
revoke execute on function public._site_policy()                    from public, anon, authenticated;
revoke execute on function public._punch_result(uuid)               from public, anon, authenticated;

grant execute on function public.site_login(text, text, text, text, text)                              to anon, authenticated;
grant execute on function public.site_session_info(text)                                               to anon, authenticated;
grant execute on function public.site_logout(text)                                                     to anon, authenticated;
grant execute on function public.site_roster(text)                                                     to anon, authenticated;
grant execute on function public.site_verify_pin(text, uuid, text)                                     to anon, authenticated;
grant execute on function public.site_punch(text, text, public.punch_action, uuid, jsonb, timestamptz) to anon, authenticated;
grant execute on function public.site_check_request(text, uuid)                                        to anon, authenticated;
