import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync, useDebounced } from '../lib/hooks';
import { useSites } from '../lib/lookups';
import { php, todayPH } from '../lib/format';
import type { EmployeeOverview, Schedule } from '../lib/types';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Th, Tr } from '../components/ui';

export const CLASSIFICATIONS = ['regular', 'probationary', 'project', 'seasonal', 'casual', 'fixed_term'];

export function Employees() {
  const navigate = useNavigate();
  const sites = useSites();
  const [search, setSearch] = useState('');
  const [siteId, setSiteId] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(search.trim());

  const list = useAsync(async () => {
    let query = supabase.from('v_employee_overview').select('*').order('last_name').order('first_name').limit(500);
    if (!showInactive) query = query.eq('is_active', true);
    if (siteId === 'none') query = query.is('current_site_id', null);
    else if (siteId) query = query.eq('current_site_id', siteId);
    if (term) {
      const t = term.replace(/[%,()]/g, ' ');
      query = query.or(`display_name.ilike.%${t}%,employee_code.ilike.%${t}%`);
    }
    return q<EmployeeOverview[]>(query);
  }, [term, siteId, showInactive]);

  return (
    <div className="space-y-4">
      <PageHeader title="Employees" subtitle="Records, site assignments, daily rates, schedules and PINs."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>New employee</Button>} />
      <div className="filter-bar">
        <Field label="Search" className="w-64"><Input placeholder="Name or code" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
        <Field label="Site" className="w-56">
          <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">All sites</option>
            <option value="none">Unassigned</option>
            {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <div className="pb-2"><Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /></div>
      </div>
      <ErrorBox error={list.error} />
      <Card padded={false}>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty>No employees match.</Empty> : (
          <Table>
            <thead><tr><Th>Code</Th><Th>Name</Th><Th>Site</Th><Th className="text-right">Daily rate</Th><Th>Schedule</Th><Th>PIN</Th><Th>Now</Th><Th>Status</Th></tr></thead>
            <tbody>
              {list.data.map((e) => (
                <Tr key={e.id} onClick={() => navigate(`/employees/${e.id}`)}>
                  <Td className="font-mono text-xs">{e.employee_code}</Td>
                  <Td className="font-medium">{e.display_name}</Td>
                  <Td>{e.current_site_name ?? <Badge tone="amber">unassigned</Badge>}</Td>
                  <Td className="num text-right">{e.current_daily_rate != null ? php(e.current_daily_rate) : <Badge tone="red">none</Badge>}</Td>
                  <Td className="text-xs">{e.current_schedule_name ?? <Badge tone="amber">none</Badge>}</Td>
                  <Td>{!e.has_pin ? <Badge tone="amber">not set</Badge> : e.pin_locked_until && new Date(e.pin_locked_until) > new Date() ? <Badge tone="red">locked</Badge> : <Badge tone="green">set</Badge>}</Td>
                  <Td>{e.open_session_id ? <Badge tone="blue">clocked in</Badge> : ''}</Td>
                  <Td>{e.is_active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && <NewEmployee onClose={() => setCreating(false)} onCreated={(id) => navigate(`/employees/${id}`)} />}
    </div>
  );
}

function NewEmployee({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { run, toast } = useFeedback();
  const sites = useSites();
  const schedules = useAsync(() => q<Schedule[]>(supabase.from('schedules').select('*').eq('is_active', true).order('name')), []);
  const today = todayPH();
  const [f, setF] = useState({
    first_name: '', middle_name: '', last_name: '', hire_date: today, classification: 'regular',
    is_minimum_wage_earner: false, labor_standards_covered: true, statutory_covered: true,
    site_id: '', assign_from: today, daily_rate: '', rate_from: today, schedule_id: '', schedule_from: today,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const valid = useMemo(() => Boolean(f.first_name.trim() && f.last_name.trim()), [f]);

  async function create() {
    setBusy(true);
    let id: string | null = null;
    const ok = await run(async () => {
      // employee_code is generated by the database (EMP-0001, ...)
      const row = await q<{ id: string }>(supabase.from('employees').insert({
        first_name: f.first_name.trim(), middle_name: f.middle_name.trim() || null,
        last_name: f.last_name.trim(), hire_date: f.hire_date || null, classification: f.classification,
        is_minimum_wage_earner: f.is_minimum_wage_earner, labor_standards_covered: f.labor_standards_covered,
        statutory_covered: f.statutory_covered,
      }).select('id').single());
      id = row.id;
      if (f.daily_rate) await q(supabase.from('employee_rates').insert({ employee_id: id, daily_rate: Number(f.daily_rate), effective_from: f.rate_from, reason: 'Starting rate' }));
      if (f.schedule_id) await q(supabase.from('employee_schedules').insert({ employee_id: id, schedule_id: f.schedule_id, effective_from: f.schedule_from }));
      if (f.site_id) await rpc('employee_assign_site', { p_employee_id: id, p_site_id: f.site_id, p_effective_from: `${f.assign_from}T00:00:00+08:00`, p_reason: 'Initial assignment' });
    }, 'Employee created');
    setBusy(false);
    if (id) {
      if (!ok) toast('The employee was created, but some details failed to save. Complete them on the employee page.', 'error');
      onCreated(id);
    }
  }

  return (
    <Modal open title="New employee" wide onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!valid} onClick={() => void create()}>Create</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="First name"><Input value={f.first_name} onChange={(e) => set({ first_name: e.target.value })} /></Field>
        <Field label="Middle name"><Input value={f.middle_name} onChange={(e) => set({ middle_name: e.target.value })} /></Field>
        <Field label="Last name"><Input value={f.last_name} onChange={(e) => set({ last_name: e.target.value })} /></Field>
        <Field label="Hire date"><Input type="date" value={f.hire_date} onChange={(e) => set({ hire_date: e.target.value })} /></Field>
        <Field label="Classification">
          <Select value={f.classification} onChange={(e) => set({ classification: e.target.value })}>
            {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
          </Select>
        </Field>
      </div>
      <p className="text-xs text-gray-500">The employee code (EMP-0001, EMP-0002, …) is assigned automatically and cannot be changed. It appears on the roster to tell identical names apart.</p>
      <div className="flex flex-wrap gap-4">
        <Checkbox label="Covered by OT / holiday / premium rules" checked={f.labor_standards_covered} onChange={(e) => set({ labor_standards_covered: e.target.checked })} />
        <Checkbox label="SSS / PhilHealth / Pag-IBIG apply" checked={f.statutory_covered} onChange={(e) => set({ statutory_covered: e.target.checked })} />
        <Checkbox label="Statutory minimum wage earner (tax exempt)" checked={f.is_minimum_wage_earner} onChange={(e) => set({ is_minimum_wage_earner: e.target.checked })} />
      </div>
      <div className="grid gap-3 rounded-md bg-gray-50 p-3 sm:grid-cols-2">
        <Field label="Site">
          <Select value={f.site_id} onChange={(e) => set({ site_id: e.target.value })}>
            <option value="">— assign later —</option>
            {sites.data?.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Assigned from"><Input type="date" value={f.assign_from} onChange={(e) => set({ assign_from: e.target.value })} /></Field>
        <Field label="Daily rate (PHP)"><Input inputMode="decimal" value={f.daily_rate} onChange={(e) => set({ daily_rate: e.target.value.replace(/[^0-9.]/g, '') })} /></Field>
        <Field label="Rate effective from"><Input type="date" value={f.rate_from} onChange={(e) => set({ rate_from: e.target.value })} /></Field>
        <Field label="Schedule">
          <Select value={f.schedule_id} onChange={(e) => set({ schedule_id: e.target.value })}>
            <option value="">— assign later —</option>
            {schedules.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Schedule effective from"><Input type="date" value={f.schedule_from} onChange={(e) => set({ schedule_from: e.target.value })} /></Field>
      </div>
      <p className="text-xs text-gray-500">Set the employee's PIN on the next screen. PINs are never shown again after handover.</p>
    </Modal>
  );
}
