// Employee portal (/employee): each employee's own account, used on their own phone.
// View only, except for leave requests and the password. Clock In / Clock Out stays on the site device.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router';
import { supabaseConfigured } from '../lib/supabase';
import { useAsync } from '../lib/hooks';
import { AuthShell, IconInput } from '../pages/Login';
import { Button, ErrorBox, Notice, Spinner, cx } from '../components/ui';
import { Icon, Logo, type IconName } from '../components/icons';
import { SIGNED_OUT_EVENT, call, currentSession, signIn, signOut, type Me, type PortalSession } from './api';
import { AccountPage, AttendancePage, HomePage, LeavePage, PayslipPage, PayslipsPage, ThirteenthMonthPage } from './pages';

const TABS: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/employee', label: 'Home', icon: 'dashboard', end: true },
  { to: '/employee/attendance', label: 'Attendance', icon: 'clock' },
  { to: '/employee/leave', label: 'Leave', icon: 'leave' },
  { to: '/employee/payslips', label: 'Payslips', icon: 'receipt' },
  { to: '/employee/13th-month', label: '13th month', icon: 'gift' },
];

export function PortalApp() {
  const [session, setSession] = useState<PortalSession | null>(() => currentSession());
  useEffect(() => {
    const onOut = () => setSession(null);
    window.addEventListener(SIGNED_OUT_EVENT, onOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onOut);
  }, []);
  useEffect(() => {
    const before = document.title;
    document.title = 'Insync — Employee';
    return () => { document.title = before; };
  }, []);

  if (!supabaseConfigured) return <div className="p-6"><Notice tone="amber">The website is not connected to its database yet.</Notice></div>;
  if (!session) return <PortalLogin onSignedIn={() => setSession(currentSession())} />;
  return <SignedIn key={session.token} session={session} />;
}

function PortalLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(name.trim(), pin);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="relative space-y-5 rounded-2xl border border-gray-200 bg-white p-6 shadow-xl shadow-gray-900/5 sm:p-8 lg:border-0 lg:p-0 lg:shadow-none">
        <div>
          <div className="mb-5 hidden items-center gap-3 lg:flex">
            <Logo className="h-12 w-12" />
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">Employee account</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Employee sign-in</h1>
          <p className="mt-1 text-sm text-gray-500">See your attendance, overtime, leave, payslips and 13th month pay.</p>
        </div>
        <IconInput icon="user" label="Your name" value={name} onChange={(e) => setName(e.target.value)} required
          autoComplete="username" autoCapitalize="words" placeholder="Juan Dela Cruz" />
        <IconInput icon="lock" label="PIN" type={show ? 'text' : 'password'} value={pin} required
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric" maxLength={6} autoComplete="current-password" placeholder="6-digit attendance PIN"
          trailing={
            <button type="button" onClick={() => setShow((v) => !v)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              aria-label={show ? 'Hide PIN' : 'Show PIN'}>
              <Icon name={show ? 'eyeOff' : 'eye'} className="h-5 w-5" />
            </button>
          } />
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" className="w-full !py-2.5 !text-[15px]" busy={busy} disabled={pin.length !== 6 || !name.trim()}>
          {!busy && <Icon name="login" className="h-[18px] w-[18px]" />}Sign in
        </Button>
        <p className="text-xs leading-relaxed text-gray-500">
          Type your name as it appears on your payslip (first name and last name) and the same PIN you use to clock in.
          You can also type your employee code, for example EMP-0001. Forgot your PIN? Ask the office to reset it.
          Clock In and Clock Out are done on the attendance device at your site, not here.
        </p>
        <div className="border-t border-gray-100 pt-4 text-center text-sm text-gray-500">
          Office staff? <a href="/" className="font-semibold text-brand-700 hover:underline">Admin website</a>
        </div>
      </form>
    </AuthShell>
  );
}

function SignedIn({ session }: { session: PortalSession }) {
  const me = useAsync(() => call<Me>('emp_me'), [session.token]);

  if (me.loading && !me.data) return <Spinner />;
  if (!me.data) {
    return (
      <div className="mx-auto max-w-md space-y-3 p-6">
        <ErrorBox error={me.error ?? 'Could not load your account.'} />
        <div className="flex gap-2"><Button variant="primary" onClick={me.reload}>Try again</Button><Button onClick={() => void signOut()}>Sign out</Button></div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="payslips/:id" element={<PayslipPage />} />
      <Route path="*" element={
        <Frame me={me.data}>
          <Routes>
            <Route index element={<HomePage me={me.data} />} />
            <Route path="attendance" element={<AttendancePage me={me.data} />} />
            <Route path="leave" element={<LeavePage me={me.data} onChanged={me.reload} />} />
            <Route path="payslips" element={<PayslipsPage />} />
            <Route path="13th-month" element={<ThirteenthMonthPage me={me.data} />} />
            <Route path="account" element={<AccountPage me={me.data} />} />
            <Route path="*" element={<Navigate to="/employee" replace />} />
          </Routes>
        </Frame>
      } />
    </Routes>
  );
}

function Frame({ me, children, bare }: { me: Me; children: ReactNode; bare?: boolean }) {
  const e = me.employee;
  return (
    <div className="flex min-h-full flex-col">
      <header className="no-print sticky top-0 z-30 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-3 px-4">
          <Link to="/employee" className="flex min-w-0 items-center gap-2.5">
            <Logo className="h-8 w-8" />
            <span className="hidden text-[15px] font-bold text-gray-900 sm:block">Insync</span>
          </Link>
          <div className="ml-auto min-w-0 text-right leading-tight">
            <div className="truncate text-sm font-semibold text-gray-900">{e.name}</div>
            <div className="truncate text-xs text-gray-500">{e.employee_code}{e.site_name ? ` · ${e.site_name}` : ''}</div>
          </div>
          {!bare && (
            <Link to="/employee/account" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900" aria-label="Account" title="Account">
              <Icon name="user" className="h-[18px] w-[18px]" />
            </Link>
          )}
          <button className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900" onClick={() => void signOut()} aria-label="Sign out" title="Sign out">
            <Icon name="logout" className="h-[18px] w-[18px]" />
          </button>
        </div>
        {!bare && (
          <nav className="mx-auto hidden w-full max-w-4xl gap-1 px-3 sm:flex" aria-label="Sections">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end}
                className={({ isActive }) => cx('flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium',
                  isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-gray-500 hover:text-gray-900')}>
                <Icon name={t.icon} className="h-4 w-4" />{t.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>

      <main className={cx('mx-auto w-full max-w-4xl flex-1 px-4 py-5 sm:py-7', !bare && 'pb-24 sm:pb-10')}>{children}</main>

      {/* Phone navigation */}
      {!bare && (
        <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] sm:hidden" aria-label="Sections">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end}
              className={({ isActive }) => cx('flex flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium',
                isActive ? 'text-brand-700' : 'text-gray-500')}>
              <Icon name={t.icon} className="h-5 w-5" /><span className="truncate">{t.label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
