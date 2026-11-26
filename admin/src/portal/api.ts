// Employee portal API: every call goes through a security-definer emp_* database function
// that checks the portal session token. The portal never reads tables directly.
import { rpc } from '../lib/supabase';
import type { PaymentRecord, Payslip } from '../lib/types';

const KEY = 'insync.employee.session';
export const SIGNED_OUT_EVENT = 'insync-portal-signed-out';

export interface PortalSession { token: string; employee: { id: string; employee_code: string; name: string } }

export function loadSession(): PortalSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as PortalSession) : null;
    return s?.token ? s : null;
  } catch {
    return null;
  }
}
export function saveSession(s: PortalSession) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: stays signed in until the tab closes */ }
  memory = s;
}
export function clearSession() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  memory = null;
}
let memory: PortalSession | null = null;
export const currentSession = () => memory ?? (memory = loadSession());

interface Fail { ok: false; code: string; message: string; locked_until?: string }

/** Calls an emp_* function with the session token; throws a readable Error when it is refused. */
export async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const s = currentSession();
  if (!s) {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    throw new Error('Please sign in again.');
  }
  const res = await rpc<({ ok: true } & T) | Fail>(fn, { p_token: s.token, ...args });
  if (!res.ok) {
    if (res.code === 'SESSION_INVALID') {
      clearSession();
      window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    }
    throw new Error(res.message || 'Request failed');
  }
  return res;
}

/** Sign in with the employee's name (or employee code) and the 6-digit attendance PIN. */
export async function signIn(name: string, pin: string): Promise<void> {
  const res = await rpc<{ ok: true; token: string; employee: PortalSession['employee'] } | Fail>(
    'emp_login', { p_name: name, p_pin: pin, p_device_label: navigator.userAgent.slice(0, 120) });
  if (!res.ok) throw new Error(res.message || 'Sign-in failed');
  saveSession({ token: res.token, employee: res.employee });
}

export async function signOut() {
  const s = currentSession();
  clearSession();
  if (s) await rpc('emp_logout', { p_token: s.token }).catch(() => undefined);
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

// ---- Shapes returned by the emp_* functions ----
export interface LeaveTypeBalance {
  id: string; code: string; name: string; is_paid: boolean; requires_balance: boolean; balance_days: number; pending_days: number;
}
export interface Me {
  today: string;
  employee: {
    id: string; employee_code: string; name: string; first_name: string; classification: string; hire_date: string | null;
    site_name: string | null; daily_rate: number | null; schedule_name: string | null;
  };
  open_session: { clock_in_at: string; site_name: string } | null;
  leave_types: LeaveTypeBalance[];
}
export type DayStatus = 'present' | 'clocked_in' | 'on_leave' | 'holiday' | 'rest_day' | 'no_record_yet' | 'leave_pending' | 'absent';
export interface AttendanceDay {
  date: string;
  status: DayStatus;
  sessions: { clock_in_at: string; clock_out_at: string | null; status: string; site_name: string; entered_by_staff: boolean }[];
  is_working_day: boolean;
  holiday: string | null;
  leave: { status: string; type: string; is_paid: boolean; hours: number } | null;
  elapsed_minutes: number;
  worked_minutes: number;
  late_minutes: number;
  undertime: boolean;
  ot: { recorded_minutes: number; accepted_minutes: number; status: 'counted' | 'pending' | 'accepted' | 'rejected' | 'disputed'; reason: string | null } | null;
}
export interface Attendance {
  from: string; to: string; days: AttendanceDay[];
  summary: { present: number; late: number; absent: number; on_leave: number; ot_recorded_minutes: number; ot_accepted_minutes: number };
}
export interface LeaveRow {
  id: string; leave_date: string; hours: number; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; reason: string | null;
  decision_note: string | null; decided_at: string | null; created_at: string; source: 'staff' | 'employee'; type_name: string; is_paid: boolean;
}
export interface PayslipRow {
  id: string; payslip_no: string; status: 'issued' | 'void'; issued_at: string; start_date: string; end_date: string; payday: string;
  gross_pay: number; total_deductions: number; net_pay: number; paid_at: string | null;
}
export interface PayslipDetail { slip: Payslip; payment: PaymentRecord | null }
export interface ThirteenthMonth {
  year: number; basic_earned: number; thirteenth_month: number; payroll_runs: number;
  first_period_start: string | null; last_period_end: string | null; months: { month: string; basic: number }[];
}
