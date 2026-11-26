import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { rpc } from '../../lib/supabase';
import { useAsync } from '../../lib/hooks';
import { dateOnly, money, php, todayPH } from '../../lib/format';
import { downloadCsv } from '../../lib/csv';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Notice, PageHeader, Select, Spinner, Stat, Table, Td, Th, Tr } from '../../components/ui';

interface Row {
  employee_id: string; employee_code: string; employee_name: string; site_name: string | null; is_active: boolean;
  hire_date: string | null; separation_date: string | null; payroll_runs: number;
  first_period_start: string | null; last_period_end: string | null; basic_earned: number; thirteenth_month: number;
}

/**
 * 13th month pay (P.D. 851): total basic salary earned in the calendar year ÷ 12.
 * The figures come from finalized / paid payroll runs, so they always match the payslips.
 */
export function ThirteenthMonth() {
  const thisYear = Number(todayPH().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [site, setSite] = useState('');
  const [search, setSearch] = useState('');
  const data = useAsync(() => rpc<Row[]>('thirteenth_month_report', { p_year: year }), [year]);

  const sites = useMemo(() => [...new Set((data.data ?? []).map((r) => r.site_name).filter((s): s is string => !!s))].sort(), [data.data]);
  const rows = useMemo(() => (data.data ?? []).filter((r) =>
    (!site || r.site_name === site)
    && (!search || `${r.employee_name} ${r.employee_code}`.toLowerCase().includes(search.trim().toLowerCase()))), [data.data, site, search]);
  const totalBasic = rows.reduce((n, r) => n + Number(r.basic_earned), 0);
  const total13 = rows.reduce((n, r) => n + Number(r.thirteenth_month), 0);
  const lastEnd = rows.map((r) => r.last_period_end).filter(Boolean).sort().pop();

  function exportCsv() {
    downloadCsv(`13th-month-pay-${year}${site ? `-${site}` : ''}.csv`,
      ['Employee code', 'Employee', 'Site', 'Status', 'Date hired', 'Payroll runs counted', 'First pay period start', 'Last pay period end',
        'Basic salary earned', '13th month pay'],
      rows.map((r) => [r.employee_code, r.employee_name, r.site_name, r.is_active ? 'active' : 'inactive', r.hire_date, r.payroll_runs,
        r.first_period_start, r.last_period_end, Number(r.basic_earned).toFixed(2), Number(r.thirteenth_month).toFixed(2)]));
  }

  return (
    <div className="space-y-4">
      <PageHeader title="13th month pay"
        subtitle="Total basic salary earned in the year ÷ 12, computed from finalized payroll. Employees see their own amount in their employee account."
        actions={<>
          <Button onClick={() => window.print()}>Print</Button>
          <Button variant="primary" disabled={!rows.length} onClick={exportCsv}>Export CSV</Button>
        </>} />

      <div className="filter-bar no-print">
        <Field label="Year" className="w-28">
          <Select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[thisYear + 0, thisYear - 1, thisYear - 2, thisYear - 3].map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
        </Field>
        <Field label="Site" className="w-48">
          <Select value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All sites</option>{sites.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="Search" className="w-56"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or code" /></Field>
      </div>

      <ErrorBox error={data.error} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Employees" value={rows.filter((r) => Number(r.basic_earned) > 0).length} hint={`with basic salary in ${year}`} />
        <Stat label="Total basic salary" value={php(totalBasic)} hint={lastEnd ? `payroll counted up to ${dateOnly(lastEnd)}` : 'no finalized payroll yet'} />
        <Stat label="Total 13th month pay" value={php(total13)} tone="green" hint={year === thisYear ? 'earned so far this year' : `for ${year}`} />
      </div>

      <Card padded={false} className="print-area">
        {data.loading && !data.data ? <Spinner /> : !rows.length ? <Empty>No employees to show.</Empty> : (
          <Table>
            <thead><tr>
              <Th>Employee</Th><Th>Site</Th><Th className="text-right">Payroll runs</Th><Th>Pay periods covered</Th>
              <Th className="text-right">Basic salary earned</Th><Th className="text-right">13th month pay</Th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.employee_id}>
                  <Td>
                    <Link to={`/employees/${r.employee_id}`} className="font-medium text-gray-900 hover:text-brand-700 hover:underline">{r.employee_name}</Link>{' '}
                    <span className="text-xs text-gray-400">{r.employee_code}</span>{' '}
                    {!r.is_active && <Badge>inactive</Badge>}
                  </Td>
                  <Td>{r.site_name ?? '—'}</Td>
                  <Td className="num text-right">{r.payroll_runs}</Td>
                  <Td className="whitespace-nowrap text-xs text-gray-600">
                    {r.first_period_start && r.last_period_end ? `${dateOnly(r.first_period_start)} – ${dateOnly(r.last_period_end)}` : '—'}
                  </Td>
                  <Td className="num text-right">{money(r.basic_earned)}</Td>
                  <Td className="num text-right font-semibold">{money(r.thirteenth_month)}</Td>
                </Tr>
              ))}
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                <Td colSpan={4} className="text-right">Total</Td>
                <Td className="num text-right">{php(totalBasic)}</Td>
                <Td className="num text-right">{php(total13)}</Td>
              </tr>
            </tbody>
          </Table>
        )}
      </Card>

      <Notice>
        <b>How it is computed.</b> 13th month pay = total <i>basic salary</i> earned from January 1 to December 31 ÷ 12 (Presidential Decree 851).
        Basic salary is the regular daily wage for days worked, including paid leave and the base pay of rest-day work. Overtime pay,
        rest-day and holiday premiums, holiday pay adjustments and allowances are not included. Only payroll runs that are finalized or paid
        are counted, by the end date of their pay period, so an employee who started or left during the year is prorated automatically.
        It must be released on or before December 24; amounts up to ₱90,000 are tax-exempt.
      </Notice>
    </div>
  );
}
