import { supabase } from './supabase';
import type { LocationPayload } from './location';

// ---------------------------------------------------------------------------
// Server contract types (supabase/migrations/*_attendance_device_api.sql)
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'INVALID_LOGIN'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_DISABLED'
  | 'SESSION_INVALID'
  | 'NOT_ON_ROSTER'
  | 'PIN_FORMAT'
  | 'PIN_NOT_SET'
  | 'PIN_INVALID'
  | 'PIN_LOCKED'
  | 'DEVICE_LOCKED'
  | 'PIN_EXPIRED'
  | 'FACE_MISMATCH'
  | 'FACE_NOT_ENROLLED'
  | 'OPEN_AT_OTHER_SITE'
  | 'ALREADY_CLOCKED_IN'
  | 'NOT_CLOCKED_IN'
  | 'LOCATION_REQUIRED'
  | 'REQUEST_CONFLICT'
  | 'BAD_REQUEST'
  | 'RETRY'
  | 'NOT_FOUND';

export type PunchAction = 'clock_in' | 'clock_out';
export type LocationStatus = 'captured' | 'permission_denied' | 'unavailable' | 'timeout' | 'stale';

export interface Site {
  id: string;
  code: string;
  name: string;
}

export interface SitePolicy {
  location_failure_policy: 'save_and_flag' | 'block';
  pin_length: number;
  pin_auth_ttl_seconds: number;
  location_stale_ms: number;
}

export interface Failure {
  ok: false;
  code: ErrorCode;
  message: string;
  attempts_remaining?: number;
  locked_until?: string;
  open_session?: { clock_in_at: string; site_name: string };
}

export interface LoginOk {
  ok: true;
  token: string;
  session_id: string;
  expires_at: string;
  site: Site;
  policy: SitePolicy;
  server_time: string;
}

export interface SessionInfoOk {
  ok: true;
  session_id: string;
  expires_at: string;
  site: Site;
  policy: SitePolicy;
  server_time: string;
}

export interface RosterEmployee {
  id: string;
  code: string;
  name: string;
  first_name: string;
  last_name: string;
  /** The employee recorded their face in their employee account: verify by face instead of PIN. */
  has_face?: boolean;
  has_pin?: boolean;
}

export interface RosterOk {
  ok: true;
  employees: RosterEmployee[];
  server_time: string;
}

export interface VerifyPinOk {
  ok: true;
  auth_token: string;
  expires_at: string;
  employee: { id: string; code: string; name: string };
  next_action: PunchAction;
  open_session: { id: string; clock_in_at: string } | null;
  policy: SitePolicy;
  server_time: string;
}

export interface PunchOk {
  ok: true;
  event_id: string;
  request_id: string;
  action: PunchAction;
  server_time: string;
  location_status: LocationStatus;
  work_session_id: string;
  employee: { id: string; code: string; name: string };
  site: { id: string; name: string };
  replayed: boolean;
}

/**
 * - ok:      the server answered with { ok: true, ... }
 * - fail:    the server answered with { ok: false, code, message }
 * - error:   the server rejected the call with a database / API error (definitely not saved)
 * - network: no reliable answer (offline, timeout, gateway). The outcome is UNKNOWN.
 */
export type RpcResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'fail'; failure: Failure }
  | { kind: 'error'; message: string }
  | { kind: 'network'; message: string };

const TIMEOUT_MS = 15000;

async function call<T extends { ok: true }>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { data, error } = await supabase.rpc(fn, args).abortSignal(controller.signal);
    if (error) {
      // postgrest-js reports fetch/abort failures with an empty code. Treat as unknown outcome.
      if (!error.code) return { kind: 'network', message: error.message };
      return { kind: 'error', message: error.message };
    }
    const body = data as (T | Failure | null);
    if (!body || typeof body !== 'object') {
      return { kind: 'network', message: 'Empty response from server' };
    }
    if (body.ok === true) return { kind: 'ok', data: body as T };
    return { kind: 'fail', failure: body as Failure };
  } catch (e) {
    return { kind: 'network', message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function siteLogin(
  username: string,
  password: string,
  device: { label?: string; platform?: string; appVersion?: string },
) {
  return call<LoginOk>('site_login', {
    p_username: username,
    p_password: password,
    p_device_label: device.label ?? null,
    p_platform: device.platform ?? null,
    p_app_version: device.appVersion ?? null,
  });
}

export function siteSessionInfo(token: string) {
  return call<SessionInfoOk>('site_session_info', { p_token: token });
}

export function siteLogout(token: string) {
  return call<{ ok: true }>('site_logout', { p_token: token });
}

export function siteRoster(token: string) {
  return call<RosterOk>('site_roster', { p_token: token });
}

export function siteVerifyPin(token: string, employeeId: string, pin: string) {
  return call<VerifyPinOk>('site_verify_pin', { p_token: token, p_employee_id: employeeId, p_pin: pin });
}

/** Face instead of PIN: the server compares the template with the employee's recorded face. */
export function siteVerifyFace(token: string, employeeId: string, descriptor: number[]) {
  return call<VerifyPinOk>('site_verify_face', { p_token: token, p_employee_id: employeeId, p_descriptor: descriptor });
}

export function sitePunch(
  token: string,
  authToken: string,
  action: PunchAction,
  requestId: string,
  location: LocationPayload,
) {
  return call<PunchOk>('site_punch', {
    p_token: token,
    p_auth_token: authToken,
    p_action: action,
    p_request_id: requestId,
    p_location: location,
    p_client_time: new Date().toISOString(),
  });
}

export function siteCheckRequest(token: string, requestId: string) {
  return call<PunchOk>('site_check_request', { p_token: token, p_request_id: requestId });
}
