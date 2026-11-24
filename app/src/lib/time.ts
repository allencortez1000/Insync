// All attendance times are shown in Philippine time (UTC+8, no daylight saving).
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let intlTime: Intl.DateTimeFormat | null | undefined;
let intlDate: Intl.DateTimeFormat | null | undefined;

function makeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat | null {
  try {
    const f = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', ...options });
    // Some engines silently ignore unknown time zones; only trust the formatter if it took effect.
    return f.resolvedOptions().timeZone === 'Asia/Manila' ? f : null;
  } catch {
    return null;
  }
}

function manualParts(date: Date) {
  const d = new Date(date.getTime() + MANILA_OFFSET_MS);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return {
    time: `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`,
    date: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
  };
}

export function formatManilaTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (intlTime === undefined) intlTime = makeFormatter({ hour: 'numeric', minute: '2-digit', hour12: true });
  return intlTime ? intlTime.format(date) : manualParts(date).time;
}

export function formatManilaDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (intlDate === undefined) intlDate = makeFormatter({ month: 'short', day: 'numeric', year: 'numeric' });
  return intlDate ? intlDate.format(date) : manualParts(date).date;
}

export function formatManilaDateTime(iso: string): string {
  return `${formatManilaDate(iso)} · ${formatManilaTime(iso)}`;
}

/** Milliseconds from server "now" until a server deadline, applied to the local clock. */
export function localDeadline(serverNowIso: string, serverDeadlineIso: string): number {
  const ttl = new Date(serverDeadlineIso).getTime() - new Date(serverNowIso).getTime();
  return Date.now() + (Number.isFinite(ttl) ? Math.max(0, ttl) : 60000);
}
