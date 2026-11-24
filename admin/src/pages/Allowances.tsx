import { useState } from 'react';
import { q, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { employeeLabel, useEmployeesLite } from '../lib/lookups';
import { dateOnly, php, todayPH } from '../lib/format';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Th, Tr } from '../components/ui';

interface Rule {
  id: string; employee_id: string; name: string; amount: number; frequency: 'per_day_worked' | 'per_week';
  taxable: boolean; requires_attendance: boolean; effective_from: string; effective_to: string | null; is_active: boolean;
  employees: { display_name: string; employee_code: string } | null;
}
type Form = Omit<Rule, 'id' | 'employees' | 'amount'> & { id?: string; amount: string };

export function Allowances() {
  const { run } = useFeedback();
  const employees = useEmployeesLite();
  const [showEnded, setShowEnded] = useState(false);
  const rows = useAsync(async () => {
    let query = supabase.from('allowance_rules').select('*, employees(display_name, employee_code)').order('created_at', { ascending: false });
    if (!showEnded) query = query.eq('is_active', true);
    return q<Rule[]>(query);
  }, [showEnded]);
  const [f, setF] = useState<Form | null>(null);

  async function save() {
    if (!f) return;
    const { id, ...rest } = f;
    const row = { ...rest, amount: Number(rest.amount), effective_to: rest.effective_to || null };
    const ok = await run(() => id ? q(supabase.from('allowance_rules').update(row).eq('id', id)) : q(supabase.from('allowance_rules').insert(row)), 'Allowance saved');
    if (ok) { setF(null); rows.reload(); }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Allowances" subtitle="Per-employee allowances added to weekly payroll."
        actions={<Button variant="primary" onClick={() => setF({ employee_id: '', name: '', amount: '', frequency: 'per_day_worked', taxable: false,
          requires_attendance: true, effective_from: todayPH(), effective_to: null, is_active: true })}>New allowance</Button>} />
      <Checkbox label="Show inactive" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
      <ErrorBox error={rows.error} />
      <Card padded={false}>
        {rows.loading && !rows.data ? <Spinner /> : !rows.data?.length ? <Empty>No allowances.</Empty> : (
          <Table>
            <thead><tr><Th>Employee</Th><Th>Allowance</Th><Th className="text-right">Amount</Th><Th>Frequency</Th><Th>Tax</Th><Th>Effective</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>{rows.data.map((r) => (
              <Tr key={r.id}>
                <Td>{r.employees?.display_name} <span className="text-xs text-gray-400">{r.employees?.employee_code}</span></Td>
                <Td className="font-medium">{r.name}</Td>
                <Td className="num text-right">{php(r.amount)}</Td>
                <Td>{r.frequency === 'per_day_worked' ? 'per day worked' : `per week${r.requires_attendance ? ' (if attended)' : ''}`}</Td>
                <Td>{r.taxable ? <Badge tone="amber">taxable</Badge> : <Badge>non-taxable</Badge>}</Td>
                <Td className="whitespace-nowrap text-xs">{dateOnly(r.effective_from)} → {r.effective_to ? dateOnly(r.effective_to) : 'open'}</Td>
                <Td>{r.is_active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
                <Td className="text-right"><Button size="sm" onClick={() => setF({ ...r, amount: String(r.amount) })}>Edit</Button></Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={f !== null} title={f?.id ? 'Edit allowance' : 'New allowance'} onClose={() => setF(null)}
        footer={<><Button onClick={() => setF(null)}>Cancel</Button><Button variant="primary" disabled={!f?.employee_id || !f.name.trim() || !(Number(f.amount) > 0)} onClick={() => void save()}>Save</Button></>}>
        {f && (
          <>
            <Field label="Employee">
              <Select value={f.employee_id} disabled={Boolean(f.id)} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
                <option value="">Select…</option>{employees.data?.map((e) => <option key={e.id} value={e.id}>{employeeLabel(e)}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Meal allowance" /></Field>
              <Field label="Amount (PHP)"><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
              <Field label="Frequency">
                <Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value as Form['frequency'] })}>
                  <option value="per_day_worked">Per day actually worked</option><option value="per_week">Fixed per week</option>
                </Select>
              </Field>
              <div className="flex flex-col justify-end gap-2 pb-1">
                <Checkbox label="Taxable" checked={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.checked })} />
                {f.frequency === 'per_week' && <Checkbox label="Only if attended that week" checked={f.requires_attendance} onChange={(e) => setF({ ...f, requires_attendance: e.target.checked })} />}
              </div>
              <Field label="Effective from"><Input type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
              <Field label="Effective to (optional)"><Input type="date" value={f.effective_to ?? ''} onChange={(e) => setF({ ...f, effective_to: e.target.value || null })} /></Field>
            </div>
            <Checkbox label="Active" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />
          </>
        )}
      </Modal>
    </div>
  );
}
