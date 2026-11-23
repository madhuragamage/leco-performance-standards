import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { INTERRUPTION_CATEGORIES, parseInterruptionFile, parseTransformerFile } from '../domain/supply.js';
import { HttpError, requireRole } from '../middleware/auth.js';
import { localKey } from '../services/analytics.js';
import { deleteUpload, importInterruptions, importTransformers, supplyCompensation, supplyCompensationByCsc, supplyIndices, transformerDurations } from '../services/supply.js';
import type { Role } from '../domain/catalog.js';

export const supplyRouter = Router();

/** Who may load supply quality data. */
export const SUPPLY_UPLOADERS: Role[] = ['ADMIN', 'CE', 'HENG', 'SDM'];
const uploaders = requireRole(...SUPPLY_UPLOADERS);
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

supplyRouter.get('/meta', async (_req, res) => {
  res.json({ categories: INTERRUPTION_CATEGORIES, uploaders: SUPPLY_UPLOADERS, targets: await prisma.supplyTarget.findMany({ orderBy: { feederClass: 'asc' } }) });
});

supplyRouter.post('/uploads/transformers', uploaders, async (req, res) => {
  const b = z
    .object({ csv: z.string().min(1), filename: z.string().max(255).optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional(), dryRun: z.boolean().default(true) })
    .parse(req.body);
  const parsed = parseTransformerFile(b.csv);
  res.json(await importTransformers(parsed.rows, parsed.errors, { dryRun: b.dryRun, month: b.month ?? localKey(new Date()).slice(0, 7), filename: b.filename, actor: req.user!, source: 'WEB' }));
});

supplyRouter.post('/uploads/interruptions', uploaders, async (req, res) => {
  const b = z
    .object({ csv: z.string().min(1), filename: z.string().max(255).optional(), dateFormat: z.enum(['AUTO', 'YMD', 'DMY', 'MDY']).default('AUTO'), dryRun: z.boolean().default(true) })
    .parse(req.body);
  const parsed = parseInterruptionFile(b.csv, b.dateFormat);
  const out = await importInterruptions(parsed.rows, parsed.errors, parsed.warnings, { dryRun: b.dryRun, filename: b.filename, actor: req.user!, source: 'WEB' });
  res.json({ ...out, layout: parsed.layout });
});

supplyRouter.get('/uploads', async (_req, res) => {
  const ups = await prisma.supplyUpload.findMany({ orderBy: { uploadedAt: 'desc' }, take: 100 });
  const users = new Map((await prisma.user.findMany({ where: { id: { in: ups.map((u) => u.uploadedById).filter((x): x is number => !!x) } } })).map((u) => [u.id, u.fullName]));
  res.json(ups.map((u) => ({ ...u, uploadedBy: u.uploadedById ? users.get(u.uploadedById) ?? null : u.source === 'API' ? 'ADMS / API' : null })));
});

supplyRouter.delete('/uploads/:id', uploaders, async (req, res) => {
  res.json({ removed: await deleteUpload(z.coerce.number().int().parse(req.params.id)) });
});

supplyRouter.get('/transformers', async (req, res) => {
  const q = z.object({ q: z.string().optional(), cscId: z.coerce.number().int().optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const where = {
    ...(q.cscId ? { cscId: q.cscId } : {}),
    ...(q.q ? { OR: [{ code: { contains: q.q, mode: 'insensitive' as const } }, { name: { contains: q.q, mode: 'insensitive' as const } }] } : {}),
  };
  const [total, rows, agg] = await Promise.all([
    prisma.transformer.count({ where }),
    prisma.transformer.findMany({ where, include: { csc: true }, orderBy: { code: 'asc' }, skip: (q.page - 1) * 50, take: 50 }),
    prisma.transformer.aggregate({ where: { ...where, active: true }, _sum: { consumers: true } }),
  ]);
  res.json({ total, consumers: agg._sum.consumers ?? 0, rows: rows.map((t) => ({ id: t.id, code: t.code, name: t.name, csc: t.csc.name, feederClass: t.csc.feederClass, consumers: t.consumers, active: t.active })) });
});

function period(query: unknown) {
  const today = localKey(new Date());
  const q = z.object({ from: dateKey.optional(), to: dateKey.optional(), cscId: z.coerce.number().int().optional(), branchId: z.coerce.number().int().optional() }).parse(query);
  const to = q.to ?? today;
  const from = q.from ?? `${to.slice(0, 4)}-01-01`;
  if (from > to) throw new HttpError(400, '"From" must be on or before "To"', 'BAD_PERIOD');
  return { ...q, from, to };
}

supplyRouter.get('/indices', async (req, res) => {
  const p = period(req.query);
  res.json(await supplyIndices(req.user!, p.from, p.to, p.cscId, p.branchId));
});

supplyRouter.get('/transformer-durations', async (req, res) => {
  const p = period(req.query);
  res.json(await transformerDurations(req.user!, p.from, p.to, p.cscId));
});

/** Company-wide compensation figures - management and the Control Engineer only. */
supplyRouter.get('/compensation', requireRole('GM', 'HENG', 'SDM', 'CE'), async (req, res) => {
  const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100).default(Number(localKey(new Date()).slice(0, 4))) }).parse(req.query);
  res.json(await supplyCompensation(year));
});

/** CSC contributions; Branch Managers see their own CSCs. */
supplyRouter.get('/compensation/by-csc', requireRole('GM', 'HENG', 'SDM', 'CE', 'BM'), async (req, res) => {
  const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100).default(Number(localKey(new Date()).slice(0, 4))) }).parse(req.query);
  res.json(await supplyCompensationByCsc(req.user!, year));
});

supplyRouter.get('/year-data', async (req, res) => {
  const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.query);
  const rows = await prisma.supplyYearData.findMany({ where: { year } });
  res.json([1, 2, 3, 4].map((fc) => rows.find((r) => r.feederClass === fc) ?? { year, feederClass: fc, energySalesKwh: null, supplyCost: null, cens: null, approvedEensMwh: null, note: null, updatedAt: null }));
});

supplyRouter.put('/year-data', requireRole('ADMIN'), async (req, res) => {
  const rows = z
    .array(
      z.object({
        year: z.number().int().min(2000).max(2100),
        feederClass: z.number().int().min(1).max(4),
        energySalesKwh: z.number().min(0).nullable(),
        supplyCost: z.number().min(0).nullable(),
        cens: z.number().min(0).nullable(),
        approvedEensMwh: z.number().min(0).nullable(),
        note: z.string().max(300).nullable().optional(),
      }),
    )
    .min(1)
    .parse(req.body);
  await prisma.$transaction(rows.map((r) => prisma.supplyYearData.upsert({ where: { year_feederClass: { year: r.year, feederClass: r.feederClass } }, create: r, update: r })));
  res.json(await prisma.supplyYearData.findMany({ where: { year: rows[0].year }, orderBy: { feederClass: 'asc' } }));
});

supplyRouter.put('/targets', requireRole('ADMIN'), async (req, res) => {
  const rows = z
    .array(
      z.object({
        feederClass: z.number().int().min(1).max(4),
        saidi: z.number().min(0).nullable(),
        saifi: z.number().min(0).nullable(),
        maifi: z.number().min(0).nullable().optional(),
        individualHours: z.number().min(0).nullable(),
        provisional: z.boolean(),
        note: z.string().max(300).nullable().optional(),
      }),
    )
    .parse(req.body);
  await prisma.$transaction(rows.map((r) => prisma.supplyTarget.upsert({ where: { feederClass: r.feederClass }, create: r, update: r })));
  res.json(await prisma.supplyTarget.findMany({ orderBy: { feederClass: 'asc' } }));
});
