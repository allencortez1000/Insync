// Row shapes for the tables / views used by the website (see supabase/migrations).

export type AppRole = 'admin' | 'staff';
export type PayrollStatus = 'draft' | 'ready_for_review' | 'finalized' | 'paid' | 'void';
export type OtStatus = 'pending' | 'accepted' | 'rejected' | 'disputed';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type LocationStatus = 'captured' | 'permission_denied' | 'unavailable' | 'timeout' | 'stale';

export interface AppUser {
  id: string;
  email: string;
  full_name: string;
  role: AppRole | null;
  is_active: boolean;
  all_sites: boolean;
  created_at: string;
}

export interface Site {
  id: string;
  code: string;
  name: string;
  address: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
  created_at: string;
}

export interface SiteAccount {
  id: string;
  site_id: string;
  username: string;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
  password_changed_at: string;
}

export interface DeviceSession {
  id: string;
  site_id: string;
  device_label: string | null;
  platform: string | null;
  app_version: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface Employee {
  id: string;
  employee_code: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  display_name: string;
  is_active: boolean;
  hire_date: string | null;
  separation_date: string | null;
  classification: string;
  is_minimum_wage_earner: boolean;
  labor_standards_covered: boolean;
  statutory_covered: boolean;
  tin: string | null;
  sss_number: string | null;
  philhealth_number: string | null;
  pagibig_number: string | null;
  notes: string | null;
}

export interface EmployeeOverview extends Employee {
  current_site_id: string | null;
  current_site_name: string | null;
  current_site_code: string | null;
  assigned_since: string | null;
  current_daily_rate: number | null;
  rate_since: string | null;
  current_schedule_name: string | null;
  pin_set_at: string | null;
  pin_locked_until: string | null;
  has_pin: boolean;
  open_session_id: string | null;
  open_since: string | null;
}

export interface Schedule {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  working_days: number[];
  unpaid_break_minutes: number;
  break_applies_after_minutes: number;
  grace_minutes: number;
  is_active: boolean;
  notes: string | null;
}

export interface WorkSessionRow {
  id: string;
  employee_id: string;
  site_id: string;
  status: 'open' | 'closed' | 'voided';
  clock_in_at: string;
  clock_out_at: string | null;
  source: 'device' | 'correction';
  review_flags: string[];
  reviewed_at: string | null;
  review_note: string | null;
  allow_origin_close: boolean;
  work_date: string;
  employee_code: string;
  employee_name: string;
  site_code: string;
  site_name: string;
  elapsed_minutes: number | null;
  in_location_status: LocationStatus | null;
  in_latitude: number | null;
  in_longitude: number | null;
  in_accuracy_m: number | null;
  out_location_status: LocationStatus | null;
  out_latitude: number | null;
  out_longitude: number | null;
  out_accuracy_m: number | null;
  in_device_label: string | null;
}

export interface PayrollRunRow {
  id: string;
  run_no: number;
  period_id: string;
  site_ids: string[] | null;
  status: PayrollStatus;
  reissue_of_run_id: string | null;
  notes: string | null;
  totals: { employees?: number; gross?: number; deductions?: number; net?: number; employer?: number };
  blocking_count: number;
  warning_count: number;
  calculated_at: string | null;
  submitted_at: string | null;
  finalized_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  start_date: string;
  end_date: string;
  payday: string;
  site_names: string | null;
}

export interface PayrollResult {
  id: string;
  run_id: string;
  employee_id: string;
  primary_site_id: string | null;
  employee_snapshot: Record<string, unknown> & { name?: string; employee_code?: string; site_name?: string; daily_rate?: number };
  days_worked: number;
  regular_minutes: number;
  ot_minutes_recorded: number;
  ot_minutes_paid: number;
  undertime_minutes: number;
  late_minutes: number;
  night_minutes: number;
  leave_hours: number;
  gross_pay: number;
  total_deductions: number;
  net_pay: number;
  employer_contributions: number;
  blocking_count: number;
  warning_count: number;
  statutory: StatutoryEntry[];
}

export interface StatutoryEntry {
  agency: 'sss' | 'philhealth' | 'pagibig';
  month: string;
  basis: number;
  month_basis: number;
  projected_basis: number;
  final: boolean;
  ee: number;
  er: number;
  ec: number;
  obligation_ee: number;
  obligation_er: number;
  credit: number;
  prior_ee: number;
  paydays_in_month: number;
  payday_index: number;
  rule_version_id: string;
}

export interface PayrollLine {
  id: number;
  run_id: string;
  result_id: string;
  employee_id: string;
  category: 'earning' | 'deduction' | 'employer' | 'info';
  code: string;
  description: string;
  work_date: string | null;
  site_id: string | null;
  quantity: number | null;
  unit: string | null;
  rate: number | null;
  multiplier: number | null;
  amount: number;
  basic_amount: number;
  taxable: boolean;
  source: Record<string, unknown>;
  sort_order: number;
}

export interface PayrollException {
  id: number;
  run_id: string;
  employee_id: string | null;
  work_date: string | null;
  code: string;
  message: string;
  blocking: boolean;
  source: Record<string, unknown>;
}

export interface Payslip {
  id: string;
  run_id: string;
  employee_id: string;
  payslip_no: string;
  status: 'issued' | 'void';
  issued_at: string;
  voided_at: string | null;
  void_reason: string | null;
  snapshot: PayslipSnapshot;
}

export interface PayslipSnapshot {
  run_no: number;
  period: { start_date: string; end_date: string; payday: string };
  employee: PayrollResult['employee_snapshot'];
  totals: {
    gross_pay: number; total_deductions: number; net_pay: number; employer_contributions: number;
    days_worked: number; regular_minutes: number; ot_minutes_paid: number; undertime_minutes: number;
    late_minutes: number; night_minutes: number; leave_hours: number;
  };
  statutory: StatutoryEntry[];
  lines: Pick<PayrollLine, 'category' | 'code' | 'description' | 'work_date' | 'quantity' | 'unit' | 'rate' | 'multiplier' | 'amount'>[];
  finalized_at: string;
}

export interface PaymentRecord {
  id: string;
  run_id: string;
  employee_id: string;
  amount: number;
  method: string;
  reference: string | null;
  paid_at: string;
}

export interface StatutoryRule {
  id: string;
  agency: 'sss' | 'philhealth' | 'pagibig' | 'bir_withholding';
  name: string;
  effective_from: string;
  effective_to: string | null;
  status: 'draft' | 'approved' | 'retired';
  params: Record<string, unknown>;
  source_reference: string;
  notes: string | null;
  approved_at: string | null;
}
