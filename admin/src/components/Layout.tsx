import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { Icon, Logo, type IconName } from './icons';
import { cx } from './ui';

interface Item { to: string; label: string; icon: IconName; admin?: boolean }
const groups: { title: string; items: Item[] }[] = [
  { title: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: 'dashboard' }] },
  {
    title: 'Attendance',
    items: [{ to: '/attendance', label: 'Attendance', icon: 'clock' }, { to: '/overtime', label: 'Overtime review', icon: 'timer' }],
  },
  {
    title: 'People',
    items: [
      { to: '/employees', label: 'Employees', icon: 'users' }, { to: '/schedules', label: 'Schedules', icon: 'calendar' },
      { to: '/leave', label: 'Leave', icon: 'leave' }, { to: '/allowances', label: 'Allowances', icon: 'wallet' },
      { to: '/advances', label: 'Cash advances', icon: 'cash' },
    ],
  },
  {
    title: 'Payroll',
    items: [
      { to: '/payroll', label: 'Payroll runs', icon: 'payroll' }, { to: '/payslips', label: 'Payslips', icon: 'receipt' },
      { to: '/reports', label: 'Reports', icon: 'chart' },
    ],
  },
  {
    title: 'Setup',
    items: [
      { to: '/sites', label: 'Sites & devices', icon: 'site' }, { to: '/policies', label: 'Policies & rules', icon: 'sliders' },
      { to: '/users', label: 'Users & access', icon: 'shield', admin: true }, { to: '/audit', label: 'Audit log', icon: 'history', admin: true },
    ],
  },
];

function initials(name: string) {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase();
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <Logo />
      <div className="leading-tight">
        <div className="text-[15px] font-bold text-gray-900">Insync</div>
        <div className="text-xs text-gray-500">Attendance &amp; Payroll</div>
      </div>
    </div>
  );
}

export function Layout() {
  const { profile, isAdmin, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const name = profile?.full_name || profile?.email || '';

  // Close the mobile menu on navigation and lock page scroll while it is open.
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const nav = (
    <nav className="space-y-5 px-3 py-4" aria-label="Main">
      {groups.map((g) => {
        const items = g.items.filter((i) => !i.admin || isAdmin);
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{g.title}</div>
            <div className="space-y-0.5">
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'}
                  className={({ isActive }) => cx('group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive ? 'bg-brand-50 font-semibold text-brand-700' : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900')}>
                  {({ isActive }) => (
                    <>
                      <Icon name={i.icon} className={cx('h-[18px] w-[18px] shrink-0', isActive ? 'text-brand-600' : 'text-gray-400 group-hover:text-gray-600')} />
                      <span className="truncate">{i.label}</span>
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );

  const userCard = (
    <div className="flex items-center gap-3 border-t border-gray-100 p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">{initials(name)}</span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-medium text-gray-900">{name}</div>
        <div className="text-xs capitalize text-gray-500">{profile?.role}</div>
      </div>
      <button className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900" onClick={() => void signOut()} aria-label="Sign out" title="Sign out">
        <Icon name="logout" className="h-[18px] w-[18px]" />
      </button>
    </div>
  );

  return (
    <div className="flex min-h-full">
      <aside className="no-print sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-gray-200 bg-white lg:flex">
        <div className="border-b border-gray-100 px-5 py-4"><Brand /></div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        {userCard}
      </aside>

      {/* Mobile / tablet menu */}
      <div className={cx('no-print fixed inset-0 z-40 lg:hidden', open ? 'pointer-events-auto' : 'pointer-events-none')} aria-hidden={!open}>
        <div className={cx('absolute inset-0 bg-gray-900/40 transition-opacity', open ? 'opacity-100' : 'opacity-0')} onClick={() => setOpen(false)} />
        <aside className={cx('absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full')}>
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <Brand />
            <button className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" onClick={() => setOpen(false)} aria-label="Close menu">
              <Icon name="close" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">{nav}</div>
          {userCard}
        </aside>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-gray-200 bg-white/90 px-3 backdrop-blur sm:px-4">
          <button className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <div className="min-w-0 lg:hidden"><Logo className="h-8 w-8" /></div>
          <div className="hidden items-center gap-2 text-xs text-gray-500 lg:flex">
            <Icon name="globe" className="h-4 w-4" /> All times in Philippine time (Asia/Manila)
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
            <a href="/site/" className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 md:inline-flex">
              <Icon name="phone" className="h-4 w-4" /> Attendance app
            </a>
            <span className="hidden min-w-0 truncate text-sm text-gray-700 sm:block lg:hidden">{name}</span>
            <span className="hidden rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium uppercase text-gray-600 sm:inline lg:hidden">{profile?.role}</span>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 sm:hidden" title={name}>
              {initials(name)}
            </span>
            <button className="inline-flex items-center gap-1.5 rounded-lg p-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 sm:px-2.5 sm:py-1.5 lg:hidden"
              onClick={() => void signOut()} aria-label="Sign out">
              <Icon name="logout" className="h-[18px] w-[18px]" /><span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
