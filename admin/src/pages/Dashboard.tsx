import { Link } from 'react-router';
import { rpc, q, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { dateTime, hm } from '../lib/format';
import { Card, Empty, ErrorBox, Notice, PageHeader, Spinner, Stat, Table, Td, Th, Tr, Badge } from '../components/ui';
import type { WorkSessionRow } from '../lib/types';

interface Summary {
  open_sessions: number; stale_open_sessions: number; punches_today: number; unreviewed_flags: number;
  pending_ot: number; pending_leave: number; lockouts_24h: number; failed_pins_24h: number;
  runs_in_progress: number; runs_awaiting_payment: number; payroll_impacts: number; draft_rules: number;
  active_employees: number; active_devices: number;
}

interface SecurityEvent { id: number; kind: string; created_at: string; site_id: string | null; employee_id: string | null; details: Record<string, unknown> }

export function Dashboard() {
  const summary = useAsync(() => rpc<Summary>('dashboard_summary'), []);
  const open = useAsync(() => q<WorkSessionRow[]>(
    supabase.from('v_work_sessions').select('*').eq('status', 'open').order('clock_in_at').limit(50)), []);
  const events = useAsync(() => q<SecurityEvent[]>(
    supabase.from('security_events').select('*').in('kind', ['pin_lockout', 'site_login_locked', 'device_lockout', 'pin_reset', 'session_revoked'])
      .order('created_at', { ascending: false }).limit(10)), []);

  const s = summary.data;
  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle="Today's attendance, items needing review, and payroll status." />
      <ErrorBox error={summary.error} />
      {summary.loading && !s && <Spinner />}
      {s && (
        <>
          {s.draft_rules > 0 && (
            <Notice tone="amber">
              {s.draft_rules} statutory rule version(s) are drafts. Payroll that uses them cannot be finalized until an admin
              verifies and approves them in <Link className="underline" to="/policies">Policies &amp; rules</Link>.
            </Notice>
          )}
          {s.payroll_impacts > 0 && (
            <Notice tone="red">
              {s.payroll_impacts} attendance correction(s) affect payroll that is already finalized. Void and reissue the
              affected run(s) from <Link className="underline" to="/payroll">Payroll runs</Link>.
            </Notice>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Punches today" value={s.punches_today} />
            <Stat label="Clocked in now" value={s.open_sessions} hint={s.stale_open_sessions ? `${s.stale_open_sessions} look like missed clock-outs` : undefined}
              tone={s.stale_open_sessions ? 'amber' : undefined} />
            <Stat label="Flags to review" value={s.unreviewed_flags} tone={s.unreviewed_flags ? 'amber' : undefined}
              hint={<Link className="underline" to="/attendance?flagged=1">Review attendance</Link>} />
            <Stat label="OT decisions" value={s.pending_ot} tone={s.pending_ot ? 'amber' : undefined}
              hint={<Link className="underline" to="/overtime">Open overtime review</Link>} />
            <Stat label="Leave requests" value={s.pending_leave} tone={s.pending_leave ? 'amber' : undefined}
              hint={<Link className="underline" to="/leave">Open leave</Link>} />
            <Stat label="PIN / login lockouts (24h)" value={s.lockouts_24h} tone={s.lockouts_24h ? 'red' : undefined}
              hint={`${s.failed_pins_24h} wrong PIN attempts`} />
            <Stat label="Payroll in progress" value={s.runs_in_progress} hint={`${s.runs_awaiting_payment} finalized, awaiting payment`} />
            <Stat label="Active employees / devices" value={`${s.active_employees} / ${s.active_devices}`} />
          </div>
        </>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Currently clocked in" padded={false}>
          <ErrorBox error={open.error} />
          {open.loading && !open.data ? <Spinner /> : !open.data?.length ? <Empty>No one is clocked in.</Empty> : (
            <Table>
              <thead><tr><Th>Employee</Th><Th>Site</Th><Th>Since</Th><Th>Elapsed</Th></tr></thead>
              <tbody>
                {open.data.map((w) => {
                  const mins = (Date.now() - new Date(w.clock_in_at).getTime()) / 60000;
                  return (
                    <Tr key={w.id}>
                      <Td>{w.employee_name} <span className="text-xs text-gray-400">{w.employee_code}</span></Td>
                      <Td>{w.site_name}</Td>
                      <Td className="whitespace-nowrap">{dateTime(w.clock_in_at)}</Td>
                      <Td>{mins > 960 ? <Badge tone="red">{hm(mins)}</Badge> : hm(mins)}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Recent security events" padded={false}>
          <ErrorBox error={events.error} />
          {events.loading && !events.data ? <Spinner /> : !events.data?.length ? <Empty>No recent lockouts or resets.</Empty> : (
            <Table>
              <thead><tr><Th>When</Th><Th>Event</Th><Th>Details</Th></tr></thead>
              <tbody>
                {events.data.map((e) => (
                  <Tr key={e.id}>
                    <Td className="whitespace-nowrap">{dateTime(e.created_at)}</Td>
                    <Td><Badge tone={e.kind.includes('lock') ? 'red' : 'gray'}>{e.kind.replace(/_/g, ' ')}</Badge></Td>
                    <Td className="text-xs text-gray-500">{Object.entries(e.details ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
