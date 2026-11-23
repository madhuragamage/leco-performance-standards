import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import {
  type FileError,
  type Figures,
  INTERRUPTION_CATEGORIES,
  type InterruptionRow,
  type TransformerRow,
  computeIndices,
  consumersIn,
  eensCompensation,
  individualCompensation,
  monthsBetween,
  overallCompensation,
  allocateByExcess,
} from '../domain/supply.js';
import { type AuthUser, HttpError, visibleCscIds } from '../middleware/auth.js';
import { localKey } from './analytics.js';

const LECO_CODES = INTERRUPTION_CATEGORIES.filter((c) => c.owner === 'LECO').map((c) => c.code);
const MAX_ERRORS = 200;

// ---------------------------------------------------------------------------------------------
// Transformer register
// ---------------------------------------------------------------------------------------------

export async function importTransformers(rows: TransformerRow[], parseErrors: FileError[], opts: { dryRun: boolean; month: string; filename?: string | null; actor: AuthUser | null; source: 'WEB' | 'API' }) {
  const errors = [...parseErrors];
  const cscs = await prisma.csc.findMany();
  const byKey = new Map<string, (typeof cscs)[number]>();
  for (const c of cscs) {
    byKey.set(c.code.toLowerCase(), c);
    byKey.set(c.name.toLowerCase(), c);
  }
  const existing = new Map((await prisma.transformer.findMany()).map((t) => [t.code, t]));
  const valid: (TransformerRow & { cscId: number })[] = [];
  for (const r of rows) {
    const csc = byKey.get(r.csc.toLowerCase());
    if (!csc) errors.push({ line: r.line, message: `Unknown CSC "${r.csc}"` });
    else valid.push({ ...r, cscId: csc.id });
  }
  const created = valid.filter((r) => !existing.has(r.code));
  const changed = valid.filter((r) => {
    const t = existing.get(r.code);
    return (
      t &&
      (t.cscId !== r.cscId || t.consumers !== r.consumers || t.active !== r.active || (r.name !== null && t.name !== r.name) || (r.annualEnergyKwh !== null && t.annualEnergyKwh !== r.annualEnergyKwh))
    );
  });
  const byCsc = new Map<string, { transformers: number; consumers: number }>();
  for (const r of valid) {
    const name = cscs.find((c) => c.id === r.cscId)!.name;
    const b = byCsc.get(name) ?? { transformers: 0, consumers: 0 };
    b.transformers++;
    b.consumers += r.consumers;
    byCsc.set(name, b);
  }
  const summary = {
    rows: rows.length + parseErrors.length,
    valid: valid.length,
    new: created.length,
    updated: changed.length,
    unchanged: valid.length - created.length - changed.length,
    consumers: valid.reduce((s, r) => s + r.consumers, 0),
    month: opts.month,
    byCsc: [...byCsc.entries()].map(([csc, v]) => ({ csc, ...v })).sort((a, b) => a.csc.localeCompare(b.csc)),
  };
  if (opts.dryRun || errors.length) return { ok: errors.length === 0, imported: false, summary, errors: errors.slice(0, MAX_ERRORS), errorCount: errors.length };

  await prisma.$transaction(
    async (tx) => {
      if (created.length) {
        await tx.transformer.createMany({ data: created.map((r) => ({ code: r.code, name: r.name, cscId: r.cscId, consumers: r.consumers, active: r.active, annualEnergyKwh: r.annualEnergyKwh })) });
      }
      for (const r of changed) {
        await tx.transformer.update({
          where: { code: r.code },
          data: { cscId: r.cscId, consumers: r.consumers, active: r.active, ...(r.name !== null ? { name: r.name } : {}), ...(r.annualEnergyKwh !== null ? { annualEnergyKwh: r.annualEnergyKwh } : {}) },
        });
      }
      const ids = new Map((await tx.transformer.findMany({ where: { code: { in: valid.map((r) => r.code) } }, select: { id: true, code: true } })).map((t) => [t.code, t.id]));
      await tx.transformerConsumers.deleteMany({ where: { month: opts.month, transformerId: { in: [...ids.values()] } } });
      await tx.transformerConsumers.createMany({ data: valid.map((r) => ({ transformerId: ids.get(r.code)!, month: opts.month, consumers: r.consumers })) });
      await tx.supplyUpload.create({
        data: { kind: 'TRANSFORMERS', source: opts.source, filename: opts.filename ?? null, uploadedById: opts.actor?.id ?? null, rows: valid.length, periodFrom: opts.month, periodTo: opts.month, summary: summary as unknown as Prisma.InputJsonValue },
      });
    },
    { timeout: 120_000 },
  );
  return { ok: true, imported: true, summary, errors: [], errorCount: 0 };
}

// ---------------------------------------------------------------------------------------------
// Interruption data
// ---------------------------------------------------------------------------------------------

export async function importInterruptions(
  rows: InterruptionRow[],
  parseErrors: FileError[],
  parseWarnings: string[],
  opts: { dryRun: boolean; filename?: string | null; actor: AuthUser | null; source: 'WEB' | 'API' },
) {
  const errors = [...parseErrors];
  const warnings = [...parseWarnings];
  const tfs = await prisma.transformer.findMany({ where: { code: { in: [...new Set(rows.map((r) => r.tfCode))] } }, include: { csc: true } });
  const tfByCode = new Map(tfs.map((t) => [t.code, t]));
  const today = localKey(new Date());
  const unknown = new Map<string, number>();
  const valid: (InterruptionRow & { transformerId: number; cscId: number; feederClass: number })[] = [];
  let overDay = 0;
  for (const r of rows) {
    const tf = tfByCode.get(r.tfCode);
    if (!tf) {
      if (!unknown.has(r.tfCode)) unknown.set(r.tfCode, r.line);
      continue;
    }
    if (r.date > today) {
      errors.push({ line: r.line, message: `Date ${r.date} is in the future` });
      continue;
    }
    const consumers = r.consumers ?? tf.consumers;
    if (consumers > 0 && r.consumerHours > consumers * 24) overDay++;
    valid.push({ ...r, transformerId: tf.id, cscId: tf.cscId, feederClass: tf.csc.feederClass });
  }
  for (const [code, line] of unknown) errors.push({ line, message: `Transformer "${code}" is not in the transformer register - upload the register first` });
  if (overDay) warnings.push(`${overDay} row(s) have more consumer hours than consumers x 24 h. That is only possible if a row covers more than one day.`);

  const totals: Record<string, Figures> = {};
  for (const r of valid) {
    const t = (totals[r.category] ??= { hours: 0, interruptions: 0 });
    t.hours += r.consumerHours;
    t.interruptions += r.consumerInterruptions;
  }
  const dates = valid.map((r) => r.date).sort();
  let replaces = 0;
  if (valid.length) {
    const res = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "InterruptionRecord" r
      JOIN unnest(${valid.map((v) => v.date)}::text[], ${valid.map((v) => v.transformerId)}::int[], ${valid.map((v) => v.category)}::text[]) AS k(d, t, c)
        ON r.date = k.d AND r."transformerId" = k.t AND r.category = k.c`;
    replaces = Number(res[0]?.n ?? 0);
  }
  const summary = {
    rows: rows.length,
    valid: valid.length,
    periodFrom: dates[0] ?? null,
    periodTo: dates[dates.length - 1] ?? null,
    transformers: new Set(valid.map((r) => r.transformerId)).size,
    replaces,
    totals: INTERRUPTION_CATEGORIES.map((c) => ({ category: c.code, label: c.label, hours: Math.round((totals[c.code]?.hours ?? 0) * 100) / 100, interruptions: totals[c.code]?.interruptions ?? 0 })),
  };
  if (opts.dryRun || errors.length) {
    return { ok: errors.length === 0, imported: false, summary, warnings, errors: errors.sort((a, b) => a.line - b.line).slice(0, MAX_ERRORS), errorCount: errors.length };
  }

  await prisma.$transaction(
    async (tx) => {
      const upload = await tx.supplyUpload.create({
        data: {
          kind: 'INTERRUPTIONS', source: opts.source, filename: opts.filename ?? null, uploadedById: opts.actor?.id ?? null, rows: valid.length,
          periodFrom: summary.periodFrom, periodTo: summary.periodTo, summary: summary as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.$executeRaw`
        DELETE FROM "InterruptionRecord" r
        USING unnest(${valid.map((v) => v.date)}::text[], ${valid.map((v) => v.transformerId)}::int[], ${valid.map((v) => v.category)}::text[]) AS k(d, t, c)
        WHERE r.date = k.d AND r."transformerId" = k.t AND r.category = k.c`;
      for (let i = 0; i < valid.length; i += 5000) {
        await tx.interruptionRecord.createMany({
          data: valid.slice(i, i + 5000).map((v) => ({
            date: v.date, transformerId: v.transformerId, category: v.category, consumerHours: v.consumerHours, consumerInterruptions: v.consumerInterruptions, ensKwh: v.ensKwh,
            cscId: v.cscId, feederClass: v.feederClass, uploadId: upload.id,
          })),
        });
      }
      // Consumer counts given in the data file update that month's snapshot.
      const snap = new Map<string, { transformerId: number; month: string; consumers: number; date: string }>();
      for (const v of valid) {
        if (v.consumers === null) continue;
        const k = `${v.transformerId}|${v.date.slice(0, 7)}`;
        const cur = snap.get(k);
        if (!cur || v.date >= cur.date) snap.set(k, { transformerId: v.transformerId, month: v.date.slice(0, 7), consumers: v.consumers, date: v.date });
      }
      for (const s of snap.values()) {
        await tx.transformerConsumers.upsert({
          where: { transformerId_month: { transformerId: s.transformerId, month: s.month } },
          create: { transformerId: s.transformerId, month: s.month, consumers: s.consumers },
          update: { consumers: s.consumers },
        });
      }
    },
    { timeout: 300_000 },
  );
  return { ok: true, imported: true, summary, warnings, errors: [], errorCount: 0 };
}

/** Undo an interruption upload: remove the records it still owns. */
export async function deleteUpload(id: number) {
  const up = await prisma.supplyUpload.findUnique({ where: { id } });
  if (!up) throw new HttpError(404, 'Upload not found', 'NOT_FOUND');
  if (up.kind !== 'INTERRUPTIONS') throw new HttpError(422, 'Only interruption uploads can be removed; correct the transformer register by uploading it again', 'NOT_REMOVABLE');
  const { count } = await prisma.interruptionRecord.deleteMany({ where: { uploadId: id } });
  await prisma.supplyUpload.update({ where: { id }, data: { summary: { ...((up.summary as object) ?? {}), removedAt: new Date().toISOString(), removedRecords: count } } });
  return count;
}

// ---------------------------------------------------------------------------------------------
// Indices
// ---------------------------------------------------------------------------------------------

async function scopeCscs(user: AuthUser, cscId?: number, branchId?: number) {
  const ids = await visibleCscIds(user);
  return prisma.csc.findMany({
    where: { AND: [ids ? { id: { in: ids } } : {}, cscId ? { id: cscId } : {}, branchId ? { branchId } : {}] },
    include: { branch: true },
  });
}

/** Average consumers per CSC for each month: sum over its transformers, carried forward from snapshots. */
async function consumersByCscMonth(cscIds: number[], months: string[]) {
  const tfs = await prisma.transformer.findMany({
    where: { cscId: { in: cscIds }, active: true },
    select: { id: true, cscId: true, consumers: true, snapshots: { where: { month: { lte: months[months.length - 1] } }, select: { month: true, consumers: true } } },
  });
  const out = new Map<number, Map<string, number>>();
  for (const t of tfs) {
    const m = out.get(t.cscId) ?? new Map<string, number>();
    for (const month of months) m.set(month, (m.get(month) ?? 0) + consumersIn(month, t.snapshots, t.consumers));
    out.set(t.cscId, m);
  }
  return { byCsc: out, transformers: tfs.length };
}

const avgOver = (perMonth: Map<string, number> | undefined, months: string[]) => (perMonth ? months.reduce((s, m) => s + (perMonth.get(m) ?? 0), 0) / months.length : 0);

export async function supplyIndices(user: AuthUser, from: string, to: string, cscId?: number, branchId?: number) {
  const cscs = await scopeCscs(user, cscId, branchId);
  const ids = cscs.map((c) => c.id);
  const months = monthsBetween(from, to);
  const year = to.slice(0, 4);
  const trendMonths = monthsBetween(`${year}-01-01`, to);
  const allMonths = [...new Set([...months, ...trendMonths])].sort();
  const consumers = await consumersByCscMonth(ids, allMonths);

  const groups = await prisma.interruptionRecord.groupBy({
    by: ['cscId', 'category'],
    where: { date: { gte: from, lte: to }, cscId: { in: ids } },
    _sum: { consumerHours: true, consumerInterruptions: true },
  });
  const totalsFor = (pred: (cscId: number) => boolean) => {
    const t: Record<string, Figures> = {};
    for (const g of groups) {
      if (!pred(g.cscId)) continue;
      const x = (t[g.category] ??= { hours: 0, interruptions: 0 });
      x.hours += g._sum.consumerHours ?? 0;
      x.interruptions += g._sum.consumerInterruptions ?? 0;
    }
    return t;
  };
  const avgFor = (pred: (cscId: number) => boolean, ms = months) => cscs.filter((c) => pred(c.id)).reduce((s, c) => s + avgOver(consumers.byCsc.get(c.id), ms), 0);

  const fcOf = new Map(cscs.map((c) => [c.id, c.feederClass]));
  const targets = await prisma.supplyTarget.findMany({ orderBy: { feederClass: 'asc' } });

  // Period length for annualising: days from "from" to min(to, today).
  const today = localKey(new Date());
  const end = to < today ? to : today;
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(from)) / 86_400_000) + 1);
  const yearDays = (+year % 4 === 0 ? 366 : 365);
  const factor = days >= yearDays ? 1 : yearDays / days;
  const assess = (actual: number | null, target: number | null | undefined) => {
    if (actual === null || target === null || target === undefined) return null;
    const annualised = Math.round(actual * factor * 100) / 100;
    return { target, actual, annualised, status: actual > target ? 'EXCEEDED' : annualised > target ? 'AT_RISK' : 'ON_COURSE' };
  };

  const byFeederClass = [1, 2, 3, 4]
    .filter((fc) => cscs.some((c) => c.feederClass === fc))
    .map((fc) => {
      const pred = (id: number) => fcOf.get(id) === fc;
      const idx = computeIndices(totalsFor(pred), avgFor(pred));
      const t = targets.find((x) => x.feederClass === fc);
      return {
        feederClass: fc,
        cscs: cscs.filter((c) => c.feederClass === fc).length,
        ...idx,
        target: t ? { saidi: assess(idx.leco.saidi, t.saidi), saifi: assess(idx.leco.saifi, t.saifi), provisional: t.provisional } : null,
      };
    });
  const overall = computeIndices(totalsFor(() => true), avgFor(() => true));
  const byCsc = cscs
    .map((c) => ({ cscId: c.id, csc: c.name, branch: c.branch.name, feederClass: c.feederClass, ...computeIndices(totalsFor((id) => id === c.id), avgFor((id) => id === c.id)) }))
    .sort((a, b) => (b.leco.saidi ?? 0) - (a.leco.saidi ?? 0));

  // Monthly LECO SAIDI / SAIFI by feeder class for the year of "to".
  const monthly = await prisma.interruptionRecord.groupBy({
    by: ['date', 'cscId'],
    where: { date: { gte: `${year}-01-01`, lte: to }, cscId: { in: ids }, category: { in: LECO_CODES } },
    _sum: { consumerHours: true, consumerInterruptions: true },
  });
  const trend = trendMonths.map((m) => {
    const row: Record<string, unknown> = { month: m };
    for (const fc of [0, 1, 2, 3, 4]) {
      const pred = (id: number) => fc === 0 || fcOf.get(id) === fc;
      const avg = avgFor(pred, [m]);
      let h = 0;
      let n = 0;
      for (const g of monthly) {
        if (g.date.slice(0, 7) !== m || !pred(g.cscId)) continue;
        h += g._sum.consumerHours ?? 0;
        n += g._sum.consumerInterruptions ?? 0;
      }
      row[fc === 0 ? 'all' : `fc${fc}`] = { saidi: avg ? Math.round((h / avg) * 100) / 100 : null, saifi: avg ? Math.round((n / avg) * 100) / 100 : null };
    }
    return row;
  });

  const coverage = await prisma.interruptionRecord.aggregate({ where: { cscId: { in: ids } }, _max: { date: true }, _min: { date: true } });
  const daysWithData = await prisma.interruptionRecord.groupBy({ by: ['date'], where: { date: { gte: from, lte: to }, cscId: { in: ids } } });

  return {
    period: { from, to, months: months.length, days, annualiseFactor: Math.round(factor * 100) / 100 },
    coverage: { firstDate: coverage._min.date, lastDate: coverage._max.date, daysWithData: daysWithData.length, transformers: consumers.transformers },
    categories: INTERRUPTION_CATEGORIES,
    overall,
    byFeederClass,
    byCsc,
    trend,
    targets,
  };
}

// ---------------------------------------------------------------------------------------------
// Compensation (sections 12.1 - 12.3)
// ---------------------------------------------------------------------------------------------

/**
 * Compensation for a calendar year, company-wide.
 *  - "As at": with the year's indices so far (what would be payable if the year ended today).
 *  - "Projected": with indices annualised to the full year (the same as "as at" once the year is complete).
 */
export async function supplyCompensation(year: number) {
  const today = localKey(new Date());
  const from = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  if (from > today) throw new HttpError(422, `${year} has not started yet`, 'BAD_YEAR');
  const to = yearEnd < today ? yearEnd : today;
  const complete = yearEnd < today;
  const months = monthsBetween(from, to);
  const yearDays = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const factor = complete ? 1 : yearDays / days;

  const cscs = await prisma.csc.findMany();
  const consumers = await consumersByCscMonth(cscs.map((c) => c.id), months);
  const [targets, yearData, groups] = await Promise.all([
    prisma.supplyTarget.findMany(),
    prisma.supplyYearData.findMany({ where: { year } }),
    prisma.interruptionRecord.groupBy({
      by: ['feederClass'],
      where: { date: { gte: from, lte: to }, category: { in: LECO_CODES } },
      _sum: { consumerHours: true, consumerInterruptions: true, ensKwh: true },
    }),
  ]);

  const fcAvg = new Map<number, number>();
  for (const c of cscs) fcAvg.set(c.feederClass, (fcAvg.get(c.feederClass) ?? 0) + avgOver(consumers.byCsc.get(c.id), months));

  const overall = [1, 2, 3, 4].map((fc) => {
    const g = groups.find((x) => x.feederClass === fc);
    const avg = fcAvg.get(fc) ?? 0;
    const hours = g?._sum.consumerHours ?? 0;
    const ints = g?._sum.consumerInterruptions ?? 0;
    const ens = g?._sum.ensKwh ?? 0;
    const saidi = avg ? hours / avg : 0;
    const saifi = avg ? ints / avg : 0;
    const t = targets.find((x) => x.feederClass === fc);
    const yd = yearData.find((x) => x.feederClass === fc);
    const missing: string[] = [];
    if (!yd?.energySalesKwh) missing.push('energy sales');
    if (!yd?.supplyCost) missing.push('supply cost');
    if (t?.saidi == null && t?.saifi == null) missing.push('approved SAIDI / SAIFI');
    const calc = (s: number, f: number) =>
      missing.length ? null : overallCompensation({ saidi: s, saifi: f, approvedSaidi: t?.saidi ?? null, approvedSaifi: t?.saifi ?? null, energyKwh: yd!.energySalesKwh!, supplyCost: yd!.supplyCost! });
    const approvedEensKwh = yd?.approvedEensMwh != null ? yd.approvedEensMwh * 1000 : null;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      feederClass: fc,
      avgConsumers: Math.round(avg),
      consumerHours: r2(hours),
      consumerInterruptions: ints,
      saidi: r2(saidi),
      saifi: r2(saifi),
      projectedSaidi: r2(saidi * factor),
      projectedSaifi: r2(saifi * factor),
      approvedSaidi: t?.saidi ?? null,
      approvedSaifi: t?.saifi ?? null,
      energySalesKwh: yd?.energySalesKwh ?? null,
      supplyCost: yd?.supplyCost ?? null,
      missing,
      asAt: calc(saidi, saifi),
      projected: calc(saidi * factor, saifi * factor),
      eens: {
        actualKwh: Math.round(ens),
        projectedKwh: Math.round(ens * factor),
        approvedKwh: approvedEensKwh,
        cens: yd?.cens ?? null,
        asAt: eensCompensation(ens, approvedEensKwh, yd?.cens ?? null),
        projected: eensCompensation(ens * factor, approvedEensKwh, yd?.cens ?? null),
      },
    };
  });

  // Individual (transformer groups)
  const tfGroups = await prisma.interruptionRecord.groupBy({
    by: ['transformerId'],
    where: { date: { gte: from, lte: to }, category: { in: LECO_CODES } },
    _sum: { consumerHours: true },
  });
  const tfs = await prisma.transformer.findMany({
    where: { id: { in: tfGroups.map((g) => g.transformerId) } },
    include: { csc: { include: { branch: true } }, snapshots: { where: { month: { lte: months[months.length - 1] } }, select: { month: true, consumers: true } } },
  });
  const tfById = new Map(tfs.map((t) => [t.id, t]));
  const individual = [];
  for (const g of tfGroups) {
    const t = tfById.get(g.transformerId);
    if (!t) continue;
    const fc = t.csc.feederClass;
    const tfAvg = months.reduce((s, m) => s + consumersIn(m, t.snapshots, t.consumers), 0) / months.length;
    if (!tfAvg) continue;
    const duration = (g._sum.consumerHours ?? 0) / tfAvg;
    const specified = targets.find((x) => x.feederClass === fc)?.individualHours ?? null;
    const yd = yearData.find((x) => x.feederClass === fc);
    if (specified === null || !yd?.supplyCost) continue;
    if (duration * factor <= specified) continue; // not expected to qualify this year
    const fcEnergyPerConsumer = yd.energySalesKwh && fcAvg.get(fc) ? yd.energySalesKwh / fcAvg.get(fc)! : null;
    const energy = t.annualEnergyKwh ?? (fcEnergyPerConsumer ? fcEnergyPerConsumer * tfAvg : null);
    if (energy === null) continue;
    const asAt = individualCompensation(duration, specified, energy, yd.supplyCost);
    const projected = individualCompensation(duration * factor, specified, energy, yd.supplyCost);
    individual.push({
      transformerId: t.id, code: t.code, name: t.name, cscId: t.cscId, csc: t.csc.name, branch: t.csc.branch.name, feederClass: fc,
      consumers: Math.round(tfAvg),
      energyKwh: Math.round(energy),
      energyEstimated: t.annualEnergyKwh === null,
      durationHours: Math.round(duration * 100) / 100,
      projectedHours: Math.round(duration * factor * 100) / 100,
      specifiedHours: specified,
      supplyCost: yd.supplyCost,
      asAt,
      projected,
    });
  }
  individual.sort((a, b) => b.projected.compensation - a.projected.compensation);

  const sum = (xs: (number | null | undefined)[]) => Math.round(xs.reduce<number>((s, x) => s + (x ?? 0), 0) * 100) / 100;
  return {
    year, from, to, complete, days, factor: Math.round(factor * 1000) / 1000,
    overall,
    individual: {
      rows: individual,
      qualifyingAsAt: individual.filter((r) => r.asAt.compensation > 0).length,
      qualifyingProjected: individual.length,
      estimatedEnergy: individual.filter((r) => r.energyEstimated).length,
    },
    totals: {
      overall: { asAt: sum(overall.map((o) => o.asAt?.compensation)), projected: sum(overall.map((o) => o.projected?.compensation)) },
      eens: { asAt: sum(overall.map((o) => o.eens.asAt.compensation)), projected: sum(overall.map((o) => o.eens.projected.compensation)) },
      individual: { asAt: sum(individual.map((r) => r.asAt.compensation)), projected: sum(individual.map((r) => r.projected.compensation)) },
    },
  };
}

/**
 * Which CSCs the supply quality compensation comes from.
 *  - Overall (12.1): the feeder-class amount is shared by each CSC's excess over the approved level on the
 *    deciding index (consumer hours above the SAIDI allowance, or consumer interruptions above the SAIFI allowance).
 *  - EENS (12.2): shared by each CSC's EENS above its consumer-weighted part of the approved EENS.
 *  - Individual (12.3): exact - each transformer belongs to a CSC.
 */
export async function supplyCompensationByCsc(user: AuthUser, year: number) {
  const comp = await supplyCompensation(year);
  const months = monthsBetween(comp.from, comp.to);
  const cscs = await prisma.csc.findMany({ include: { branch: true } });
  const visible = await visibleCscIds(user);
  const consumers = await consumersByCscMonth(cscs.map((c) => c.id), months);
  const groups = await prisma.interruptionRecord.groupBy({
    by: ['cscId'],
    where: { date: { gte: comp.from, lte: comp.to }, category: { in: LECO_CODES } },
    _sum: { consumerHours: true, consumerInterruptions: true, ensKwh: true },
  });
  const base = cscs.map((c) => {
    const g = groups.find((x) => x.cscId === c.id);
    const avg = avgOver(consumers.byCsc.get(c.id), months);
    const hours = g?._sum.consumerHours ?? 0;
    const ints = g?._sum.consumerInterruptions ?? 0;
    return { csc: c, avg, hours, ints, ens: g?._sum.ensKwh ?? 0, saidi: avg ? hours / avg : 0, saifi: avg ? ints / avg : 0 };
  });

  type Scenario = 'asAt' | 'projected';
  const result = new Map<number, Record<Scenario, { overall: number; eens: number; basis: string | null; excess: number }>>();
  for (const b of base) result.set(b.csc.id, { asAt: { overall: 0, eens: 0, basis: null, excess: 0 }, projected: { overall: 0, eens: 0, basis: null, excess: 0 } });

  for (const o of comp.overall) {
    const members = base.filter((b) => b.csc.feederClass === o.feederClass);
    const fcAvg = members.reduce((s, b) => s + b.avg, 0);
    for (const sc of ['asAt', 'projected'] as Scenario[]) {
      const f = sc === 'asAt' ? 1 : comp.factor;
      const res = o[sc];
      if (res && res.compensation > 0 && res.basis) {
        const onSaidi = res.basis === 'SAIDI';
        const approved = (onSaidi ? o.approvedSaidi : o.approvedSaifi) ?? 0;
        const parts = members.map((b) => ({
          key: b.csc.id,
          // units above the allowance: consumer hours (SAIDI) or consumer interruptions (SAIFI)
          excess: ((onSaidi ? b.saidi : b.saifi) * f - approved) * b.avg,
          weight: onSaidi ? b.hours : b.ints,
        }));
        const alloc = allocateByExcess(res.compensation, parts);
        for (const p of parts) {
          const r = result.get(p.key)![sc];
          r.overall = alloc.get(p.key) ?? 0;
          r.basis = res.basis;
          r.excess = Math.round(Math.max(0, p.excess) * 100) / 100;
        }
      }
      const e = o.eens[sc];
      if (e.compensation && o.eens.approvedKwh !== null) {
        const parts = members.map((b) => ({ key: b.csc.id, excess: b.ens * f - (fcAvg ? (o.eens.approvedKwh! * b.avg) / fcAvg : 0), weight: b.ens }));
        const alloc = allocateByExcess(e.compensation, parts);
        for (const p of parts) result.get(p.key)![sc].eens = alloc.get(p.key) ?? 0;
      }
    }
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rows = base
    .filter((b) => !visible || visible.includes(b.csc.id))
    .map((b) => {
      const r = result.get(b.csc.id)!;
      const fcRow = comp.overall.find((o) => o.feederClass === b.csc.feederClass)!;
      const ind = comp.individual.rows.filter((x) => x.cscId === b.csc.id);
      const indAsAt = r2(ind.reduce((s, x) => s + x.asAt.compensation, 0));
      const indProj = r2(ind.reduce((s, x) => s + x.projected.compensation, 0));
      return {
        cscId: b.csc.id,
        csc: b.csc.name,
        branch: b.csc.branch.name,
        feederClass: b.csc.feederClass,
        avgConsumers: Math.round(b.avg),
        saidi: r2(b.saidi),
        saifi: r2(b.saifi),
        approvedSaidi: fcRow.approvedSaidi,
        approvedSaifi: fcRow.approvedSaifi,
        ensKwh: Math.round(b.ens),
        asAt: { ...r.asAt, individual: indAsAt, individualCount: ind.filter((x) => x.asAt.compensation > 0).length, total: r2(r.asAt.overall + r.asAt.eens + indAsAt) },
        projected: { ...r.projected, individual: indProj, individualCount: ind.length, total: r2(r.projected.overall + r.projected.eens + indProj) },
      };
    })
    .sort((a, b) => b.projected.total - a.projected.total || b.asAt.total - a.asAt.total);

  return {
    year: comp.year, from: comp.from, to: comp.to, complete: comp.complete, factor: comp.factor,
    companyTotals: comp.totals,
    feederClasses: comp.overall.map((o) => ({ feederClass: o.feederClass, asAt: o.asAt, projected: o.projected, missing: o.missing })),
    partial: !!visible,
    rows,
  };
}

/** Transformers with the longest LECO interruption duration (section 12.3 individual supply quality). */
export async function transformerDurations(user: AuthUser, from: string, to: string, cscId?: number, limit = 25) {
  const cscs = await scopeCscs(user, cscId);
  const ids = cscs.map((c) => c.id);
  const groups = await prisma.interruptionRecord.groupBy({
    by: ['transformerId'],
    where: { date: { gte: from, lte: to }, cscId: { in: ids }, category: { in: LECO_CODES } },
    _sum: { consumerHours: true, consumerInterruptions: true },
  });
  const tfs = await prisma.transformer.findMany({ where: { id: { in: groups.map((g) => g.transformerId) } }, include: { csc: true } });
  const targets = new Map((await prisma.supplyTarget.findMany()).map((t) => [t.feederClass, t.individualHours]));
  const rows = groups
    .map((g) => {
      const t = tfs.find((x) => x.id === g.transformerId)!;
      const hours = t.consumers ? (g._sum.consumerHours ?? 0) / t.consumers : 0;
      const limitHours = targets.get(t.csc.feederClass) ?? null;
      return {
        transformerId: t.id, code: t.code, name: t.name, csc: t.csc.name, feederClass: t.csc.feederClass, consumers: t.consumers,
        consumerHours: Math.round((g._sum.consumerHours ?? 0) * 100) / 100,
        durationHours: Math.round(hours * 100) / 100,
        interruptions: t.consumers ? Math.round(((g._sum.consumerInterruptions ?? 0) / t.consumers) * 10) / 10 : 0,
        limitHours,
        exceeds: limitHours !== null && hours > limitHours,
      };
    })
    .sort((a, b) => b.durationHours - a.durationHours);
  return { exceeding: rows.filter((r) => r.exceeds).length, transformersWithOutages: rows.length, rows: rows.slice(0, limit) };
}
