import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Badge, Card, Checkbox, Empty, ErrorBox, Field, Input, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td, Th, Tr,
} from '../../components/ui';
import { useAsync } from '../../lib/hooks';
import { dateOnly, dateTime, money } from '../../lib/format';
import { q, supabase } from '../../lib/supabase';
import type { PaymentRecord, PayrollRunRow } from '../../lib/types';
import { fetchAll } from './PayrollRunDetail';

interface PayslipListRow {
  id: string;
  run_id: string;
  employee_id: string;
  payslip_no: string;
  status: 'issued' | 'void';
  issued_at: string;
  void_reason: string | null;
  employee_name: string | null;
  employee_code: string | null;
  site_name: string | null;
  start_date: string | null;
  end_date: string | null;
  payday: string | null;
  net_pay: string | number | null;
}

type RunOption = Pick<PayrollRunRow, 'id' | 'run_no' | 'status' | 'start_date' | 'end_date' | 'site_names' | 'site_ids'>;

const LIST_COLUMNS = [
  'id', 'run_id', 'employee_id', 'payslip_no', 'status', 'issued_at', 'void_reason',
  'employee_name:snapshot->employee->>name', 'employee_code:snapshot->employee->>employee_code',
  'site_name:snapshot->employee->>site_name', 'start_date:snapshot->period->>start_date',
  'end_date:snapshot->period->>end_date', 'payday:snapshot->period->>payday', 'net_pay:snapshot->totals->>net_pay',
].join(',');

const LIMIT = 1000;

type ListResult = { data: PayslipListRow[] | null; error: { message: string } | null };

export function Payslips() {
  const [params, setParams] = useSearchParams();
  const runFilter = params.get('run') ?? '';
  const [includeVoid, setIncludeVoid] = useState(params.get('void') === '1');
  const [search, setSearch] = useState('');

  const runs = useAsync(
    () => q<RunOption[]>(supabase.from('v_payroll_runs')
      .select('id, run_no, status, start_date, end_date, site_names, site_ids')
      .in('status', ['finalized', 'paid', 'void'])
      .order('start_date', { ascending: false }).order('run_no', { ascending: false }).limit(300)),
    [],
  );

  const slips = useAsync(async () => {
    const build = (from: number, to: number) => {
      let query = supabase.from('payslips').select(LIST_COLUMNS).order('issued_at', { ascending: false }).order('payslip_no');
      if (runFilter) query = query.eq('run_id', runFilter);
      if (!includeVoid) query = query.eq('status', 'issued');
      // JSON-path aliases are not understood by the client's type parser; the shape is PayslipListRow.
      return query.range(from, to) as unknown as PromiseLike<ListResult>;
    };
    // A selected run loads completely; otherwise the newest payslips.
    const rows = runFilter
      ? await fetchAll<PayslipListRow>(build)
      : await q<PayslipListRow[]>(build(0, LIMIT - 1));
    const runIds = [...new Set(rows.map((r) => r.run_id))];
    const payments = runIds.length === 0 ? [] : await fetchAll<PaymentRecord>((f, t) =>
      supabase.from('payment_records').select('*').in('run_id', runIds).range(f, t));
    return { rows, payments, truncated: !runFilter && rows.length >= LIMIT };
  }, [runFilter, includeVoid]);

  const runMap = useMemo(() => new Map((runs.data ?? []).map((r) => [r.id, r])), [runs.data]);
  const payMap = useMemo(
    () => new Map((slips.data?.payments ?? []).map((p) => [`${p.run_id}:${p.employee_id}`, p])),
    [slips.data],
  );

  const rows = (slips.data?.rows ?? []).filter((r) => {
    const s = search.trim().toLowerCase();
    if (!s) return true;
    return `${r.employee_name ?? ''} ${r.employee_code ?? ''} ${r.payslip_no}`.toLowerCase().includes(s);
  });

  const setRun = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('run', v); else next.delete('run');
    next.delete('void');
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        title="Payslips"
        subtitle="Issued when payroll is finalized. Distribute privately — payslips never appear on the shared attendance device."
      />

      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Payroll run">
            <Select value={runFilter} onChange={(e) => setRun(e.target.value)}>
              <option value="">All recent runs</option>
              {(runs.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.run_no} · {r.start_date} – {r.end_date} · {r.site_ids ? r.site_names ?? 'selected sites' : 'all sites'}{r.status === 'void' ? ' (void)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search">
            <Input placeholder="Employee, code or payslip no." value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox label="Include void payslips" checked={includeVoid} onChange={(e) => setIncludeVoid(e.target.checked)} />
          </div>
        </div>
      </Card>

      <div className="mt-4">
        <Card padded={false} title={`Payslips (${rows.length})`}>
          {slips.loading && !slips.data && <Spinner />}
          {slips.error && <div className="p-4"><ErrorBox error={slips.error} /></div>}
          {slips.data?.truncated && <div className="p-4"><Notice tone="amber">Showing the newest {LIMIT} payslips. Pick a run to see all of its payslips.</Notice></div>}
          {slips.data && rows.length === 0 && <Empty>No payslips match.</Empty>}
          {rows.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Payslip no.</Th><Th>Employee</Th><Th>Site</Th><Th>Period</Th><Th>Payday</Th><Th>Run</Th>
                  <Th className="text-right">Net pay</Th><Th>Status</Th><Th>Payment</Th><Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pay = payMap.get(`${r.run_id}:${r.employee_id}`);
                  const run = runMap.get(r.run_id);
                  return (
                    <Tr key={r.id}>
                      <Td className="whitespace-nowrap font-mono text-xs">{r.payslip_no}</Td>
                      <Td className="whitespace-nowrap">{r.employee_name ?? '—'} <span className="text-xs text-gray-500">{r.employee_code}</span></Td>
                      <Td className="whitespace-nowrap">{r.site_name ?? '—'}</Td>
                      <Td className="whitespace-nowrap">{r.start_date ? `${dateOnly(r.start_date)} – ${dateOnly(r.end_date)}` : '—'}</Td>
                      <Td className="whitespace-nowrap">{dateOnly(r.payday)}</Td>
                      <Td className="whitespace-nowrap">{run ? `#${run.run_no}` : '—'}</Td>
                      <Td className="num text-right">{money(r.net_pay)}</Td>
                      <Td>
                        <StatusBadge status={r.status} />
                        {r.status === 'void' && r.void_reason && <div className="max-w-48 truncate text-xs text-gray-500" title={r.void_reason}>{r.void_reason}</div>}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {pay
                          ? <span title={`${pay.method}${pay.reference ? ` · ${pay.reference}` : ''}`}><Badge tone="green">paid</Badge> <span className="text-xs text-gray-500">{dateTime(pay.paid_at)}</span></span>
                          : <Badge tone={r.status === 'void' ? 'gray' : 'amber'}>unpaid</Badge>}
                      </Td>
                      <Td>
                        <a href={`/payslips/${r.id}`} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-600 hover:underline">Open ↗</a>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
