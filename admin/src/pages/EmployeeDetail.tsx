import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useSites } from '../lib/lookups';
import { useAuth } from '../lib/auth';
import { dateOnly, dateTime, hm, isoToLocalInput, localInputToIso, php, todayPH } from '../lib/format';
import type { EmployeeOverview, Schedule, WorkSessionRow } from '../lib/types';
import { useFeedback } from '../components/feedback';
import { CLASSIFICATIONS } from './Employees';
import {
  Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner,
  StatusBadge, Table, Tabs, Td, Textarea, Th, Tr,
} from '../components/ui';

interface Assignment { id: string; site_id: string; effective_from: string; effective_to: string | null; reason: string | null; sites: { name: string } | null }
interface Rate { id: string; daily_rate: number; effective_from: string; reason: string | null; created_at: string }
interface EmpSchedule { id: string; effective_from: string; schedules: { name: string } | null }
interface LeaveBalance { leave_type_id: string; leave_name: string; balance_days: number }
interface LeaveLedgerRow { id: string; entry_date: string; days: number; kind: string; note: string | null; leave_types: { name: string } | null }
interface LeaveType { id: string; code: string; name: string }

type Tab = 'profile' | 'site' | 'pay' | 'deductions' | 'leave' | 'attendance';

interface DeductionProfile {
  sss_enabled: boolean; sss_amount: number; philhealth_enabled: boolean; philhealth_amount: number;
  pagibig_enabled: boolean; pagibig_amount: number; tax_enabled: boolean; tax_amount: number;
  sss_loan_enabled: boolean; sss_loan_amount: number; additional_enabled: boolean; additional_amount: number;
  additional_label: string | null;
}
const emptyProfile: DeductionProfile = {
  sss_enabled: false, sss_amount: 0, philhealth_enabled: false, philhealth_amount: 0, pagibig_enabled: false, pagibig_amount: 0,
  tax_enabled: false, tax_amount: 0, sss_loan_enabled: false, sss_loan_amount: 0, additional_enabled: false, additional_amount: 0,
  additional_label: '',
};

export function EmployeeDetail() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState<Tab>('profile');
  const emp = useAsync(() => q<EmployeeOverview>(supabase.from('v_employee_overview').select('*').eq('id', id).single()), [id]);
  const e = emp.data;

  return (
    <div className="space-y-4">
      <div className="text-sm"><Link className="text-brand-700 hover:underline" to="/employees">← Employees</Link></div>
      <ErrorBox error={emp.error} />
      {emp.loading && !e && <Spinner />}
      {e && (
        <>
          <PageHeader
            title={<span>{e.display_name} <span className="ml-1 font-mono text-sm text-gray-500">{e.employee_code}</span></span>}
            subtitle={<span className="flex flex-wrap items-center gap-2">
              {e.is_active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}
              {e.current_site_name ? <span>{e.current_site_name}</span> : <Badge tone="amber">unassigned</Badge>}
              <span>· {e.current_daily_rate != null ? `${php(e.current_daily_rate)}/day` : 'no rate'}</span>
              {e.open_since && <Badge tone="blue">clocked in since {dateTime(e.open_since)}</Badge>}
            </span>} />
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[
            { id: 'profile', label: 'Profile' }, { id: 'site', label: 'Site & PIN' }, { id: 'pay', label: 'Rate & schedule' },
            { id: 'deductions', label: 'Deductions' },
            { id: 'leave', label: 'Leave' }, { id: 'attendance', label: 'Attendance' },
          ]} />
          {tab === 'profile' && <ProfileTab emp={e} onSaved={emp.reload} />}
          {tab === 'site' && <SiteTab emp={e} onChanged={emp.reload} />}
          {tab === 'pay' && <PayTab emp={e} onChanged={emp.reload} />}
          {tab === 'deductions' && <DeductionsTab emp={e} />}
          {tab === 'leave' && <LeaveTab emp={e} />}
          {tab === 'attendance' && <AttendanceTab emp={e} />}
        </>
      )}
    </div>
  );
}

function ProfileTab({ emp, onSaved }: { emp: EmployeeOverview; onSaved: () => void }) {
  const { run } = useFeedback();
  const [f, setF] = useState(() => ({ ...emp }));
  const [busy, setBusy] = useState(false);
  useEffect(() => setF({ ...emp }), [emp]);
  const set = (p: Partial<EmployeeOverview>) => setF((x) => ({ ...x, ...p }));
  const txt = (v: string | null) => (v && v.trim() ? v.trim() : null);

  async function save() {
    setBusy(true);
    const ok = await run(() => q(supabase.from('employees').update({
      first_name: f.first_name.trim(), middle_name: txt(f.middle_name), last_name: f.last_name.trim(),
      hire_date: f.hire_date || null, separation_date: f.separation_date || null, classification: f.classification,
      is_minimum_wage_earner: f.is_minimum_wage_earner, labor_standards_covered: f.labor_standards_covered,
      statutory_covered: f.statutory_covered, is_active: f.is_active, tin: txt(f.tin), sss_number: txt(f.sss_number),
      philhealth_number: txt(f.philhealth_number), pagibig_number: txt(f.pagibig_number), notes: txt(f.notes),
    }).eq('id', emp.id)), 'Saved');
    setBusy(false);
    if (ok) onSaved();
  }

  return (
    <Card title="Employee record" actions={<Button variant="primary" busy={busy} onClick={() => void save()}>Save changes</Button>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Employee code" hint="Automatic; cannot be edited"><Input value={f.employee_code} disabled readOnly /></Field>
        <Field label="Classification">
          <Select value={f.classification} onChange={(e) => set({ classification: e.target.value })}>
            {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
          </Select>
        </Field>
        <div className="flex items-end pb-2"><Checkbox label="Active" checked={f.is_active} onChange={(e) => set({ is_active: e.target.checked })} /></div>
        <Field label="First name"><Input value={f.first_name} onChange={(e) => set({ first_name: e.target.value })} /></Field>
        <Field label="Middle name"><Input value={f.middle_name ?? ''} onChange={(e) => set({ middle_name: e.target.value })} /></Field>
        <Field label="Last name"><Input value={f.last_name} onChange={(e) => set({ last_name: e.target.value })} /></Field>
        <Field label="Hire date"><Input type="date" value={f.hire_date ?? ''} onChange={(e) => set({ hire_date: e.target.value })} /></Field>
        <Field label="Separation date" hint="Final weekly payroll trues up monthly contributions"><Input type="date" value={f.separation_date ?? ''} onChange={(e) => set({ separation_date: e.target.value })} /></Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-4">
        <Checkbox label="Covered by OT / holiday / premium rules" checked={f.labor_standards_covered} onChange={(e) => set({ labor_standards_covered: e.target.checked })} />
        <Checkbox label="SSS / PhilHealth / Pag-IBIG apply" checked={f.statutory_covered} onChange={(e) => set({ statutory_covered: e.target.checked })} />
        <Checkbox label="Statutory minimum wage earner" checked={f.is_minimum_wage_earner} onChange={(e) => set({ is_minimum_wage_earner: e.target.checked })} />
      </div>
      <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-gray-500">Government identifiers (confidential)</h3>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="TIN"><Input value={f.tin ?? ''} onChange={(e) => set({ tin: e.target.value })} autoComplete="off" /></Field>
        <Field label="SSS no."><Input value={f.sss_number ?? ''} onChange={(e) => set({ sss_number: e.target.value })} autoComplete="off" /></Field>
        <Field label="PhilHealth no."><Input value={f.philhealth_number ?? ''} onChange={(e) => set({ philhealth_number: e.target.value })} autoComplete="off" /></Field>
        <Field label="Pag-IBIG MID"><Input value={f.pagibig_number ?? ''} onChange={(e) => set({ pagibig_number: e.target.value })} autoComplete="off" /></Field>
      </div>
      <Field label="Notes" className="mt-4"><Textarea value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></Field>
      {emp.open_session_id && !f.is_active && <div className="mt-3"><Notice tone="amber">This employee is clocked in. Close the open session before deactivating.</Notice></div>}
    </Card>
  );
}

function SiteTab({ emp, onChanged }: { emp: EmployeeOverview; onChanged: () => void }) {
  const { run, confirm, prompt } = useFeedback();
  const sites = useSites();
  const history = useAsync(() => q<Assignment[]>(supabase.from('employee_site_assignments')
    .select('id, site_id, effective_from, effective_to, reason, sites(name)').eq('employee_id', emp.id).order('effective_from', { ascending: false })), [emp.id]);
  const [transfer, setTransfer] = useState<{ site_id: string; from: string; reason: string; permit: boolean } | null>(null);
  const [newPin, setNewPin] = useState<string | null>(null);
  const [manualPin, setManualPin] = useState<string | null>(null);

  async function doTransfer() {
    if (!transfer) return;
    const ok = await run(() => rpc('employee_assign_site', {
      p_employee_id: emp.id, p_site_id: transfer.site_id, p_effective_from: localInputToIso(transfer.from),
      p_reason: transfer.reason || null, p_permit_origin_close: transfer.permit,
    }), 'Assignment saved');
    if (ok) { setTransfer(null); history.reload(); onChanged(); }
  }

  async function endAssignment() {
    const reason = await prompt({ title: 'End current assignment', label: 'Reason', minLength: 3, multiline: false,
      message: 'The employee will leave the site roster now and can no longer clock in until reassigned.' });
    if (reason === null) return;
    if (await run(() => rpc('employee_end_assignment', { p_employee_id: emp.id, p_reason: reason }), 'Assignment ended')) {
      history.reload(); onChanged();
    }
  }

  async function generatePin() {
    if (emp.has_pin && !(await confirm({ title: 'Reset PIN?', message: 'The current PIN stops working immediately.', confirmText: 'Generate new PIN' }))) return;
    try {
      const pin = await rpc<string>('generate_employee_pin', { p_employee_id: emp.id });
      setNewPin(pin);
      onChanged();
    } catch (e) {
      await run(() => Promise.reject(e));
    }
  }

  async function saveManualPin() {
    if (!manualPin) return;
    if (await run(() => rpc('set_employee_pin', { p_employee_id: emp.id, p_pin: manualPin }), 'PIN set')) {
      setManualPin(null); onChanged();
    }
  }

  const locked = emp.pin_locked_until && new Date(emp.pin_locked_until) > new Date();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Site assignment" actions={<>
        <Button size="sm" variant="primary" onClick={() => setTransfer({ site_id: '', from: isoToLocalInput(new Date().toISOString()), reason: '', permit: false })}>
          {emp.current_site_id ? 'Transfer' : 'Assign'}
        </Button>
        {emp.current_site_id && <Button size="sm" onClick={() => void endAssignment()}>End</Button>}
      </>}>
        <p className="mb-3 text-sm">Current: <b>{emp.current_site_name ?? 'unassigned'}</b>{emp.assigned_since && <> since {dateTime(emp.assigned_since)}</>}</p>
        {history.loading && !history.data ? <Spinner /> : !history.data?.length ? <Empty>No assignment history.</Empty> : (
          <Table>
            <thead><tr><Th>Site</Th><Th>From</Th><Th>To</Th><Th>Reason</Th></tr></thead>
            <tbody>{history.data.map((a) => (
              <Tr key={a.id}><Td>{a.sites?.name}</Td><Td className="whitespace-nowrap">{dateTime(a.effective_from)}</Td>
                <Td className="whitespace-nowrap">{a.effective_to ? dateTime(a.effective_to) : <Badge tone="green">current</Badge>}</Td><Td className="text-xs">{a.reason}</Td></Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      <Card title="Attendance PIN">
        <div className="space-y-3 text-sm">
          <div>Status: {!emp.has_pin ? <Badge tone="amber">not set</Badge> : locked ? <Badge tone="red">locked until {dateTime(emp.pin_locked_until)}</Badge> : <Badge tone="green">set {emp.pin_set_at && `on ${dateTime(emp.pin_set_at)}`}</Badge>}</div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void generatePin()}>{emp.has_pin ? 'Reset with new random PIN' : 'Generate PIN'}</Button>
            <Button onClick={() => setManualPin('')}>Set PIN manually</Button>
            {locked && <Button onClick={() => void run(() => rpc('unlock_employee_pin', { p_employee_id: emp.id }), 'PIN unlocked').then((ok) => ok && onChanged())}>Unlock</Button>}
          </div>
          <p className="text-xs text-gray-500">PINs are stored only as secure hashes. Hand a new PIN to the employee privately; it cannot be viewed again. Five wrong attempts lock the PIN temporarily.</p>
        </div>
      </Card>

      <Modal open={transfer !== null} title={emp.current_site_id ? 'Transfer employee' : 'Assign to site'} onClose={() => setTransfer(null)}
        footer={<><Button onClick={() => setTransfer(null)}>Cancel</Button><Button variant="primary" disabled={!transfer?.site_id || !transfer.from} onClick={() => void doTransfer()}>Save</Button></>}>
        {transfer && (
          <>
            <Field label="New site">
              <Select value={transfer.site_id} onChange={(e) => setTransfer({ ...transfer, site_id: e.target.value })}>
                <option value="">Select…</option>
                {sites.data?.filter((s) => s.is_active && s.id !== emp.current_site_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Effective from (Philippine time)" hint="The roster changes at this time. Payroll uses the assignment for each work date.">
              <Input type="datetime-local" value={transfer.from} onChange={(e) => setTransfer({ ...transfer, from: e.target.value })} />
            </Field>
            <Field label="Reason"><Input value={transfer.reason} onChange={(e) => setTransfer({ ...transfer, reason: e.target.value })} /></Field>
            {emp.open_session_id && (
              <Notice tone="amber">
                The employee is clocked in at {emp.current_site_name}.
                <div className="mt-2"><Checkbox label="Allow them to clock out at the original site" checked={transfer.permit} onChange={(e) => setTransfer({ ...transfer, permit: e.target.checked })} /></div>
              </Notice>
            )}
          </>
        )}
      </Modal>

      <Modal open={newPin !== null} title="New PIN — hand over privately" onClose={() => setNewPin(null)}
        footer={<Button variant="primary" onClick={() => setNewPin(null)}>I have handed it over</Button>}>
        <div className="text-center font-mono text-4xl tracking-[0.4em]">{newPin}</div>
        <Notice tone="amber">This PIN will not be shown again. Do not write it on shared notes or send it in group chats.</Notice>
      </Modal>

      <Modal open={manualPin !== null} title="Set PIN" onClose={() => setManualPin(null)}
        footer={<><Button onClick={() => setManualPin(null)}>Cancel</Button><Button variant="primary" disabled={!/^\d{6}$/.test(manualPin ?? '')} onClick={() => void saveManualPin()}>Set PIN</Button></>}>
        <Field label="6-digit PIN" hint="Avoid repeated or sequential digits. Let the employee type it if possible.">
          <Input type="password" inputMode="numeric" maxLength={6} autoComplete="off" value={manualPin ?? ''} onChange={(e) => setManualPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </Modal>
    </div>
  );
}

function PayTab({ emp, onChanged }: { emp: EmployeeOverview; onChanged: () => void }) {
  const { run } = useFeedback();
  const rates = useAsync(() => q<Rate[]>(supabase.from('employee_rates').select('*').eq('employee_id', emp.id).order('effective_from', { ascending: false })), [emp.id]);
  const scheds = useAsync(() => q<EmpSchedule[]>(supabase.from('employee_schedules').select('id, effective_from, schedules(name)').eq('employee_id', emp.id).order('effective_from', { ascending: false })), [emp.id]);
  const allScheds = useAsync(() => q<Schedule[]>(supabase.from('schedules').select('*').eq('is_active', true).order('name')), []);
  const [rate, setRate] = useState<{ daily_rate: string; effective_from: string; reason: string } | null>(null);
  const [sched, setSched] = useState<{ schedule_id: string; effective_from: string } | null>(null);

  async function addRate() {
    if (!rate) return;
    const ok = await run(() => q(supabase.from('employee_rates').insert({ employee_id: emp.id, daily_rate: Number(rate.daily_rate), effective_from: rate.effective_from, reason: rate.reason || null })), 'Rate added');
    if (ok) { setRate(null); rates.reload(); onChanged(); }
  }
  async function addSched() {
    if (!sched) return;
    const ok = await run(() => q(supabase.from('employee_schedules').insert({ employee_id: emp.id, ...sched })), 'Schedule assigned');
    if (ok) { setSched(null); scheds.reload(); onChanged(); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Daily rate history" actions={<Button size="sm" variant="primary" onClick={() => setRate({ daily_rate: '', effective_from: todayPH(), reason: '' })}>Add rate</Button>}>
        <p className="mb-3 text-xs text-gray-500">Hourly rate = daily ÷ 8. A change applies from its date; finalized payroll keeps its original rate.</p>
        {rates.loading && !rates.data ? <Spinner /> : !rates.data?.length ? <Empty>No rate yet — payroll will flag this employee.</Empty> : (
          <Table>
            <thead><tr><Th>Effective</Th><Th className="text-right">Daily</Th><Th className="text-right">Hourly</Th><Th>Reason</Th></tr></thead>
            <tbody>{rates.data.map((r) => (
              <Tr key={r.id}><Td>{dateOnly(r.effective_from)}</Td><Td className="num text-right">{php(r.daily_rate)}</Td>
                <Td className="num text-right">{php(Number(r.daily_rate) / 8)}</Td><Td className="text-xs">{r.reason}</Td></Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Card title="Schedule history" actions={<Button size="sm" variant="primary" onClick={() => setSched({ schedule_id: '', effective_from: todayPH() })}>Assign schedule</Button>}>
        <p className="mb-3 text-xs text-gray-500">Schedules define working days, rest days, breaks and lateness. <Link className="underline" to="/schedules">Manage schedules</Link></p>
        {scheds.loading && !scheds.data ? <Spinner /> : !scheds.data?.length ? <Empty>No schedule yet — payroll will flag this employee.</Empty> : (
          <Table>
            <thead><tr><Th>Effective</Th><Th>Schedule</Th></tr></thead>
            <tbody>{scheds.data.map((s) => <Tr key={s.id}><Td>{dateOnly(s.effective_from)}</Td><Td>{s.schedules?.name}</Td></Tr>)}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={rate !== null} title="Add daily rate" onClose={() => setRate(null)}
        footer={<><Button onClick={() => setRate(null)}>Cancel</Button><Button variant="primary" disabled={!rate || !(Number(rate.daily_rate) > 0)} onClick={() => void addRate()}>Save</Button></>}>
        {rate && (
          <>
            <Field label="Daily rate (PHP)"><Input inputMode="decimal" value={rate.daily_rate} onChange={(e) => setRate({ ...rate, daily_rate: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
            <Field label="Or enter a monthly salary" hint="Converted to a daily rate as salary ÷ 26, rounded to the peso.">
              <Input inputMode="decimal" placeholder="e.g. 15600" onChange={(e) => {
                const m = Number(e.target.value.replace(/[^0-9.]/g, ''));
                if (m > 0) setRate({ ...rate, daily_rate: String(Math.round(m / 26)), reason: rate.reason || `Monthly salary ₱${m} ÷ 26` });
              }} />
            </Field>
            <Field label="Effective from"><Input type="date" value={rate.effective_from} onChange={(e) => setRate({ ...rate, effective_from: e.target.value })} /></Field>
            <Field label="Reason"><Input value={rate.reason} onChange={(e) => setRate({ ...rate, reason: e.target.value })} placeholder="e.g. Wage order, promotion" /></Field>
          </>
        )}
      </Modal>
      <Modal open={sched !== null} title="Assign schedule" onClose={() => setSched(null)}
        footer={<><Button onClick={() => setSched(null)}>Cancel</Button><Button variant="primary" disabled={!sched?.schedule_id} onClick={() => void addSched()}>Save</Button></>}>
        {sched && (
          <>
            <Field label="Schedule">
              <Select value={sched.schedule_id} onChange={(e) => setSched({ ...sched, schedule_id: e.target.value })}>
                <option value="">Select…</option>
                {allScheds.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Effective from"><Input type="date" value={sched.effective_from} onChange={(e) => setSched({ ...sched, effective_from: e.target.value })} /></Field>
          </>
        )}
      </Modal>
    </div>
  );
}

function DeductionsTab({ emp }: { emp: EmployeeOverview }) {
  const { run } = useFeedback();
  const { profile } = useAuth();
  const saved = useAsync(() => q<DeductionProfile | null>(supabase.from('employee_deduction_profiles').select('*').eq('employee_id', emp.id).maybeSingle()), [emp.id]);
  const [f, setF] = useState<DeductionProfile>(emptyProfile);
  useEffect(() => { if (saved.data) setF({ ...emptyProfile, ...saved.data }); }, [saved.data]);

  const rows: { key: 'sss' | 'philhealth' | 'pagibig' | 'tax' | 'sss_loan' | 'additional'; label: string }[] = [
    { key: 'sss', label: 'SSS' }, { key: 'philhealth', label: 'PhilHealth' }, { key: 'pagibig', label: 'Pag-IBIG' },
    { key: 'tax', label: 'Withholding tax' }, { key: 'sss_loan', label: 'SSS loan' }, { key: 'additional', label: 'Additional deduction' },
  ];
  const total = rows.reduce((s, r) => s + (f[`${r.key}_enabled`] ? Number(f[`${r.key}_amount`]) || 0 : 0), 0);

  async function save() {
    const payload = { ...f, employee_id: emp.id, updated_by: profile?.id, additional_label: f.additional_label?.trim() || null };
    for (const r of rows) (payload as Record<string, unknown>)[`${r.key}_amount`] = Math.round((Number(f[`${r.key}_amount`]) || 0) * 100) / 100;
    if (await run(() => q(supabase.from('employee_deduction_profiles').upsert(payload, { onConflict: 'employee_id' })), 'Deductions saved — recalculate draft payroll to apply')) saved.reload();
  }

  return (
    <Card title="Deductions per weekly payroll" actions={<Button variant="primary" onClick={() => void save()}>Save deductions</Button>}>
      <p className="mb-3 text-xs text-gray-500">
        Construction computation: only enabled amounts are deducted each payroll, in this order, then cash advance installments.
        A deduction that does not fit in the gross pay is reduced (net never goes below zero) and flagged.
      </p>
      <ErrorBox error={saved.error && /employee_deduction_profiles/.test(saved.error)
        ? 'Deductions are not set up in the database yet. Run migration 20261117001000_construction_payroll.sql in the Supabase SQL Editor.'
        : saved.error} />
      {saved.loading && saved.data === undefined ? <Spinner /> : saved.error ? null : (
        <Table>
          <thead><tr><Th>Enabled</Th><Th>Deduction</Th><Th className="text-right">Amount per payroll (₱)</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <Tr key={r.key}>
              <Td><Checkbox label="" checked={f[`${r.key}_enabled`]} onChange={(e) => setF({ ...f, [`${r.key}_enabled`]: e.target.checked })} /></Td>
              <Td>{r.key === 'additional'
                ? <Input value={f.additional_label ?? ''} placeholder="Additional deduction (label)" onChange={(e) => setF({ ...f, additional_label: e.target.value })} />
                : r.label}</Td>
              <Td className="text-right"><Input className="ml-auto w-36 text-right" type="number" min={0} step="0.01" value={String(f[`${r.key}_amount`])}
                disabled={!f[`${r.key}_enabled`]} onChange={(e) => setF({ ...f, [`${r.key}_amount`]: Number(e.target.value) })} /></Td>
            </Tr>
          ))}
            <Tr><Td /><Td className="font-semibold">Total per payroll</Td><Td className="num text-right font-semibold">{php(total)}</Td></Tr>
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function LeaveTab({ emp }: { emp: EmployeeOverview }) {
  const { run } = useFeedback();
  const { profile } = useAuth();
  const balances = useAsync(() => q<LeaveBalance[]>(supabase.from('v_leave_balances').select('*').eq('employee_id', emp.id)), [emp.id]);
  const ledger = useAsync(() => q<LeaveLedgerRow[]>(supabase.from('leave_ledger').select('id, entry_date, days, kind, note, leave_types(name)')
    .eq('employee_id', emp.id).order('created_at', { ascending: false }).limit(100)), [emp.id]);
  const types = useAsync(() => q<LeaveType[]>(supabase.from('leave_types').select('id, code, name').eq('requires_balance', true).eq('is_active', true)), []);
  const [grant, setGrant] = useState<{ leave_type_id: string; days: string; kind: string; note: string } | null>(null);

  async function save() {
    if (!grant || !profile) return;
    const ok = await run(() => q(supabase.from('leave_ledger').insert({
      employee_id: emp.id, leave_type_id: grant.leave_type_id, days: Number(grant.days), kind: grant.kind,
      note: grant.note || null, created_by: profile.id,
    })), 'Leave ledger updated');
    if (ok) { setGrant(null); balances.reload(); ledger.reload(); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Balances" actions={<Button size="sm" variant="primary" onClick={() => setGrant({ leave_type_id: types.data?.[0]?.id ?? '', days: '5', kind: 'grant', note: '' })}>Grant / adjust</Button>}>
        {!balances.data?.length ? <Empty>No leave balances.</Empty> : (
          <ul className="space-y-2 text-sm">{balances.data.map((b) => (
            <li key={b.leave_type_id} className="flex justify-between"><span>{b.leave_name}</span><b className="num">{Number(b.balance_days)} day(s)</b></li>
          ))}</ul>
        )}
        <p className="mt-3 text-xs text-gray-500">Record leave on the <Link className="underline" to="/leave">Leave</Link> page.</p>
      </Card>
      <Card title="Ledger" className="lg:col-span-2" padded={false}>
        {!ledger.data?.length ? <Empty>No entries.</Empty> : (
          <Table>
            <thead><tr><Th>Date</Th><Th>Type</Th><Th>Kind</Th><Th className="text-right">Days</Th><Th>Note</Th></tr></thead>
            <tbody>{ledger.data.map((l) => (
              <Tr key={l.id}><Td>{dateOnly(l.entry_date)}</Td><Td>{l.leave_types?.name}</Td><Td><Badge>{l.kind}</Badge></Td>
                <Td className={`num text-right ${Number(l.days) < 0 ? 'text-red-700' : 'text-green-700'}`}>{Number(l.days) > 0 ? '+' : ''}{Number(l.days)}</Td><Td className="text-xs">{l.note}</Td></Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={grant !== null} title="Grant or adjust leave" onClose={() => setGrant(null)}
        footer={<><Button onClick={() => setGrant(null)}>Cancel</Button><Button variant="primary"
          disabled={!grant?.leave_type_id || !Number(grant.days) || (grant.kind !== 'grant' && grant.note.trim().length < 3)} onClick={() => void save()}>Save</Button></>}>
        {grant && (
          <>
            <Field label="Leave type">
              <Select value={grant.leave_type_id} onChange={(e) => setGrant({ ...grant, leave_type_id: e.target.value })}>
                {types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="Kind">
              <Select value={grant.kind} onChange={(e) => setGrant({ ...grant, kind: e.target.value })}>
                <option value="grant">Grant (annual entitlement)</option>
                <option value="carryover">Carryover</option>
                <option value="adjustment">Adjustment (+/-)</option>
                <option value="expiry">Expiry (negative)</option>
              </Select>
            </Field>
            <Field label="Days" hint="Use a negative number to reduce the balance"><Input inputMode="decimal" value={grant.days} onChange={(e) => setGrant({ ...grant, days: e.target.value })} /></Field>
            <Field label="Note" hint={grant.kind !== 'grant' ? 'Required' : undefined}><Input value={grant.note} onChange={(e) => setGrant({ ...grant, note: e.target.value })} /></Field>
          </>
        )}
      </Modal>
    </div>
  );
}

function AttendanceTab({ emp }: { emp: EmployeeOverview }) {
  const rows = useAsync(() => q<WorkSessionRow[]>(supabase.from('v_work_sessions').select('*').eq('employee_id', emp.id)
    .order('clock_in_at', { ascending: false }).limit(60)), [emp.id]);
  return (
    <Card title="Recent attendance" padded={false} actions={<Link className="text-sm text-brand-700 underline" to={`/attendance?employee=${emp.id}`}>Open in attendance review</Link>}>
      <ErrorBox error={rows.error} />
      {rows.loading && !rows.data ? <Spinner /> : !rows.data?.length ? <Empty>No attendance yet.</Empty> : (
        <Table>
          <thead><tr><Th>Work date</Th><Th>Site</Th><Th>In</Th><Th>Out</Th><Th>Elapsed</Th><Th>Status</Th><Th>Flags</Th></tr></thead>
          <tbody>{rows.data.map((w) => (
            <Tr key={w.id}><Td>{dateOnly(w.work_date)}</Td><Td>{w.site_name}</Td><Td>{dateTime(w.clock_in_at)}</Td><Td>{dateTime(w.clock_out_at)}</Td>
              <Td>{hm(w.elapsed_minutes)}</Td><Td><StatusBadge status={w.status} /></Td>
              <Td>{w.review_flags.map((f) => <Badge key={f} tone={w.reviewed_at ? 'gray' : 'amber'}>{f.replace('_', ' ')}</Badge>)}</Td></Tr>
          ))}</tbody>
        </Table>
      )}
    </Card>
  );
}
