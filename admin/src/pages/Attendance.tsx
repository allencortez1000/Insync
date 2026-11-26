import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { employeeLabel, useEmployeesLite, useSites } from '../lib/lookups';
import { addDays, dateOnly, dateTime, hm, isoToLocalInput, localInputToIso, mapsLink, timeOnly, todayPH } from '../lib/format';
import type { LocationStatus, WorkSessionRow } from '../lib/types';
import { usePlaceName } from '../lib/geocode';
import { Icon } from '../components/icons';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, StatusBadge, Table, Td, Textarea, Th, Tr } from '../components/ui';

interface Correction { id: string; kind: string; reason: string; created_at: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; affects_finalized_run_id: string | null }

function LocBadge({ status, lat, lng, acc }: { status: LocationStatus | null; lat: number | null; lng: number | null; acc: number | null }) {
  if (!status) return null;
  const link = mapsLink(lat, lng);
  const label = status === 'captured' ? `±${acc != null ? Math.round(Number(acc)) : '?'} m` : status.replace('_', ' ');
  const badge = <StatusBadge status={status} />;
  return link ? <a href={link} target="_blank" rel="noreferrer" title={label} className="hover:opacity-80">{badge}</a> : <span title={label}>{badge}</span>;
}

/** Location line in the session detail: place name first, the recorded coordinates underneath as evidence. */
function LocationLine({ label, status, lat, lng, acc }: { label: string; status: LocationStatus | null; lat: number | null; lng: number | null; acc: number | null }) {
  const link = mapsLink(lat, lng);
  const place = usePlaceName(lat, lng);
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-gray-500">{label}:</span> {status ? <StatusBadge status={status} /> : '—'}
      </div>
      {lat != null && (
        <div className="mt-1 flex items-start gap-2 rounded-lg bg-gray-50 px-2.5 py-2">
          <Icon name="site" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900">
              {place.loading ? <span className="text-gray-400">Finding place name…</span>
                : place.name ?? <span className="text-gray-500">Place name not available</span>}
            </div>
            <div className="num text-xs text-gray-500">
              {Number(lat).toFixed(5)}, {Number(lng).toFixed(5)}{acc != null && ` · ±${Math.round(Number(acc))} m`}
              {link && <> · <a className="text-brand-700 underline" href={link} target="_blank" rel="noreferrer">Open map</a></>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Attendance() {
  const [params] = useSearchParams();
  const sites = useSites();
  const employees = useEmployeesLite(true);
  const today = todayPH();
  const [from, setFrom] = useState(params.get('employee') ? addDays(today, -30) : today);
  const [to, setTo] = useState(today);
  const [siteId, setSiteId] = useState('');
  const [employeeId, setEmployeeId] = useState(params.get('employee') ?? '');
  const [view, setView] = useState<'range' | 'open'>('range');
  const [flagged, setFlagged] = useState(params.get('flagged') === '1');
  const [showVoided, setShowVoided] = useState(false);
  const [detail, setDetail] = useState<WorkSessionRow | null>(null);
  const [adding, setAdding] = useState(false);

  const rows = useAsync(async () => {
    let query = supabase.from('v_work_sessions').select('*').order('clock_in_at', { ascending: false }).limit(1000);
    if (view === 'open') query = query.eq('status', 'open');
    else query = query.gte('work_date', from).lte('work_date', to);
    if (siteId) query = query.eq('site_id', siteId);
    if (employeeId) query = query.eq('employee_id', employeeId);
    if (!showVoided) query = query.neq('status', 'voided');
    if (flagged) query = query.neq('review_flags', '{}').is('reviewed_at', null);
    return q<WorkSessionRow[]>(query);
  }, [from, to, siteId, employeeId, view, flagged, showVoided]);

  return (
    <div className="space-y-4">
      <PageHeader title="Attendance" subtitle="Punches are original evidence. Corrections need a reason and keep the original record."
        actions={<Button variant="primary" onClick={() => setAdding(true)}>Add missing session</Button>} />
      <div className="filter-bar">
        <Field label="View" className="w-40">
          <Select value={view} onChange={(e) => setView(e.target.value as 'range' | 'open')}>
            <option value="range">By work date</option><option value="open">Open sessions (any date)</option>
          </Select>
        </Field>
        {view === 'range' && <>
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </>}
        <Field label="Site" className="w-48">
          <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">All sites</option>{sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Employee" className="w-60">
          <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">All employees</option>{employees.data?.map((e) => <option key={e.id} value={e.id}>{employeeLabel(e)}</option>)}
          </Select>
        </Field>
        <div className="flex gap-4 pb-2">
          <Checkbox label="Flagged, unreviewed" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} />
          <Checkbox label="Show voided" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
        </div>
      </div>
      <ErrorBox error={rows.error} />
      <Card padded={false}>
        {rows.loading && !rows.data ? <Spinner /> : !rows.data?.length ? <Empty>No attendance for these filters.</Empty> : (
          <Table>
            <thead><tr><Th>Work date</Th><Th>Employee</Th><Th>Site</Th><Th>Clock in</Th><Th>Clock out</Th><Th>Elapsed</Th><Th>Status</Th><Th>Flags</Th></tr></thead>
            <tbody>{rows.data.map((w) => {
              const long = w.status === 'open' && Date.now() - new Date(w.clock_in_at).getTime() > 16 * 3600e3;
              return (
                <Tr key={w.id} onClick={() => setDetail(w)}>
                  <Td className="whitespace-nowrap">{dateOnly(w.work_date)}</Td>
                  <Td>{w.employee_name} <span className="text-xs text-gray-400">{w.employee_code}</span></Td>
                  <Td>{w.site_name}</Td>
                  <Td className="whitespace-nowrap">{timeOnly(w.clock_in_at)} <LocBadge status={w.in_location_status} lat={w.in_latitude} lng={w.in_longitude} acc={w.in_accuracy_m} /></Td>
                  <Td className="whitespace-nowrap">{w.clock_out_at ? <>{isoToLocalInput(w.clock_out_at).slice(0, 10) !== w.work_date ? dateTime(w.clock_out_at) : timeOnly(w.clock_out_at)} <LocBadge status={w.out_location_status} lat={w.out_latitude} lng={w.out_longitude} acc={w.out_accuracy_m} /></> : long ? <Badge tone="red">missing</Badge> : '—'}</Td>
                  <Td className="whitespace-nowrap">{hm(w.elapsed_minutes)}
                    {w.elapsed_minutes != null && w.elapsed_minutes < 480 && <> <Badge tone="amber">short</Badge></>}
                    {w.elapsed_minutes != null && w.elapsed_minutes > 480 && <> <Badge tone="blue">extra</Badge></>}</Td>
                  <Td><StatusBadge status={w.status} />{w.source === 'correction' && <> <Badge tone="purple">correction</Badge></>}</Td>
                  <Td>{w.review_flags.map((f) => <Badge key={f} tone={w.reviewed_at ? 'gray' : 'amber'}>{f.replace('_', ' ')}</Badge>)}{w.reviewed_at && w.review_flags.length > 0 && <span className="ml-1 text-xs text-green-700">reviewed</span>}</Td>
                </Tr>
              );
            })}</tbody>
          </Table>
        )}
      </Card>
      <p className="text-xs text-gray-500">"Short" / "extra" compare elapsed time with 8 hours before any unpaid break. Location identifies the shared device's reported position, not which person entered the PIN.</p>
      {detail && <SessionDetail row={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); rows.reload(); }} />}
      {adding && <AddSession onClose={() => setAdding(false)} onSaved={() => { setAdding(false); rows.reload(); }} />}
    </div>
  );
}

function SessionDetail({ row, onClose, onChanged }: { row: WorkSessionRow; onClose: () => void; onChanged: () => void }) {
  const { run, prompt } = useFeedback();
  const history = useAsync(() => q<Correction[]>(supabase.from('attendance_corrections').select('*').eq('work_session_id', row.id).order('created_at')), [row.id]);
  const [edit, setEdit] = useState<{ in: string; out: string; reason: string } | null>(null);

  async function saveEdit() {
    if (!edit) return;
    const ok = await run(() => rpc('attendance_edit_session', {
      p_session_id: row.id, p_clock_in: localInputToIso(edit.in), p_clock_out: localInputToIso(edit.out), p_reason: edit.reason,
    }), 'Session corrected');
    if (ok) onChanged();
  }
  async function voidIt() {
    const reason = await prompt({ title: 'Void this session?', label: 'Reason', minLength: 3, danger: true, confirmText: 'Void',
      message: 'The original punches stay on record; the session stops counting for payroll.' });
    if (reason !== null && await run(() => rpc('attendance_void_session', { p_session_id: row.id, p_reason: reason }), 'Session voided')) onChanged();
  }
  async function review() {
    const note = await prompt({ title: 'Mark as reviewed', label: 'Review note', minLength: 3, message: `Flags: ${row.review_flags.join(', ') || 'none'}` });
    if (note !== null && await run(() => rpc('attendance_mark_reviewed', { p_session_id: row.id, p_note: note }), 'Marked reviewed')) onChanged();
  }

  return (
    <Modal open wide title={`${row.employee_name} · ${dateOnly(row.work_date)}`} onClose={onClose}
      footer={row.status !== 'voided' && <>
        {row.review_flags.length > 0 && !row.reviewed_at && <Button onClick={() => void review()}>Mark reviewed</Button>}
        <Button variant="danger" onClick={() => void voidIt()}>Void</Button>
        <Button variant="primary" onClick={() => setEdit({ in: isoToLocalInput(row.clock_in_at), out: isoToLocalInput(row.clock_out_at), reason: '' })}>
          {row.status === 'open' ? 'Close / correct' : 'Correct times'}
        </Button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 text-sm">
          <div><span className="text-gray-500">Site:</span> {row.site_name}</div>
          <div><span className="text-gray-500">Clock in:</span> {dateTime(row.clock_in_at)}</div>
          <div><span className="text-gray-500">Clock out:</span> {dateTime(row.clock_out_at)}</div>
          <div><span className="text-gray-500">Elapsed:</span> {hm(row.elapsed_minutes)}</div>
          <div><span className="text-gray-500">Status:</span> <StatusBadge status={row.status} /> {row.source === 'correction' && <Badge tone="purple">entered by staff</Badge>}</div>
        </div>
        <div className="space-y-2">
          <LocationLine label="In location" status={row.in_location_status} lat={row.in_latitude} lng={row.in_longitude} acc={row.in_accuracy_m} />
          <LocationLine label="Out location" status={row.out_location_status} lat={row.out_latitude} lng={row.out_longitude} acc={row.out_accuracy_m} />
          <div className="text-sm"><span className="text-gray-500">Device:</span> {row.in_device_label ?? '—'}</div>
          {row.source === 'device' && (
            <div className="text-sm"><span className="text-gray-500">Verified by:</span>{' '}
              {row.in_auth_method === 'face' ? 'face' : 'PIN'} at clock in{row.out_auth_method ? <>, {row.out_auth_method === 'face' ? 'face' : 'PIN'} at clock out</> : null}
            </div>
          )}
          <div className="text-sm"><span className="text-gray-500">Flags:</span> {row.review_flags.join(', ') || 'none'} {row.reviewed_at && `· reviewed ${dateTime(row.reviewed_at)}`}</div>
          {row.review_note && <div className="text-sm"><span className="text-gray-500">Note:</span> {row.review_note}</div>}
        </div>
      </div>
      {row.allow_origin_close && <Notice tone="amber">The employee was transferred; this site may still record their Clock Out.</Notice>}
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Correction history</h4>
        {!history.data?.length ? <p className="text-sm text-gray-500">No corrections.</p> : (
          <ul className="space-y-1 text-sm">{history.data.map((c) => (
            <li key={c.id}><Badge>{c.kind.replace('_', ' ')}</Badge> {dateTime(c.created_at)} — {c.reason}
              {c.before && c.after && (c.before.clock_in_at !== c.after.clock_in_at || c.before.clock_out_at !== c.after.clock_out_at) && (
                <span className="text-xs text-gray-500"> ({timeOnly(String(c.before.clock_in_at))}–{c.before.clock_out_at ? timeOnly(String(c.before.clock_out_at)) : 'open'} → {timeOnly(String(c.after.clock_in_at))}–{c.after.clock_out_at ? timeOnly(String(c.after.clock_out_at)) : 'open'})</span>)}
              {c.affects_finalized_run_id && <> <Badge tone="red">affects finalized payroll</Badge></>}</li>
          ))}</ul>
        )}
      </div>
      {edit && (
        <div className="space-y-3 rounded-md border border-brand-100 bg-brand-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Clock in (PH time)"><Input type="datetime-local" value={edit.in} onChange={(e) => setEdit({ ...edit, in: e.target.value })} /></Field>
            <Field label="Clock out (PH time)" hint="Leave empty to keep the session open"><Input type="datetime-local" value={edit.out} onChange={(e) => setEdit({ ...edit, out: e.target.value })} /></Field>
          </div>
          <Field label="Reason (required)"><Textarea value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} placeholder="e.g. Forgot to clock out; confirmed by supervisor" /></Field>
          <div className="flex justify-end gap-2"><Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" disabled={edit.reason.trim().length < 3 || !edit.in} onClick={() => void saveEdit()}>Save correction</Button></div>
        </div>
      )}
    </Modal>
  );
}

function AddSession({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { run } = useFeedback();
  const sites = useSites();
  const employees = useEmployeesLite();
  const [f, setF] = useState({ employee_id: '', site_id: '', in: `${todayPH()}T08:00`, out: `${todayPH()}T17:00`, reason: '' });

  async function save() {
    const ok = await run(() => rpc('attendance_create_session', {
      p_employee_id: f.employee_id, p_site_id: f.site_id, p_clock_in: localInputToIso(f.in), p_clock_out: localInputToIso(f.out), p_reason: f.reason,
    }), 'Session added');
    if (ok) onSaved();
  }

  return (
    <Modal open title="Add missing attendance session" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.employee_id || !f.site_id || !f.in || f.reason.trim().length < 3} onClick={() => void save()}>Save</Button></>}>
      <Field label="Employee">
        <Select value={f.employee_id} onChange={(e) => {
          const emp = employees.data?.find((x) => x.id === e.target.value);
          setF({ ...f, employee_id: e.target.value, site_id: emp?.current_site_id ?? f.site_id });
        }}>
          <option value="">Select…</option>{employees.data?.map((e) => <option key={e.id} value={e.id}>{employeeLabel(e)}</option>)}
        </Select>
      </Field>
      <Field label="Site">
        <Select value={f.site_id} onChange={(e) => setF({ ...f, site_id: e.target.value })}>
          <option value="">Select…</option>{sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Clock in (PH time)"><Input type="datetime-local" value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })} /></Field>
        <Field label="Clock out (PH time)" hint="Empty = still open"><Input type="datetime-local" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} /></Field>
      </div>
      <Field label="Reason (required)"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Phone was offline; time confirmed by site supervisor" /></Field>
      <Notice>Staff-entered sessions are marked as corrections and keep your name and reason in the history.</Notice>
    </Modal>
  );
}
