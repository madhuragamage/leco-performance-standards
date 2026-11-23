import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/auth.js';
import {
  commercialCompensationByCsc,
  commercialCompensationCases,
  dashboard,
  kpiReport,
  localDayStart,
  localKey,
  localMonthRange,
  pendingRows,
} from '../services/analytics.js';
import { LISS, lissReport, penaltyRegister, toCsv } from '../services/reports.js';

export const monitoringRouter = Router();

monitoringRouter.get('/pending', async (req, res) => {
  const q = z
    .object({
      serviceType: z.string().optional(),
      cscId: z.coerce.number().int().optional(),
      branchId: z.coerce.number().int().optional(),
      compliance: z.enum(['WITHIN_INTERNAL', 'INTERNAL_EXCEEDED', 'BREACHED', 'NO_TARGET']).optional(),
      q: z.string().optional(),
      format: z.enum(['json', 'csv']).default('json'),
    })
    .parse(req.query);
  const rows = await pendingRows(req.user!, q);
  if (q.format === 'csv') {
    const header = ['Ref No', 'Application Ref', 'Service', 'Measure', 'Branch', 'CSC', 'Feeder Class', 'Customer', 'Start date', 'Elapsed', 'Unit', 'Present status', 'To LECO target', 'To regulatory target', 'Status', 'Paused', 'Reason codes', 'Accrued compensation'];
    const data = rows.map((r) => [
      r.refNo, r.portalReference ?? '', r.serviceName, r.clockLabel, r.branchName, r.cscName, r.feederClass, r.customerName, r.startedAt ? localKey(r.startedAt) : '',
      r.elapsed, r.unit, r.presentStatus, r.remainingInternal ?? '', r.remainingRegulatory ?? '', r.compliance, r.paused ? 'Y' : '', r.reasonCodes.join(' '), r.accruedPenalty,
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pending-services-${localKey(new Date())}.csv"`);
    res.send(toCsv(header, data));
    return;
  }
  res.json(rows);
});

function periodFromQuery(query: unknown) {
  const q = z
    .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), cscId: z.coerce.number().int().optional(), branchId: z.coerce.number().int().optional() })
    .parse(query);
  const today = localKey(new Date());
  const monthStart = localMonthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
  const from = q.from ? localDayStart(q.from) : monthStart.from;
  // `to` is inclusive in the UI, exclusive here.
  const to = q.to ? new Date(localDayStart(q.to).getTime() + 86_400_000) : monthStart.to;
  if (to <= from) throw new HttpError(400, '"To" date must be on or after "From" date', 'BAD_PERIOD');
  return { from, to, cscId: q.cscId, branchId: q.branchId };
}

monitoringRouter.get('/dashboard', async (req, res) => {
  const p = periodFromQuery(req.query);
  res.json(await dashboard(req.user!, p.from, p.to, p.cscId, p.branchId));
});

monitoringRouter.get('/compensation/by-csc', async (req, res) => {
  const p = periodFromQuery(req.query);
  res.json(await commercialCompensationByCsc(req.user!, p.from, p.to, p.branchId));
});

monitoringRouter.get('/compensation/by-csc/:cscId', async (req, res) => {
  const p = periodFromQuery(req.query);
  res.json(await commercialCompensationCases(req.user!, z.coerce.number().int().parse(req.params.cscId), p.from, p.to));
});

monitoringRouter.get('/kpi', async (req, res) => {
  const p = periodFromQuery(req.query);
  const { serviceType } = z.object({ serviceType: z.string() }).parse(req.query);
  res.json(await kpiReport(req.user!, serviceType, p.from, p.to, p.cscId));
});

monitoringRouter.get('/reports/liss', (_req, res) => {
  res.json(LISS.map((l) => ({ code: l.code, title: l.title, clockKey: l.clockKey, columns: l.columns })));
});

const monthQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12), format: z.enum(['json', 'csv']).default('json') });

monitoringRouter.get('/reports/liss/:code', async (req, res) => {
  const q = monthQuery.parse(req.query);
  const out = await lissReport(req.user!, req.params.code.toUpperCase(), q.year, q.month);
  if (!out) throw new HttpError(404, 'Unknown LISS report', 'NOT_FOUND');
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="LISS-${out.def.code}-${q.year}-${String(q.month).padStart(2, '0')}.csv"`);
    res.send(out.csv);
    return;
  }
  res.json({ code: out.def.code, title: out.def.title, header: out.header, rows: out.rows });
});

monitoringRouter.get('/reports/penalties', async (req, res) => {
  const q = monthQuery.parse(req.query);
  const out = await penaltyRegister(req.user!, q.year, q.month);
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="compensation-register-${q.year}-${String(q.month).padStart(2, '0')}.csv"`);
    res.send(out.csv);
    return;
  }
  res.json({ header: out.header, rows: out.rows, total: out.total });
});
