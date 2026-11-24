import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../../lib/auth';
import { useFeedback } from '../../components/feedback';
import {
  Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Stat,
  Table, Td, Textarea, Th, Tr,
} from '../../components/ui';
import { useAsync } from '../../lib/hooks';
import { employeeLabel, useEmployeesLite } from '../../lib/lookups';
import { dateOnly, dateTime, hm, isoToLocalInput, localInputToIso, money, php } from '../../lib/format';
import { q, rpc, supabase } from '../../lib/supabase';
import type { PaymentRecord, PayrollException, PayrollLine, PayrollResult, PayrollRunRow, StatutoryEntry } from '../../lib/types';
import { RunStatus } from './PayrollRuns';

// ---------------------------------------------------------------------------
// Shared helpers (also used by the other payroll pages)
// ---------------------------------------------------------------------------
type Res<T> = { data: T | null; error: { message: string; details?: string | null; hint?: string | null } | null };

/** Fetches every row of a query in pages (PostgREST caps responses at the project's max rows). */
export async function fetchAll<T>(make: (from: number, to: number) => PromiseLike<Res<T[]>>, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const rows = (await q<T[]>(make(from, from + page - 1))) ?? [];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

type LineLike = Pick<PayrollLine, 'quantity' | 'unit' | 'rate' | 'multiplier'>;

export function lineQty(l: LineLike): string {
  if (l.quantity === null || l.quantity === undefined) return '—';
  const n = Number(l.quantity);
  switch (l.unit) {
    case 'minutes': return hm(n);
    case 'days': return `${n} day${n === 1 ? '' : 's'}`;
    case 'week': return `${n} wk`;
    case 'peso': return `${php(n)} taxable`;
    default: return `${n}${l.unit ? ` ${l.unit}` : ''}`;
  }
}

export function lineRate(l: LineLike): string {
  if (l.rate === null || l.rate === undefined) return '—';
  const suffix = l.unit === 'minutes' ? '/h' : l.unit === 'days' ? '/day' : l.unit === 'week' ? '/wk' : '';
  return `${money(l.rate)}${suffix}`;
}

export function lineMult(l: LineLike): string {
  return l.multiplier === null || l.multiplier === undefined ? '—' : `×${Number(l.multiplier).toFixed(2)}`;
}

export const agencyName = (a: string) =>
  ({ sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG', bir_withholding: 'BIR withholding' } as Record<string, string>)[a] ?? a;

export function monthLabel(isoDate: string): string {
  const [y, m] = isoDate.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'short', year: 'numeric' });
}

export const lineGroups: { key: PayrollLine['category']; title: string }[] = [
  { key: 'earning', title: 'Earnings' },
  { key: 'deduction', title: 'Deductions' },
  { key: 'employer', title: 'Employer contributions (not deducted)' },
  { key: 'info', title: 'Informational' },
];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function exceptionLink(e: PayrollException): { to: string; label: string } | null {
  const c = e.code;
  if (c.startsWith('OT_')) return { to: '/overtime', label: 'Overtime review' };
  if (['MISSING_CLOCK_OUT', 'LONG_SESSION', 'LOCATION_EXCEPTION', 'SITE_MISMATCH'].includes(c)) return { to: '/attendance', label: 'Attendance' };
  if (['RULE_NOT_APPROVED', 'NO_RULE', 'NIGHT_WORK', 'NO_MULTIPLIER', 'DOUBLE_HOLIDAY'].includes(c)) return { to: '/policies', label: 'Policies & rules' };
  if (['NO_RATE', 'NO_SCHEDULE', 'HOLIDAY_ELIGIBILITY', 'DEDUCTION_CAPPED'].includes(c) && e.employee_id) return { to: `/employees/${e.employee_id}`, label: 'Employee record' };
  if (c.startsWith('LEAVE_')) return { to: '/leave', label: 'Leave' };
  if (c.startsWith('ADVANCE_')) return { to: '/advances', label: 'Cash advances' };
  if (c === 'PRIOR_RUN_OPEN' || c === 'IN_OTHER_RUN') return { to: '/payroll', label: 'Payroll runs' };
  return null;
}

function statusNotice(run: PayrollRunRow): { tone: 'blue' | 'amber' | 'red' | 'green'; text: ReactNode } {
  switch (run.status) {
    case 'draft':
      return { tone: 'blue', text: <><b>Draft — not approved.</b> Figures are a preview computed from current attendance and rules. Resolve exceptions, then submit for review.</> };
    case 'ready_for_review':
      return { tone: 'blue', text: <><b>Ready for review — not yet approved.</b> Finalizing recalculates from current data and locks an immutable snapshot with payslips.</> };
    case 'finalized':
      return { tone: 'amber', text: <><b>Finalized.</b> Payslips are issued. This system does not transfer money — record payments after actually paying.</> };
    case 'paid':
      return { tone: 'green', text: <><b>Paid.</b> All employees in this run have a recorded payment.</> };
    default:
      return { tone: 'red', text: <><b>Void.</b> Payslips are kept for history but marked void. {run.void_reason && <>Reason: {run.void_reason}</>}</> };
  }
}

interface Adjustment {
  id: string; employee_id: string; period_id: string; kind: 'earning' | 'deduction'; adj_type?: 'holiday' | 'other'; description: string;
  amount: number; taxable: boolean; reason: string; created_at: string;
}
interface Impact { correction_id: string; created_at: string; kind: string; reason: string; employee_id: string; employee_name: string }
interface RunLink { id: string; run_no: number; status: PayrollRunRow['status'] }

const resultName = (r: Pick<PayrollResult, 'employee_snapshot' | 'employee_id'>) =>
  String(r.employee_snapshot?.name ?? r.employee_id.slice(0, 8));

// ---------------------------------------------------------------------------
export function PayrollRunDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { toast, run: act, prompt, confirm } = useFeedback();
  const [version, setVersion] = useState(0);
  const reloadAll = () => setVersion((v) => v + 1);
  const [busy, setBusy] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const runQ = useAsync(() => q<PayrollRunRow>(supabase.from('v_payroll_runs').select('*').eq('id', id).single()), [id, version]);
  const results = useAsync(
    async () => (await fetchAll<PayrollResult>((f, t) => supabase.from('payroll_results').select('*').eq('run_id', id).range(f, t)))
      .sort((a, b) => resultName(a).localeCompare(resultName(b))),
    [id, version],
  );
  const exceptions = useAsync(
    () => fetchAll<PayrollException>((f, t) => supabase.from('payroll_exceptions').select('*').eq('run_id', id)
      .order('blocking', { ascending: false }).order('id').range(f, t)),
    [id, version],
  );
  const payments = useAsync(
    () => fetchAll<PaymentRecord>((f, t) => supabase.from('payment_records').select('*').eq('run_id', id).range(f, t)),
    [id, version],
  );
  const impacts = useAsync(() => q<Impact[]>(supabase.from('v_payroll_impacts').select('*').eq('run_id', id).order('created_at')), [id, version]);
  const reissuedAs = useAsync(
    () => q<RunLink[]>(supabase.from('v_payroll_runs').select('id, run_no, status').eq('reissue_of_run_id', id)),
    [id, version],
  );
  const originalId = runQ.data?.reissue_of_run_id ?? null;
  const original = useAsync(async () => {
    if (!originalId) return null;
    const [r, res] = await Promise.all([
      q<RunLink | null>(supabase.from('v_payroll_runs').select('id, run_no, status').eq('id', originalId).maybeSingle()),
      fetchAll<Pick<PayrollResult, 'employee_id' | 'net_pay' | 'employee_snapshot'>>((f, t) =>
        supabase.from('payroll_results').select('employee_id, net_pay, employee_snapshot').eq('run_id', originalId).range(f, t)),
    ]);
    return { run: r, results: res };
  }, [originalId, version]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of results.data ?? []) m.set(r.employee_id, resultName(r));
    return m;
  }, [results.data]);
  const missingNameIds = useMemo(
    () => [...new Set((exceptions.data ?? []).map((e) => e.employee_id).filter((x): x is string => Boolean(x) && !names.has(x!)))],
    [exceptions.data, names],
  );
  const extraNames = useAsync(async () => {
    if (missingNameIds.length === 0) return new Map<string, string>();
    const rows = await q<{ id: string; display_name: string; employee_code: string }[]>(
      supabase.from('employees').select('id, display_name, employee_code').in('id', missingNameIds));
    return new Map(rows.map((r) => [r.id, `${r.display_name} (${r.employee_code})`]));
  }, [missingNameIds.join(',')]);
  const nameOf = (empId: string | null) => (empId ? names.get(empId) ?? extraNames.data?.get(empId) ?? empId.slice(0, 8) : '—');

  const paidMap = useMemo(() => new Map((payments.data ?? []).map((p) => [p.employee_id, p])), [payments.data]);

  const run = runQ.data;
  if (runQ.loading && !run) return <Spinner />;
  if (runQ.error && !run) return <ErrorBox error={runQ.error} />;
  if (!run) return <Empty>Payroll run not found.</Empty>;

  const editable = run.status === 'draft' || run.status === 'ready_for_review';
  const totals = run.totals ?? {};
  const notice = statusNotice(run);
  const unpaid = (results.data ?? []).filter((r) => !paidMap.has(r.employee_id));

  async function doAction(name: string, fn: () => Promise<unknown>, success: string) {
    setBusy(name);
    await act(fn, success);
    setBusy(null);
    reloadAll();
  }

  async function finalize() {
    const net = Number(totals.net ?? 0);
    const ok = await confirm({
      title: `Finalize payroll run #${run!.run_no}`,
      message: (
        <div className="space-y-2">
          <p>The run is recalculated from current data. If the net total no longer matches what you reviewed, finalization stops so you can review again.</p>
          <p>Employees: <b>{totals.employees ?? 0}</b> · Reviewed net pay: <b className="num">{php(net)}</b></p>
          <p>Finalizing issues immutable payslips and posts statutory contributions and cash-advance repayments. It does not pay anyone.</p>
        </div>
      ),
      confirmText: 'Finalize payroll',
    });
    if (!ok) return;
    setBusy('finalize');
    try {
      const res = await rpc<{ ok: boolean; code?: string; message?: string; payslips?: number }>('payroll_finalize', {
        p_run_id: id, p_expected_net: net,
      });
      if (res.ok) toast(`Finalized — ${res.payslips ?? 0} payslip(s) issued.`);
      else toast(res.message ?? 'Payroll could not be finalized.', 'error');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
      reloadAll();
    }
  }

  async function voidRun() {
    const reason = await prompt({
      title: `Void payroll run #${run!.run_no}`,
      message: (
        <div className="space-y-2">
          <p>Payslips stay on record but are marked void; cash-advance repayments are reversed and contributions stop counting. You can then reissue the run.</p>
          {run!.status === 'paid' && <p className="text-red-700">This run is marked paid. Only an admin can void paid payroll; settle any difference with the employees manually.</p>}
        </div>
      ),
      label: 'Reason',
      minLength: 5,
      danger: true,
      confirmText: 'Void run',
    });
    if (!reason) return;
    await doAction('void', () => rpc('payroll_void', { p_run_id: id, p_reason: reason }), 'Payroll run voided');
  }

  async function reissue() {
    const ok = await confirm({
      title: 'Reissue payroll',
      message: 'Creates a new draft run for the same period and sites, linked to this voided run. Calculate and review it as usual.',
      confirmText: 'Create reissue',
    });
    if (!ok) return;
    setBusy('reissue');
    try {
      const newId = await rpc<string>('payroll_reissue', { p_run_id: id });
      toast('Reissue draft created');
      navigate(`/payroll/${newId}`);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function deleteDraft() {
    const ok = await confirm({ title: `Delete draft run #${run!.run_no}`, message: 'The draft and its computed preview are deleted. Attendance and OT decisions are not affected.', confirmText: 'Delete draft', danger: true });
    if (!ok) return;
    setBusy('delete');
    const done = await act(() => rpc('payroll_delete_draft', { p_run_id: id }), 'Draft deleted');
    setBusy(null);
    if (done) navigate('/payroll');
  }

  const actions = (
    <>
      {editable && (
        <Button variant={run.calculated_at ? 'secondary' : 'primary'} busy={busy === 'calc'}
          onClick={() => void doAction('calc', () => rpc('payroll_calculate', { p_run_id: id }), 'Payroll calculated')}>
          {run.calculated_at ? 'Recalculate' : 'Calculate'}
        </Button>
      )}
      {run.status === 'draft' && (
        <>
          <Button variant="primary" disabled={!run.calculated_at} busy={busy === 'submit'}
            onClick={() => void doAction('submit', () => rpc('payroll_submit', { p_run_id: id }), 'Submitted for review')}>
            Submit for review
          </Button>
          <Button variant="ghost" busy={busy === 'delete'} onClick={() => void deleteDraft()}>Delete draft</Button>
        </>
      )}
      {run.status === 'ready_for_review' && (
        <>
          <Button busy={busy === 'return'}
            onClick={() => void doAction('return', () => rpc('payroll_return_to_draft', { p_run_id: id }), 'Returned to draft')}>
            Return to draft
          </Button>
          <Button variant="primary" disabled={run.blocking_count > 0} busy={busy === 'finalize'} onClick={() => void finalize()}
            title={run.blocking_count > 0 ? 'Resolve blocking exceptions first' : undefined}>
            Finalize
          </Button>
        </>
      )}
      {(run.status === 'finalized' || run.status === 'paid') && (
        <>
          {unpaid.length > 0 && <Button variant="primary" onClick={() => setPaying(true)}>Record payment</Button>}
          <Link to={`/payslips?run=${run.id}`}><Button>Payslips</Button></Link>
          <Button variant="danger" busy={busy === 'void'} disabled={run.status === 'paid' && !isAdmin}
            title={run.status === 'paid' && !isAdmin ? 'Only an admin can void paid payroll' : undefined}
            onClick={() => void voidRun()}>
            Void
          </Button>
        </>
      )}
      {run.status === 'void' && (
        <>
          <Link to={`/payslips?run=${run.id}&void=1`}><Button>Payslips</Button></Link>
          {!(reissuedAs.data ?? []).some((r) => r.status !== 'void') && (
            <Button variant="primary" busy={busy === 'reissue'} onClick={() => void reissue()}>Reissue</Button>
          )}
        </>
      )}
    </>
  );

  return (
    <div className="space-y-5">
      <div className="no-print text-sm"><Link to="/payroll" className="text-brand-600 hover:underline">← Payroll runs</Link></div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">Payroll run #{run.run_no} <RunStatus status={run.status} /></span>}
        subtitle={<>{dateOnly(run.start_date)} – {dateOnly(run.end_date)} · Payday {dateOnly(run.payday)} · {run.site_ids ? run.site_names ?? `${run.site_ids.length} site(s)` : 'All sites'}</>}
        actions={actions}
      />

      <Notice tone={notice.tone}>{notice.text}</Notice>

      {(run.status === 'finalized' || run.status === 'paid') && (impacts.data ?? []).length > 0 && (
        <Notice tone="amber">
          <b>Attendance was corrected after finalization — void and reissue to pay the difference.</b>
          <ul className="mt-1 list-disc pl-5">
            {(impacts.data ?? []).map((i) => (
              <li key={i.correction_id}>{i.employee_name}: {i.kind.replace(/_/g, ' ')} on {dateTime(i.created_at)} — {i.reason}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Employees" value={run.calculated_at ? totals.employees ?? 0 : '—'} />
        <Stat label="Gross" value={run.calculated_at ? php(totals.gross ?? 0) : '—'} />
        <Stat label="Deductions" value={run.calculated_at ? php(totals.deductions ?? 0) : '—'} />
        <Stat label="Net pay" value={run.calculated_at ? php(totals.net ?? 0) : '—'} />
        <Stat label="Employer contrib." value={run.calculated_at ? php(totals.employer ?? 0) : '—'} hint="Not deducted from pay" />
        <Stat label="Blocking" value={run.blocking_count} tone={run.blocking_count > 0 ? 'red' : 'green'} />
        <Stat label="Warnings" value={run.warning_count} tone={run.warning_count > 0 ? 'amber' : undefined} />
      </div>

      <Card title="Run details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Calculated">{dateTime(run.calculated_at)}</Detail>
          <Detail label="Submitted for review">{dateTime(run.submitted_at)}</Detail>
          <Detail label="Finalized">{dateTime(run.finalized_at)}</Detail>
          <Detail label="Paid">{dateTime(run.paid_at)}</Detail>
          {run.voided_at && <Detail label="Voided">{dateTime(run.voided_at)} — {run.void_reason}</Detail>}
          {run.reissue_of_run_id && (
            <Detail label="Reissue of">
              <Link className="text-brand-600 hover:underline" to={`/payroll/${run.reissue_of_run_id}`}>
                Run #{original.data?.run?.run_no ?? '…'}
              </Link>
            </Detail>
          )}
          {(reissuedAs.data ?? []).length > 0 && (
            <Detail label="Reissued as">
              {(reissuedAs.data ?? []).map((r) => (
                <Link key={r.id} className="mr-2 text-brand-600 hover:underline" to={`/payroll/${r.id}`}>Run #{r.run_no} ({r.status.replace(/_/g, ' ')})</Link>
              ))}
            </Detail>
          )}
          {run.notes && <Detail label="Notes">{run.notes}</Detail>}
        </dl>
      </Card>

      <ExceptionsPanel
        loading={exceptions.loading && !exceptions.data}
        error={exceptions.error}
        calculated={Boolean(run.calculated_at)}
        exceptions={exceptions.data ?? []}
        nameOf={nameOf}
      />

      {original.data && (
        <ReissueComparison originalRunNo={original.data.run?.run_no ?? null} original={original.data.results} current={results.data ?? []} />
      )}

      <ResultsCard
        loading={results.loading && !results.data}
        error={results.error}
        results={results.data ?? []}
        exceptions={exceptions.data ?? []}
        paidMap={paidMap}
        calculated={Boolean(run.calculated_at)}
      />

      <AdjustmentsCard periodId={run.period_id} editable={editable} version={version} runSiteIds={run.site_ids}
        resultEmployeeIds={(results.data ?? []).map((r) => r.employee_id)} />

      {paying && (
        <PaymentModal runId={id} unpaid={unpaid} onClose={() => setPaying(false)} onDone={() => { setPaying(false); reloadAll(); }} />
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-gray-800">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ExceptionsPanel({ loading, error, calculated, exceptions, nameOf }: {
  loading: boolean; error: string | null; calculated: boolean; exceptions: PayrollException[]; nameOf: (id: string | null) => string;
}) {
  const [showAll, setShowAll] = useState(false);
  const blocking = exceptions.filter((e) => e.blocking);
  const warnings = exceptions.filter((e) => !e.blocking);
  const list = [...blocking, ...warnings];
  const shown = showAll ? list : list.slice(0, 40);

  return (
    <Card
      padded={false}
      title={<span className="flex items-center gap-2">Exceptions
        {blocking.length > 0 && <Badge tone="red">{blocking.length} blocking</Badge>}
        {warnings.length > 0 && <Badge tone="amber">{warnings.length} warnings</Badge>}</span>}
    >
      {loading && <Spinner />}
      {error && <div className="p-4"><ErrorBox error={error} /></div>}
      {!loading && !calculated && <Empty>Calculate the run to see exceptions.</Empty>}
      {!loading && calculated && list.length === 0 && <div className="p-4"><Notice tone="green">No exceptions.</Notice></div>}
      {calculated && blocking.length === 0 && warnings.length > 0 && (
        <div className="px-4 pt-3"><Notice tone="green">No blocking exceptions. Review the warnings below before finalizing.</Notice></div>
      )}
      {list.length > 0 && (
        <Table>
          <thead><tr><Th>Severity</Th><Th>Employee</Th><Th>Date</Th><Th>Code</Th><Th>Message</Th><Th>Resolve</Th></tr></thead>
          <tbody>
            {shown.map((e) => {
              const link = exceptionLink(e);
              return (
                <Tr key={e.id}>
                  <Td>{e.blocking ? <Badge tone="red">blocking</Badge> : <Badge tone="amber">warning</Badge>}</Td>
                  <Td className="whitespace-nowrap">{nameOf(e.employee_id)}</Td>
                  <Td className="whitespace-nowrap">{e.work_date ? dateOnly(e.work_date) : '—'}</Td>
                  <Td><code className="text-xs">{e.code}</code></Td>
                  <Td className="min-w-64">{e.message}</Td>
                  <Td className="whitespace-nowrap">{link ? <Link className="text-brand-600 hover:underline" to={link.to}>{link.label} →</Link> : '—'}</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {list.length > shown.length && (
        <div className="border-t border-gray-100 p-3 text-center">
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>Show all {list.length} exceptions</Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function ResultsCard({ loading, error, results, exceptions, paidMap, calculated }: {
  loading: boolean; error: string | null; results: PayrollResult[]; exceptions: PayrollException[];
  paidMap: Map<string, PaymentRecord>; calculated: boolean;
}) {
  const [search, setSearch] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = results.filter((r) => {
    const s = search.trim().toLowerCase();
    const hay = `${resultName(r)} ${String(r.employee_snapshot?.employee_code ?? '')}`.toLowerCase();
    if (s && !hay.includes(s)) return false;
    if (onlyFlagged && r.blocking_count + r.warning_count === 0) return false;
    return true;
  });

  return (
    <Card
      padded={false}
      title={`Employees (${results.length})`}
      actions={
        <>
          <Input placeholder="Search name or code" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48" />
          <Checkbox label="With exceptions" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
        </>
      }
    >
      {loading && <Spinner />}
      {error && <div className="p-4"><ErrorBox error={error} /></div>}
      {!loading && !calculated && <Empty>Not calculated yet.</Empty>}
      {!loading && calculated && results.length === 0 && <Empty>No employees with payable time or exceptions in this period.</Empty>}
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Employee</Th><Th>Site</Th><Th className="text-right">Days</Th><Th className="text-right">Regular</Th>
              <Th className="text-right">OT paid / recorded</Th><Th className="text-right">Leave h</Th>
              <Th className="text-right">Gross</Th><Th className="text-right">Deductions</Th><Th className="text-right">Net</Th>
              <Th>Paid</Th><Th>Flags</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = expanded === r.id;
              const pay = paidMap.get(r.employee_id);
              return (
                <Fragment key={r.id}>
                  <Tr onClick={() => setExpanded(open ? null : r.id)} className={open ? 'bg-brand-50/40' : undefined}>
                    <Td className="whitespace-nowrap">
                      <span className="mr-1 text-gray-400">{open ? '▾' : '▸'}</span>
                      <span className="font-medium">{resultName(r)}</span>{' '}
                      <span className="text-xs text-gray-500">{String(r.employee_snapshot?.employee_code ?? '')}</span>
                    </Td>
                    <Td className="whitespace-nowrap">{String(r.employee_snapshot?.site_name ?? '—')}</Td>
                    <Td className="num text-right">{r.days_worked}</Td>
                    <Td className="num text-right">{hm(r.regular_minutes)}</Td>
                    <Td className="num text-right whitespace-nowrap">{hm(r.ot_minutes_paid)} / {hm(r.ot_minutes_recorded)}</Td>
                    <Td className="num text-right">{Number(r.leave_hours) || '—'}</Td>
                    <Td className="num text-right">{money(r.gross_pay)}</Td>
                    <Td className="num text-right">{money(r.total_deductions)}</Td>
                    <Td className="num text-right font-semibold">{money(r.net_pay)}</Td>
                    <Td>{pay ? <Badge tone="green">paid</Badge> : <span className="text-xs text-gray-400">—</span>}</Td>
                    <Td className="whitespace-nowrap">
                      {r.blocking_count > 0 && <Badge tone="red">{r.blocking_count}</Badge>}{' '}
                      {r.warning_count > 0 && <Badge tone="amber">{r.warning_count}</Badge>}
                    </Td>
                  </Tr>
                  {open && (
                    <tr className="border-b border-gray-200 bg-gray-50/60">
                      <td colSpan={11} className="p-3 sm:p-4">
                        <ResultDetail result={r} exceptions={exceptions.filter((e) => e.employee_id === r.employee_id)} payment={pay} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ResultDetail({ result, exceptions, payment }: { result: PayrollResult; exceptions: PayrollException[]; payment?: PaymentRecord }) {
  const lines = useAsync(
    () => q<PayrollLine[]>(supabase.from('payroll_lines').select('*').eq('result_id', result.id)
      .order('sort_order').order('work_date', { ascending: true, nullsFirst: false }).order('id')),
    [result.id],
  );
  const snap = result.employee_snapshot ?? {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-600">
        <span>Daily rate: <b className="num">{php(snap.daily_rate as number | undefined)}</b></span>
        <span>Hourly: <b className="num">{php(snap.hourly_rate as number | undefined)}</b></span>
        <span>Classification: {String(snap.classification ?? '—')}</span>
        {snap.is_minimum_wage_earner === true && <span>Minimum wage earner</span>}
        {snap.labor_standards_covered === false && <span>Not covered by OT/holiday rules</span>}
        {snap.statutory_covered === false && <span>No statutory contributions</span>}
        <span>Undertime: {hm(result.undertime_minutes)} · Late: {hm(result.late_minutes)} · Night: {hm(result.night_minutes)}</span>
        {payment && <span>Paid {dateTime(payment.paid_at)} via {payment.method.replace(/_/g, ' ')}{payment.reference ? ` (${payment.reference})` : ''}</span>}
      </div>

      {exceptions.length > 0 && (
        <ul className="space-y-1 text-sm">
          {exceptions.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2">
              {e.blocking ? <Badge tone="red">blocking</Badge> : <Badge tone="amber">warning</Badge>}
              {e.work_date && <span className="text-xs text-gray-500">{dateOnly(e.work_date)}</span>}
              <span>{e.message}</span>
            </li>
          ))}
        </ul>
      )}

      {lines.loading && !lines.data && <Spinner label="Loading lines…" />}
      <ErrorBox error={lines.error} />
      {lines.data && (
        <div className="grid gap-4 xl:grid-cols-2">
          {lineGroups.map((g) => {
            const ls = lines.data!.filter((l) => l.category === g.key);
            if (ls.length === 0) return null;
            const total = ls.reduce((s, l) => s + Number(l.amount), 0);
            return (
              <div key={g.key} className="rounded-md border border-gray-200 bg-white">
                <div className="flex justify-between border-b border-gray-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <span>{g.title}</span>
                  {g.key !== 'info' && <span className="num">{php(total)}</span>}
                </div>
                <Table>
                  <thead><tr><Th>Date</Th><Th>Description</Th><Th className="text-right">Qty</Th><Th className="text-right">Rate</Th><Th className="text-right">×</Th><Th className="text-right">Amount</Th></tr></thead>
                  <tbody>
                    {ls.map((l) => (
                      <Tr key={l.id}>
                        <Td className="whitespace-nowrap text-xs">{l.work_date ? dateOnly(l.work_date) : '—'}</Td>
                        <Td>{l.description} <span className="text-[10px] text-gray-400">{l.code}</span></Td>
                        <Td className="num text-right whitespace-nowrap">{lineQty(l)}</Td>
                        <Td className="num text-right whitespace-nowrap">{lineRate(l)}</Td>
                        <Td className="num text-right">{lineMult(l)}</Td>
                        <Td className="num text-right">{g.key === 'info' && Number(l.amount) === 0 ? '—' : money(l.amount)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            );
          })}
        </div>
      )}

      {/* Construction mode uses fixed per-employee amounts: there is no monthly projection to explain. */}
      {(result.statutory ?? []).some((s) => (s as { mode?: string }).mode !== 'fixed_profile') && <StatutoryTable entries={result.statutory} />}
    </div>
  );
}

export function StatutoryTable({ entries }: { entries: StatutoryEntry[] }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Statutory contributions — monthly reconciliation
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Agency</Th><Th>Month</Th><Th className="text-right">This-run basis</Th><Th className="text-right">Month basis to date</Th>
            <Th className="text-right">Basis used</Th><Th className="text-right">Credit</Th><Th className="text-right">Monthly obligation (EE)</Th>
            <Th className="text-right">Previously collected</Th><Th className="text-right">This collection (EE)</Th>
            <Th className="text-right">ER</Th><Th className="text-right">EC</Th><Th>Stage</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((s) => (
            <Tr key={`${s.agency}-${s.month}`}>
              <Td className="font-medium">{agencyName(s.agency)}</Td>
              <Td className="whitespace-nowrap">{monthLabel(s.month)}</Td>
              <Td className="num text-right">{money(s.basis)}</Td>
              <Td className="num text-right">{money(s.month_basis)}</Td>
              <Td className="num text-right whitespace-nowrap">{money(s.projected_basis)} <span className="text-[10px] text-gray-500">{s.final ? 'actual' : 'projected'}</span></Td>
              <Td className="num text-right">{money(s.credit)}</Td>
              <Td className="num text-right">{money(s.obligation_ee)}</Td>
              <Td className="num text-right">{money(s.prior_ee)}</Td>
              <Td className="num text-right font-medium">{money(s.ee)}</Td>
              <Td className="num text-right">{money(s.er)}</Td>
              <Td className="num text-right">{money(s.ec)}</Td>
              <Td className="whitespace-nowrap text-xs">{s.final ? 'Month-end reconciliation' : `Installment ${s.payday_index} of ${s.paydays_in_month}`}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ReissueComparison({ originalRunNo, original, current }: {
  originalRunNo: number | null;
  original: Pick<PayrollResult, 'employee_id' | 'net_pay' | 'employee_snapshot'>[];
  current: PayrollResult[];
}) {
  const rows = useMemo(() => {
    const m = new Map<string, { id: string; name: string; before: number | null; after: number | null }>();
    for (const r of original) m.set(r.employee_id, { id: r.employee_id, name: resultName(r), before: Number(r.net_pay), after: null });
    for (const r of current) {
      const e = m.get(r.employee_id) ?? { id: r.employee_id, name: resultName(r), before: null, after: null };
      e.after = Number(r.net_pay);
      m.set(r.employee_id, e);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [original, current]);
  const sum = (k: 'before' | 'after') => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const diffCell = (d: number) => (
    <span className={d > 0 ? 'text-green-700' : d < 0 ? 'text-red-700' : 'text-gray-500'}>{d > 0 ? '+' : ''}{money(d)}</span>
  );

  return (
    <Card padded={false} title={`Compared with original run #${originalRunNo ?? '…'}`}>
      <div className="px-4 pt-3 text-xs text-gray-500">Positive difference = additional amount owed to the employee; negative = overpaid in the original run.</div>
      <Table>
        <thead><tr><Th>Employee</Th><Th className="text-right">Original net</Th><Th className="text-right">Reissued net</Th><Th className="text-right">Difference</Th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td>{r.name}</Td>
              <Td className="num text-right">{r.before === null ? '—' : money(r.before)}</Td>
              <Td className="num text-right">{r.after === null ? '—' : money(r.after)}</Td>
              <Td className="num text-right">{diffCell((r.after ?? 0) - (r.before ?? 0))}</Td>
            </Tr>
          ))}
          <Tr className="font-semibold">
            <Td>Total</Td>
            <Td className="num text-right">{money(sum('before'))}</Td>
            <Td className="num text-right">{money(sum('after'))}</Td>
            <Td className="num text-right">{diffCell(sum('after') - sum('before'))}</Td>
          </Tr>
        </tbody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function AdjustmentsCard({ periodId, editable, version, runSiteIds, resultEmployeeIds }: {
  periodId: string; editable: boolean; version: number; runSiteIds: string[] | null; resultEmployeeIds: string[];
}) {
  const { session } = useAuth();
  const { run: act, confirm } = useFeedback();
  const employees = useEmployeesLite(true);
  const [tick, setTick] = useState(0);
  const adjustments = useAsync(
    () => q<Adjustment[]>(supabase.from('payroll_adjustments').select('*').eq('period_id', periodId).order('created_at')),
    [periodId, version, tick],
  );
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ employee_id: '', kind: 'earning' as 'earning' | 'deduction' | 'holiday', description: '', amount: '', taxable: true, reason: '' });
  const [saving, setSaving] = useState(false);

  const empName = useMemo(() => new Map((employees.data ?? []).map((e) => [e.id, employeeLabel(e)])), [employees.data]);
  const pickable = useMemo(() => {
    const inRun = new Set(resultEmployeeIds);
    return (employees.data ?? []).filter((e) =>
      inRun.has(e.id) || !runSiteIds || (e.current_site_id !== null && runSiteIds.includes(e.current_site_id)));
  }, [employees.data, runSiteIds, resultEmployeeIds]);

  const amount = Number(form.amount);
  const valid = form.employee_id && form.description.trim() && amount > 0 && form.reason.trim().length >= 3;

  async function save() {
    setSaving(true);
    const ok = await act(() => q(supabase.from('payroll_adjustments').insert({
      employee_id: form.employee_id, period_id: periodId, kind: form.kind === 'deduction' ? 'deduction' : 'earning',
      adj_type: form.kind === 'holiday' ? 'holiday' : 'other', description: form.description.trim(),
      amount: Math.round(amount * 100) / 100, taxable: form.kind !== 'deduction' ? form.taxable : false,
      reason: form.reason.trim(), created_by: session?.user.id,
    })), 'Adjustment saved — recalculate the payroll to apply it');
    setSaving(false);
    if (ok) {
      setAdding(false);
      setForm({ employee_id: '', kind: 'earning', description: '', amount: '', taxable: true, reason: '' });
      setTick((t) => t + 1);
    }
  }

  async function remove(a: Adjustment) {
    const ok = await confirm({ title: 'Delete adjustment', message: `${a.description} (${php(a.amount)})`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    if (await act(() => q(supabase.from('payroll_adjustments').delete().eq('id', a.id)), 'Adjustment deleted — recalculate the payroll')) {
      setTick((t) => t + 1);
    }
  }

  const rows = adjustments.data ?? [];
  return (
    <Card
      padded={false}
      title="Period adjustments"
      actions={editable ? <Button size="sm" onClick={() => setAdding(true)}>Add adjustment</Button> : undefined}
    >
      <div className="px-4 pt-3 text-xs text-gray-500">
        Manual earnings or deductions for this pay period, each with a reason and the person who entered it.
        {editable ? ' Recalculate after any change.' : ' Locked: the run is no longer a draft.'}
      </div>
      {adjustments.loading && !adjustments.data && <Spinner />}
      {adjustments.error && <div className="p-4"><ErrorBox error={adjustments.error} /></div>}
      {adjustments.data && rows.length === 0 && <Empty>No adjustments for this period.</Empty>}
      {rows.length > 0 && (
        <Table>
          <thead><tr><Th>Employee</Th><Th>Kind</Th><Th>Description</Th><Th className="text-right">Amount</Th><Th>Taxable</Th><Th>Reason</Th><Th>Entered</Th><Th /></tr></thead>
          <tbody>
            {rows.map((a) => (
              <Tr key={a.id}>
                <Td className="whitespace-nowrap">{empName.get(a.employee_id) ?? a.employee_id.slice(0, 8)}</Td>
                <Td>{a.adj_type === 'holiday' ? <Badge tone="purple">holiday pay</Badge> : a.kind === 'earning' ? <Badge tone="green">earning</Badge> : <Badge tone="amber">deduction</Badge>}</Td>
                <Td>{a.description}</Td>
                <Td className="num text-right">{money(a.amount)}</Td>
                <Td>{a.kind === 'earning' ? (a.taxable ? 'Yes' : 'No') : '—'}</Td>
                <Td className="min-w-48">{a.reason}</Td>
                <Td className="whitespace-nowrap text-xs text-gray-500">{dateTime(a.created_at)}</Td>
                <Td>{editable && <Button size="sm" variant="ghost" onClick={() => void remove(a)}>Delete</Button>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        open={adding}
        title="Add period adjustment"
        onClose={() => setAdding(false)}
        footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!valid} busy={saving} onClick={() => void save()}>Save</Button></>}
      >
        <Field label="Employee">
          <Select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })}>
            <option value="">Select employee…</option>
            {pickable.map((e) => <option key={e.id} value={e.id}>{employeeLabel(e)}{!e.is_active ? ' — inactive' : ''}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => {
              const kind = e.target.value as 'earning' | 'deduction' | 'holiday';
              setForm({ ...form, kind, description: kind === 'holiday' && !form.description ? 'Holiday pay' : form.description });
            }}>
              <option value="holiday">Holiday pay</option>
              <option value="earning">Earning</option>
              <option value="deduction">Deduction</option>
            </Select>
          </Field>
          <Field label="Amount (PHP)">
            <Input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
        </div>
        <Field label="Description (shown on payslip)">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Retro pay for 2026-01-12" />
        </Field>
        {form.kind !== 'deduction' && (
          <Checkbox label="Taxable compensation" checked={form.taxable} onChange={(e) => setForm({ ...form, taxable: e.target.checked })} />
        )}
        <Field label="Reason" hint="Required (at least 3 characters). Recorded with your name.">
          <Textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={2} />
        </Field>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
const METHODS = [
  { id: 'cash', label: 'Cash' },
  { id: 'bank_transfer', label: 'Bank transfer' },
  { id: 'e_wallet', label: 'E-wallet' },
  { id: 'check', label: 'Check' },
];

function PaymentModal({ runId, unpaid, onClose, onDone }: { runId: string; unpaid: PayrollResult[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useFeedback();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(unpaid.map((r) => r.employee_id)));
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [busy, setBusy] = useState(false);

  const toggle = (empId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(empId)) next.delete(empId); else next.add(empId);
    return next;
  });
  const total = unpaid.filter((r) => selected.has(r.employee_id)).reduce((s, r) => s + Number(r.net_pay), 0);

  async function save() {
    setBusy(true);
    try {
      const n = await rpc<number>('payroll_record_payment', {
        p_run_id: runId, p_employee_ids: [...selected], p_method: method,
        p_reference: reference.trim() || null, p_paid_at: localInputToIso(paidAt),
      });
      toast(`${n} payment(s) recorded`);
      onDone();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      title="Record payment"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={selected.size === 0 || !paidAt} busy={busy} onClick={() => void save()}>Record {selected.size} payment(s) · {php(total)}</Button></>}
    >
      <Notice tone="amber">Record payments only after the money has actually been handed over or transferred. Each amount equals the employee's finalized net pay.</Notice>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Method">
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </Field>
        <Field label="Reference (optional)">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Batch / transfer ref" />
        </Field>
        <Field label="Paid at (PH time)">
          <Input type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => setSelected(new Set(unpaid.map((r) => r.employee_id)))}>Select all</Button>
        <Button size="sm" onClick={() => setSelected(new Set())}>Select none</Button>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-md border border-gray-200">
        <Table>
          <thead><tr><Th /><Th>Employee</Th><Th>Site</Th><Th className="text-right">Net pay</Th></tr></thead>
          <tbody>
            {unpaid.map((r) => (
              <Tr key={r.id} onClick={() => toggle(r.employee_id)}>
                <Td><input type="checkbox" readOnly checked={selected.has(r.employee_id)} className="h-4 w-4" /></Td>
                <Td>{resultName(r)} <span className="text-xs text-gray-500">{String(r.employee_snapshot?.employee_code ?? '')}</span></Td>
                <Td>{String(r.employee_snapshot?.site_name ?? '—')}</Td>
                <Td className="num text-right">{money(r.net_pay)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Modal>
  );
}
