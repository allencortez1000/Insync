import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../lib/auth';
import { cx } from './ui';

interface Item { to: string; label: string; admin?: boolean }
const groups: { title: string; items: Item[] }[] = [
  { title: 'Overview', items: [{ to: '/', label: 'Dashboard' }] },
  { title: 'Attendance', items: [{ to: '/attendance', label: 'Attendance' }, { to: '/overtime', label: 'Overtime review' }] },
  {
    title: 'People',
    items: [
      { to: '/employees', label: 'Employees' }, { to: '/schedules', label: 'Schedules' }, { to: '/leave', label: 'Leave' },
      { to: '/allowances', label: 'Allowances' }, { to: '/advances', label: 'Cash advances' },
    ],
  },
  { title: 'Payroll', items: [{ to: '/payroll', label: 'Payroll runs' }, { to: '/payslips', label: 'Payslips' }, { to: '/reports', label: 'Reports' }] },
  {
    title: 'Setup',
    items: [
      { to: '/sites', label: 'Sites & devices' }, { to: '/policies', label: 'Policies & rules' },
      { to: '/users', label: 'Users & access', admin: true }, { to: '/audit', label: 'Audit log', admin: true },
    ],
  },
];

export function Layout() {
  const { profile, isAdmin, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="space-y-5 px-3 py-4">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{g.title}</div>
          {g.items.filter((i) => !i.admin || isAdmin).map((i) => (
            <NavLink key={i.to} to={i.to} end={i.to === '/'} onClick={() => setOpen(false)}
              className={({ isActive }) => cx('block rounded-md px-2 py-1.5 text-sm',
                isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-gray-700 hover:bg-gray-100')}>
              {i.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-full">
      <aside className="no-print hidden w-56 shrink-0 border-r border-gray-200 bg-white lg:block">
        <div className="border-b border-gray-100 px-5 py-4">
          <div className="text-base font-bold text-brand-700">Insync</div>
          <div className="text-xs text-gray-500">Attendance &amp; Payroll</div>
        </div>
        {nav}
      </aside>

      {open && (
        <div className="no-print fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)}>
          <aside className="h-full w-64 overflow-y-auto bg-white" onClick={(e) => e.stopPropagation()}>{nav}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-2.5">
          <button className="rounded p-1.5 text-gray-600 hover:bg-gray-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
          <div className="hidden text-xs text-gray-500 lg:block">All times in Philippine time (Asia/Manila)</div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-700">{profile?.full_name || profile?.email}</span>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs uppercase text-gray-600">{profile?.role}</span>
            <button className="text-gray-500 hover:text-gray-900" onClick={() => void signOut()}>Sign out</button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
