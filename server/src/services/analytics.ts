import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { SERVICES, getClock, getService, findService } from '../domain/catalog.js';
import { evaluateKpis, evaluateRequest } from '../domain/sla.js';
import { round2 } from '../domain/time.js';
import { type AuthUser, visibleCscIds } from '../middleware/auth.js';
import { loadRules } from './rules.js';
import { contextOf, toEventLike } from './requests.js';

const OFFSET_MIN = Number(process.env.TZ_OFFSET_MINUTES ?? 330);

/** Start of a local (Sri Lanka) day as a UTC instant. */
export function localDayStart(key: string): Date {
  return new Date(Date.parse(`${key}T00:00:00Z`) - OFFSET_MIN * 60_000);
}

export function localMonthRange(year: number, month: number): { from: Date; to: Date } {
  const from = localDayStart(`${year}-${String(month).padStart(2, '0')}-01`);
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  return { from, to: localDayStart(`${ny}-${String(nm).padStart(2, '0')}-01`) };
}

export function localKey(d: Date): string {
  return new Date(d.getTime() + OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

async function scopeWhere(user: AuthUser, cscId?: number, branchId?: number): Promise<Prisma.ServiceRequestWhereInput> {
  const ids = await visibleCscIds(user);
  const where: Prisma.ServiceRequestWhereInput = {};
  const and: Prisma.ServiceRequestWhereInput[] = [];
  if (ids) and.push({ cscId: { in: ids } });
  if (cscId) and.push({ cscId });
  if (branchId) and.push({ csc: { branchId } });
  if (and.length) where.AND = and;
  return where;
}

export interface PendingFilters {
  serviceType?: string;
  cscId?: number;
  branchId?: number;
  compliance?: string;
  q?: string;
}

/** Customer Pending Service Monitoring (sections 2.3, 3.3, 4.3, 5.3, 6.3): every running SLA clock. */
export async function pendingRows(user: AuthUser, f: PendingFilters = {}) {
  const where = await scopeWhere(user, f.cscId, f.branchId);
  where.status = 'OPEN';
  if (f.serviceType) where.serviceType = f.serviceType;
  if (f.q) where.OR = [{ refNo: { contains: f.q, mode: 'insensitive' } }, { customerName: { contains: f.q, mode: 'insensitive' } }, { portalReference: { contains: f.q, mode: 'insensitive' } }];
  const reqs = await prisma.serviceRequest.findMany({ where, include: { events: { orderBy: { occurredAt: 'asc' } }, csc: { include: { branch: true } } } });
  const rules = await loadRules();
  const now = new Date();
  const rows = [];
  for (const r of reqs) {
    const service = findService(r.serviceType);
    if (!service) continue;
    const events = r.events.map(toEventLike);
    const { clocks } = evaluateRequest(service, events, contextOf(r), rules, now);
    const last = r.events[r.events.length - 1];
    const presentStatus = last ? service.steps.find((s) => s.key === last.stepKey)?.label ?? last.stepKey : '';
    const reasonCodes = [...new Set(r.events.flatMap((e) => e.reasonCodes))];
    for (const c of clocks) {
      if (c.state !== 'RUNNING') continue;
      if (f.compliance && c.compliance !== f.compliance) continue;
      rows.push({
        requestId: r.id,
        refNo: r.refNo,
        portalReference: r.portalReference,
        serviceType: r.serviceType,
        serviceName: service.name,
        subType: r.subType,
        cscId: r.cscId,
        cscName: r.csc.name,
        branchName: r.csc.branch.name,
        feederClass: r.csc.feederClass,
        customerName: r.customerName,
        natureOfSupply: r.natureOfSupply,
        changesRequired: r.changesRequired,
        clockKey: c.key,
        clockLabel: c.label,
        mode: c.mode,
        startedAt: c.startedAt,
        elapsed: c.elapsed,
        excluded: c.excluded,
        unit: c.unit,
        internalTarget: c.internalTarget,
        regulatoryTarget: c.regulatoryTarget,
        provisional: c.provisional,
        remainingInternal: c.remainingInternal,
        remainingRegulatory: c.remainingRegulatory,
        compliance: c.compliance,
        paused: c.paused,
        presentStatus,
        reasonCodes,
        accruedPenalty: c.penaltyAmount,
      });
    }
  }
  const rank = { BREACHED: 0, INTERNAL_EXCEEDED: 1, WITHIN_INTERNAL: 2, NO_TARGET: 3 } as const;
  rows.sort((a, b) => rank[a.compliance] - rank[b.compliance] || (a.remainingRegulatory ?? 1e9) - (b.remainingRegulatory ?? 1e9));
  return rows;
}

type Bucket = { total: number; internalOk: number; regulatoryOk: number; breached: number; penalty: number; elapsedSum: number };
const bucket = (): Bucket => ({ total: 0, internalOk: 0, regulatoryOk: 0, breached: 0, penalty: 0, elapsedSum: 0 });
const pct = (n: number, d: number) => (d ? round2((n / d) * 100) : null);
function finish(b: Bucket) {
  return {
    total: b.total,
    internalOk: b.internalOk,
    regulatoryOk: b.regulatoryOk,
    breached: b.breached,
    internalPct: pct(b.internalOk, b.total),
    regulatoryPct: pct(b.regulatoryOk, b.total),
    penalty: round2(b.penalty),
    avgElapsed: b.total ? round2(b.elapsedSum / b.total) : null,
  };
}

export async function dashboard(user: AuthUser, from: Date, to: Date, cscId?: number, branchId?: number) {
  const reqWhere = await scopeWhere(user, cscId, branchId);
  const results = await prisma.clockResult.findMany({
    where: { endedAt: { gte: from, lt: to }, request: reqWhere },
    include: { request: { include: { csc: { include: { branch: true } } } } },
  });

  const byClock = new Map<string, Bucket>();
  const byCsc = new Map<number, Bucket & { name: string; branch: string; feederClass: number }>();
  const overall = bucket();
  for (const r of results) {
    const add = (b: Bucket) => {
      b.total++;
      if (r.internalMet !== false) b.internalOk++;
      if (r.regulatoryMet !== false) b.regulatoryOk++;
      else b.breached++;
      b.penalty += r.penaltyAmount;
      b.elapsedSum += r.elapsed;
    };
    if (!byClock.has(r.clockKey)) byClock.set(r.clockKey, bucket());
    add(byClock.get(r.clockKey)!);
    const csc = r.request.csc;
    if (!byCsc.has(csc.id)) byCsc.set(csc.id, { ...bucket(), name: csc.name, branch: csc.branch.name, feederClass: csc.feederClass });
    add(byCsc.get(csc.id)!);
    add(overall);
  }

  const pending = await pendingRows(user, { cscId, branchId });
  const openByService = new Map<string, { running: number; internalExceeded: number; breached: number; paused: number }>();
  for (const p of pending) {
    const o = openByService.get(p.serviceType) ?? { running: 0, internalExceeded: 0, breached: 0, paused: 0 };
    o.running++;
    if (p.compliance === 'INTERNAL_EXCEEDED') o.internalExceeded++;
    if (p.compliance === 'BREACHED') o.breached++;
    if (p.paused) o.paused++;
    openByService.set(p.serviceType, o);
  }

  // 12-month trend ending with the month of `to - 1ms`
  const end = new Date(to.getTime() - 1);
  const endKey = localKey(end);
  let y = Number(endKey.slice(0, 4));
  let m = Number(endKey.slice(5, 7));
  const months: { key: string; from: Date; to: Date }[] = [];
  for (let i = 0; i < 12; i++) {
    months.unshift({ key: `${y}-${String(m).padStart(2, '0')}`, ...localMonthRange(y, m) });
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
  }
  const trendResults = await prisma.clockResult.findMany({
    where: { endedAt: { gte: months[0].from, lt: months[11].to }, request: reqWhere },
    select: { endedAt: true, internalMet: true, regulatoryMet: true, penaltyAmount: true },
  });
  const trend = months.map((mo) => {
    const b = bucket();
    for (const r of trendResults) {
      if (r.endedAt < mo.from || r.endedAt >= mo.to) continue;
      b.total++;
      if (r.internalMet !== false) b.internalOk++;
      if (r.regulatoryMet !== false) b.regulatoryOk++;
      else b.breached++;
      b.penalty += r.penaltyAmount;
    }
    return { month: mo.key, ...finish(b) };
  });

  // Service quality by category: month-to-date and year-to-date, ending on the "To" date.
  const refYear = Number(endKey.slice(0, 4));
  const refMonth = Number(endKey.slice(5, 7));
  const monthFrom = localMonthRange(refYear, refMonth).from;
  const ytdFrom = localMonthRange(refYear, 1).from;
  const qualityResults = await prisma.clockResult.findMany({
    where: { endedAt: { gte: ytdFrom, lt: to }, request: reqWhere },
    select: { clockKey: true, endedAt: true, internalMet: true, regulatoryMet: true, penaltyAmount: true },
  });
  const quality = (filter: (serviceType: string) => boolean) => {
    const month = bucket();
    const ytd = bucket();
    for (const r of qualityResults) {
      if (!filter(r.clockKey.split('.')[0])) continue;
      for (const b of r.endedAt >= monthFrom ? [month, ytd] : [ytd]) {
        b.total++;
        if (r.internalMet !== false) b.internalOk++;
        if (r.regulatoryMet !== false) b.regulatoryOk++;
        else b.breached++;
        b.penalty += r.penaltyAmount;
      }
    }
    return { month: finish(month), ytd: finish(ytd) };
  };
  const serviceQuality = {
    asOf: localKey(new Date(Math.min(end.getTime(), Date.now()))),
    monthLabel: endKey.slice(0, 7),
    overall: quality(() => true),
    services: SERVICES.map((s) => ({ serviceType: s.code, serviceName: s.name, regulated: s.clocks.some((c) => c.regulated), ...quality((t) => t === s.code) })),
  };

  const intake = await prisma.serviceRequest.groupBy({ by: ['serviceType', 'source'], where: { ...reqWhere, createdAt: { gte: from, lt: to } }, _count: { _all: true } });
  const feedback = await prisma.serviceRequest.aggregate({ where: { ...reqWhere, rating: { not: null }, updatedAt: { gte: from, lt: to } }, _avg: { rating: true }, _count: { rating: true } });

  return {
    period: { from, to },
    overall: finish(overall),
    byClock: [...byClock.entries()].map(([key, b]) => {
      const c = getClock(key);
      return { clockKey: key, label: c?.label ?? key, serviceType: key.split('.')[0], serviceName: findService(key.split('.')[0])?.name ?? key, unit: c?.unit, regulated: c?.regulated ?? false, ...finish(b) };
    }),
    byCsc: [...byCsc.entries()].map(([id, b]) => ({ cscId: id, name: b.name, branch: b.branch, feederClass: b.feederClass, ...finish(b) })).sort((a, b) => (a.regulatoryPct ?? 101) - (b.regulatoryPct ?? 101)),
    open: {
      running: pending.length,
      internalExceeded: pending.filter((p) => p.compliance === 'INTERNAL_EXCEEDED').length,
      breached: pending.filter((p) => p.compliance === 'BREACHED').length,
      paused: pending.filter((p) => p.paused).length,
      accruedPenalty: round2(pending.reduce((s, p) => s + p.accruedPenalty, 0)),
      byService: [...openByService.entries()].map(([serviceType, v]) => ({ serviceType, serviceName: findService(serviceType)?.name ?? serviceType, ...v })),
    },
    trend,
    serviceQuality,
    intake: intake.map((i) => ({ serviceType: i.serviceType, source: i.source, count: i._count._all })),
    feedback: { average: feedback._avg.rating ? round2(feedback._avg.rating) : null, count: feedback._count.rating },
  };
}

// ---------------------------------------------------------------------------------------------
// Commercial quality compensation by CSC
// ---------------------------------------------------------------------------------------------

/**
 * Which CSCs the commercial-quality compensation comes from.
 *  - payable: measures that stopped in the period past the regulatory target
 *  - accruing: services still open and already past the regulatory target (as of now)
 */
export async function commercialCompensationByCsc(user: AuthUser, from: Date, to: Date, branchId?: number) {
  const reqWhere = await scopeWhere(user, undefined, branchId);
  const [results, pending, cscs] = await Promise.all([
    prisma.clockResult.findMany({
      where: { endedAt: { gte: from, lt: to }, penaltyAmount: { gt: 0 }, request: reqWhere },
      select: { clockKey: true, penaltyAmount: true, request: { select: { cscId: true } } },
    }),
    pendingRows(user, { branchId }),
    prisma.csc.findMany({ include: { branch: true } }),
  ]);
  type Row = { payable: number; payableCount: number; accruing: number; accruingCount: number; byService: Record<string, number> };
  const rows = new Map<number, Row>();
  const get = (id: number) => {
    if (!rows.has(id)) rows.set(id, { payable: 0, payableCount: 0, accruing: 0, accruingCount: 0, byService: {} });
    return rows.get(id)!;
  };
  for (const r of results) {
    const row = get(r.request.cscId);
    const svc = r.clockKey.split('.')[0];
    row.payable += r.penaltyAmount;
    row.payableCount++;
    row.byService[svc] = (row.byService[svc] ?? 0) + r.penaltyAmount;
  }
  for (const p of pending) {
    if (!p.accruedPenalty) continue;
    const row = get(p.cscId);
    row.accruing += p.accruedPenalty;
    row.accruingCount++;
  }
  const out = [...rows.entries()].map(([cscId, r]) => {
    const c = cscs.find((x) => x.id === cscId)!;
    return { cscId, csc: c.name, branch: c.branch.name, feederClass: c.feederClass, ...r, payable: round2(r.payable), accruing: round2(r.accruing) };
  });
  const totalPayable = out.reduce((s, r) => s + r.payable, 0);
  out.sort((a, b) => b.payable - a.payable || b.accruing - a.accruing);
  const services = [...new Set(out.flatMap((r) => Object.keys(r.byService)))].map((code) => ({ code, name: findService(code)?.name ?? code }));
  return {
    period: { from, to },
    services,
    totals: { payable: round2(totalPayable), payableCount: out.reduce((s, r) => s + r.payableCount, 0), accruing: round2(out.reduce((s, r) => s + r.accruing, 0)), accruingCount: out.reduce((s, r) => s + r.accruingCount, 0) },
    rows: out.map((r) => ({ ...r, share: totalPayable ? round2((r.payable / totalPayable) * 100) : null })),
  };
}

/** The individual cases behind one CSC's commercial-quality compensation. */
export async function commercialCompensationCases(user: AuthUser, cscId: number, from: Date, to: Date) {
  const reqWhere = await scopeWhere(user, cscId);
  const [results, pending, codes] = await Promise.all([
    prisma.clockResult.findMany({
      where: { endedAt: { gte: from, lt: to }, penaltyAmount: { gt: 0 }, request: reqWhere },
      include: { request: { select: { id: true, refNo: true, customerName: true, serviceType: true, accountNo: true } } },
      orderBy: { penaltyAmount: 'desc' },
    }),
    pendingRows(user, { cscId }),
    prisma.reasonCode.findMany({ where: { category: 'DELAY' } }),
  ]);
  return [
    ...results.map((r) => ({
      status: 'PAYABLE' as const,
      requestId: r.request.id, refNo: r.request.refNo, customerName: r.request.customerName,
      serviceName: findService(r.request.serviceType)?.name ?? r.request.serviceType, measure: getClock(r.clockKey)?.label ?? r.clockKey,
      date: r.endedAt, elapsed: r.elapsed, unit: r.unit, regulatoryTarget: r.regulatoryTarget, amount: r.penaltyAmount,
      reasons: r.delayReasons.map((c) => codes.find((x) => x.code === c)?.description ?? c),
    })),
    ...pending
      .filter((p) => p.accruedPenalty > 0)
      .map((p) => ({
        status: 'ACCRUING' as const,
        requestId: p.requestId, refNo: p.refNo, customerName: p.customerName, serviceName: p.serviceName, measure: p.clockLabel,
        date: p.startedAt, elapsed: p.elapsed, unit: p.unit, regulatoryTarget: p.regulatoryTarget, amount: p.accruedPenalty, reasons: [] as string[],
      })),
  ];
}

/** KPI averages (section x.2 tables) for requests created in the period. */
export async function kpiReport(user: AuthUser, serviceType: string, from: Date, to: Date, cscId?: number) {
  const service = getService(serviceType);
  const where = await scopeWhere(user, cscId);
  where.serviceType = serviceType;
  where.createdAt = { gte: from, lt: to };
  where.status = { not: 'CANCELLED' };
  const reqs = await prisma.serviceRequest.findMany({ where, include: { events: true, csc: true } });
  const rules = await loadRules();
  const acc = new Map<string, number[]>();
  const accCsc = new Map<string, Map<string, number[]>>();
  for (const r of reqs) {
    for (const k of evaluateKpis(service, r.events.map(toEventLike), rules.calendar)) {
      if (k.value === null) continue;
      if (!acc.has(k.code)) acc.set(k.code, []);
      acc.get(k.code)!.push(k.value);
      if (!accCsc.has(r.csc.name)) accCsc.set(r.csc.name, new Map());
      const m = accCsc.get(r.csc.name)!;
      if (!m.has(k.code)) m.set(k.code, []);
      m.get(k.code)!.push(k.value);
    }
  }
  const stats = (v: number[] = []) => (v.length ? { count: v.length, avg: round2(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v) } : { count: 0, avg: null, max: null });
  return {
    service: { code: service.code, name: service.name, kpiPrefix: service.kpiPrefix, unit: service.kpiUnit },
    requests: reqs.length,
    kpis: service.kpis.map((k) => ({ ...k, ...stats(acc.get(k.code)) })),
    byCsc: [...accCsc.entries()].map(([csc, m]) => ({ csc, values: Object.fromEntries(service.kpis.map((k) => [k.code, stats(m.get(k.code)).avg])) })),
  };
}
