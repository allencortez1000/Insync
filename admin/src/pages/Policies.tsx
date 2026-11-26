import { useEffect, useState, type ChangeEvent } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useSites } from '../lib/lookups';
import { dateOnly, dateTime, titleCase, todayPH } from '../lib/format';
import type { StatutoryRule } from '../lib/types';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Tabs, Td, Textarea, Th, Tr } from '../components/ui';

type Tab = 'settings' | 'rules' | 'holidays' | 'multipliers';

export function Policies() {
  const [tab, setTab] = useState<Tab>('settings');
  return (
    <div>
      <PageHeader title="Policies & rules" subtitle="Configurable business decisions, statutory rule versions, holiday calendars and premium multipliers." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: 'settings', label: 'Payroll & attendance settings' }, { id: 'rules', label: 'Statutory rules' },
        { id: 'holidays', label: 'Holidays' }, { id: 'multipliers', label: 'Day multipliers' },
      ]} />
      {tab === 'settings' && <SettingsTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'holidays' && <HolidaysTab />}
      {tab === 'multipliers' && <MultipliersTab />}
    </div>
  );
}

interface Settings {
  calc_mode: 'construction' | 'statutory';
  period_start_dow: number; payday_offset_days: number; ot_review_required: boolean; night_diff_mode: 'flag' | 'pay';
  night_diff_rate: number; max_session_minutes: number; pin_max_attempts: number; pin_lockout_minutes: number;
  device_max_failed_pins: number; pin_auth_ttl_seconds: number; device_session_days: number; site_login_max_attempts: number;
  site_login_lockout_minutes: number; location_stale_ms: number; face_match_threshold: number; location_failure_policy: 'save_and_flag' | 'block';
  holiday_lookback_days: number; policies_confirmed_at: string | null; policy_notes: string | null; updated_at: string;
}
const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function SettingsTab() {
  const { isAdmin, profile } = useAuth();
  const { run, confirm } = useFeedback();
  const s = useAsync(() => q<Settings>(supabase.from('payroll_settings').select('*').eq('id', 1).single()), []);
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => { if (s.data) setF(s.data); }, [s.data]);
  if (!f) return s.error ? <ErrorBox error={s.error} /> : <Spinner />;
  const set = (p: Partial<Settings>) => setF({ ...f, ...p });
  const num = (k: keyof Settings) => ({ type: 'number', value: String(f[k] ?? ''), disabled: !isAdmin,
    onChange: (e: ChangeEvent<HTMLInputElement>) => set({ [k]: Number(e.target.value) } as Partial<Settings>) });
  const payday = DOW[(f.period_start_dow - 1 + 6 + f.payday_offset_days) % 7];

  async function save(confirmPolicies = false) {
    if (!f) return;
    if (confirmPolicies && !(await confirm({ title: 'Confirm business policies?',
      message: 'Record that the owner has confirmed the open PRD decisions (cutoff and payday, OT approval, lunch break, schedules, night work, location failure, leave and allowances) for the pilot workforce.' }))) return;
    const { updated_at: _u, ...rest } = f;
    void _u;
    const ok = await run(() => q(supabase.from('payroll_settings').update({
      ...rest, updated_by: profile?.id, policies_confirmed_at: confirmPolicies ? new Date().toISOString() : rest.policies_confirmed_at,
    }).eq('id', 1)), 'Settings saved');
    if (ok) s.reload();
  }

  return (
    <div className="space-y-4">
      {!f.policies_confirmed_at
        ? <Notice tone="amber">Open business decisions from the PRD have not been confirmed yet. Review these settings with the owner before running production payroll.</Notice>
        : <Notice tone="green">Policies confirmed on {dateTime(f.policies_confirmed_at)}.</Notice>}
      {!isAdmin && <Notice>Only admins can change settings.</Notice>}
      {f.calc_mode === undefined && (
        <Notice tone="red">
          The construction payroll computation is not installed in this database yet, so payroll still uses the DOLE statutory engine.
          Run <code>20261117001000_construction_payroll.sql</code> (then <code>20261117001100_fixes.sql</code>) in the Supabase SQL Editor.
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Weekly payroll">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Payroll computation" className="sm:col-span-2"
              hint={f.calc_mode === 'construction'
                ? 'Lunch 1 h if ≥ 8 h, whole hours, OT after 9 h, Sunday rest day ×1.30, OT ×1.25 / rest-day OT, manual holiday pay, per-employee deductions.'
                : 'DOLE day-type multipliers, automatic holiday pay, SSS / PhilHealth / Pag-IBIG / BIR from approved rule tables.'}>
              <Select disabled={!isAdmin} value={f.calc_mode} onChange={(e) => set({ calc_mode: e.target.value as Settings['calc_mode'] })}>
                <option value="construction">Construction (company computation)</option>
                <option value="statutory">DOLE statutory engine</option>
              </Select>
            </Field>
            <Field label="Week starts on">
              <Select disabled={!isAdmin} value={f.period_start_dow} onChange={(e) => set({ period_start_dow: Number(e.target.value) })}>
                {DOW.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
              </Select>
            </Field>
            <Field label="Payday (days after period end)" hint={`Payday falls on ${payday}`}><Input {...num('payday_offset_days')} min={0} max={14} /></Field>
            <div className="sm:col-span-2"><Checkbox disabled={!isAdmin} label="Extra time requires an OT decision before payroll can be finalized" checked={f.ot_review_required} onChange={(e) => set({ ot_review_required: e.target.checked })} /></div>
            <Field label="Night work (10 PM–6 AM)">
              <Select disabled={!isAdmin} value={f.night_diff_mode} onChange={(e) => set({ night_diff_mode: e.target.value as Settings['night_diff_mode'] })}>
                <option value="flag">Flag for resolution (blocks payroll)</option><option value="pay">Pay night differential</option>
              </Select>
            </Field>
            <Field label="Night differential rate" hint="0.10 = 10% of the applicable hourly rate"><Input {...num('night_diff_rate')} step={0.01} /></Field>
            <Field label="Implausible session length (min)" hint="Longer sessions need review"><Input {...num('max_session_minutes')} /></Field>
            <Field label="Holiday eligibility look-back (days)"><Input {...num('holiday_lookback_days')} /></Field>
          </div>
        </Card>
        <Card title="Attendance app & security">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="When location is unavailable">
              <Select disabled={!isAdmin} value={f.location_failure_policy} onChange={(e) => set({ location_failure_policy: e.target.value as Settings['location_failure_policy'] })}>
                <option value="save_and_flag">Save attendance and flag for review</option><option value="block">Block attendance until location works</option>
              </Select>
            </Field>
            <Field label="Location older than (ms) is stale"><Input {...num('location_stale_ms')} /></Field>
            <Field label="Wrong PINs before lockout"><Input {...num('pin_max_attempts')} /></Field>
            <Field label="PIN lockout (min)"><Input {...num('pin_lockout_minutes')} /></Field>
            <Field label="Wrong PINs per device / 15 min"><Input {...num('device_max_failed_pins')} /></Field>
            <Field label="PIN check valid for (s)"><Input {...num('pin_auth_ttl_seconds')} /></Field>
            <Field label="Site sign-in attempts before lock"><Input {...num('site_login_max_attempts')} /></Field>
            <Field label="Site sign-in lockout (min)"><Input {...num('site_login_lockout_minutes')} /></Field>
            <Field label="Device session lifetime (days)"><Input {...num('device_session_days')} /></Field>
            <Field label="Face match limit" hint="0.30–0.70. Lower = stricter: fewer wrong matches, but the right person is refused more often. 0.45 is the default.">
              <Input {...num('face_match_threshold')} step={0.01} min={0.3} max={0.7} />
            </Field>
          </div>
        </Card>
      </div>
      <Card title="Policy notes">
        <Textarea disabled={!isAdmin} rows={5} value={f.policy_notes ?? ''} onChange={(e) => set({ policy_notes: e.target.value })}
          placeholder="Record the owner's decisions: lunch break treatment, schedules and grace, OT approval, leave entitlements, allowance eligibility, deduction allocation, employee classifications and site regions…" />
        <p className="mt-2 text-xs text-gray-500">Last updated {dateTime(f.updated_at)}</p>
      </Card>
      {isAdmin && <div className="flex justify-end gap-2">
        <Button onClick={() => void save(true)}>Save &amp; mark policies confirmed</Button>
        <Button variant="primary" onClick={() => void save()}>Save settings</Button>
      </div>}
    </div>
  );
}

const AGENCIES: StatutoryRule['agency'][] = ['sss', 'philhealth', 'pagibig', 'bir_withholding'];
const agencyLabel = (a: string) => ({ sss: 'SSS', philhealth: 'PhilHealth', pagibig: 'Pag-IBIG', bir_withholding: 'BIR withholding' }[a] ?? a);

function RulesTab() {
  const { isAdmin } = useAuth();
  const { run, confirm, prompt } = useFeedback();
  const rules = useAsync(() => q<StatutoryRule[]>(supabase.from('statutory_rule_versions').select('*').order('agency').order('effective_from', { ascending: false })), []);
  const [draft, setDraft] = useState<{ agency: StatutoryRule['agency']; name: string; effective_from: string; effective_to: string; params: string; source_reference: string; notes: string } | null>(null);
  const [view, setView] = useState<StatutoryRule | null>(null);
  const jsonOk = (() => { try { return draft ? typeof JSON.parse(draft.params) === 'object' : false; } catch { return false; } })();

  async function approve(r: StatutoryRule) {
    if (!(await confirm({ title: `Approve ${agencyLabel(r.agency)} rule?`, confirmText: 'Approve',
      message: <>Confirm you verified <b>{r.name}</b> (effective {dateOnly(r.effective_from)}) against the current official issuance: {r.source_reference}. Approved versions cannot be edited.</> }))) return;
    if (await run(() => rpc('rule_approve', { p_rule_id: r.id }), 'Rule approved')) rules.reload();
  }
  async function endDate(r: StatutoryRule) {
    const v = await prompt({ title: 'Set end date', label: 'Last effective date (YYYY-MM-DD)', multiline: false, initial: todayPH(), minLength: 10 });
    if (v && await run(() => rpc('rule_retire', { p_rule_id: r.id, p_effective_to: v }), 'End date set')) rules.reload();
  }
  async function retire(r: StatutoryRule) {
    if (await confirm({ title: 'Retire rule?', message: 'Retired versions are never used again.', danger: true, confirmText: 'Retire' })
      && await run(() => rpc('rule_retire', { p_rule_id: r.id }), 'Rule retired')) rules.reload();
  }
  async function del(r: StatutoryRule) {
    if (await confirm({ title: 'Delete draft?', danger: true, confirmText: 'Delete' })
      && await run(() => q(supabase.from('statutory_rule_versions').delete().eq('id', r.id)), 'Draft deleted')) rules.reload();
  }
  async function saveDraft() {
    if (!draft) return;
    const ok = await run(() => q(supabase.from('statutory_rule_versions').insert({
      agency: draft.agency, name: draft.name, effective_from: draft.effective_from, effective_to: draft.effective_to || null,
      params: JSON.parse(draft.params), source_reference: draft.source_reference, notes: draft.notes || null, status: 'draft',
    })), 'Draft rule created');
    if (ok) { setDraft(null); rules.reload(); }
  }
  function cloneOf(r: StatutoryRule) {
    setDraft({ agency: r.agency, name: `${r.name} (new version)`, effective_from: todayPH(), effective_to: '',
      params: JSON.stringify(r.params, null, 2), source_reference: r.source_reference, notes: r.notes ?? '' });
  }

  return (
    <div className="space-y-4">
      <Notice tone="amber">
        Payroll uses the approved version effective on each payday. Seeded versions are drafts: verify every rate, bracket, cap and basis
        against the newest SSS, PhilHealth, Pag-IBIG and BIR issuances before approving. A draft blocks payroll finalization.
      </Notice>
      <ErrorBox error={rules.error} />
      {rules.loading && !rules.data ? <Spinner /> : AGENCIES.map((a) => {
        const list = rules.data?.filter((r) => r.agency === a) ?? [];
        return (
          <Card key={a} title={agencyLabel(a)} padded={false}>
            {!list.length ? <Empty>No rule versions.</Empty> : (
              <Table>
                <thead><tr><Th>Name</Th><Th>Effective</Th><Th>Status</Th><Th>Source</Th><Th /></tr></thead>
                <tbody>{list.map((r) => (
                  <Tr key={r.id}>
                    <Td className="font-medium">{r.name}{r.notes && <div className="text-xs font-normal text-gray-500">{r.notes}</div>}</Td>
                    <Td className="whitespace-nowrap text-xs">{dateOnly(r.effective_from)} → {r.effective_to ? dateOnly(r.effective_to) : 'open'}</Td>
                    <Td><StatusBadge status={r.status} />{r.approved_at && <div className="text-xs text-gray-400">{dateTime(r.approved_at)}</div>}</Td>
                    <Td className="max-w-xs text-xs break-words text-gray-600">{r.source_reference}</Td>
                    <Td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => setView(r)}>Parameters</Button>
                      {isAdmin && r.status === 'draft' && <><Button size="sm" variant="primary" onClick={() => void approve(r)}>Approve</Button> <Button size="sm" variant="ghost" onClick={() => void del(r)}>Delete</Button></>}
                      {isAdmin && r.status === 'approved' && <><Button size="sm" onClick={() => void endDate(r)}>End date</Button> <Button size="sm" variant="ghost" onClick={() => void retire(r)}>Retire</Button></>}
                      {isAdmin && <Button size="sm" variant="ghost" onClick={() => cloneOf(r)}>New version</Button>}
                    </Td>
                  </Tr>
                ))}</tbody>
              </Table>
            )}
          </Card>
        );
      })}
      <Modal open={view !== null} title={view ? `${agencyLabel(view.agency)} · ${view.name}` : ''} onClose={() => setView(null)} wide>
        <pre className="overflow-x-auto rounded bg-gray-50 p-3 text-xs">{view && JSON.stringify(view.params, null, 2)}</pre>
        <p className="text-xs text-gray-500">
          basis: "basic" = basic pay portion (excludes OT, premiums, allowances); "compensation" = gross excluding non-taxable allowances; "gross" = all earnings.
        </p>
      </Modal>
      <Modal open={draft !== null} title="New draft rule version" wide onClose={() => setDraft(null)}
        footer={<><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" disabled={!draft?.name || !jsonOk || !draft.source_reference} onClick={() => void saveDraft()}>Create draft</Button></>}>
        {draft && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Agency">
                <Select value={draft.agency} onChange={(e) => setDraft({ ...draft, agency: e.target.value as StatutoryRule['agency'] })}>
                  {AGENCIES.map((a) => <option key={a} value={a}>{agencyLabel(a)}</option>)}
                </Select>
              </Field>
              <Field label="Effective from"><Input type="date" value={draft.effective_from} onChange={(e) => setDraft({ ...draft, effective_from: e.target.value })} /></Field>
              <Field label="Effective to (optional)"><Input type="date" value={draft.effective_to} onChange={(e) => setDraft({ ...draft, effective_to: e.target.value })} /></Field>
            </div>
            <Field label="Name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="Parameters (JSON)" hint={jsonOk ? 'Valid JSON' : 'Invalid JSON'}>
              <Textarea rows={12} className="font-mono text-xs" value={draft.params} onChange={(e) => setDraft({ ...draft, params: e.target.value })} />
            </Field>
            <Field label="Official source reference"><Input value={draft.source_reference} onChange={(e) => setDraft({ ...draft, source_reference: e.target.value })} /></Field>
            <Field label="Notes"><Textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field>
            <Notice>To change an approved version, set its end date and approve a new version starting the next day.</Notice>
          </>
        )}
      </Modal>
    </div>
  );
}

interface Holiday { id: string; holiday_date: string; name: string; kind: 'regular' | 'special_non_working' | 'special_working'; site_id: string | null; source_reference: string; published_on: string | null; notes: string | null }

function HolidaysTab() {
  const { isAdmin } = useAuth();
  const { run, confirm } = useFeedback();
  const sites = useSites();
  const [year, setYear] = useState(todayPH().slice(0, 4));
  const list = useAsync(() => q<Holiday[]>(supabase.from('holidays').select('*').gte('holiday_date', `${year}-01-01`).lte('holiday_date', `${year}-12-31`).order('holiday_date')), [year]);
  const [f, setF] = useState<Omit<Holiday, 'id'> | null>(null);
  const siteName = (id: string | null) => (id ? sites.data?.find((s) => s.id === id)?.name ?? 'site' : 'National');

  async function save() {
    if (!f) return;
    const ok = await run(() => q(supabase.from('holidays').insert({ ...f, published_on: f.published_on || null, notes: f.notes || null })), 'Holiday added');
    if (ok) { setF(null); list.reload(); }
  }
  async function del(h: Holiday) {
    if (await confirm({ title: `Delete ${h.name}?`, message: 'Draft payroll recalculated afterwards will no longer apply this holiday. Finalized payroll is unaffected.', danger: true, confirmText: 'Delete' })
      && await run(() => q(supabase.from('holidays').delete().eq('id', h.id)), 'Holiday deleted')) list.reload();
  }

  return (
    <div className="space-y-4">
      <div className="filter-bar">
        <Field label="Year"><Input type="number" className="w-28" value={year} onChange={(e) => setYear(e.target.value)} /></Field>
        <Button variant="primary" onClick={() => setF({ holiday_date: `${year}-01-01`, name: '', kind: 'regular', site_id: null, source_reference: '', published_on: null, notes: null })}>Add holiday</Button>
      </div>
      <Notice>Holidays must match the official proclamation for the year (and local ordinances for site holidays). Two holidays on one date are flagged in payroll until a documented rule exists.</Notice>
      <ErrorBox error={list.error} />
      <Card padded={false}>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <Empty>No holidays for {year}.</Empty> : (
          <Table>
            <thead><tr><Th>Date</Th><Th>Name</Th><Th>Kind</Th><Th>Scope</Th><Th>Source</Th><Th /></tr></thead>
            <tbody>{list.data.map((h) => (
              <Tr key={h.id}>
                <Td className="whitespace-nowrap">{dateOnly(h.holiday_date)}</Td>
                <Td className="font-medium">{h.name}{h.notes && <div className="text-xs font-normal text-gray-500">{h.notes}</div>}</Td>
                <Td><Badge tone={h.kind === 'regular' ? 'purple' : h.kind === 'special_non_working' ? 'blue' : 'gray'}>{titleCase(h.kind)}</Badge></Td>
                <Td>{siteName(h.site_id)}</Td>
                <Td className="max-w-xs text-xs text-gray-600">{h.source_reference}</Td>
                <Td className="text-right">{(isAdmin || h.site_id) && <Button size="sm" variant="ghost" onClick={() => void del(h)}>Delete</Button>}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={f !== null} title="Add holiday" onClose={() => setF(null)}
        footer={<><Button onClick={() => setF(null)}>Cancel</Button><Button variant="primary" disabled={!f?.name || !f.holiday_date || !f.source_reference} onClick={() => void save()}>Save</Button></>}>
        {f && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date"><Input type="date" value={f.holiday_date} onChange={(e) => setF({ ...f, holiday_date: e.target.value })} /></Field>
              <Field label="Kind">
                <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Holiday['kind'] })}>
                  <option value="regular">Regular holiday</option><option value="special_non_working">Special non-working day</option><option value="special_working">Special working day (ordinary pay)</option>
                </Select>
              </Field>
            </div>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Scope">
              <Select value={f.site_id ?? ''} onChange={(e) => setF({ ...f, site_id: e.target.value || null })}>
                {isAdmin && <option value="">National (all sites)</option>}
                {!isAdmin && <option value="" disabled>National — admin only</option>}
                {sites.data?.map((s) => <option key={s.id} value={s.id}>Local: {s.name}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Official source"><Input value={f.source_reference} onChange={(e) => setF({ ...f, source_reference: e.target.value })} placeholder="Proclamation / ordinance no." /></Field>
              <Field label="Published on"><Input type="date" value={f.published_on ?? ''} onChange={(e) => setF({ ...f, published_on: e.target.value })} /></Field>
            </div>
            <Field label="Notes"><Input value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          </>
        )}
      </Modal>
    </div>
  );
}

interface Multiplier { id: string; day_type: string; effective_from: string; regular_multiplier: number; ot_multiplier: number; source_reference: string }

function MultipliersTab() {
  const { isAdmin } = useAuth();
  const { run } = useFeedback();
  const list = useAsync(() => q<Multiplier[]>(supabase.from('day_type_multipliers').select('*').order('day_type').order('effective_from', { ascending: false })), []);
  const [f, setF] = useState<Omit<Multiplier, 'id' | 'regular_multiplier' | 'ot_multiplier'> & { regular_multiplier: string; ot_multiplier: string } | null>(null);

  async function save() {
    if (!f) return;
    const ok = await run(() => q(supabase.from('day_type_multipliers').insert({ ...f, regular_multiplier: Number(f.regular_multiplier), ot_multiplier: Number(f.ot_multiplier) })), 'Multiplier version added');
    if (ok) { setF(null); list.reload(); }
  }

  return (
    <div className="space-y-4">
      <Notice>Multipliers are total rates on the basic hourly rate (8 hours on a regular holiday = 200%, not 100% + 200%). Add a new version with a later effective date for higher contractual benefits.</Notice>
      <Card padded={false} actions={isAdmin && <Button size="sm" variant="primary" onClick={() => setF({ day_type: 'ordinary', effective_from: todayPH(), regular_multiplier: '1.00', ot_multiplier: '1.25', source_reference: '' })}>New version</Button>} title="Day classification multipliers">
        {list.loading && !list.data ? <Spinner /> : (
          <Table>
            <thead><tr><Th>Day type</Th><Th>Effective</Th><Th className="text-right">First 8 hours</Th><Th className="text-right">OT hourly</Th><Th>Source</Th></tr></thead>
            <tbody>{list.data?.map((m) => (
              <Tr key={m.id}><Td>{titleCase(m.day_type)}</Td><Td>{dateOnly(m.effective_from)}</Td>
                <Td className="num text-right">{(Number(m.regular_multiplier) * 100).toFixed(0)}%</Td><Td className="num text-right">{(Number(m.ot_multiplier) * 100).toFixed(0)}%</Td>
                <Td className="text-xs text-gray-600">{m.source_reference}</Td></Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={f !== null} title="New multiplier version" onClose={() => setF(null)}
        footer={<><Button onClick={() => setF(null)}>Cancel</Button><Button variant="primary" disabled={!f?.source_reference || !(Number(f.regular_multiplier) >= 1) || !(Number(f.ot_multiplier) >= 1)} onClick={() => void save()}>Save</Button></>}>
        {f && (
          <>
            <Field label="Day type">
              <Select value={f.day_type} onChange={(e) => setF({ ...f, day_type: e.target.value })}>
                {['ordinary', 'rest_day', 'special_non_working', 'special_rest', 'regular_holiday', 'regular_holiday_rest'].map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Effective from"><Input type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} /></Field>
              <Field label="First 8 h (×)"><Input value={f.regular_multiplier} onChange={(e) => setF({ ...f, regular_multiplier: e.target.value })} /></Field>
              <Field label="OT (×)"><Input value={f.ot_multiplier} onChange={(e) => setF({ ...f, ot_multiplier: e.target.value })} /></Field>
            </div>
            <Field label="Source / policy reference"><Input value={f.source_reference} onChange={(e) => setF({ ...f, source_reference: e.target.value })} /></Field>
          </>
        )}
      </Modal>
    </div>
  );
}
