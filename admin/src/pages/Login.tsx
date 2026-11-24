import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { Button, ErrorBox, Field, Input, Notice } from '../components/ui';

export function Login() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div>
          <div className="text-lg font-bold text-brand-700">Insync</div>
          <h1 className="text-sm text-gray-500">Attendance &amp; Payroll — admin and staff</h1>
        </div>
        {mode === 'signup' && (
          <Field label="Full name">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
        </Field>
        <ErrorBox error={error} />
        {info && <Notice tone="green">{info}</Notice>}
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
        <button type="button" className="w-full text-center text-sm text-brand-700 hover:underline"
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setInfo(null); }}>
          {mode === 'signin' ? 'New staff member? Request access' : 'Have an account? Sign in'}
        </button>
        <p className="text-xs text-gray-500">
          Each person uses their own account so every change has an identifiable actor. Site attendance
          accounts are used only in the attendance app.
        </p>
      </form>
    </div>
  );
}

export function PendingApproval() {
  const { profile, session, refreshProfile, signOut } = useAuth();
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="text-base font-semibold">Waiting for access</h1>
        <p className="text-sm text-gray-600">
          You are signed in as <b>{profile?.email ?? session?.user.email}</b>, but an admin has not activated your
          account yet. Ask an admin to grant you a role and site access under <i>Users &amp; access</i>.
        </p>
        <Notice tone="amber">
          Setting up a new system? Make the first admin by running this once in the Supabase SQL editor:
          <code className="mt-1 block rounded bg-white px-2 py-1 text-xs">select public.bootstrap_admin('{profile?.email ?? session?.user.email}');</code>
        </Notice>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void refreshProfile()}>Check again</Button>
          <Button onClick={() => void signOut()}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}
