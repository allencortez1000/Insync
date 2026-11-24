import { useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useSites } from '../lib/lookups';
import { dateTime } from '../lib/format';
import type { AppRole, AppUser } from '../lib/types';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select, Spinner, Table, Td, Th, Tr } from '../components/ui';

interface Scope { user_id: string; site_id: string }

export function Users() {
  const { profile } = useAuth();
  const sites = useSites();
  const users = useAsync(() => q<AppUser[]>(supabase.from('app_users').select('*').order('created_at')), []);
  const scopes = useAsync(() => q<Scope[]>(supabase.from('staff_site_scopes').select('user_id, site_id')), []);
  const [editing, setEditing] = useState<AppUser | null>(null);
  const siteNames = (uid: string) => scopes.data?.filter((s) => s.user_id === uid)
    .map((s) => sites.data?.find((x) => x.id === s.site_id)?.name).filter(Boolean).join(', ');

  return (
    <div className="space-y-4">
      <PageHeader title="Users & access" subtitle="Individual website accounts for admins and authorized staff." />
      <Notice>
        New staff sign up on the website and appear here as <b>pending</b>. Staff can manage employees, attendance, salaries and payroll for
        their assigned sites only; admins have every site plus policies, users and audit history.
      </Notice>
      <ErrorBox error={users.error} />
      <Card padded={false}>
        {users.loading && !users.data ? <Spinner /> : !users.data?.length ? <Empty /> : (
          <Table>
            <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Site scope</Th><Th>Status</Th><Th>Joined</Th><Th /></tr></thead>
            <tbody>{users.data.map((u) => (
              <Tr key={u.id}>
                <Td className="font-medium">{u.full_name || '—'}{u.id === profile?.id && <span className="ml-1 text-xs text-gray-400">(you)</span>}</Td>
                <Td>{u.email}</Td>
                <Td>{u.role ? <Badge tone={u.role === 'admin' ? 'purple' : 'blue'}>{u.role}</Badge> : <Badge tone="amber">pending</Badge>}</Td>
                <Td className="text-xs">{u.role === 'admin' || u.all_sites ? 'All sites' : siteNames(u.id) || '—'}</Td>
                <Td>{u.is_active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
                <Td className="whitespace-nowrap text-xs">{dateTime(u.created_at)}</Td>
                <Td className="text-right"><Button size="sm" variant={u.role ? 'secondary' : 'primary'} onClick={() => setEditing(u)}>{u.role ? 'Edit' : 'Approve'}</Button></Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      {editing && <EditAccess user={editing} current={scopes.data?.filter((s) => s.user_id === editing.id).map((s) => s.site_id) ?? []}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); users.reload(); scopes.reload(); }} />}
    </div>
  );
}

function EditAccess({ user, current, onClose, onSaved }: { user: AppUser; current: string[]; onClose: () => void; onSaved: () => void }) {
  const { run } = useFeedback();
  const sites = useSites();
  const [role, setRole] = useState<AppRole | ''>(user.role ?? 'staff');
  const [active, setActive] = useState(user.role ? user.is_active : true);
  const [allSites, setAllSites] = useState(user.all_sites);
  const [siteIds, setSiteIds] = useState<string[]>(current);
  const [name, setName] = useState(user.full_name);

  async function save() {
    const ok = await run(() => rpc('admin_set_user_access', {
      p_user_id: user.id, p_role: role || null, p_is_active: active, p_all_sites: allSites, p_site_ids: siteIds, p_full_name: name,
    }), 'Access updated');
    if (ok) onSaved();
  }

  return (
    <Modal open title={`Access · ${user.email}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!role || (role === 'staff' && !allSites && !siteIds.length && active)} onClick={() => void save()}>Save</Button></>}>
      <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Role">
        <Select value={role} onChange={(e) => setRole(e.target.value as AppRole)}>
          <option value="staff">Staff — assigned sites</option><option value="admin">Admin — everything</option>
        </Select>
      </Field>
      <Checkbox label="Active (can sign in and work)" checked={active} onChange={(e) => setActive(e.target.checked)} />
      {role === 'staff' && (
        <div className="space-y-2 rounded-md bg-gray-50 p-3">
          <Checkbox label="All sites" checked={allSites} onChange={(e) => setAllSites(e.target.checked)} />
          {!allSites && <div className="grid grid-cols-2 gap-2">{sites.data?.map((s) => (
            <Checkbox key={s.id} label={s.name} checked={siteIds.includes(s.id)}
              onChange={(e) => setSiteIds(e.target.checked ? [...siteIds, s.id] : siteIds.filter((x) => x !== s.id))} />
          ))}</div>}
        </div>
      )}
      <p className="text-xs text-gray-500">At least one active admin must always remain.</p>
    </Modal>
  );
}
