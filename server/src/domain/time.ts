/**
 * Time arithmetic in LECO local time (Sri Lanka, UTC+05:30, no DST).
 * Working days exclude Saturdays, Sundays and configured holidays (public / bank / mercantile).
 */

const DAY_MS = 86_400_000;

export interface Calendar {
  offsetMinutes: number;
  holidays: Set<string>; // YYYY-MM-DD
}

export function defaultCalendar(holidays: Iterable<string> = []): Calendar {
  const offset = Number(process.env.TZ_OFFSET_MINUTES ?? 330);
  return { offsetMinutes: Number.isFinite(offset) ? offset : 330, holidays: new Set(holidays) };
}

/** Local calendar date (YYYY-MM-DD) of an instant. */
export function localDateKey(d: Date, cal: Calendar): string {
  return new Date(d.getTime() + cal.offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function keyToUtcDay(key: string): number {
  return Date.parse(`${key}T00:00:00Z`) / DAY_MS;
}

function dayToKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function isWorkingDay(key: string, cal: Calendar): boolean {
  const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !cal.holidays.has(key);
}

/**
 * Number of working days d such that localDate(start) < d <= localDate(end).
 * Same-day completion = 0; Friday -> Monday = 1.
 */
export function workingDaysBetween(start: Date, end: Date, cal: Calendar): number {
  if (end.getTime() <= start.getTime()) return 0;
  const s = keyToUtcDay(localDateKey(start, cal));
  const e = keyToUtcDay(localDateKey(end, cal));
  let count = 0;
  for (let d = s + 1; d <= e; d++) if (isWorkingDay(dayToKey(d), cal)) count++;
  return count;
}

export function calendarDaysBetween(start: Date, end: Date, cal: Calendar): number {
  if (end.getTime() <= start.getTime()) return 0;
  return keyToUtcDay(localDateKey(end, cal)) - keyToUtcDay(localDateKey(start, cal));
}

export function hoursBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 3_600_000);
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 60_000);
}

export type UnitName = 'WORKING_DAYS' | 'CALENDAR_DAYS' | 'HOURS' | 'MINUTES';

export function measure(unit: UnitName, start: Date, end: Date, cal: Calendar): number {
  switch (unit) {
    case 'WORKING_DAYS':
      return workingDaysBetween(start, end, cal);
    case 'CALENDAR_DAYS':
      return calendarDaysBetween(start, end, cal);
    case 'HOURS':
      return round2(hoursBetween(start, end));
    case 'MINUTES':
      return round2(minutesBetween(start, end));
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
