import { useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { addDays, dateOnly, dateTime, hm, todayPH } from '../lib/format';
import type { OtStatus } from '../lib/types';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td, Textarea, Th, Tr } from '../components/ui';

interface OtRow {
  id: string; employee_id: string; work_date: string; recorded_minutes: number; accepted_minutes: number;
  status: OtStatus; reason: string | null; decided_at: string | null;
  employees: { display_name: string; employee_code: string } | null;
}

export function Overtime() {
  const { run } = useFeedback();
  const today = todayPH();
  const [from, setFrom] = useState(addDays(today, -14));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [deciding, setDeciding] = useState<OtRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const rows = useAsync(async () => {
    let query = supabase.from('ot_decisions').select('*, employees(display_name, employee_code)')
      .gte('work_date', from).lte('work_date', to).order('work_date', { ascending: false });
    if (status === 'open') query = query.in('status', ['pending', 'disputed']);
    return q<OtRow[]>(query);
  }, [from, to, status]);

  async function refresh() {
    setRefreshing(true);
    await run(async () => {
      const n = await rpc<number>('ot_refresh', { p_from: from, p_to: to });
      return n;
    }, 'Extra-time candidates refreshed');
    setRefreshing(false);
    rows.reload();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Overtime review" subtitle="Time beyond 8 worked hours on a work date is an OT candidate. It is paid only after a decision."
        actions={<Button variant="primary" busy={refreshing} onClick={() => void refresh()}>Find extra time in range</Button>} />
      <Notice>
        Pending or disputed OT blocks payroll finalization for the affected employee. A decision never deletes the recorded hours;
        unaccepted minutes stay visible on the payslip breakdown with your reason.
      </Notice>
      <div className="filter-bar">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Show" className="w-48">
          <Select value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'all')}>
            <option value="open">Needs decision</option><option value="all">All decisions</option>
          </Select>
        </Field>
      </div>
      <ErrorBox error={rows.error} />
      <Card padded={false}>
        {rows.loading && !rows.data ? <Spinner /> : !rows.data?.length ? <Empty>No OT candidates in this range.</Empty> : (
          <Table>
            <thead><tr><Th>Work date</Th><Th>Employee</Th><Th>Recorded extra</Th><Th>Accepted</Th><Th>Status</Th><Th>Reason</Th><Th /></tr></thead>
            <tbody>{rows.data.map((r) => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap">{dateOnly(r.work_date)}</Td>
                <Td>{r.employees?.display_name} <span className="text-xs text-gray-400">{r.employees?.employee_code}</span></Td>
                <Td className="num">{hm(r.recorded_minutes)}</Td>
                <Td className="num">{r.status === 'accepted' ? hm(r.accepted_minutes) : '—'}</Td>
                <Td><StatusBadge status={r.status} /></Td>
                <Td className="text-xs">{r.reason}{r.decided_at && <div className="text-gray-400">{dateTime(r.decided_at)}</div>}</Td>
                <Td className="text-right"><Button size="sm" variant={r.status === 'pending' ? 'primary' : 'secondary'} onClick={() => setDeciding(r)}>Decide</Button></Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      {deciding && <Decide row={deciding} onClose={() => setDeciding(null)} onSaved={() => { setDeciding(null); rows.reload(); }} />}
    </div>
  );
}

function Decide({ row, onClose, onSaved }: { row: OtRow; onClose: () => void; onSaved: () => void }) {
  const { run } = useFeedback();
  const [status, setStatus] = useState<OtStatus>(row.status === 'pending' ? 'accepted' : row.status);
  const [minutes, setMinutes] = useState(String(row.status === 'accepted' ? row.accepted_minutes : row.recorded_minutes));
  const [reason, setReason] = useState(row.reason ?? '');
  const partial = status === 'accepted' && Number(minutes) < row.recorded_minutes;
  const needsReason = status === 'rejected' || status === 'disputed' || partial;

  async function save() {
    const ok = await run(() => rpc('ot_decide', {
      p_employee_id: row.employee_id, p_work_date: row.work_date, p_status: status,
      p_accepted_minutes: status === 'accepted' ? Number(minutes) : 0, p_reason: reason || null,
    }), 'OT decision saved');
    if (ok) onSaved();
  }

  return (
    <Modal open title={`OT decision · ${row.employees?.display_name} · ${dateOnly(row.work_date)}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={needsReason && reason.trim().length < 3} onClick={() => void save()}>Save decision</Button></>}>
      <p className="text-sm">Recorded extra time: <b>{hm(row.recorded_minutes)}</b> beyond 8 worked hours.</p>
      <Field label="Decision">
        <Select value={status} onChange={(e) => setStatus(e.target.value as OtStatus)}>
          <option value="accepted">Accept as OT</option>
          <option value="rejected">Not OT (e.g. stayed without authorization)</option>
          <option value="disputed">Disputed — needs follow-up (blocks payroll)</option>
          <option value="pending">Leave pending</option>
        </Select>
      </Field>
      {status === 'accepted' && (
        <Field label="Accepted minutes" hint={partial ? 'Partial acceptance needs a reason.' : undefined}>
          <Input type="number" min={0} max={row.recorded_minutes} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>
      )}
      <Field label={needsReason ? 'Reason (required)' : 'Reason (optional)'}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {status === 'accepted' && <p className="text-xs text-gray-500">OT is paid at the day's OT multiplier (e.g. 125% on ordinary days, 169% on rest days, 260% on regular holidays). <Badge>DOLE baseline</Badge></p>}
    </Modal>
  );
}
