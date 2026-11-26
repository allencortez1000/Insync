-- =============================================================================
-- Migration 16: stricter face matching
--
-- A different person could pass the face check: the limit (0.55) was too loose for this face
-- engine. Measured on sample photos of different people, their distances start around 0.50,
-- and people who look alike can score closer than that.
--   * Limit is now 0.45 (Policies > "Face match limit"; smaller = stricter).
--   * The site device must send TWO camera frames; both must match, and both must be the same face.
--   * Every face check, passed or failed, is logged with its score so the limit can be tuned.
--   * Employees can test the score of their own face in their employee account.
-- This lowers the chance of a wrong match; it cannot bring it to zero, and a photo of the right
-- person can still pass. Run after 20261126000200_face_recognition.sql.
-- =============================================================================

alter table public.payroll_settings alter column face_match_threshold set default 0.45;
update public.payroll_settings set face_match_threshold = 0.45 where id = 1 and face_match_threshold > 0.45;

-- The probes sent by the device: one face template, or an array of 2-3 templates (camera frames).
-- Returns null when anything is malformed.
create or replace function public._face_probes(p jsonb) returns jsonb
language plpgsql immutable as $$
declare
  v_out jsonb := '[]'::jsonb;
  i     integer;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 then
    return null;
  end if;
  if jsonb_typeof(p -> 0) <> 'array' then
    return case when public._face_from_json(p) is null then null else jsonb_build_array(p) end;
  end if;
  if jsonb_array_length(p) > 3 then
    return null;
  end if;
  for i in 0..jsonb_array_length(p) - 1 loop
    if public._face_from_json(p -> i) is null then
      return null;
    end if;
    v_out := v_out || jsonb_build_array(p -> i);
  end loop;
  return v_out;
end $$;

-- How close the employee's own face is to what they recorded (shown in the employee account).
create or replace function public.emp_face_check(p_token text, p_descriptor jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := public._emp_session(p_token);
  v_desc  double precision[];
  v_best  double precision;
  v_limit numeric;
begin
  if v_emp is null then
    return public._fail('SESSION_INVALID', 'Please sign in again.');
  end if;
  v_desc := public._face_from_json(p_descriptor);
  if v_desc is null then
    return public._fail('BAD_REQUEST', 'The face could not be read. Please try again.');
  end if;
  select face_match_threshold into v_limit from public.payroll_settings where id = 1;
  select min(public._face_distance(f.descriptor, v_desc)) into v_best
  from public.employee_faces f where f.employee_id = v_emp;
  if v_best is null then
    return public._fail('FACE_NOT_ENROLLED', 'Record your face first.');
  end if;
  return jsonb_build_object('ok', true, 'distance', round(v_best::numeric, 3), 'limit', v_limit, 'match', v_best <= v_limit);
end $$;

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
  v_probes    jsonb;
  v_n         integer;
  v_worst     double precision;   -- the least similar of the frames: every frame must match
  v_spread    double precision;   -- how different the frames are from each other
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

  v_probes := public._face_probes(p_descriptor);
  v_n := jsonb_array_length(v_probes);
  if v_probes is null or v_n < 2 then
    return public._fail('BAD_REQUEST', 'The face could not be read. Please try again.');
  end if;
  if not exists (select 1 from public.employee_faces where employee_id = p_employee_id) then
    return public._fail('FACE_NOT_ENROLLED', 'No face is recorded for this employee yet. Use your PIN, and record your face in your employee account.');
  end if;

  select max(b.best) into v_worst
  from jsonb_array_elements(v_probes) pr(d)
  cross join lateral (select min(public._face_distance(f.descriptor, public._face_from_json(pr.d))) as best
                      from public.employee_faces f where f.employee_id = p_employee_id) b;
  select coalesce(max(public._face_distance(public._face_from_json(a.d), public._face_from_json(b.d))), 0) into v_spread
  from jsonb_array_elements(v_probes) with ordinality a(d, i)
  join jsonb_array_elements(v_probes) with ordinality b(d, i) on a.i < b.i;

  if v_worst > v_set.face_match_threshold or v_spread > 0.5 then
    insert into public.security_events (kind, site_id, employee_id, device_session_id, details)
    values ('face_failed', v_sess.site_id, p_employee_id, v_sess.id,
            jsonb_build_object('distance', round(v_worst::numeric, 3), 'limit', v_set.face_match_threshold, 'frames', v_n));
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

  insert into public.security_events (kind, site_id, employee_id, device_session_id, details)
  values ('face_verified', v_sess.site_id, p_employee_id, v_sess.id,
          jsonb_build_object('distance', round(v_worst::numeric, 3), 'limit', v_set.face_match_threshold, 'frames', v_n));

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

revoke execute on function public._face_probes(jsonb) from public, anon, authenticated;
revoke execute on function public.emp_face_check(text, jsonb) from public;
grant execute on function public.emp_face_check(text, jsonb) to anon, authenticated;
