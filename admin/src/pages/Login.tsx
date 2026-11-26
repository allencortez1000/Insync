import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { Button, ErrorBox, Notice, cx } from '../components/ui';
import { Icon, Logo, type IconName } from '../components/icons';

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'clock', title: 'Attendance', text: 'Clock in and out at each site, with location and a full correction history.' },
  { icon: 'payroll', title: 'Payroll', text: 'Weekly payroll runs, payslips and government contribution reports.' },
  { icon: 'shield', title: 'Accountability', text: 'Personal accounts and an audit log for every change.' },
];

const PHOTO = '/images/login-warehouse.jpg';
const PHOTO_CREDIT = 'Photo: Adrian Sulyok / Unsplash';

/** Sign-in frame: photo panel with the brand on wide screens, photo banner with the brand on phones. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full bg-white">
      <aside className="relative hidden w-[52%] max-w-3xl overflow-hidden lg:block">
        <img src={PHOTO} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-br from-brand-800/95 via-brand-700/85 to-brand-600/60" />
        <div className="relative flex h-full flex-col justify-between p-10 text-white xl:p-14">
          <div className="flex items-center gap-3">
            <Logo className="h-12 w-12 drop-shadow-lg" />
            <div className="leading-tight">
              <div className="text-2xl font-bold tracking-wide">Insync</div>
              <div className="text-sm text-brand-100">Attendance &amp; Payroll</div>
            </div>
          </div>
          <div className="max-w-xl space-y-6">
            <h2 className="text-4xl font-bold leading-tight xl:text-5xl">Every site, every shift, paid right.</h2>
            <p className="text-lg text-brand-100">One place for HR, payroll and site staff to keep time records and pay accurate.</p>
            <ul className="grid gap-3 pt-2">
              {FEATURES.map((f) => (
                <li key={f.title} className="flex gap-4 rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-md">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/20"><Icon name={f.icon} /></span>
                  <div>
                    <div className="font-semibold">{f.title}</div>
                    <div className="text-sm text-brand-100">{f.text}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-brand-100/80">
            <span className="inline-flex items-center gap-1.5"><Icon name="globe" className="h-4 w-4" />All times in Philippine time (Asia/Manila)</span>
            <span>{PHOTO_CREDIT}</span>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-gray-50 lg:bg-white">
        {/* Phone / tablet banner */}
        <div className="relative h-56 shrink-0 overflow-hidden sm:h-64 lg:hidden">
          <img src={PHOTO} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-brand-800/90 via-brand-700/75 to-brand-600/70" />
          <div className="relative mx-auto flex h-full w-full max-w-md flex-col justify-center px-6 pb-10 text-white sm:px-0">
            <div className="flex items-center gap-3">
              <Logo className="h-12 w-12 drop-shadow-lg" />
              <div className="leading-tight">
                <div className="text-2xl font-bold">Insync</div>
                <div className="text-sm text-brand-100">Attendance &amp; Payroll</div>
              </div>
            </div>
            <p className="mt-3 max-w-md text-sm text-brand-100">Every site, every shift, paid right.</p>
          </div>
        </div>
        <div className="flex flex-1 items-start justify-center px-4 pb-10 lg:items-center lg:px-10 lg:py-10">
          <div className="-mt-10 w-full max-w-md lg:mt-0">{children}</div>
        </div>
        <div className="pb-4 text-center text-[11px] text-gray-400 lg:hidden">{PHOTO_CREDIT}</div>
      </main>
    </div>
  );
}

export function IconInput({ icon, label, trailing, ...props }: InputHTMLAttributes<HTMLInputElement> & { icon: IconName; label: string; trailing?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-gray-700">{label}</span>
      <span className="group relative flex items-center">
        <Icon name={icon} className="pointer-events-none absolute left-3 h-5 w-5 text-gray-400 group-focus-within:text-brand-600" />
        <input {...props}
          className={cx('w-full rounded-xl border border-gray-300 bg-white py-2.5 pl-10 text-[15px] shadow-sm placeholder:text-gray-400',
            'focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100', trailing ? 'pr-11' : 'pr-3')} />
        {trailing && <span className="absolute right-1.5">{trailing}</span>}
      </span>
    </label>
  );
}

export function Login() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setError(error.message);
    } else {
      if (password.length < 10) {
        setError('Use at least 10 characters for your password.');
        setBusy(false);
        return;
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(), password, options: { data: { full_name: fullName.trim() } },
      });
      if (error) setError(error.message);
      else if (!data.session) setInfo('Check your email to confirm your account, then sign in. An admin must approve your access.');
    }
    setBusy(false);
  }

  const signin = mode === 'signin';
  return (
    <AuthShell>
      <form onSubmit={submit} className="relative space-y-5 rounded-2xl border border-gray-200 bg-white p-6 shadow-xl shadow-gray-900/5 sm:p-8 lg:border-0 lg:p-0 lg:shadow-none">
        <div>
          <div className="mb-5 hidden items-center gap-3 lg:flex">
            <Logo className="h-12 w-12" />
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">Admin website</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{signin ? 'Welcome back' : 'Request access'}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {signin ? 'Sign in to the admin website for HR, payroll and site staff.' : 'Create your personal account. An admin approves it before you can sign in.'}
          </p>
        </div>
        {!signin && (
          <IconInput icon="user" label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="name" placeholder="Juan Dela Cruz" />
        )}
        <IconInput icon="mail" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@company.com" />
        <IconInput icon="lock" label="Password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required
          autoComplete={signin ? 'current-password' : 'new-password'} placeholder={signin ? 'Your password' : 'At least 10 characters'}
          trailing={
            <button type="button" onClick={() => setShowPassword((v) => !v)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              aria-label={showPassword ? 'Hide password' : 'Show password'}>
              <Icon name={showPassword ? 'eyeOff' : 'eye'} className="h-5 w-5" />
            </button>
          } />
        <ErrorBox error={error} />
        {info && <Notice tone="green">{info}</Notice>}
        <Button type="submit" variant="primary" className="w-full !py-2.5 !text-[15px]" busy={busy}>
          {!busy && <Icon name={signin ? 'login' : 'user'} className="h-[18px] w-[18px]" />}
          {signin ? 'Sign in' : 'Create account'}
        </Button>
        <div className="text-center text-sm text-gray-600">
          {signin ? 'New staff member? ' : 'Have an account? '}
          <button type="button" className="font-semibold text-brand-700 hover:underline"
            onClick={() => { setMode(signin ? 'signup' : 'signin'); setError(null); setInfo(null); }}>
            {signin ? 'Request access' : 'Sign in'}
          </button>
        </div>
        <div className="space-y-2 border-t border-gray-100 pt-5">
          <a href="/employee" className="flex items-center gap-3 rounded-xl border border-gray-200 p-3 text-sm hover:border-brand-200 hover:bg-brand-50">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon name="user" /></span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-gray-900">Employee account</span>
              <span className="block text-gray-500">Your attendance, leave, payslips and 13th month pay</span>
            </span>
            <Icon name="arrowRight" className="h-4 w-4 text-gray-400" />
          </a>
          <a href="/site/" className="flex items-center gap-3 rounded-xl border border-gray-200 p-3 text-sm hover:border-brand-200 hover:bg-brand-50">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon name="phone" /></span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-gray-900">Site attendance app</span>
              <span className="block text-gray-500">For the shared device at each site</span>
            </span>
            <Icon name="arrowRight" className="h-4 w-4 text-gray-400" />
          </a>
        </div>
        <p className="text-xs leading-relaxed text-gray-500">
          Each person uses their own account so every change has an identifiable actor. Site attendance accounts are used only in the attendance app.
        </p>
      </form>
    </AuthShell>
  );
}

export function PendingApproval() {
  const { profile, session, refreshProfile, signOut } = useAuth();
  const email = profile?.email ?? session?.user.email;
  return (
    <AuthShell>
      <div className="relative space-y-5 rounded-2xl border border-gray-200 bg-white p-6 shadow-xl shadow-gray-900/5 sm:p-8 lg:border-0 lg:p-0 lg:shadow-none">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700"><Icon name="clock" className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Waiting for access</h1>
          <p className="mt-2 text-sm text-gray-600">
            You are signed in as <b className="break-all">{email}</b>, but an admin has not activated your account yet. Ask an admin to grant
            you a role and site access under <i>Users &amp; access</i>.
          </p>
        </div>
        <Notice tone="amber">
          Setting up a new system? Make the first admin by running this once in the Supabase SQL editor:
          <code className="mt-1 block overflow-x-auto rounded bg-white px-2 py-1 text-xs">select public.bootstrap_admin('{email}');</code>
        </Notice>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void refreshProfile()}><Icon name="refresh" className="h-4 w-4" />Check again</Button>
          <Button onClick={() => void signOut()}><Icon name="logout" className="h-4 w-4" />Sign out</Button>
        </div>
      </div>
    </AuthShell>
  );
}
