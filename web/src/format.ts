import type { Compliance, Unit } from './types';

const TZ = 'Asia/Colombo';
const OFFSET_MIN = 330;

const unitShort: Record<Unit, string> = { WORKING_DAYS: 'wd', CALENDAR_DAYS: 'd', HOURS: 'h', MINUTES: 'min' };
export const unitLong: Record<Unit, string> = { WORKING_DAYS: 'working days', CALENDAR_DAYS: 'days', HOURS: 'hours', MINUTES: 'minutes' };

export function fmtUnit(v: number | null | undefined, unit: Unit): string {
  if (v === null || v === undefined) return '-';
  const n = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${n} ${unitShort[unit]}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
}

export function fmtLkr(n: number | null | undefined): string {
  if (!n) return 'LKR 0';
  return `LKR ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function fmtPct(n: number | null | undefined): string {
  return n === null || n === undefined ? '-' : `${n.toFixed(1)}%`;
}

/** Value for <input type="datetime-local"> in Sri Lanka time. */
export function toLocalInput(d: Date = new Date()): string {
  return new Date(d.getTime() + OFFSET_MIN * 60_000).toISOString().slice(0, 16);
}

/** Interpret a datetime-local value as Sri Lanka time. */
export function fromLocalInput(v: string): string {
  return new Date(`${v}:00+05:30`).toISOString();
}

export function todayKey(): string {
  return new Date(Date.now() + OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

export function monthStartKey(): string {
  return todayKey().slice(0, 8) + '01';
}

export const complianceLabel: Record<Compliance, string> = {
  WITHIN_INTERNAL: 'Within LECO target',
  INTERNAL_EXCEEDED: 'LECO target exceeded',
  BREACHED: 'Regulatory breach',
  NO_TARGET: 'No target set',
};

export function remainingText(v: number | null, unit: Unit): string {
  if (v === null) return '-';
  if (v < 0) return `lapsed ${fmtUnit(-v, unit)}`;
  return fmtUnit(v, unit);
}
