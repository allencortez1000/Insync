import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../../lib/auth';
import { useFeedback } from '../../components/feedback';
import {
  Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner,
  StatusBadge, Table, Td, Textarea, Th, Tr,
} from '../../components/ui';
import { useAsync } from '../../lib/hooks';
import { useSites } from '../../lib/lookups';
import { addDays, dateOnly, dateTime, php, todayPH } from '../../lib/format';
import { q, rpc, supabase } from '../../lib/supabase';
import type { PayrollRunRow, PayrollStatus } from '../../lib/types';

interface PeriodRow { id: string; start_date: string; end_date: string; payday: string }
interface SettingsRow { period_start_dow: number; payday_offset_days: number }

const isoDow = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};

/** Monday of last week (Manila calendar). */
function lastWeekMonday(): string {
  const today = todayPH();
  return addDays(today, -(isoDow(today) - 1) - 7);
}

export function RunStatus({ status }: { status: PayrollStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge status={status} />
      {(status === 'draft' || status === 'ready_for_review') && <span className="text-xs text-gray-500">not approved</span>}
    </span>
  );
}

export function PayrollRuns() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<'' | PayrollStatus>('');
  const [creating, setCreating] = useState(false);

  const runs = useAsync(
    () => q<PayrollRunRow[]>(
      supabase.from('v_payroll_runs').select('*')
        .order('start_date', { ascending: false }).order('run_no', { ascending: false }).limit(500),
    ),
    [],
  );

  const rows = useMemo(
    () => (runs.data ?? []).filter((r) => !statusFilter || r.status === statusFilter),
    [runs.data, statusFilter],
  );

  return (
    <div>
      <PageHeader
        title="Payroll runs"
        subtitle="Weekly payroll: calculate → review → finalize → record payment. Calculation never approves or pays anything by itself."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>New payroll run</Button>}
      />

      <Card
        padded={false}
        title="Runs"
        actions={
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | PayrollStatus)} className="w-44">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="ready_for_review">Ready for review</option>
            <option value="finalized">Finalized</option>
            <option value="paid">Paid</option>
            <option value="void">Void</option>
          </Select>
        }
      >
        {runs.loading && !runs.data ? <Spinner /> : null}
        {runs.error && <div className="p-4"><ErrorBox error={runs.error} /></div>}
        {runs.data && rows.length === 0 ? <Empty>No payroll runs yet. Create one for a weekly period.</Empty> : null}
        {rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Run</Th><Th>Period</Th><Th>Payday</Th><Th>Sites</Th><Th>Status</Th>
                <Th className="text-right">Employees</Th><Th className="text-right">Net pay</Th>
                <Th>Exceptions</Th><Th>Calculated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} onClick={() => navigate(`/payroll/${r.id}`)}>
                  <Td className="font-medium">#{r.run_no}{r.reissue_of_run_id && <span className="ml-1 text-xs text-gray-500">(reissue)</span>}</Td>
                  <Td className="whitespace-nowrap">{dateOnly(r.start_date)} – {dateOnly(r.end_date)}</Td>
                  <Td className="whitespace-nowrap">{dateOnly(r.payday)}</Td>
                  <Td className="max-w-56 truncate">{r.site_ids ? r.site_names ?? `${r.site_ids.length} site(s)` : 'All sites'}</Td>
                  <Td><RunStatus status={r.status} /></Td>
                  <Td className="num text-right">{r.calculated_at ? r.totals.employees ?? 0 : '—'}</Td>
                  <Td className="num text-right">{r.calculated_at ? php(r.totals.net ?? 0) : '—'}</Td>
                  <Td>
                    {!r.calculated_at ? <span className="text-xs text-gray-400">not calculated</span> : (
                      <span className="flex gap-1">
                        {r.blocking_count > 0 && <Badge tone="red">{r.blocking_count} blocking</Badge>}
                        {r.warning_count > 0 && <Badge tone="amber">{r.warning_count} warnings</Badge>}
                        {r.blocking_count === 0 && r.warning_count === 0 && <Badge tone="green">none</Badge>}
                      </span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-gray-500">{dateTime(r.calculated_at)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <NewRunModal
        open={creating}
        existingRuns={runs.data ?? []}
        onClose={() => setCreating(false)}
        onCreated={(id) => navigate(`/payroll/${id}`)}
      />
    </div>
  );
}

function NewRunModal({ open, existingRuns, onClose, onCreated }:
  { open: boolean; existingRuns: PayrollRunRow[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { isAdmin, profile } = useAuth();
  const { toast } = useFeedback();
  const sites = useSites();
  const canAllSites = isAdmin || Boolean(profile?.all_sites);

  const [date, setDate] = useState(lastWeekMonday);
  const [allSites, setAllSites] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const preview = useAsync(async () => {
    if (!open || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const existing = await q<PeriodRow | null>(
      supabase.from('payroll_periods').select('*').lte('start_date', date).gte('end_date', date).maybeSingle(),
    );
    if (existing) return { ...existing, isNew: false };
    const s = await q<SettingsRow>(supabase.from('payroll_settings').select('period_start_dow, payday_offset_days').eq('id', 1).single());
    const start = addDays(date, -((isoDow(date) - s.period_start_dow + 7) % 7));
    const end = addDays(start, 6);
    return { id: '', start_date: start, end_date: end, payday: addDays(end, s.payday_offset_days), isNew: true };
  }, [open, date]);

  const conflicts = preview.data && !preview.data.isNew
    ? existingRuns.filter((r) => r.period_id === preview.data!.id && r.status !== 'void')
    : [];

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const valid = Boolean(preview.data) && (allSites ? canAllSites : selected.size > 0);

  async function create() {
    setBusy(true);
    try {
      const periodId = await rpc<string>('payroll_ensure_period', { p_date: date });
      const id = await rpc<string>('payroll_create_run', {
        p_period_id: periodId,
        p_site_ids: allSites ? null : [...selected],
        p_notes: notes.trim() || null,
      });
      toast('Draft payroll run created');
      onCreated(id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="New payroll run"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} busy={busy} onClick={() => void create()}>Create draft run</Button>
        </>
      }
    >
      <Field label="Any date in the pay week" hint="The weekly period is aligned to the configured period start day.">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>

      {preview.loading && !preview.data ? <Spinner label="Resolving period…" /> : null}
      <ErrorBox error={preview.error} />
      {preview.data && (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
          <div><span className="text-gray-500">Period:</span> <b>{dateOnly(preview.data.start_date)} – {dateOnly(preview.data.end_date)}</b></div>
          <div><span className="text-gray-500">Payday:</span> {dateOnly(preview.data.payday)}</div>
          {preview.data.isNew && <div className="mt-1 text-xs text-gray-500">This period will be created.</div>}
        </div>
      )}
      {conflicts.length > 0 && (
        <Notice tone="amber">
          Existing runs for this period: {conflicts.map((r) => `#${r.run_no} (${r.site_ids ? r.site_names ?? 'selected sites' : 'all sites'}, ${r.status.replace(/_/g, ' ')})`).join('; ')}.
          A new run cannot cover the same sites.
        </Notice>
      )}

      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Sites</div>
        {canAllSites && (
          <div className="mb-2">
            <Checkbox label={<b>All sites</b>} checked={allSites} onChange={(e) => setAllSites(e.target.checked)} />
          </div>
        )}
        {sites.loading && !sites.data ? <Spinner /> : null}
        <ErrorBox error={sites.error} />
        <div className={`grid grid-cols-1 gap-1.5 sm:grid-cols-2 ${allSites ? 'pointer-events-none opacity-40' : ''}`}>
          {(sites.data ?? []).map((s) => (
            <Checkbox
              key={s.id}
              label={<>{s.name} <span className="text-xs text-gray-500">{s.code}{!s.is_active && ' · inactive'}</span></>}
              checked={selected.has(s.id)}
              onChange={() => toggle(s.id)}
            />
          ))}
        </div>
        {!canAllSites && <p className="mt-2 text-xs text-gray-500">Pick the sites in your scope that this run covers.</p>}
      </div>

      <Field label="Notes (optional)">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </Field>
    </Modal>
  );
}
