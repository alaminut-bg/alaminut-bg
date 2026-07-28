export const DOW = ['неделя','понеделник','вторник','сряда','четвъртък','петък','събота'];
export const MON = ['януари','февруари','март','април','май','юни',
                    'юли','август','септември','октомври','ноември','декември'];

/** Orders close at 10:30 Sofia time, expressed as minutes past midnight. */
export const CUTOFF_MIN = 10 * 60 + 30;

export function eur(n) {
  const v = Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  return v.toFixed(2).replace('.', ',') + ' €';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g,
    c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}

/**
 * The current moment in Sofia, as a plain ISO date and minutes past midnight.
 * hourCycle h23 matters: without it some engines return hour "24" at midnight.
 */
export function sofiaParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);

  const p = Object.fromEntries(
    parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));

  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

export function todayISO() {
  return sofiaParts().date;
}

/** Date maths in UTC so a DST transition can never drop or repeat a day. */
export function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Mirrors is_locked() in schema.sql.
 *   alaminut for D -> deadline D     10:30
 *   menu     for D -> deadline D-1   10:30
 * Advisory only: it drives the UI. The database trigger is authoritative,
 * because the device clock can be wrong or deliberately changed.
 */
export function isLockedClient(serveDate, source, now = sofiaParts()) {
  const deadline = source === 'alaminut' ? serveDate : addDaysISO(serveDate, -1);
  if (now.date > deadline) return true;
  return now.date === deadline && now.minutes >= CUTOFF_MIN;
}

/** 1 = понеделник … 7 = неделя, matching Postgres isodow. */
export function isoDow(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function isWeekend(iso) {
  return isoDow(iso) >= 6;
}

/**
 * Mirrors is_working_day() in the database: weekends are always off, plus
 * whatever dates the admin marked as non-working (official holidays).
 */
export function isWorkingDay(iso, nonWorking = new Set()) {
  return !isWeekend(iso) && !nonWorking.has(iso);
}

export function formatDayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { dow: DOW[dt.getUTCDay()], dnum: `${d} ${MON[m - 1]}` };
}
