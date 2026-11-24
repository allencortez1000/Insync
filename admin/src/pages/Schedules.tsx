import { useState } from 'react';
import { q, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import type { Schedule } from '../lib/types';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Spinner, Table, Td, Textarea, Th, Tr } from '../components/ui';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type Form = Omit<Schedule, 'id'> & { id?: string };
const blank: Form = {
  name: '', start_time: '08:00', end_time: '17:00', working_days: [1, 2, 3, 4, 5, 6], unpaid_break_minutes: 60,
  break_applies_after_minutes: 300, grace_minutes: 5, is_active: true, notes: '',
};

export function Schedules() {
  const { run } = useFeedback();
  const list = useAsync(() => q<Schedule[]>(supabase.from('schedules').select('*').order('name')), []);
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!f) return;
    setBusy(true);
    const { id, ...row } = f;
    const payload = { ...row, notes: row.notes || null, working_days: [...row.working_days].sort() };
    const ok = await run(() => id ? q(supabase.from('schedules').update(payload).eq('id', id)) : q(supabase.from('schedules').insert(payload)), 'Schedule saved');
    setBusy(false);
    if (ok) { setF(null); list.reload(); }
  }

  const toggleDay = (d: number) => f && setF({ ...f, working_days: f.working_days.includes(d) ? f.working_days.filter((x) => x !== d) : [...f.working_days, d] });

  return (
    <div className="space-y-4">
      <PageHeader title="Schedules" subtitle="Working days, rest days, unpaid breaks and grace periods. Assign them per employee with an effective date."
        actions={<Button variant="primary" onClick={() => setF({ ...blank })}>New schedule</Button>} />
      <Notice>
        Eight hours alone cannot identify lateness or rest days. Payroll flags employees without a schedule.
        Unpaid breaks are deducted only when the schedule defines them and the day's elapsed time exceeds the threshold.
      </Notice>
      <ErrorBox error={list.error} />
      <Card padded={false}>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty /> : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Hours</Th><Th>Working days</Th><Th>Unpaid break</Th><Th>Grace</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>{list.data.map((s) => (
              <Tr key={s.id}>
                <Td className="font-medium">{s.name}{s.notes && <div className="text-xs font-normal text-gray-500">{s.notes}</div>}</Td>
                <Td className="whitespace-nowrap">{s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)}</Td>
                <Td className="whitespace-nowrap">{DAYS.map((d, i) => <span key={d} className={s.working_days.includes(i + 1) ? 'mr-1 font-medium' : 'mr-1 text-gray-300'}>{d[0]}</span>)}</Td>
                <Td>{s.unpaid_break_minutes ? `${s.unpaid_break_minutes} min (after ${s.break_applies_after_minutes / 60}h)` : 'none'}</Td>
                <Td>{s.grace_minutes} min</Td>
                <Td>{s.is_active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
                <Td className="text-right"><Button size="sm" onClick={() => setF({ ...s })}>Edit</Button></Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={f !== null} title={f?.id ? 'Edit schedule' : 'New schedule'} onClose={() => setF(null)}
        footer={<><Button onClick={() => setF(null)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f?.name.trim()} onClick={() => void save()}>Save</Button></>}>
        {f && (
          <>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start"><Input type="time" value={f.start_time.slice(0, 5)} onChange={(e) => setF({ ...f, start_time: e.target.value })} /></Field>
              <Field label="End" hint="Earlier than start = overnight shift"><Input type="time" value={f.end_time.slice(0, 5)} onChange={(e) => setF({ ...f, end_time: e.target.value })} /></Field>
            </div>
            <Field label="Working days (others are rest days)">
              <div className="flex flex-wrap gap-3">{DAYS.map((d, i) => <Checkbox key={d} label={d} checked={f.working_days.includes(i + 1)} onChange={() => toggleDay(i + 1)} />)}</div>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Unpaid break (min)"><Input type="number" min={0} max={240} value={f.unpaid_break_minutes} onChange={(e) => setF({ ...f, unpaid_break_minutes: Number(e.target.value) })} /></Field>
              <Field label="Deduct after (min)"><Input type="number" min={0} value={f.break_applies_after_minutes} onChange={(e) => setF({ ...f, break_applies_after_minutes: Number(e.target.value) })} /></Field>
              <Field label="Grace (min)"><Input type="number" min={0} max={120} value={f.grace_minutes} onChange={(e) => setF({ ...f, grace_minutes: Number(e.target.value) })} /></Field>
            </div>
            <Field label="Notes"><Textarea value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            <Checkbox label="Active" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />
          </>
        )}
      </Modal>
    </div>
  );
}
