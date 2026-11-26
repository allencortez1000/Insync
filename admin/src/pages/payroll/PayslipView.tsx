import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Button, ErrorBox, Spinner } from '../../components/ui';
import { useAsync } from '../../lib/hooks';
import { dateOnly, dateTime, hm, money, php, titleCase } from '../../lib/format';
import { q, supabase } from '../../lib/supabase';
import type { PaymentRecord, Payslip, PayslipSnapshot } from '../../lib/types';
import { lineMult, lineQty, lineRate } from './PayrollRunDetail';

type SnapLine = PayslipSnapshot['lines'][number];

/** Shows only the last four characters of a government identifier. */
function mask(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[^0-9A-Za-z]/g, '') : '';
  if (!s) return '—';
  if (s.length <= 4) return '••••';
  return `•••• ${s.slice(-4)}`;
}

const text = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

export function PayslipView() {
  const { id = '' } = useParams();
  const data = useAsync(async () => {
    const slip = await q<Payslip>(supabase.from('payslips').select('*').eq('id', id).single());
    const payment = await q<PaymentRecord | null>(
      supabase.from('payment_records').select('*').eq('run_id', slip.run_id).eq('employee_id', slip.employee_id).maybeSingle(),
    );
    return { slip, payment };
  }, [id]);

  if (data.loading && !data.data) return <Spinner />;
  if (data.error || !data.data) {
    return <div className="mx-auto max-w-xl p-6"><ErrorBox error={data.error ?? 'Payslip not found'} /></div>;
  }

  return <PayslipDocument slip={data.data.slip} payment={data.data.payment}
    back={<Link to="/payslips" className="text-sm text-brand-600 hover:underline">← Payslips</Link>} />;
}

/** The printable payslip. Also used by the employee portal for the employee's own payslips. */
export function PayslipDocument({ slip, payment, back }: { slip: Payslip; payment: PaymentRecord | null; back: ReactNode }) {
  const s = slip.snapshot;
  const emp = s.employee ?? {};
  const t = s.totals;
  const lines = s.lines ?? [];
  const earnings = lines.filter((l) => l.category === 'earning');
  const deductions = lines.filter((l) => l.category === 'deduction');
  const employer = lines.filter((l) => l.category === 'employer');
  const info = lines.filter((l) => l.category === 'info');
  const isVoid = slip.status === 'void';

  return (
    <div className="min-h-full bg-gray-100 py-4 sm:py-8">
      <div className="no-print mx-auto mb-3 flex max-w-3xl items-center justify-between px-4">
        {back}
        <Button variant="primary" onClick={() => window.print()}>Print / Save as PDF</Button>
      </div>

      <article className="print-area mx-auto max-w-3xl rounded-lg border border-gray-200 bg-white p-5 text-sm shadow-sm sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">Payslip</h1>
            <div className="text-gray-600">{text(emp.site_name)}</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm">{slip.payslip_no}</div>
            <div className="text-xs text-gray-500">Payroll run #{s.run_no}</div>
            <div className="text-xs text-gray-500">Issued {dateTime(slip.issued_at)}</div>
          </div>
        </header>

        {isVoid && (
          <div className="my-4 rounded-md border-2 border-red-500 bg-red-50 px-4 py-3 text-center text-red-800">
            <div className="text-lg font-bold tracking-widest">VOID</div>
            <div className="text-sm">This payslip was voided{slip.voided_at ? ` on ${dateTime(slip.voided_at)}` : ''}{slip.void_reason ? `: ${slip.void_reason}` : ''}. It is kept for history only.</div>
          </div>
        )}

        <section className="grid grid-cols-1 gap-x-8 gap-y-1 py-4 sm:grid-cols-2">
          <Row label="Employee">{text(emp.name)}</Row>
          <Row label="Pay period">{dateOnly(s.period.start_date)} – {dateOnly(s.period.end_date)}</Row>
          <Row label="Employee code">{text(emp.employee_code)}</Row>
          <Row label="Payday">{dateOnly(s.period.payday)}</Row>
          <Row label="Site">{text(emp.site_name)}</Row>
          <Row label="Daily rate">{php(emp.daily_rate as number | undefined)}</Row>
          <Row label="Classification">{titleCase(text(emp.classification))}</Row>
          <Row label="Hourly rate">{php(emp.hourly_rate as number | undefined)}</Row>
          <Row label="TIN">{mask(emp.tin)}</Row>
          <Row label="SSS">{mask(emp.sss_number)}</Row>
          <Row label="PhilHealth">{mask(emp.philhealth_number)}</Row>
          <Row label="Pag-IBIG">{mask(emp.pagibig_number)}</Row>
        </section>

        <LineTable title="Earnings" lines={earnings} total={Number(t.gross_pay)} totalLabel="Gross pay" detailed />
        <LineTable title="Deductions" lines={deductions} total={Number(t.total_deductions)} totalLabel="Total deductions" />

        <div className="my-5 flex flex-wrap items-center justify-between gap-2 rounded-md border-2 border-gray-900 px-4 py-3">
          <div className="text-sm font-semibold uppercase tracking-wide">Net pay</div>
          <div className="num text-2xl font-bold">{php(t.net_pay)}</div>
        </div>

        <section className="grid gap-4 sm:grid-cols-2">
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Attendance summary</h2>
            <dl className="space-y-0.5">
              <Row label="Days worked">{t.days_worked}</Row>
              <Row label="Regular time">{hm(t.regular_minutes)}</Row>
              <Row label="Overtime paid">{hm(t.ot_minutes_paid)}</Row>
              <Row label="Undertime">{hm(t.undertime_minutes)}</Row>
              <Row label="Late">{hm(t.late_minutes)}</Row>
              <Row label="Night hours">{hm(t.night_minutes)}</Row>
              <Row label="Paid leave">{Number(t.leave_hours) ? `${Number(t.leave_hours)} h` : '—'}</Row>
            </dl>
          </div>
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Payment</h2>
            {payment ? (
              <dl className="space-y-0.5">
                <Row label="Status">Paid</Row>
                <Row label="Method">{titleCase(payment.method)}</Row>
                <Row label="Reference">{text(payment.reference)}</Row>
                <Row label="Paid on">{dateTime(payment.paid_at)}</Row>
                <Row label="Amount">{php(payment.amount)}</Row>
              </dl>
            ) : (
              <p className="text-gray-700">{isVoid ? 'Not applicable (void)' : 'Unpaid'}</p>
            )}

            {employer.length > 0 && (
              <>
                <h2 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">Employer contributions</h2>
                <p className="mb-1 text-xs text-gray-500">Paid by the employer; not deducted from your pay.</p>
                <dl className="space-y-0.5">
                  {employer.map((l, i) => <Row key={i} label={l.description}>{php(l.amount)}</Row>)}
                </dl>
              </>
            )}
          </div>
        </section>

        {info.length > 0 && (
          <section className="mt-5">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Notes</h2>
            <ul className="space-y-0.5 text-xs text-gray-600">
              {info.map((l, i) => (
                <li key={i}>
                  {l.work_date ? `${dateOnly(l.work_date)} · ` : ''}{l.description}
                  {l.quantity !== null && l.quantity !== undefined ? ` (${lineQty(l)})` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-6 border-t border-gray-200 pt-3 text-xs text-gray-500">
          Snapshot of finalized payroll run #{s.run_no}, finalized {dateTime(s.finalized_at)}. Times are Philippine time.
          This payslip is confidential.
        </footer>
      </article>
    </div>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-dotted border-gray-200 py-0.5">
      <dt className="text-gray-500">{label}</dt>
      <dd className="num text-right text-gray-900">{children}</dd>
    </div>
  );
}

function LineTable({ title, lines, total, totalLabel, detailed }: {
  title: string; lines: SnapLine[]; total: number; totalLabel: string; detailed?: boolean;
}) {
  return (
    <section className="mt-2">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
              {detailed && <th className="py-1 pr-2 font-medium">Date</th>}
              <th className="py-1 pr-2 font-medium">Description</th>
              {detailed && <th className="py-1 pr-2 text-right font-medium">Qty</th>}
              {detailed && <th className="py-1 pr-2 text-right font-medium">Rate</th>}
              {detailed && <th className="py-1 pr-2 text-right font-medium">×</th>}
              <th className="py-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr><td colSpan={detailed ? 6 : 2} className="py-2 text-gray-400">None</td></tr>
            )}
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-gray-100">
                {detailed && <td className="whitespace-nowrap py-1 pr-2 text-xs text-gray-600">{l.work_date ? dateOnly(l.work_date) : ''}</td>}
                <td className="py-1 pr-2">{l.description}</td>
                {detailed && <td className="num whitespace-nowrap py-1 pr-2 text-right">{lineQty(l)}</td>}
                {detailed && <td className="num whitespace-nowrap py-1 pr-2 text-right">{lineRate(l)}</td>}
                {detailed && <td className="num py-1 pr-2 text-right">{lineMult(l)}</td>}
                <td className="num py-1 text-right">{money(l.amount)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td colSpan={detailed ? 5 : 1} className="py-1.5 pr-2 text-right">{totalLabel}</td>
              <td className="num py-1.5 text-right">{php(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
