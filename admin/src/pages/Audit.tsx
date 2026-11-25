import { useState } from 'react';
import { q, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { addDays, dateTime, phStartOfDay, todayPH } from '../lib/format';
import type { AppUser } from '../lib/types';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Th, Tr } from '../components/ui';

interface AuditRow {
  id: number; occurred_at: string; actor_user_id: string | null; actor_kind: string; action: string; entity: string;
  entity_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
}

const ENTITIES = ['employees', 'employee_rates', 'employee_site_assignments', 'employee_schedules', 'pin_credentials', 'sites', 'site_accounts',
  'app_users', 'staff_site_scopes', 'payroll_runs', 'payroll_adjustments', 'payment_records', 'ot_decisions', 'leave_entries',
  'allowance_rules', 'cash_advances', 'advance_ledger', 'statutory_rule_versions', 'payroll_settings', 'holidays', 'schedules', 'day_type_multipliers'];

function changedKeys(a: Record<string, unknown> | null, b: Record<string, unknown> | null): string[] {
  if (!a || !b) return [];
  return Object.keys(b).filter((k) => k !== 'updated_at' && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export function Audit() {
  const today = todayPH();
  const [from, setFrom] = useState(addDays(today, -7));
  const [to, setTo] = useState(today);
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState('');
  const [view, setView] = useState<AuditRow | null>(null);
  const users = useAsync(() => q<AppUser[]>(supabase.from('app_users').select('*')), []);
  const rows = useAsync(async () => {
    let query = supabase.from('audit_events').select('*')
      .gte('occurred_at', phStartOfDay(from)).lt('occurred_at', phStartOfDay(addDays(to, 1)))
      .order('occurred_at', { ascending: false }).limit(500);
    if (entity) query = query.eq('entity', entity);
    if (entityId.trim()) query = query.eq('entity_id', entityId.trim());
    return q<AuditRow[]>(query);
  }, [from, to, entity, entityId]);
  const who = (id: string | null) => (id ? users.data?.find((u) => u.id === id)?.full_name || users.data?.find((u) => u.id === id)?.email || id.slice(0, 8) : 'system');

  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" subtitle="Every change to people, pay, policies and access, with the actor. Secrets are never logged." />
      <div className="filter-bar">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Record type" className="w-56">
          <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">All</option>{ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
        </Field>
        <Field label="Record id" className="w-72"><Input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="uuid" /></Field>
      </div>
      <ErrorBox error={rows.error} />
      <Card padded={false}>
        {rows.loading && !rows.data ? <Spinner /> : !rows.data?.length ? <Empty>No audit events.</Empty> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Record</Th><Th>Changed</Th><Th /></tr></thead>
            <tbody>{rows.data.map((r) => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap">{dateTime(r.occurred_at)}</Td>
                <Td>{who(r.actor_user_id)}</Td>
                <Td><Badge tone={r.action === 'delete' ? 'red' : r.action === 'insert' ? 'green' : 'blue'}>{r.action}</Badge></Td>
                <Td className="text-xs">{r.entity} <span className="font-mono text-gray-400">{r.entity_id?.slice(0, 8)}</span></Td>
                <Td className="max-w-md text-xs text-gray-600">{r.action === 'update' ? changedKeys(r.before, r.after).join(', ') : ''}</Td>
                <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setView(r)}>Details</Button></Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <Modal open={view !== null} wide title={view ? `${view.entity} · ${view.action}` : ''} onClose={() => setView(null)}>
        {view && (
          <div className="grid gap-3 md:grid-cols-2">
            <div><div className="mb-1 text-xs font-semibold uppercase text-gray-500">Before</div><pre className="max-h-96 overflow-auto rounded bg-gray-50 p-2 text-xs">{JSON.stringify(view.before, null, 2)}</pre></div>
            <div><div className="mb-1 text-xs font-semibold uppercase text-gray-500">After</div><pre className="max-h-96 overflow-auto rounded bg-gray-50 p-2 text-xs">{JSON.stringify(view.after, null, 2)}</pre></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
