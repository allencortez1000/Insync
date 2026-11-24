// Formatting helpers. All payroll/attendance times are shown in Philippine time.
export const TZ = 'Asia/Manila';

const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function php(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return peso.format(Number(v));
}

export function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return plain.format(Number(v));
}

export function dateTime(v: string | null | undefined): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-PH', {
    timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function timeOnly(v: string | null | undefined): string {
  if (!v) return '—';
  return new Date(v).toLocaleTimeString('en-PH', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/** Formats a date-only string (YYYY-MM-DD) without timezone shifting. */
export function dateOnly(v: string | null | undefined): string {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-PH', {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', weekday: 'short',
  });
}

/** 125 → "2h 05m" */
export function hm(minutes: number | string | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes === '') return '—';
  const m = Math.round(Number(minutes));
  const sign = m < 0 ? '-' : '';
  const a = Math.abs(m);
  return `${sign}${Math.floor(a / 60)}h ${String(a % 60).padStart(2, '0')}m`;
}

/** Today's date in Manila as YYYY-MM-DD. */
export function todayPH(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Converts a <input type="datetime-local"> value (Manila wall time) to an ISO instant. */
export function localInputToIso(v: string): string | null {
  if (!v) return null;
  return `${v.length === 16 ? `${v}:00` : v}+08:00`;
}

/** ISO instant → value for <input type="datetime-local"> in Manila time. */
export function isoToLocalInput(v: string | null | undefined): string {
  if (!v) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(v));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Start of a Manila date as an ISO instant. */
export function phStartOfDay(isoDate: string): string {
  return `${isoDate}T00:00:00+08:00`;
}

export function mapsLink(lat: number | string | null | undefined, lng: number | string | null | undefined): string | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
