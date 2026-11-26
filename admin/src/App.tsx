import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { supabaseConfigured } from './lib/supabase';
import { FeedbackProvider } from './components/feedback';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { Login, PendingApproval } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Sites } from './pages/Sites';
import { Employees } from './pages/Employees';
import { EmployeeDetail } from './pages/EmployeeDetail';
import { Schedules } from './pages/Schedules';
import { Attendance } from './pages/Attendance';
import { Overtime } from './pages/Overtime';
import { Leave } from './pages/Leave';
import { Allowances } from './pages/Allowances';
import { Advances } from './pages/Advances';
import { Policies } from './pages/Policies';
import { Users } from './pages/Users';
import { Audit } from './pages/Audit';
import { PayrollRuns } from './pages/payroll/PayrollRuns';
import { PayrollRunDetail } from './pages/payroll/PayrollRunDetail';
import { Payslips } from './pages/payroll/Payslips';
import { PayslipView } from './pages/payroll/PayslipView';
import { Reports } from './pages/payroll/Reports';
import { ThirteenthMonth } from './pages/payroll/ThirteenthMonth';
import { PortalApp } from './portal/PortalApp';

function Gate({ children }: { children: ReactNode }) {
  const { session, profile, loading, isStaff } = useAuth();
  if (!supabaseConfigured) {
    return (
      <div className="mx-auto mt-20 max-w-lg rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="mb-2 text-base font-semibold">Supabase is not configured</h1>
        Copy <code>admin/.env.example</code> to <code>admin/.env</code> and set <code>VITE_SUPABASE_URL</code> and{' '}
        <code>VITE_SUPABASE_ANON_KEY</code>, then restart the dev server.
      </div>
    );
  }
  if (loading) return <Spinner />;
  if (!session) return <Login />;
  if (!profile || !isStaff) return <PendingApproval />;
  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <FeedbackProvider>
        <BrowserRouter>
          <Routes>
            {/* Employee accounts: own sign-in, no staff access needed */}
            <Route path="/employee/*" element={<PortalApp />} />
            <Route path="*" element={<Gate><AdminRoutes /></Gate>} />
          </Routes>
        </BrowserRouter>
      </FeedbackProvider>
    </AuthProvider>
  );
}

function AdminRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="overtime" element={<Overtime />} />
        <Route path="employees" element={<Employees />} />
        <Route path="employees/:id" element={<EmployeeDetail />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="leave" element={<Leave />} />
        <Route path="allowances" element={<Allowances />} />
        <Route path="advances" element={<Advances />} />
        <Route path="payroll" element={<PayrollRuns />} />
        <Route path="payroll/:id" element={<PayrollRunDetail />} />
        <Route path="payslips" element={<Payslips />} />
        <Route path="13th-month" element={<ThirteenthMonth />} />
        <Route path="reports" element={<Reports />} />
        <Route path="sites" element={<Sites />} />
        <Route path="policies" element={<Policies />} />
        <Route path="users" element={<AdminOnly><Users /></AdminOnly>} />
        <Route path="audit" element={<AdminOnly><Audit /></AdminOnly>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      {/* Printable payslip without the app chrome */}
      <Route path="payslips/:id" element={<PayslipView />} />
    </Routes>
  );
}
