import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useAsync } from '../lib/hooks';
import { addDays, dateOnly, dateTime, hm, php, timeOnly, titleCase } from '../lib/format';
import { useFeedback } from '../components/feedback';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Notice, Select, Spinner, StatusBadge, Textarea, cx } from '../components/ui';
import { Icon, type IconName } from '../components/icons';
import { PayslipDocument } from '../pages/payroll/PayslipView';
import { FaceCard, type FaceStatus } from './FaceCard';
import {
  call, signOut, type Attendance, type AttendanceDay, type DayStatus, type LeaveRow, type Me, type PayslipDetail, type PayslipRow,
  type ThirteenthMonth,
} from './api';

const days = (n: number | string) => `${Number(n)} day${Number(n) === 1 ? '' : 's'}`;

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">{children}</h1>
      {sub && <p className="mt-1 text-sm text-gray-500">{sub}</p>}
    </div>
  );
}

function Tile({ icon, label, children, className }: { icon: IconName; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex min-w-0 items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:p-3.5', className)}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon name={icon} /></span>
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
        <div className="truncate text-sm font-semibold text-gray-900">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
export function HomePage({ me }: { me: Me }) {
  const e = me.employee;
  const slips = useAsync(() => call<{ payslips: PayslipRow[] }>('emp_payslips'), []);
  const latest = slips.data?.payslips.find((p) => p.status === 'issued');
  const pending = me.leave_types.reduce((n, t) => n + Number(t.pending_days), 0);
  const face = useAsync(() => call<FaceStatus>('emp_face_status'), []);

  return (
    <div className="space-y-4">
      <Title sub={dateOnly(me.today)}>Hello, {e.first_name}</Title>

      <div className={cx('flex items-start gap-3 rounded-xl border p-4', me.open_session ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-white')}>
        <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', me.open_session ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500')}>
          <Icon name="clock" />
        </span>
        <div className="min-w-0 text-sm">
          {me.open_session ? (
            <div className="font-semibold text-blue-900">Clocked in since {timeOnly(me.open_session.clock_in_at)} at {me.open_session.site_name}</div>
          ) : (
            <div className="font-semibold text-gray-900">You are not clocked in right now</div>
          )}
          <div className="mt-0.5 text-gray-600">Clock In and Clock Out are done on the attendance device at your site. Here you can only view your records.</div>
        </div>
      </div>

      {face.data && !face.data.enrolled && (
        <Link to="/employee/account" className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm hover:bg-amber-100">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white"><Icon name="eye" /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-amber-900">Record your face</span>
            <span className="block text-amber-800">Then you can clock in and out by looking at the camera — no PIN.</span>
          </span>
          <Icon name="arrowRight" className="h-4 w-4 shrink-0 text-amber-700" />
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile icon="site" label="Site">{e.site_name ?? 'Not assigned'}</Tile>
        <Tile icon="cash" label="Daily rate">{e.daily_rate != null ? php(e.daily_rate) : '—'}</Tile>
        <Tile icon="calendar" label="Schedule" className="col-span-2 sm:col-span-1">{e.schedule_name ?? '—'}</Tile>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Latest payslip" actions={<Link to="/employee/payslips" className="text-sm font-medium text-brand-700 hover:underline">All payslips</Link>}>
          {slips.loading && !slips.data ? <Spinner /> : !latest ? <p className="text-sm text-gray-500">No payslip yet.</p> : (
            <Link to={`/employee/payslips/${latest.id}`} className="block rounded-lg hover:bg-gray-50">
              <div className="text-xs text-gray-500">{dateOnly(latest.start_date)} – {dateOnly(latest.end_date)}</div>
              <div className="num mt-1 text-2xl font-bold text-gray-900">{php(latest.net_pay)}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                net pay · {latest.paid_at ? <Badge tone="green">paid {dateOnly(latest.paid_at.slice(0, 10))}</Badge> : <Badge tone="amber">payday {dateOnly(latest.payday)}</Badge>}
              </div>
            </Link>
          )}
        </Card>

        <Card title="Leave balance" actions={<Link to="/employee/leave" className="text-sm font-medium text-brand-700 hover:underline">Request leave</Link>}>
          <ul className="space-y-2 text-sm">
            {me.leave_types.filter((t) => t.requires_balance).map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3">
                <span className="text-gray-700">{t.name}</span>
                <span className="num font-semibold text-gray-900">{days(t.balance_days)}</span>
              </li>
            ))}
            {!me.leave_types.some((t) => t.requires_balance) && <li className="text-gray-500">No leave credits recorded.</li>}
          </ul>
          {pending > 0 && <p className="mt-3 text-xs text-amber-700">{days(pending)} of leave waiting for approval.</p>}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attendance (view only)
// ---------------------------------------------------------------------------
const DAY_STATUS: Record<DayStatus, { label: string; tone: 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'purple' }> = {
  present: { label: 'Present', tone: 'green' },
  clocked_in: { label: 'Clocked in', tone: 'blue' },
  on_leave: { label: 'On leave', tone: 'purple' },
  holiday: { label: 'Holiday', tone: 'blue' },
  rest_day: { label: 'Rest day', tone: 'gray' },
  no_record_yet: { label: 'No record yet', tone: 'gray' },
  leave_pending: { label: 'Leave pending', tone: 'amber' },
  absent: { label: 'Absent', tone: 'red' },
};
const OT_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' }> = {
  counted: { label: 'counted', tone: 'green' }, accepted: { label: 'approved', tone: 'green' },
  pending: { label: 'waiting for approval', tone: 'amber' }, rejected: { label: 'not approved', tone: 'red' },
  disputed: { label: 'under review', tone: 'red' },
};

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1 + n, 1)).toISOString().slice(0, 7);
}

export function AttendancePage({ me }: { me: Me }) {
  const thisMonth = me.today.slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const range = monthRange(month);
  const data = useAsync(() => call<Attendance>('emp_attendance', { p_from: range.from, p_to: range.to }), [month]);
  const s = data.data?.summary;
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [picked, setPicked] = useState<string | null>(null);
  const days = data.data?.days ?? [];
  // Selected day: the one tapped, else today, else the latest day with a record in this month.
  const selected = days.find((d) => d.date === picked) ?? days.find((d) => d.date === me.today) ?? days[0] ?? null;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">My attendance</h1>
          <div className="inline-flex shrink-0 rounded-lg border border-gray-300 bg-white p-0.5 shadow-sm" role="group" aria-label="View">
            {(['calendar', 'list'] as const).map((v) => (
              <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v}
                className={cx('rounded-md px-3 py-1.5 text-sm font-medium capitalize', view === v ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100')}>
                {v}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1 text-sm text-gray-500">Your clock in / clock out, attendance status and overtime. View only.</p>
      </div>

      <div className="flex items-center gap-1 rounded-xl border border-gray-200 bg-white p-1.5 shadow-sm">
        <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg text-gray-600 hover:bg-gray-100">←</button>
        <div className="min-w-0 flex-1 text-center text-base font-semibold text-gray-900">{monthLabel(month)}</div>
        <Input type="month" value={month} max={thisMonth} aria-label="Jump to month"
          onChange={(e) => e.target.value && setMonth(e.target.value)} className="hidden !w-auto sm:block" />
        <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth} aria-label="Next month"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent">→</button>
      </div>

      <ErrorBox error={data.error} />
      {s && (
        <div className="grid grid-cols-5 gap-1.5 sm:gap-3">
          <Mini label="Present" value={s.present} tone="green" />
          <Mini label="Late" value={s.late} tone={s.late ? 'amber' : undefined} />
          <Mini label="Absent" value={s.absent} tone={s.absent ? 'red' : undefined} />
          <Mini label="On leave" short="Leave" value={s.on_leave} />
          <Mini label="Overtime" short="OT" value={<span className="whitespace-nowrap">{hm(s.ot_accepted_minutes)}</span>}
            hint={s.ot_recorded_minutes !== s.ot_accepted_minutes ? `of ${hm(s.ot_recorded_minutes)} recorded` : 'counted'} />
        </div>
      )}

      {data.loading && !data.data ? <Card><Spinner /></Card> : view === 'calendar' ? (
        <>
          <MonthCalendar month={month} today={me.today} days={days} selected={selected?.date ?? null} onPick={setPicked} />
          <Card padded={false} title={selected ? dateOnly(selected.date) : 'No record'}>
            {selected ? <ul><DayRow d={selected} /></ul> : <Empty>No attendance records for this month.</Empty>}
          </Card>
        </>
      ) : (
        <Card padded={false}>
          {!days.length ? <Empty>No attendance records for this month.</Empty> : (
            <ul className="divide-y divide-gray-100">
              {days.map((d) => <DayRow key={d.date} d={d} />)}
            </ul>
          )}
        </Card>
      )}
      <p className="text-xs text-gray-500">
        Something wrong with a record? Tell your foreman or the office — only staff can correct attendance, and every correction is logged.
      </p>
    </div>
  );
}

type CellLook = { label: string; cell: string; dot: string; text: string };
const LOOK: Record<string, CellLook> = {
  present: { label: 'Present', cell: 'bg-green-50', dot: 'bg-green-500', text: 'text-green-800' },
  late: { label: 'Late', cell: 'bg-amber-50', dot: 'bg-amber-500', text: 'text-amber-800' },
  clocked_in: { label: 'Clocked in', cell: 'bg-blue-50', dot: 'bg-blue-500', text: 'text-blue-800' },
  on_leave: { label: 'On leave', cell: 'bg-purple-50', dot: 'bg-purple-500', text: 'text-purple-800' },
  leave_pending: { label: 'Leave pending', cell: 'bg-amber-50', dot: 'bg-amber-400', text: 'text-amber-800' },
  holiday: { label: 'Holiday', cell: 'bg-sky-50', dot: 'bg-sky-500', text: 'text-sky-800' },
  rest_day: { label: 'Rest day', cell: 'bg-gray-50', dot: 'bg-gray-300', text: 'text-gray-500' },
  no_record_yet: { label: 'No record yet', cell: 'bg-white', dot: 'bg-gray-300', text: 'text-gray-500' },
  absent: { label: 'Absent', cell: 'bg-red-50', dot: 'bg-red-500', text: 'text-red-800' },
};
const lookOf = (d: AttendanceDay): CellLook => LOOK[d.status === 'present' && d.late_minutes > 0 ? 'late' : d.status]!;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Month grid: one cell per day, coloured by attendance status, with the clock in / out times. */
function MonthCalendar({ month, today, days, selected, onPick }: {
  month: string; today: string; days: AttendanceDay[]; selected: string | null; onPick: (date: string) => void;
}) {
  const [y, m] = month.split('-').map(Number);
  const lead = new Date(Date.UTC(y!, m! - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const cells: (string | null)[] = [...Array<null>(lead).fill(null),
    ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  const used = [...new Set(days.map((d) => (d.status === 'present' && d.late_minutes > 0 ? 'late' : d.status)))];

  return (
    <Card padded={false}>
      <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {WEEKDAYS.map((w) => <div key={w} className="py-2">{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-px bg-gray-200">
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="min-h-[4.25rem] bg-gray-50/70 sm:min-h-[6.5rem]" />;
          const d = byDate.get(date);
          const num = Number(date.slice(8));
          const isToday = date === today;
          const number = (
            <span className={cx('num flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-semibold sm:h-6 sm:w-6 sm:text-xs',
              isToday ? 'bg-brand-600 text-white' : d ? 'text-gray-900' : 'text-gray-400')}>{num}</span>
          );
          if (!d) return <div key={i} className="flex min-h-[4.25rem] flex-col items-center bg-white p-1 sm:min-h-[6.5rem] sm:items-start sm:p-1.5">{number}</div>;
          const look = lookOf(d);
          const first = d.sessions[0];
          const last = d.sessions[d.sessions.length - 1];
          const bigOt = d.ot && d.ot.recorded_minutes >= 30 ? d.ot : null;
          return (
            <button key={i} type="button" onClick={() => onPick(date)} aria-pressed={selected === date}
              aria-label={`${dateOnly(date)}: ${look.label}`}
              className={cx('relative flex min-h-[4.25rem] flex-col items-center gap-0.5 px-0.5 py-1 text-center transition sm:min-h-[6.5rem] sm:items-start sm:p-1.5 sm:text-left',
                look.cell, 'hover:brightness-95 focus:outline-none', selected === date && 'z-10 ring-2 ring-inset ring-brand-600')}>
              {number}
              {/* phone: a status bar under the date, then the first clock-in (or a one-word status) */}
              <span className={cx('h-1 w-5 rounded-full sm:hidden', look.dot)} />
              <span className={cx('num text-[10px] font-medium leading-tight sm:hidden', look.text)}>
                {first ? timeOnly(first.clock_in_at).replace(/\s?[AP]M/i, '')
                  : d.status === 'absent' ? 'Absent' : d.status === 'on_leave' ? 'Leave' : d.status === 'holiday' ? 'Holiday' : d.status === 'rest_day' ? 'Rest' : ''}
              </span>
              {bigOt && <span className="rounded bg-brand-100 px-1 text-[9px] font-semibold leading-tight text-brand-800 sm:hidden">OT</span>}
              {/* wider screens: status, in / out, overtime */}
              <span className={cx('hidden items-center gap-1 text-[11px] font-semibold sm:flex', look.text)}>
                <span className={cx('h-1.5 w-1.5 rounded-full', look.dot)} />{look.label}
              </span>
              {first && (
                <span className="num hidden text-[11px] leading-tight text-gray-700 sm:block">
                  {timeOnly(first.clock_in_at)}<br />{last?.clock_out_at ? timeOnly(last.clock_out_at) : 'still in'}
                </span>
              )}
              {d.leave && !first && <span className="hidden text-[11px] leading-tight text-gray-600 sm:block">{d.leave.type}</span>}
              {d.holiday && <span className="hidden truncate text-[11px] leading-tight text-gray-600 sm:block">{d.holiday}</span>}
              {bigOt && (
                <span className={cx('hidden rounded px-1 text-[10px] font-semibold sm:inline-block',
                  bigOt.status === 'pending' || bigOt.status === 'disputed' ? 'bg-amber-100 text-amber-800'
                    : bigOt.status === 'rejected' ? 'bg-red-100 text-red-800' : 'bg-brand-100 text-brand-800')}>
                  OT {hm(bigOt.recorded_minutes)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-200 px-4 py-2.5 text-xs text-gray-600">
        {used.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5"><span className={cx('h-2 w-2 rounded-full', LOOK[k]!.dot)} />{LOOK[k]!.label}</span>
        ))}
        <span className="inline-flex items-center gap-1.5"><span className="rounded bg-brand-100 px-1 text-[10px] font-semibold text-brand-800">OT</span>Overtime of 30 minutes or more</span>
      </div>
    </Card>
  );
}

function Mini({ label, short, value, tone, hint }: { label: string; short?: string; value: ReactNode; tone?: 'green' | 'amber' | 'red'; hint?: string }) {
  const color = tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-700' : tone === 'green' ? 'text-green-700' : 'text-gray-900';
  return (
    <div className="min-w-0 rounded-xl border border-gray-200 bg-white px-1 py-2 text-center shadow-sm sm:p-3 sm:text-left">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-gray-500 sm:text-[11px]">
        <span className="sm:hidden">{short ?? label}</span><span className="hidden sm:inline">{label}</span>
      </div>
      <div className={cx('num text-[15px] font-semibold leading-tight sm:text-xl', color)}>{value}</div>
      {hint && <div className="hidden text-[11px] text-gray-500 sm:block">{hint}</div>}
    </div>
  );
}

function DayRow({ d }: { d: AttendanceDay }) {
  const st = DAY_STATUS[d.status];
  const day = d.date.slice(8);
  const weekday = new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', weekday: 'short' });
  const month = new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'short' });
  const quiet = d.status === 'rest_day' || d.status === 'no_record_yet';
  return (
    <li className={cx('flex gap-3 px-4 py-3', quiet && 'bg-gray-50/60')}>
      <div className="w-12 shrink-0 text-center leading-tight">
        <div className="text-[11px] font-semibold uppercase text-gray-500">{weekday}</div>
        <div className="num text-lg font-bold text-gray-900">{Number(day)}</div>
        <div className="text-[11px] text-gray-400">{month}</div>
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={st.tone}>{st.label}</Badge>
          {d.late_minutes > 0 && <Badge tone="amber">late {hm(d.late_minutes)}</Badge>}
          {d.undertime && <Badge tone="amber">short day</Badge>}
          {!d.is_working_day && d.sessions.length > 0 && <Badge tone="purple">rest-day work</Badge>}
          {d.holiday && <Badge tone="blue">{d.holiday}</Badge>}
          {d.leave && d.status !== 'present' && <span className="text-xs text-gray-500">{d.leave.type}{Number(d.leave.hours) < 8 ? ' (half day)' : ''}</span>}
        </div>
        {d.sessions.map((x, i) => (
          <div key={i} className="text-sm text-gray-800">
            <span className="num font-medium">{timeOnly(x.clock_in_at)} – {x.clock_out_at ? timeOnly(x.clock_out_at) : 'still clocked in'}</span>
            <span className="text-gray-500"> · {x.site_name}</span>
            {x.entered_by_staff && <span className="text-xs text-gray-400"> · entered by staff</span>}
          </div>
        ))}
        {d.sessions.length > 0 && d.elapsed_minutes > 0 && (
          <div className="text-xs text-gray-500">{hm(d.elapsed_minutes)} on site · {hm(d.worked_minutes)} counted as worked</div>
        )}
        {d.ot && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-medium text-gray-700">Overtime {hm(d.ot.recorded_minutes)}</span>
            <Badge tone={OT_STATUS[d.ot.status]?.tone ?? 'amber'}>
              {d.ot.status === 'accepted' && d.ot.accepted_minutes < d.ot.recorded_minutes ? `approved ${hm(d.ot.accepted_minutes)}` : OT_STATUS[d.ot.status]?.label ?? d.ot.status}
            </Badge>
            {d.ot.reason && d.ot.status !== 'counted' && <span className="text-gray-500">{d.ot.reason}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------
export function LeavePage({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const { run, confirm } = useFeedback();
  const list = useAsync(() => call<{ entries: LeaveRow[] }>('emp_leave_list'), []);
  const [f, setF] = useState({ type: '', from: addDays(me.today, 1), to: addDays(me.today, 1), hours: '8', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const type = me.leave_types.find((t) => t.id === f.type);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setDone(null);
    try {
      const res = await call<{ days: number }>('emp_leave_request', {
        p_leave_type_id: f.type, p_from: f.from, p_to: f.to, p_hours: Number(f.hours), p_reason: f.reason,
      });
      setDone(`${days(res.days)} requested. You will see the decision here once the office approves or rejects it.`);
      setF({ ...f, reason: '' });
      list.reload(); onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  async function cancel(r: LeaveRow) {
    if (!(await confirm({ title: 'Cancel this request?', message: `${r.type_name} on ${dateOnly(r.leave_date)}`, confirmText: 'Cancel request', danger: true }))) return;
    if (await run(() => call('emp_leave_cancel', { p_entry_id: r.id }), 'Request cancelled')) { list.reload(); onChanged(); }
  }

  return (
    <div className="space-y-4">
      <Title sub="Request leave here. The office approves or rejects it, and the result shows below.">My leave</Title>

      <div className="grid gap-3 sm:grid-cols-3">
        {me.leave_types.filter((t) => t.requires_balance).map((t) => (
          <div key={t.id} className="rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t.name}</div>
            <div className="num mt-0.5 text-xl font-semibold text-gray-900">{days(t.balance_days)}</div>
            <div className="text-xs text-gray-500">{Number(t.pending_days) > 0 ? `${days(t.pending_days)} waiting for approval` : 'available'}</div>
          </div>
        ))}
      </div>

      <Card title="Request leave">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Leave type">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} required>
              <option value="">Select…</option>
              {me.leave_types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.is_paid ? ' (paid)' : ' (unpaid)'}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="From"><Input type="date" value={f.from} required
              onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></Field>
            <Field label="To"><Input type="date" value={f.to} min={f.from} required onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
            <Field label="Each day" className="col-span-2 sm:col-span-1">
              <Select value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })}>
                <option value="8">Whole day</option><option value="4">Half day</option>
              </Select>
            </Field>
          </div>
          <Field label="Reason"><Textarea rows={2} value={f.reason} required minLength={3} maxLength={300} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          {type?.requires_balance && (
            <p className="text-xs text-gray-500">{type.name}: {days(Number(type.balance_days) - Number(type.pending_days))} available. Rest days are skipped automatically.</p>
          )}
          <ErrorBox error={error} />
          {done && <Notice tone="green">{done}</Notice>}
          <Button type="submit" variant="primary" busy={busy} disabled={!f.type}>Send request</Button>
        </form>
      </Card>

      <Card title="My requests" padded={false}>
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Spinner /> : !list.data?.entries.length ? <Empty>No leave filed yet.</Empty> : (
          <ul className="divide-y divide-gray-100">
            {list.data.entries.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900">{dateOnly(r.leave_date)}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="text-sm text-gray-700">
                    {r.type_name}{Number(r.hours) < 8 ? ' · half day' : ''} · {r.is_paid ? 'paid' : 'unpaid'}
                  </div>
                  {r.reason && <div className="text-xs text-gray-500">{r.reason}</div>}
                  {r.decision_note && <div className="text-xs text-gray-600">Office: {r.decision_note}</div>}
                  <div className="text-[11px] text-gray-400">
                    {r.source === 'staff' ? 'Filed by the office' : 'Filed by you'} · {dateTime(r.created_at)}
                    {r.decided_at && r.status !== 'pending' ? ` · decided ${dateTime(r.decided_at)}` : ''}
                  </div>
                </div>
                {r.status === 'pending' && <Button size="sm" onClick={() => void cancel(r)}>Cancel</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------
export function PayslipsPage() {
  const slips = useAsync(() => call<{ payslips: PayslipRow[] }>('emp_payslips'), []);
  return (
    <div className="space-y-4">
      <Title sub="Issued when the weekly payroll is finalized. Tap a payslip to see the full breakdown.">My payslips</Title>
      <ErrorBox error={slips.error} />
      <Card padded={false}>
        {slips.loading && !slips.data ? <Spinner /> : !slips.data?.payslips.length ? <Empty>No payslip yet.</Empty> : (
          <ul className="divide-y divide-gray-100">
            {slips.data.payslips.map((p) => (
              <li key={p.id}>
                <Link to={`/employee/payslips/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon name="receipt" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900">{dateOnly(p.start_date)} – {dateOnly(p.end_date)}</div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span className="font-mono">{p.payslip_no}</span>
                      {p.status === 'void' ? <Badge tone="red">void</Badge>
                        : p.paid_at ? <Badge tone="green">paid</Badge> : <Badge tone="amber">payday {dateOnly(p.payday)}</Badge>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cx('num text-base font-bold', p.status === 'void' ? 'text-gray-400 line-through' : 'text-gray-900')}>{php(p.net_pay)}</div>
                    <div className="text-[11px] text-gray-500">net pay</div>
                  </div>
                  <Icon name="arrowRight" className="h-4 w-4 shrink-0 text-gray-300" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function PayslipPage() {
  const { id = '' } = useParams();
  const data = useAsync(() => call<PayslipDetail>('emp_payslip', { p_payslip_id: id }), [id]);
  if (data.loading && !data.data) return <Spinner />;
  if (!data.data) {
    return (
      <div className="mx-auto max-w-xl space-y-3 p-6">
        <ErrorBox error={data.error ?? 'Payslip not found'} />
        <Link to="/employee/payslips" className="text-sm text-brand-600 hover:underline">← My payslips</Link>
      </div>
    );
  }
  return <PayslipDocument slip={data.data.slip} payment={data.data.payment}
    back={<Link to="/employee/payslips" className="text-sm text-brand-600 hover:underline">← My payslips</Link>} />;
}

// ---------------------------------------------------------------------------
// 13th month pay
// ---------------------------------------------------------------------------
export function ThirteenthMonthPage({ me }: { me: Me }) {
  const thisYear = Number(me.today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const data = useAsync(() => call<ThirteenthMonth>('emp_thirteenth_month', { p_year: year }), [year]);
  const t = data.data;
  return (
    <div className="space-y-4">
      <Title sub="Your 13th month pay is your total basic salary for the year divided by 12.">13th month pay</Title>
      <Field label="Year" className="w-32">
        <Select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
      </Field>
      <ErrorBox error={data.error} />
      {data.loading && !t ? <Spinner /> : t && (
        <>
          <div className="rounded-2xl bg-gradient-to-br from-brand-700 to-brand-500 p-5 text-white shadow-sm sm:p-6">
            <div className="text-sm text-brand-100">{year === thisYear ? `13th month pay earned so far in ${year}` : `13th month pay for ${year}`}</div>
            <div className="num mt-1 text-3xl font-bold sm:text-4xl">{php(t.thirteenth_month)}</div>
            <div className="mt-2 text-sm text-brand-100">
              {php(t.basic_earned)} basic salary ÷ 12
              {t.first_period_start && t.last_period_end ? ` · payroll from ${dateOnly(t.first_period_start)} to ${dateOnly(t.last_period_end)}` : ''}
            </div>
          </div>
          <Card title="Basic salary by month" padded={false}>
            {!t.months.length ? <Empty>No finalized payroll in {year} yet.</Empty> : (
              <table className="min-w-full text-sm">
                <thead><tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-2 font-semibold">Month</th><th className="px-4 py-2 text-right font-semibold">Basic salary</th>
                  <th className="px-4 py-2 text-right font-semibold">Adds to 13th month</th></tr></thead>
                <tbody>
                  {t.months.map((m) => (
                    <tr key={m.month} className="border-b border-gray-100">
                      <td className="px-4 py-2">{new Date(`${m.month}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'long', year: 'numeric' })}</td>
                      <td className="num px-4 py-2 text-right">{php(m.basic)}</td>
                      <td className="num px-4 py-2 text-right">{php(Number(m.basic) / 12)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="px-4 py-2">Total</td><td className="num px-4 py-2 text-right">{php(t.basic_earned)}</td>
                    <td className="num px-4 py-2 text-right">{php(t.thirteenth_month)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </Card>
          <Notice>
            Basic salary is your regular daily wage for the days you worked, including paid leave. Overtime pay, rest-day and holiday
            premiums and allowances are not part of it. Only finalized payroll is counted, so the amount grows after every payday.
            The 13th month pay is released on or before December 24.
          </Notice>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
export function AccountPage({ me }: { me: Me }) {
  const e = me.employee;
  const row = (label: string, value: ReactNode) => (
    <div className="flex justify-between gap-3 border-b border-dotted border-gray-200 py-1.5 text-sm">
      <dt className="text-gray-500">{label}</dt><dd className="text-right font-medium text-gray-900">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-4">
      <Title>My account</Title>
      <FaceCard />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile">
          <dl>
            {row('Name', e.name)}
            {row('Employee code', <span className="font-mono">{e.employee_code}</span>)}
            {row('Site', e.site_name ?? 'Not assigned')}
            {row('Classification', titleCase(e.classification))}
            {row('Date hired', e.hire_date ? dateOnly(e.hire_date) : '—')}
            {row('Daily rate', e.daily_rate != null ? php(e.daily_rate) : '—')}
            {row('Schedule', e.schedule_name ?? '—')}
          </dl>
          <p className="mt-3 text-xs text-gray-500">Is something here wrong? Please tell the office — only staff can change employee records.</p>
          <Button className="mt-4" onClick={() => void signOut()}><Icon name="logout" className="h-4 w-4" />Sign out</Button>
        </Card>
        <Card title="Signing in">
          <div className="space-y-3 text-sm text-gray-700">
            <p>You sign in here with your <b>name</b> and the same <b>6-digit PIN</b> you use to clock in at your site.</p>
            <p>Keep your PIN to yourself: anyone who knows it can see your payslips. If you think someone else knows it, or you
              forgot it, ask the office for a new PIN. A new PIN signs this account out on every phone.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
