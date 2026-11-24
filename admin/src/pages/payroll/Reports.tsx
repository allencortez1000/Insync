import { useMemo, useState } from 'react';
import { useFeedback } from '../../components/feedback';
import { Button, Card, Empty, ErrorBox, Field, Input, Notice, PageHeader, Select, Spinner, Table, Td, Th, Tr } from '../../components/ui';
import { downloadCsv } from '../../lib/csv';
import { useAsync } from '../../lib/hooks';
import { useSites } from '../../lib/lookups';
import { addDays, isoToLocalInput, money, todayPH } from '../../lib/format';
import { q, supabase } from '../../lib/supabase';
import type { PaymentRecord, PayrollLine, PayrollResult, PayrollRunRow, WorkSessionRow } from '../../lib/types';
import { agencyName, fetchAll, monthLabel } from './PayrollRunDetail';

/** Manila wall-clock stamp for CSV cells. */
const stamp = (iso: string | null | undefined) => (iso ? isoToLocalInput(iso).replace('T', ' ') : '');
const n2 = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Reports() {
  return (
    <div className="space-y-5">
      <PageHeader title="Reports" subtitle="CSV exports open in Excel / Google Sheets. Only data within your access scope is included." />
      <RegisterReport />
      <ContributionReport />
      <AttendanceExport />
      <PaymentsExport />
    </div>
  );
}

// ---------------------------------------------------------------------------
// (a) Payroll register
// ---------------------------------------------------------------------------
type RunOption = Pick<PayrollRunRow, 'id' | 'run_no' | 'status' | 'start_date' | 'end_date' | 'payday' | 'site_ids' | 'site_names' | 'totals' | 'calculated_at'>;

const DEDUCTION_CODES = ['SSS_EE', 'PHIC_EE', 'HDMF_EE', 'TAX_WH', 'ADVANCE', 'ADJ_DED'] as const;
const EMPLOYER_CODES = ['SSS_ER', 'SSS_EC', 'PHIC_ER', 'HDMF_ER'] as const;

function RegisterReport() {
  const { toast } = useFeedback();
  const runs = useAsync(
    () => q<RunOption[]>(supabase.from('v_payroll_runs')
      .select('id, run_no, status, start_date, end_date, payday, site_ids, site_names, totals, calculated_at')
      .order('start_date', { ascending: false }).order('run_no', { ascending: false }).limit(300)),
    [],
  );
  const [runId, setRunId] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = (runs.data ?? []).find((r) => r.id === runId) ?? (runs.data ?? []).find((r) => r.status === 'finalized' || r.status === 'paid');
  const effectiveId = runId || selected?.id || '';

  async function download() {
    if (!selected) return;
    setBusy(true);
    try {
      const [results, lines, payments] = await Promise.all([
        fetchAll<PayrollResult>((f, t) => supabase.from('payroll_results').select('*').eq('run_id', selected.id).range(f, t)),
        fetchAll<Pick<PayrollLine, 'result_id' | 'category' | 'code' | 'amount'>>((f, t) =>
          supabase.from('payroll_lines').select('result_id, category, code, amount').eq('run_id', selected.id)
            .in('category', ['deduction', 'employer']).order('id').range(f, t)),
        fetchAll<PaymentRecord>((f, t) => supabase.from('payment_records').select('*').eq('run_id', selected.id).range(f, t)),
      ]);
      const sums = new Map<string, Map<string, number>>();
      for (const l of lines) {
        const m = sums.get(l.result_id) ?? new Map<string, number>();
        const key = l.category === 'deduction' && !(DEDUCTION_CODES as readonly string[]).includes(l.code) ? 'OTHER_DED' : l.code;
        m.set(key, (m.get(key) ?? 0) + Number(l.amount));
        sums.set(l.result_id, m);
      }
      const pay = new Map(payments.map((p) => [p.employee_id, p]));
      results.sort((a, b) => String(a.employee_snapshot?.name ?? '').localeCompare(String(b.employee_snapshot?.name ?? '')));
      const header = [
        'Run #', 'Run status', 'Period start', 'Period end', 'Payday', 'Employee code', 'Employee', 'Site',
        'Days worked', 'Regular minutes', 'OT minutes paid', 'Gross pay',
        'SSS (EE)', 'PhilHealth (EE)', 'Pag-IBIG (EE)', 'Withholding tax', 'Cash advance', 'Other deductions (manual)', 'Other deductions',
        'Total deductions', 'Net pay', 'SSS (ER)', 'SSS EC', 'PhilHealth (ER)', 'Pag-IBIG (ER)', 'Employer total',
        'Payment method', 'Payment reference', 'Paid at',
      ];
      const rows = results.map((r) => {
        const m = sums.get(r.id) ?? new Map<string, number>();
        const g = (k: string) => n2(m.get(k) ?? 0);
        const p = pay.get(r.employee_id);
        return [
          selected.run_no, selected.status, selected.start_date, selected.end_date, selected.payday,
          String(r.employee_snapshot?.employee_code ?? ''), String(r.employee_snapshot?.name ?? ''), String(r.employee_snapshot?.site_name ?? ''),
          r.days_worked, r.regular_minutes, r.ot_minutes_paid, n2(r.gross_pay),
          ...DEDUCTION_CODES.map(g), g('OTHER_DED'),
          n2(r.total_deductions), n2(r.net_pay), ...EMPLOYER_CODES.map(g), n2(r.employer_contributions),
          p?.method ?? '', p?.reference ?? '', stamp(p?.paid_at),
        ];
      });
      downloadCsv(`payroll-register-run-${selected.run_no}-${selected.start_date}.csv`, header, rows);
      toast(`Register exported (${rows.length} employees)`);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Payroll register" actions={<Button variant="primary" disabled={!selected || !selected.calculated_at} busy={busy} onClick={() => void download()}>Download CSV</Button>}>
      {runs.loading && !runs.data && <Spinner />}
      <ErrorBox error={runs.error} />
      {runs.data && runs.data.length === 0 && <Empty>No payroll runs yet.</Empty>}
      {runs.data && runs.data.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payroll run" hint="One row per employee: earnings, each deduction, net pay, employer shares and payment.">
            <Select value={effectiveId} onChange={(e) => setRunId(e.target.value)}>
              {runs.data.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.run_no} · {r.start_date} – {r.end_date} · {r.site_ids ? r.site_names ?? 'selected sites' : 'all sites'} · {r.status.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          {selected && (
            <div className="self-center text-sm text-gray-700">
              {selected.calculated_at
                ? <>Employees {selected.totals?.employees ?? 0} · Gross {money(selected.totals?.gross ?? 0)} · Net {money(selected.totals?.net ?? 0)}</>
                : 'Not calculated yet.'}
              {(selected.status === 'draft' || selected.status === 'ready_for_review') && (
                <div className="mt-1"><Notice tone="amber">This run is not finalized — figures are a draft, not approved payroll.</Notice></div>
              )}
              {selected.status === 'void' && <div className="mt-1"><Notice tone="red">This run is void.</Notice></div>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (b) Monthly contribution report
// ---------------------------------------------------------------------------
interface ContribRow {
  id: string;
  employee_id: string;
  agency: 'sss' | 'philhealth' | 'pagibig';
  contribution_month: string;
  payroll_run_id: string;
  kind: 'collection' | 'true_up';
  basis_amount: number;
  employee_amount: number;
  employer_amount: number;
  ec_amount: number;
  obligation_employee: number | null;
  obligation_employer: number | null;
  obligation_ec: number | null;
  created_at: string;
  employees: { employee_code: string; display_name: string } | null;
  payroll_runs: { run_no: number; status: string } | null;
}

function currentMonth(): string {
  return todayPH().slice(0, 7);
}

function ContributionReport() {
  const [month, setMonth] = useState(currentMonth);
  const data = useAsync(async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return [];
    const rows = await fetchAll<ContribRow>((f, t) => supabase.from('contribution_ledger')
      .select('*, employees(employee_code, display_name), payroll_runs(run_no, status)')
      .eq('contribution_month', `${month}-01`).order('created_at').range(f, t));
    return rows.filter((r) => r.payroll_runs && (r.payroll_runs.status === 'finalized' || r.payroll_runs.status === 'paid'));
  }, [month]);

  const summary = useMemo(() => {
    const agencies = ['sss', 'philhealth', 'pagibig'] as const;
    return agencies.map((a) => {
      const rows = (data.data ?? []).filter((r) => r.agency === a);
      const employees = new Set(rows.map((r) => r.employee_id));
      const reconciled = new Set(rows.filter((r) => r.kind === 'true_up').map((r) => r.employee_id));
      const sum = (k: 'employee_amount' | 'employer_amount' | 'ec_amount' | 'basis_amount') => rows.reduce((s, r) => s + Number(r[k]), 0);
      return {
        agency: a, rows: rows.length, employees: employees.size, reconciled: reconciled.size,
        basis: sum('basis_amount'), ee: sum('employee_amount'), er: sum('employer_amount'), ec: sum('ec_amount'),
      };
    });
  }, [data.data]);

  function download() {
    const rows = (data.data ?? []).map((r) => [
      r.contribution_month, agencyName(r.agency), r.employees?.employee_code ?? '', r.employees?.display_name ?? r.employee_id,
      r.kind === 'true_up' ? 'month-end true-up' : 'collection', n2(r.basis_amount), n2(r.employee_amount), n2(r.employer_amount),
      n2(r.ec_amount), n2(r.obligation_employee), n2(r.obligation_employer), n2(r.obligation_ec),
      r.payroll_runs?.run_no ?? '', r.payroll_runs?.status ?? '', stamp(r.created_at),
    ]);
    downloadCsv(`contributions-${month}.csv`, [
      'Month', 'Agency', 'Employee code', 'Employee', 'Kind', 'Basis', 'Employee share', 'Employer share', 'EC',
      'Obligation EE (at posting)', 'Obligation ER (at posting)', 'Obligation EC (at posting)', 'Run #', 'Run status', 'Posted at',
    ], rows);
  }

  return (
    <Card
      title="Government contributions by month"
      actions={<Button variant="primary" disabled={!data.data || data.data.length === 0} onClick={download}>Download CSV</Button>}
    >
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Field label="Contribution month" hint="Grouped by payday month. Only finalized / paid runs; voided runs are excluded.">
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
      </div>
      {data.loading && !data.data && <Spinner />}
      <ErrorBox error={data.error} />
      {data.data && data.data.length === 0 && <Empty>No posted contributions for {/^\d{4}-\d{2}$/.test(month) ? monthLabel(`${month}-01`) : 'this month'}.</Empty>}
      {data.data && data.data.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Agency</Th><Th className="text-right">Employees</Th><Th className="text-right">Month-end reconciled</Th>
              <Th className="text-right">Basis</Th><Th className="text-right">Employee share</Th><Th className="text-right">Employer share</Th>
              <Th className="text-right">EC</Th><Th className="text-right">Total remittance</Th>
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <Tr key={s.agency}>
                <Td className="font-medium">{agencyName(s.agency)}</Td>
                <Td className="num text-right">{s.employees}</Td>
                <Td className="num text-right">{s.reconciled} / {s.employees}</Td>
                <Td className="num text-right">{money(s.basis)}</Td>
                <Td className="num text-right">{money(s.ee)}</Td>
                <Td className="num text-right">{money(s.er)}</Td>
                <Td className="num text-right">{money(s.ec)}</Td>
                <Td className="num text-right font-semibold">{money(s.ee + s.er + s.ec)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {summary.some((s) => s.employees > s.reconciled) && (
        <p className="mt-3 text-xs text-gray-500">
          Employees not yet reconciled have only installment collections so far; the month's last payday trues up to the actual monthly obligation.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (c) Attendance export
// ---------------------------------------------------------------------------
function AttendanceExport() {
  const { toast } = useFeedback();
  const sites = useSites();
  const [to, setTo] = useState(todayPH);
  const [from, setFrom] = useState(() => addDays(todayPH(), -6));
  const [site, setSite] = useState('');
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const rows = await fetchAll<WorkSessionRow>((f, t) => {
        let query = supabase.from('v_work_sessions').select('*').gte('work_date', from).lte('work_date', to);
        if (site) query = query.eq('site_id', site);
        return query.order('work_date').order('clock_in_at').order('id').range(f, t);
      });
      downloadCsv(`attendance-${from}-to-${to}.csv`, [
        'Work date', 'Employee code', 'Employee', 'Site', 'Clock in', 'Clock out', 'Elapsed minutes', 'Status', 'Source',
        'Flags', 'Reviewed at', 'Review note', 'In location', 'In latitude', 'In longitude', 'In accuracy (m)',
        'Out location', 'Out latitude', 'Out longitude', 'Out accuracy (m)', 'Device',
      ], rows.map((r) => [
        r.work_date, r.employee_code, r.employee_name, r.site_name, stamp(r.clock_in_at), stamp(r.clock_out_at),
        r.elapsed_minutes, r.status, r.source, (r.review_flags ?? []).join(' '), stamp(r.reviewed_at), r.review_note,
        r.in_location_status, r.in_latitude, r.in_longitude, r.in_accuracy_m,
        r.out_location_status, r.out_latitude, r.out_longitude, r.out_accuracy_m, r.in_device_label,
      ]));
      toast(`Attendance exported (${rows.length} sessions)`);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const valid = Boolean(from && to && from <= to);
  return (
    <Card title="Attendance sessions" actions={<Button variant="primary" disabled={!valid} busy={busy} onClick={() => void download()}>Download CSV</Button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="From (work date)"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To (work date)"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Site">
          <Select value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All my sites</option>
            {(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      </div>
      <p className="mt-2 text-xs text-gray-500">Includes clock-in/out times (Philippine time), review flags, and location status with coordinates. Treat the file as confidential.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// (d) Payments export
// ---------------------------------------------------------------------------
interface PaymentExportRow extends PaymentRecord {
  payroll_runs: { run_no: number } | null;
  employees: { employee_code: string; display_name: string } | null;
}

function PaymentsExport() {
  const { toast } = useFeedback();
  const [to, setTo] = useState(todayPH);
  const [from, setFrom] = useState(() => addDays(todayPH(), -30));
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const rows = await fetchAll<PaymentExportRow>((f, t) => supabase.from('payment_records')
        .select('*, payroll_runs(run_no), employees(employee_code, display_name)')
        .gte('paid_at', `${from}T00:00:00+08:00`).lt('paid_at', `${addDays(to, 1)}T00:00:00+08:00`)
        .order('paid_at').order('id').range(f, t));
      const total = rows.reduce((s, r) => s + Number(r.amount), 0);
      downloadCsv(`payments-${from}-to-${to}.csv`,
        ['Paid at', 'Run #', 'Employee code', 'Employee', 'Amount', 'Method', 'Reference'],
        rows.map((r) => [stamp(r.paid_at), r.payroll_runs?.run_no ?? '', r.employees?.employee_code ?? '',
          r.employees?.display_name ?? r.employee_id, n2(r.amount), r.method, r.reference ?? '']));
      toast(`Payments exported (${rows.length} records, total ${money(total)})`);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const valid = Boolean(from && to && from <= to);
  return (
    <Card title="Recorded payments" actions={<Button variant="primary" disabled={!valid} busy={busy} onClick={() => void download()}>Download CSV</Button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Paid from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Paid to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
    </Card>
  );
}
