-- =============================================================================
-- Migration 15: face recognition for Clock In / Clock Out
--
-- * The employee records (enrolls) their face in their own employee account (/employee).
-- * On the site attendance device the employee taps their name and looks at the camera
--   instead of typing the PIN. Employees without an enrolled face keep using the PIN.
-- * No photo is stored. The browser turns the camera picture into a face template
--   (128 numbers); only templates are sent. The comparison is done HERE, on the server,
--   and the stored templates are never readable through the API.
-- * Each attendance punch records how the employee was verified (PIN or face).
-- * This is face MATCHING, not a certified biometric device: it has no reliable way to
--   tell a live person from a good photo. Staff can remove an enrolled face at any time.
-- =============================================================================

create table if not exists public.employee_faces (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.employees (id) on delete cascade,
  descriptor   double precision[] not null check (cardinality(descriptor) = 128),
  created_at   timestamptz not null default now()
);
create index if not exists employee_faces_employee_idx on public.employee_faces (employee_id);

alter table public.employee_faces enable row level security;
revoke all on public.employee_faces from anon, authenticated;
-- Staff may see THAT a face is enrolled and when, never the template itself.
grant select (id, employee_id, created_at) on public.employee_faces to authenticated;
drop policy if exists employee_faces_select on public.employee_faces;
create policy employee_faces_select on public.employee_faces for select to authenticated
  using (public.can_access_employee(employee_id));

-- Largest allowed distance between the camera face and the enrolled face (smaller = stricter).
alter table public.payroll_settings
  add column if not exists face_match_threshold numeric(4, 3) not null default 0.55
  check (face_match_threshold between 0.3 and 0.7);

alter table public.pin_authorizations
  add column if not exists method text not null default 'pin' check (method in ('pin', 'face'));
alter table public.attendance_events
  add column if not exists auth_method text not null default 'pin' check (auth_method in ('pin', 'face'));

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
-- A face template sent by the browser: a JSON array of exactly 128 small numbers. Null when invalid.
create or replace function public._face_from_json(p jsonb) returns double precision[]
language plpgsql immutable as $$
declare v double precision[];
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) <> 128 then
    return null;
  end if;
  select array_agg(x.v::double precision order by x.ord) into v
  from jsonb_array_elements(p) with ordinality x(v, ord)
  where jsonb_typeof(x.v) = 'number';
  if v is null or cardinality(v) <> 128 or exists (select 1 from unnest(v) u where u is null or abs(u) > 4) then
    return null;
  end if;
  return v;
exception when others then
  return null;
end $$;

create or replace function public._face_distance(a double precision[], b double precision[]) returns double precision
language sql immutable as $$
  select sqrt(sum((t.x - t.y) ^ 2)) from unnest(a, b) t(x, y)
$$;

-- ---------------------------------------------------------------------------
-- Employee account: record / remove own face
-- ---------------------------------------------------------------------------
create or replace function public.emp_face_status(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public._emp_session(p_token);
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  return (select jsonb_build_object('ok', true, 'enrolled', count(*) > 0, 'samples', count(*), 'enrolled_at', max(created_at))
          from public.employee_faces where employee_id = v_emp);
end $$;

-- p_descriptors: JSON array of 3 to 6 templates taken a moment apart. Replaces any earlier face.
create or replace function public.emp_face_enroll(p_token text, p_descriptors jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp uuid := public._emp_session(p_token);
  i     integer;
  j     integer;
  n     integer;
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  if p_descriptors is null or jsonb_typeof(p_descriptors) <> 'array'
     or jsonb_array_length(p_descriptors) < 3 or jsonb_array_length(p_descriptors) > 6 then
    return public._fail('BAD_REQUEST', 'The face could not be read. Please try again.');
  end if;
  n := jsonb_array_length(p_descriptors);
  for i in 0..n - 1 loop
    if public._face_from_json(p_descriptors -> i) is null then
      return public._fail('BAD_REQUEST', 'The face could not be read. Please try again.');
    end if;
  end loop;
  -- All pictures must be the same person (guards against someone else stepping into the frame).
  for i in 0..n - 2 loop
    for j in i + 1..n - 1 loop
      if public._face_distance(public._face_from_json(p_descriptors -> i), public._face_from_json(p_descriptors -> j)) > 0.5 then
        return public._fail('FACE_INCONSISTENT', 'The pictures do not look like the same person. Try again in good light, with only your face in view.');
      end if;
    end loop;
  end loop;

  delete from public.employee_faces where employee_id = v_emp;
  insert into public.employee_faces (employee_id, descriptor)
  select v_emp, public._face_from_json(x.d) from jsonb_array_elements(p_descriptors) x(d);
  delete from public.pin_authorizations where employee_id = v_emp and used_at is null;
  insert into public.security_events (kind, employee_id, details) values ('face_enrolled', v_emp, jsonb_build_object('samples', n));
  return jsonb_build_object('ok', true, 'enrolled', true, 'samples', n, 'enrolled_at', now());
end $$;

create or replace function public.emp_face_remove(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public._emp_session(p_token);
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  delete from public.employee_faces where employee_id = v_emp;
  delete from public.pin_authorizations where employee_id = v_emp and used_at is null and method = 'face';
  insert into public.security_events (kind, employee_id, details) values ('face_removed', v_emp, jsonb_build_object('by', 'employee'));
  return jsonb_build_object('ok', true, 'enrolled', false, 'samples', 0, 'enrolled_at', null);
end $$;

-- Staff: remove an employee's enrolled face (they go back to the PIN until they record it again).
create or replace function public.admin_clear_face(p_employee_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_staff();
begin
  if not public.can_access_employee(p_employee_id) then
    raise exception 'Employee not found';
  end if;
  delete from public.employee_faces where employee_id = p_employee_id;
  delete from public.pin_authorizations where employee_id = p_employee_id and used_at is null and method = 'face';
  insert into public.security_events (kind, employee_id, actor_user_id, details)
  values ('face_removed', p_employee_id, v_uid, jsonb_build_object('by', 'staff'));
end $$;

-- ---------------------------------------------------------------------------
-- Site device: the roster says who has a face; verify a face instead of a PIN
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
           'last_name', e.last_name,
           'has_face', exists (select 1 from public.employee_faces f where f.employee_id = e.id),
           'has_pin', exists (select 1 from public.pin_credentials c where c.employee_id = e.id))
         order by e.last_name, e.first_name, e.employee_code), '[]'::jsonb)
    into v_list
  from public.employees e
  where e.is_active
    and public._site_eligibility(e.id, v_sess.site_id) is not null;

  return jsonb_build_object('ok', true, 'employees', v_list, 'server_time', now());
end $$;

-- Same result as site_verify_pin (a single-use authorization for one punch), but the proof is the face.
create or replace function public.site_verify_face(p_token text, p_employee_id uuid, p_descriptor jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sess      public.device_sessions;
  v_set       public.payroll_settings;
  v_emp       public.employees;
  v_open      public.work_sessions;
  v_open_site public.sites;
  v_elig      text;
  v_failures  integer;
  v_desc      double precision[];
  v_best      double precision;
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
  where device_session_id = v_sess.id and kind = 'face_failed' and created_at > now() - interval '15 minutes';
  if v_failures >= 40 then
    return public._fail('DEVICE_LOCKED', 'Too many failed face checks on this device. Wait 15 minutes or contact staff.');
  end if;

  select * into v_emp from public.employees where id = p_employee_id;
  v_elig := public._site_eligibility(p_employee_id, v_sess.site_id);
  if v_emp.id is null or not v_emp.is_active or v_elig is null then
    return public._fail('NOT_ON_ROSTER', 'This employee is not on this site''s roster.');
  end if;

  v_desc := public._face_from_json(p_descriptor);
  if v_desc is null then
    return public._fail('BAD_REQUEST', 'The face could not be read. Please try again.');
  end if;

  select min(public._face_distance(f.descriptor, v_desc)) into v_best
  from public.employee_faces f where f.employee_id = p_employee_id;
  if v_best is null then
    return public._fail('FACE_NOT_ENROLLED', 'No face is recorded for this employee yet. Use your PIN, and record your face in your employee account.');
  end if;
  if v_best > v_set.face_match_threshold then
    insert into public.security_events (kind, site_id, employee_id, device_session_id, details)
    values ('face_failed', v_sess.site_id, p_employee_id, v_sess.id, jsonb_build_object('distance', round(v_best::numeric, 3)));
    return public._fail('FACE_MISMATCH', 'Face not recognized. Look straight at the camera in good light.');
  end if;

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
  insert into public.pin_authorizations (token_hash, employee_id, device_session_id, pin_version, expires_at, method)
  values (extensions.digest(v_auth, 'sha256'), p_employee_id, v_sess.id,
          coalesce((select pin_version from public.pin_credentials where employee_id = p_employee_id), 0), v_expires, 'face');

  return jsonb_build_object(
    'ok', true,
    'auth_token', v_auth,
    'expires_at', v_expires,
    'method', 'face',
    'employee', jsonb_build_object('id', v_emp.id, 'code', v_emp.employee_code, 'name', v_emp.display_name),
    'next_action', case when v_open.id is not null then 'clock_out' else 'clock_in' end,
    'open_session', case when v_open.id is not null
                         then jsonb_build_object('id', v_open.id, 'clock_in_at', v_open.clock_in_at) end,
    'policy', public._site_policy(),
    'server_time', now());
end $$;

-- site_punch: unchanged except that a face authorization is accepted and the method is recorded.
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
  -- A PIN authorization dies when the PIN is reset; a face authorization does not depend on the PIN.
  if v_auth.method = 'pin' and v_pin_ver is distinct from v_auth.pin_version then
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
    location_status, latitude, longitude, accuracy_m, location_captured_at, location_age_ms, auth_method)
  values (
    p_request_id, v_emp.id, v_sess.site_id, v_sess.id, v_session_id, p_action, v_now, p_client_time,
    v_loc_status::public.location_status,
    case when v_loc_status in ('captured', 'stale') then v_lat end,
    case when v_loc_status in ('captured', 'stale') then v_lng end,
    case when v_loc_status in ('captured', 'stale') then v_acc end,
    v_cap_at, v_age, v_auth.method)
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

-- Attendance review shows how each punch was verified.
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
       ds_in.device_label as in_device_label,
       ein.auth_method as in_auth_method, eout.auth_method as out_auth_method
from public.work_sessions w
join public.employees e on e.id = w.employee_id
join public.sites s on s.id = w.site_id
left join public.attendance_events ein on ein.id = w.clock_in_event_id
left join public.attendance_events eout on eout.id = w.clock_out_event_id
left join public.device_sessions ds_in on ds_in.id = ein.device_session_id;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('_face_from_json', '_face_distance', 'emp_face_status', 'emp_face_enroll', 'emp_face_remove',
                               'admin_clear_face', 'site_verify_face') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function public.admin_clear_face(uuid) to authenticated;
grant execute on function
  public.emp_face_status(text),
  public.emp_face_enroll(text, jsonb),
  public.emp_face_remove(text),
  public.site_verify_face(text, uuid, jsonb)
to anon, authenticated;
