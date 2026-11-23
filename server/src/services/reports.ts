/**
 * PUCSL LISS reporting formats (report section 1.4.1, R1-R7) and the penalty register.
 * Rows are drawn from ClockResult snapshots whose clock stopped in the reporting month.
 */
import type { ClockResult, Csc, Branch, ServiceRequest, ServiceEvent, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { NATURE_LABELS, findService, getClock } from '../domain/catalog.js';
import { type AuthUser, visibleCscIds } from '../middleware/auth.js';
import { localKey, localMonthRange } from './analytics.js';

type Row = ClockResult & { request: ServiceRequest & { csc: Csc & { branch: Branch }; events: ServiceEvent[] } };

const yn = (b: boolean | null | undefined) => (b === true ? 'Y' : b === false ? 'N' : '');
const d = (x: Date | null | undefined) => (x ? localKey(x) : '');
const firstEvent = (r: Row, step: string) => r.request.events.find((e) => e.stepKey === step);
const nature = (r: Row) => NATURE_LABELS[r.request.natureOfSupply ?? ''] ?? r.request.natureOfSupply ?? '';
const appRef = (r: Row) => r.request.portalReference ?? r.request.refNo;

interface LissDef {
  code: string;
  title: string;
  clockKey: string;
  filter?: (r: Row) => boolean;
  columns: string[];
  row: (r: Row, reasons: string) => (string | number)[];
}

const common = (r: Row, y: number, m: number) => [y, m, r.request.csc.branch.name, r.request.csc.name];

export const LISS: LissDef[] = [
  {
    code: 'R1', title: 'New Connection Estimates', clockKey: 'NEW_CONNECTION.ESTIMATE',
    columns: ['Year', 'Month', 'Area_Branch', 'CSC', 'Feeder Class', 'Changes required to the Distribution system', 'Nature of the supply', 'Application Reference No', 'Date of valid Application submitted', 'Date of Estimate issued', 'Reasons for not meeting the target, if any'],
    row: (r, reasons) => [r.request.csc.feederClass, yn(r.request.changesRequired), nature(r), appRef(r), d(r.startedAt), d(r.endedAt), reasons],
  },
  {
    code: 'R2', title: 'New Connection Supply', clockKey: 'NEW_CONNECTION.SUPPLY',
    columns: ['Year', 'Month', 'Area_Branch', 'CSC', 'Feeder Class', 'Application Ref No', 'Changes required to the Distribution system', 'Nature of the supply', 'Date of Estimate Paid', 'Date of Connection Provided', 'Reasons for not meeting the target, if any'],
    row: (r, reasons) => [r.request.csc.feederClass, appRef(r), yn(r.request.changesRequired), nature(r), d(r.startedAt), d(r.endedAt), reasons],
  },
  {
    code: 'R3', title: 'Reconnection After Disconnection', clockKey: 'RECONNECTION.RECONNECT',
    columns: ['Year', 'Month', 'Area_Branch', 'CSC', 'Feeder Class', 'Account No', 'Date of payment made for reconnection', 'Date of reconnected', 'Reasons for not meeting the target, if any'],
    row: (r, reasons) => [r.request.csc.feederClass, r.request.accountNo ?? '', d(r.startedAt), d(r.endedAt), reasons],
  },
  {
    code: 'R4', title: 'Meter Testing', clockKey: 'METER_TESTING.TEST',
    columns: ['Year', 'Month', 'Area_Branch', 'CSC', 'Feeder Class', 'Nature of the Supply', 'Application Reference No', 'Account No', 'Date of Payment made for Testing', 'Date of Meter test Started', 'Reasons for not meeting the target, if any'],
    row: (r, reasons) => [r.request.csc.feederClass, nature(r), appRef(r), r.request.accountNo ?? '', d(r.startedAt), d(r.endedAt), reasons],
  },
  {
    code: 'R5', title: 'Meter Shifting', clockKey: 'SHIFTING.SHIFT', filter: (r) => r.request.subType === 'METER',
    columns: ['Year', 'Month', 'Area_Branch', 'CSC', 'Name of the Customer Service', 'Account No', 'Application Reference No', 'Wayleave clearance procedure required', 'Changes required to Distribution system', 'Nature of the supply', 'Date of payment made for shifting', 'Date of Meter_Line & Pole Shifted', 'Reasons for not meeting the target, if any'],
    row: (r, reasons) => ['Meter shifting', r.request.accountNo ?? '', appRef(r), yn(r.request.wayleaveRequired), yn(r.request.changesRequired), nature(r), d(r.startedAt), d(r.endedAt), reasons],
  },
  {
    code: 'R6', title: 'Pole/Line/Service Shifting', clockKey: 'SHIFTING.SHIFT', filter: (r) => r.request.subType !== 'METER',
    columns: ['Year', 'Month', 'Area_Branch', 'CSC', 'Name of the Customer Service', 'Account No', 'Application Reference No', 'Wayleave clearance procedure required', 'Changes required to Distribution system', 'Nature of the supply', 'Date of payment made for shifting', 'Date of Meter_Line & Pole Shifted', 'Reasons for not meeting the target, if any'],
    row: (r, reasons) => [
      findService('SHIFTING')?.subTypes?.find((s) => s.code === r.request.subType)?.label ?? r.request.subType ?? '',
      r.request.accountNo ?? '', appRef(r), yn(r.request.wayleaveRequired), yn(r.request.changesRequired), nature(r), d(r.startedAt), d(r.endedAt), reasons,
    ],
  },
  {
    code: 'R7', title: 'Announcing Scheduled Outages', clockKey: 'SCHEDULED_OUTAGE.NOTICE',
    columns: ['Year', 'Month', 'Area_Branch', 'Requested CSC_CEB', 'Feeder Class', 'Reference No', 'Type of Notice given', 'Nature of the supply', 'Date of power outage notice issued', 'Date of power outage scheduled', 'Affected customers', 'Reasons for not meeting the target, if any'],
    row: (r, reasons) => {
      const pub = firstEvent(r, 'NOTICE_PUBLISHED');
      const data = (pub?.data ?? {}) as Record<string, unknown>;
      return [r.request.csc.feederClass, r.request.refNo, String(data.noticeType ?? ''), nature(r), d(r.startedAt), data.scheduledFor ? localKey(new Date(String(data.scheduledFor))) : '', r.request.affectedCustomers ?? '', reasons];
    },
  },
];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function reasonLabels(): Promise<Map<string, string>> {
  const codes = await prisma.reasonCode.findMany({ where: { category: 'DELAY' } });
  return new Map(codes.map((c) => [c.code, c.description]));
}

async function resultsFor(user: AuthUser, clockKey: string | undefined, from: Date, to: Date, extra: Prisma.ClockResultWhereInput = {}) {
  const ids = await visibleCscIds(user);
  return (await prisma.clockResult.findMany({
    where: { ...(clockKey ? { clockKey } : {}), endedAt: { gte: from, lt: to }, ...(ids ? { request: { cscId: { in: ids } } } : {}), ...extra },
    include: { request: { include: { csc: { include: { branch: true } }, events: { orderBy: { occurredAt: 'asc' } } } } },
    orderBy: { endedAt: 'asc' },
  })) as Row[];
}

export async function lissReport(user: AuthUser, code: string, year: number, month: number) {
  const def = LISS.find((l) => l.code === code);
  if (!def) return null;
  const { from, to } = localMonthRange(year, month);
  const labels = await reasonLabels();
  const rows = (await resultsFor(user, def.clockKey, from, to)).filter((r) => !def.filter || def.filter(r));
  const data = rows.map((r) => {
    const reasons = r.delayReasons.map((c) => labels.get(c) ?? c).join('; ') + (r.delayNotes ? ` (${r.delayNotes})` : '');
    return [...common(r, year, month), ...def.row(r, reasons)];
  });
  return { def, header: def.columns, rows: data, csv: toCsv(def.columns, data) };
}

export async function penaltyRegister(user: AuthUser, year: number, month: number) {
  const { from, to } = localMonthRange(year, month);
  const labels = await reasonLabels();
  const rows = await resultsFor(user, undefined, from, to, { penaltyAmount: { gt: 0 } });
  const header = ['Ref No', 'Application Ref', 'Service', 'Measure', 'Branch', 'CSC', 'Feeder Class', 'Customer', 'Account No', 'Clock started', 'Clock stopped', 'Elapsed', 'Unit', 'Regulatory target', 'Compensation (LKR)', 'Delay reasons'];
  const data = rows.map((r) => [
    r.request.refNo, r.request.portalReference ?? '', findService(r.request.serviceType)?.name ?? r.request.serviceType, getClock(r.clockKey)?.label ?? r.clockKey,
    r.request.csc.branch.name, r.request.csc.name, r.feederClass, r.request.customerName, r.request.accountNo ?? '', d(r.startedAt), d(r.endedAt), r.elapsed, r.unit,
    r.regulatoryTarget ?? '', r.penaltyAmount, r.delayReasons.map((c) => labels.get(c) ?? c).join('; '),
  ]);
  return { header, rows: data, csv: toCsv(header, data), total: rows.reduce((s, r) => s + r.penaltyAmount, 0) };
}
