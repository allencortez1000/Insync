import { useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { employeeLabel, useEmployeesLite } from '../lib/lookups';
import { addDays, dateOnly, todayPH } from '../lib/format';
import type { LeaveStatus } from '../lib/types';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td, Th, Tr } from '../components/ui';

interface LeaveType { id: string; code: string; name: string; is_paid: boolean; requires_balance: boolean }
interface LeaveEntry {
  id: string; employee_id: string; leave_type_id: string; leave_date: string; hours: number; status: LeaveStatus;
  reason: string | null; decision_note: string | null;
  employees: { display_name: string; employee_code: string } | null; leave_types: { name: string; is_paid: boolean } | null;
}

export function Leave() {
  const { run, prompt } = useFeedback();
  const today = todayPH();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(addDays(today, 60));
  const [creating, setCreating] = useState(false);

  const rows = useAsync(async () => {
    let query = supabase.from('leave_entries').select('*, employees(display_name, employee_code), leave_types(name, is_paid)')
      .gte('leave_date', from).lte('leave_date', to).order('leave_date');
    if (status === 'pending') query = query.eq('status', 'pending');
    return q<LeaveEntry[]>(query);
  }, [status, from, to]);

  async function decide(e: LeaveEntry, approve: boolean) {
    let note: string | null = '';
    if (!approve) {
      note = await prompt({ title: 'Reject leave', label: 'Reason', minLength: 3, danger: true, confirmText: 'Reject' });
      if (note === null) return;
    }
    if (await run(() => rpc('leave_decide', { p_entry_id: e.id, p_approve: approve, p_note: note || null }), approve ? 'Leave approved' : 'Leave rejected')) rows.reload();
  }
  async function cancel(e: LeaveEntry) {
    const reason = await prompt({ title: 'Cancel leave', label: 'Reason', minLength: 3, danger: true, confirmText: 'Cancel leave',
      message: e.status === 'approved' ? 'The used balance is returned to the ledger.' : undefined });
    if (reason !== null && await run(() => rpc('leave_cancel', { p_entry_id: e.id, p_reason: reason }), 'Leave cancelled')) rows.reload();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Leave" subtitle="Staff record leave for employees. Approved paid leave is paid without a clock-in and reduces the balance."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Record leave</Button>} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Show" className="w-44">
          <Select value={status} onChange={(e) => setStatus(e.target.value as 'pending' | 'all')}>
            <option value="pending">Pending approval</option><option value="all">All</option>
          </Select>
        </Field>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <ErrorBox error={rows.error} />
      <Card padded={false}>
        {rows.loading && !rows.data ? <Spinner /> : !rows.data?.length ? <Empty>No leave entries.</Empty> : (
          <Table>
            <thead><tr><Th>Date</Th><Th>Employee</Th><Th>Type</Th><Th>Hours</Th><Th>Status</Th><Th>Reason / note</Th><Th /></tr></thead>
            <tbody>{rows.data.map((e) => (
              <Tr key={e.id}>
                <Td className="whitespace-nowrap">{dateOnly(e.leave_date)}</Td>
                <Td>{e.employees?.display_name} <span className="text-xs text-gray-400">{e.employees?.employee_code}</span></Td>
                <Td>{e.leave_types?.name} {e.leave_types?.is_paid ? <Badge tone="green">paid</Badge> : <Badge>unpaid</Badge>}</Td>
                <Td className="num">{Number(e.hours)}</Td>
                <Td><StatusBadge status={e.status} /></Td>
                <Td className="text-xs">{e.reason}{e.decision_note && <div className="text-gray-500">→ {e.decision_note}</div>}</Td>
                <Td className="whitespace-nowrap text-right">
                  {e.status === 'pending' && <><Button size="sm" variant="primary" onClick={() => void decide(e, true)}>Approve</Button>{' '}
                    <Button size="sm" onClick={() => void decide(e, false)}>Reject</Button>{' '}</>}
                  {(e.status === 'pending' || e.status === 'approved') && <Button size="sm" variant="ghost" onClick={() => void cancel(e)}>Cancel</Button>}
                </Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      {creating && <RecordLeave onClose={() => setCreating(false)} onSaved={() => { setCreating(false); rows.reload(); }} />}
    </div>
  );
}

function RecordLeave({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { run } = useFeedback();
  const { profile } = useAuth();
  const employees = useEmployeesLite();
  const types = useAsync(() => q<LeaveType[]>(supabase.from('leave_types').select('*').eq('is_active', true).order('name')), []);
  const today = todayPH();
  const [f, setF] = useState({ employee_id: '', leave_type_id: '', from: today, to: today, hours: '8', reason: '' });
  const balances = useAsync(async () => f.employee_id
    ? q<{ leave_type_id: string; leave_name: string; balance_days: number }[]>(supabase.from('v_leave_balances').select('*').eq('employee_id', f.employee_id))
    : [], [f.employee_id]);

  const dates: string[] = [];
  for (let d = f.from; d <= f.to && dates.length < 31; d = addDays(d, 1)) dates.push(d);

  async function save() {
    if (!profile) return;
    const ok = await run(() => q(supabase.from('leave_entries').insert(dates.map((d) => ({
      employee_id: f.employee_id, leave_type_id: f.leave_type_id, leave_date: d, hours: Number(f.hours), reason: f.reason || null, created_by: profile.id,
    })))), `${dates.length} leave day(s) recorded — approve them to apply`);
    if (ok) onSaved();
  }

  return (
    <Modal open title="Record leave" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.employee_id || !f.leave_type_id || !dates.length || !(Number(f.hours) > 0)} onClick={() => void save()}>Save</Button></>}>
      <Field label="Employee">
        <Select value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
          <option value="">Select…</option>{employees.data?.map((e) => <option key={e.id} value={e.id}>{employeeLabel(e)}</option>)}
        </Select>
      </Field>
      <Field label="Leave type">
        <Select value={f.leave_type_id} onChange={(e) => setF({ ...f, leave_type_id: e.target.value })}>
          <option value="">Select…</option>{types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_paid ? ' (paid)' : ' (unpaid)'}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="From"><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></Field>
        <Field label="To"><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Hours / day"><Input type="number" min={1} max={8} step={0.5} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>
      </div>
      <Field label="Reason"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      {f.employee_id && (
        <Notice>Balances: {balances.data?.length ? balances.data.map((b) => `${b.leave_name} ${Number(b.balance_days)} day(s)`).join(' · ') : 'none recorded'}.
          {' '}{dates.length} day(s) selected — include only scheduled working days; payroll flags leave on rest days and holidays.</Notice>
      )}
    </Modal>
  );
}
