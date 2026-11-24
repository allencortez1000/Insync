import { useState } from 'react';
import { q, rpc, supabase } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { dateTime, mapsLink } from '../lib/format';
import type { DeviceSession, Site, SiteAccount } from '../lib/types';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Modal, Notice, PageHeader, Spinner, StatusBadge, Table, Tabs, Td, Th, Tr } from '../components/ui';

const MIN_PASSWORD = 10;
const emptySite = { name: '', address: '', region: '', is_active: true, password: '' };
type SiteForm = typeof emptySite & { id?: string; code?: string; originalName?: string };

function friendly(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('sites_name_unique_idx')) return new Error('A site with this name already exists. Site names must be unique because the app signs in with them.');
  return e instanceof Error ? e : new Error(msg);
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <Input type={show ? 'text' : 'password'} autoComplete="new-password" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} />
      <Button onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</Button>
    </div>
  );
}

export function Sites() {
  const { isAdmin } = useAuth();
  const { run } = useFeedback();
  const sites = useAsync(() => q<Site[]>(supabase.from('sites').select('*').order('name')), []);
  const accounts = useAsync(() => q<SiteAccount[]>(supabase.from('site_accounts')
    .select('id, site_id, username, is_active, failed_attempts, locked_until, password_changed_at')), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<SiteForm | null>(null);
  const [busy, setBusy] = useState(false);

  const acctFor = (id: string) => accounts.data?.find((a) => a.site_id === id);
  const site = sites.data?.find((s) => s.id === selected) ?? null;
  const isNew = editing !== null && !editing.id;
  const pwOk = editing !== null && (editing.password === '' ? !isNew : editing.password.length >= MIN_PASSWORD);

  async function save() {
    if (!editing) return;
    setBusy(true);
    const row = {
      name: editing.name.trim(), address: editing.address || null, region: editing.region || null, is_active: editing.is_active,
    };
    const ok = await run(async () => {
      try {
        let id = editing.id;
        if (id) await q(supabase.from('sites').update(row).eq('id', id));
        else id = (await q<{ id: string }>(supabase.from('sites').insert(row).select('id').single())).id;
        if (editing.password) await rpc('admin_set_site_password', { p_site_id: id, p_password: editing.password });
      } catch (e) {
        throw friendly(e);
      }
    }, isNew ? 'Site created. Devices can sign in with the site name and password.' : 'Site saved');
    setBusy(false);
    if (ok) { setEditing(null); sites.reload(); accounts.reload(); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Sites & devices" subtitle="The attendance app signs in with the site name and the site's password."
        actions={isAdmin && <Button variant="primary" onClick={() => setEditing({ ...emptySite })}>New site</Button>} />
      <ErrorBox error={sites.error} />
      <Card padded={false}>
        {sites.loading && !sites.data ? <Spinner /> : !sites.data?.length ? <Empty>No sites yet.</Empty> : (
          <Table>
            <thead><tr><Th>Site name (app sign-in)</Th><Th>Code</Th><Th>Region</Th><Th>App password</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {sites.data.map((s) => {
                const a = acctFor(s.id);
                return (
                  <Tr key={s.id} onClick={() => setSelected(s.id === selected ? null : s.id)} className={s.id === selected ? 'bg-brand-50' : ''}>
                    <Td className="font-medium">{s.name}</Td>
                    <Td className="font-mono text-xs text-gray-500">{s.code}</Td>
                    <Td>{s.region ?? '—'}</Td>
                    <Td>{a ? <Badge tone="green">set</Badge> : <Badge tone="amber">not set</Badge>}
                      {a && !a.is_active && <> <Badge tone="red">disabled</Badge></>}
                      {a?.locked_until && new Date(a.locked_until) > new Date() && <> <Badge tone="red">locked</Badge></>}</Td>
                    <Td>{s.is_active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</Td>
                    <Td className="text-right">
                      {isAdmin && <Button size="sm" onClick={(e) => { e.stopPropagation(); setEditing({
                        id: s.id, code: s.code, originalName: s.name, name: s.name, address: s.address ?? '', region: s.region ?? '',
                        is_active: s.is_active, password: '' }); }}>Edit</Button>}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {site && <SitePanel site={site} account={acctFor(site.id)} onChanged={accounts.reload} />}

      <Modal open={editing !== null} title={isNew ? 'New site' : `Edit site · ${editing?.code ?? ''}`} onClose={() => setEditing(null)}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}
          disabled={!editing?.name.trim() || !pwOk}>Save</Button></>}>
        {editing && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Site name" className="col-span-2" hint="Used to sign in on the attendance app. Must be unique.">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Makati Warehouse" />
            </Field>
            {!isNew && (
              <Field label="Code" className="col-span-2" hint="Generated automatically; cannot be edited.">
                <Input value={editing.code ?? ''} disabled readOnly />
              </Field>
            )}
            <Field label={isNew ? 'App password' : 'New app password (optional)'} className="col-span-2"
              hint={isNew ? `At least ${MIN_PASSWORD} characters. Staff type the site name and this password on the attendance app.`
                : `Leave blank to keep the current password. Changing it signs out all of this site's devices.`}>
              <PasswordInput value={editing.password} onChange={(v) => setEditing({ ...editing, password: v })} />
              {editing.password !== '' && editing.password.length < MIN_PASSWORD && <span className="mt-1 block text-xs text-red-600">{MIN_PASSWORD - editing.password.length} more character(s) needed</span>}
            </Field>
            <Field label="Address" className="col-span-2"><Input value={editing.address} onChange={(e) => setEditing({ ...editing, address: e.target.value })} /></Field>
            <Field label="Region" className="col-span-2" hint="Used for regional wage / holiday rules"><Input value={editing.region} onChange={(e) => setEditing({ ...editing, region: e.target.value })} /></Field>
            {!isNew && <Checkbox label="Active" checked={editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} />}
            {!isNew && editing.originalName && editing.name.trim() !== editing.originalName && (
              <div className="col-span-2"><Notice tone="amber">Renaming changes the name used to sign in on the app. Devices already signed in stay signed in.</Notice></div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function SitePanel({ site, account, onChanged }: { site: Site; account: SiteAccount | undefined; onChanged: () => void }) {
  const { isAdmin } = useAuth();
  const { run, prompt, confirm } = useFeedback();
  const [tab, setTab] = useState<'account' | 'devices'>('account');
  const [password, setPassword] = useState<string | null>(null);
  const devices = useAsync(() => q<DeviceSession[]>(supabase.from('device_sessions')
    .select('id, site_id, device_label, platform, app_version, created_at, last_seen_at, expires_at, revoked_at, revoke_reason')
    .eq('site_id', site.id).order('last_seen_at', { ascending: false }).limit(100)), [site.id]);
  const link = mapsLink(site.latitude, site.longitude);

  async function savePassword() {
    if (!password) return;
    const ok = await run(() => rpc('admin_set_site_password', { p_site_id: site.id, p_password: password }),
      account ? 'Password changed. Existing devices were signed out.' : 'App password set.');
    if (ok) { setPassword(null); onChanged(); devices.reload(); }
  }

  async function toggleAccount() {
    if (!account) return;
    const enable = !account.is_active;
    if (!enable && !(await confirm({ title: 'Disable attendance sign-in?', message: 'All devices for this site will be signed out and attendance will stop until re-enabled.', danger: true, confirmText: 'Disable' }))) return;
    if (await run(() => rpc('admin_set_site_account_active', { p_site_id: site.id, p_active: enable }), enable ? 'Sign-in enabled' : 'Sign-in disabled')) {
      onChanged(); devices.reload();
    }
  }

  async function revoke(d: DeviceSession) {
    const reason = await prompt({ title: 'Sign out this device?', label: 'Reason', minLength: 3, multiline: false, confirmText: 'Revoke', danger: true,
      message: `${d.device_label ?? 'Device'} will need the site name and password to sign in again.` });
    if (reason === null) return;
    if (await run(() => rpc('revoke_device_session', { p_session_id: d.id, p_reason: reason }), 'Device signed out')) devices.reload();
  }

  return (
    <Card title={`${site.name} (${site.code})`} actions={link && <a className="text-sm text-brand-700 underline" href={link} target="_blank" rel="noreferrer">Map</a>}>
      <Tabs tabs={[{ id: 'account', label: 'App sign-in' }, { id: 'devices', label: 'Device sessions' }]} value={tab} onChange={setTab} />
      {tab === 'account' && (
        <div className="space-y-3">
          <div className="rounded-md bg-gray-50 p-3 text-sm">
            On the attendance app, sign in with:
            <div className="mt-1">Site name: <b>{site.name}</b></div>
            <div>Password: {account ? <Badge tone="green">set</Badge> : <Badge tone="amber">not set yet</Badge>}</div>
          </div>
          {account && (
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div>Status: {account.is_active ? <Badge tone="green">enabled</Badge> : <Badge tone="red">disabled</Badge>}</div>
              <div>Password last changed: {dateTime(account.password_changed_at)}</div>
              <div>Failed sign-ins: {account.failed_attempts}{account.locked_until && new Date(account.locked_until) > new Date() && <> · locked until {dateTime(account.locked_until)}</>}</div>
            </div>
          )}
          {isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setPassword('')}>{account ? 'Change password' : 'Set password'}</Button>
              {account && <Button variant={account.is_active ? 'danger' : 'secondary'} onClick={() => void toggleAccount()}>{account.is_active ? 'Disable sign-in' : 'Enable sign-in'}</Button>}
            </div>
          ) : <p className="text-xs text-gray-500">Only admins can change the site password.</p>}
          <p className="text-xs text-gray-500">The site sign-in can only see this site's roster and record attendance. It has no access to salaries, payroll, government IDs or PINs.</p>
        </div>
      )}
      {tab === 'devices' && (
        devices.loading && !devices.data ? <Spinner /> : !devices.data?.length ? <Empty>No devices have signed in.</Empty> : (
          <Table>
            <thead><tr><Th>Device</Th><Th>Platform / app</Th><Th>Signed in</Th><Th>Last seen</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {devices.data.map((d) => {
                const active = !d.revoked_at && new Date(d.expires_at) > new Date();
                return (
                  <Tr key={d.id}>
                    <Td>{d.device_label ?? '—'}</Td>
                    <Td className="text-xs">{d.platform ?? '—'} {d.app_version && `· v${d.app_version}`}</Td>
                    <Td className="whitespace-nowrap">{dateTime(d.created_at)}</Td>
                    <Td className="whitespace-nowrap">{dateTime(d.last_seen_at)}</Td>
                    <Td>{active ? <Badge tone="green">active</Badge> : d.revoked_at ? <span title={d.revoke_reason ?? ''}><StatusBadge status="voided" /> <span className="text-xs text-gray-500">{d.revoke_reason}</span></span> : <Badge>expired</Badge>}</Td>
                    <Td className="text-right">{active && <Button size="sm" variant="danger" onClick={() => void revoke(d)}>Revoke</Button>}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )
      )}
      <Modal open={password !== null} title={`App password · ${site.name}`} onClose={() => setPassword(null)}
        footer={<><Button onClick={() => setPassword(null)}>Cancel</Button><Button variant="primary" onClick={() => void savePassword()}
          disabled={(password ?? '').length < MIN_PASSWORD}>Save</Button></>}>
        <Field label="New password" hint={`At least ${MIN_PASSWORD} characters. Share it only with the people who set up devices.`}>
          <PasswordInput value={password ?? ''} onChange={setPassword} />
        </Field>
        {account && <Notice tone="amber">Saving signs out every device currently signed in to this site.</Notice>}
      </Modal>
    </Card>
  );
}
