import { useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { employeeLabel, useEmployeesLite } from '../lib/lookups';
import { dateOnly, dateTime, php, todayPH } from '../lib/format';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td, Textarea, Th, Tr } from '../components/ui';

interface AdvanceRow {
  id: string; employee_id: string; employee_name: string; employee_code: string; principal: number; released_on: string;
  installment_amount: number; first_deduction_date: string; status: 'active' | 'completed' | 'cancelled'; reason: string | null;
  balance: number; repaid: number;
}
interface LedgerRow { id: string; entry_date: string; kind: string; amount: number; note: string | null; created_at: string; payroll_run_id: string | null }

export function Advances() {
  const { run } = useFeedback();
  const [showClosed, setShowClosed] = useState(false);
  const rows = useAsync(async () => {
    let query = supabase.from('v_advance_balances').select('*').order('released_on', { ascending: false });
    if (!showClosed) query = query.eq('status', 'active');
    return q<AdvanceRow[]>(query);
  }, [showClosed]);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<AdvanceRow | null>(null);

  async function changeInstallment(a: AdvanceRow, value: string) {
    if (await run(() => q(supabase.from('cash_advances').update({ installment_amount: Number(value) }).eq('id', a.id)), 'Installment updated')) rows.reload();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Cash advances" subtitle="Installments are deducted in weekly payroll and posted to the ledger only when payroll is finalized."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Record advance</Button>} />
      <Checkbox label="Show completed / cancelled" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
      <ErrorBox error={rows.error} />
      <Card padded={false}>
        {rows.loading && !rows.data ? <Spinner /> : !rows.data?.length ? <Empty>No cash advances.</Empty> : (
          <Table>
            <thead><tr><Th>Employee</Th><Th>Released</Th><Th className="text-right">Principal</Th><Th className="text-right">Installment</Th><Th className="text-right">Repaid</Th><Th className="text-right">Balance</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>{rows.data.map((a) => (
              <Tr key={a.id} onClick={() => setSelected(a)}>
                <Td>{a.employee_name} <span className="text-xs text-gray-400">{a.employee_code}</span></Td>
                <Td className="whitespace-nowrap">{dateOnly(a.released_on)}</Td>
                <Td className="num text-right">{php(a.principal)}</Td>
                <Td className="num text-right">{php(a.installment_amount)}<div className="text-xs text-gray-400">from {dateOnly(a.first_deduction_date)}</div></Td>
                <Td className="num text-right">{php(a.repaid)}</Td>
                <Td className="num text-right font-semibold">{php(a.balance)}</Td>
                <Td><StatusBadge status={a.status} /></Td>
                <Td className="text-right text-xs text-brand-700">Ledger →</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      {creating && <NewAdvance onClose={() => setCreating(false)} onSaved={() => { setCreating(false); rows.reload(); }} />}
      {selected && <AdvanceLedger advance={selected} onClose={() => setSelected(null)} onChanged={() => { setSelected(null); rows.reload(); }}
        onInstallment={(v) => void changeInstallment(selected, v)} />}
    </div>
  );
}

function NewAdvance({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { run } = useFeedback();
  const { profile } = useAuth();
  const employees = useEmployeesLite();
  const today = todayPH();
  const [f, setF] = useState({ employee_id: '', principal: '', installment_amount: '', released_on: today, first_deduction_date: today, reason: '' });

  async function save() {
    if (!profile) return;
    const ok = await run(() => q(supabase.from('cash_advances').insert({
      employee_id: f.employee_id, principal: Number(f.principal), installment_amount: Number(f.installment_amount),
      released_on: f.released_on, first_deduction_date: f.first_deduction_date, reason: f.reason || null,
      authorized_by: profile.id, created_by: profile.id,
    })), 'Advance recorded');
    if (ok) onSaved();
  }
  const n = Number(f.principal) > 0 && Number(f.installment_amount) > 0 ? Math.ceil(Number(f.principal) / Number(f.installment_amount)) : null;

  return (
    <Modal open title="Record cash advance" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.employee_id || !(Number(f.principal) > 0) || !(Number(f.installment_amount) > 0)} onClick={() => void save()}>Save</Button></>}>
      <Field label="Employee">
        <Select value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
          <option value="">Select…</option>{employees.data?.map((e) => <option key={e.id} value={e.id}>{employeeLabel(e)}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Principal (PHP)"><Input inputMode="decimal" value={f.principal} onChange={(e) => setF({ ...f, principal: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
        <Field label="Weekly installment (PHP)" hint={n ? `About ${n} payroll(s)` : undefined}><Input inputMode="decimal" value={f.installment_amount} onChange={(e) => setF({ ...f, installment_amount: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
        <Field label="Released on"><Input type="date" value={f.released_on} onChange={(e) => setF({ ...f, released_on: e.target.value })} /></Field>
        <Field label="First deduction (payday on/after)"><Input type="date" value={f.first_deduction_date} onChange={(e) => setF({ ...f, first_deduction_date: e.target.value })} /></Field>
      </div>
      <Field label="Reason / authorization note"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <Notice>You are recorded as the authorizing user. Deductions never exceed the outstanding balance; if net pay is insufficient the installment is deferred.</Notice>
    </Modal>
  );
}

function AdvanceLedger({ advance, onClose, onChanged, onInstallment }:
  { advance: AdvanceRow; onClose: () => void; onChanged: () => void; onInstallment: (v: string) => void }) {
  const { run } = useFeedback();
  const ledger = useAsync(() => q<LedgerRow[]>(supabase.from('advance_ledger').select('*').eq('advance_id', advance.id).order('created_at')), [advance.id]);
  const [adj, setAdj] = useState<{ amount: string; note: string } | null>(null);
  const [inst, setInst] = useState(String(advance.installment_amount));

  async function saveAdj() {
    if (!adj) return;
    if (await run(() => rpc('advance_adjust', { p_advance_id: advance.id, p_amount: Number(adj.amount), p_note: adj.note }), 'Adjustment recorded')) onChanged();
  }

  return (
    <Modal open wide title={`Advance · ${advance.employee_name}`} onClose={onClose}
      footer={<><Button onClick={() => setAdj({ amount: '', note: '' })}>Manual adjustment</Button><Button variant="primary" onClick={onClose}>Close</Button></>}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="text-sm">Balance <b className="num">{php(advance.balance)}</b> of {php(advance.principal)}</div>
        {advance.status === 'active' && (
          <div className="ml-auto flex items-end gap-2">
            <Field label="Installment"><Input className="w-32" inputMode="decimal" value={inst} onChange={(e) => setInst(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
            <Button disabled={!(Number(inst) > 0) || Number(inst) === Number(advance.installment_amount)} onClick={() => onInstallment(inst)}>Update</Button>
          </div>
        )}
      </div>
      {ledger.loading && !ledger.data ? <Spinner /> : (
        <Table>
          <thead><tr><Th>Date</Th><Th>Kind</Th><Th className="text-right">Amount</Th><Th>Note</Th><Th>Recorded</Th></tr></thead>
          <tbody>{ledger.data?.map((l) => (
            <Tr key={l.id}><Td>{dateOnly(l.entry_date)}</Td><Td><Badge>{l.kind}</Badge></Td>
              <Td className={`num text-right ${Number(l.amount) < 0 ? 'text-green-700' : ''}`}>{php(l.amount)}</Td>
              <Td className="text-xs">{l.note}</Td><Td className="text-xs text-gray-500">{dateTime(l.created_at)}</Td></Tr>
          ))}</tbody>
        </Table>
      )}
      {adj && (
        <div className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount" hint="Negative reduces the balance (e.g. cash repayment); positive increases it"><Input value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></Field>
            <Field label="Reason (required)"><Input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2"><Button onClick={() => setAdj(null)}>Cancel</Button>
            <Button variant="primary" disabled={!Number(adj.amount) || adj.note.trim().length < 3} onClick={() => void saveAdj()}>Record</Button></div>
        </div>
      )}
    </Modal>
  );
}
