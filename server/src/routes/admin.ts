import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { type ApprovalLimit, type Role, APPROVER_ROLES, ROLES, getClock, validateApprovalLimits } from '../domain/catalog.js';
import { HttpError, requireRole } from '../middleware/auth.js';
import { invalidateRules, loadRules } from '../services/rules.js';
import { recomputeClockResults } from '../services/requests.js';

export const adminRouter = Router();
const adminOnly = requireRole('ADMIN');

// ---- Thresholds (Threshold 11/12 internal, 21/22 regulatory) --------------------------------
adminRouter.get('/thresholds', async (_req, res) => {
  res.json(await prisma.threshold.findMany({ orderBy: [{ clockKey: 'asc' }, { natureOfSupply: 'asc' }, { changesRequired: 'asc' }, { feederClass: 'asc' }] }));
});

const thresholdSchema = z.object({
  clockKey: z.string().refine((k) => !!getClock(k), 'Unknown clock'),
  natureOfSupply: z.string().default('*'),
  changesRequired: z.enum(['ANY', 'YES', 'NO']).default('ANY'),
  feederClass: z.number().int().min(0).max(4).default(0),
  internalTarget: z.number().min(0).nullable(),
  regulatoryTarget: z.number().min(0).nullable(),
  provisional: z.boolean().default(true),
  note: z.string().max(500).nullable().optional(),
});

adminRouter.post('/thresholds', adminOnly, async (req, res) => {
  const b = thresholdSchema.parse(req.body);
  const { clockKey, natureOfSupply, changesRequired, feederClass, ...vals } = b;
  const row = await prisma.threshold.upsert({
    where: { clockKey_natureOfSupply_changesRequired_feederClass: { clockKey, natureOfSupply, changesRequired, feederClass } },
    create: b,
    update: vals,
  });
  invalidateRules();
  res.json(row);
});

adminRouter.put('/thresholds/:id', adminOnly, async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = thresholdSchema.partial().parse(req.body);
  const row = await prisma.threshold.update({ where: { id }, data: b });
  invalidateRules();
  res.json(row);
});

adminRouter.delete('/thresholds/:id', adminOnly, async (req, res) => {
  await prisma.threshold.delete({ where: { id: z.coerce.number().int().parse(req.params.id) } });
  invalidateRules();
  res.json({ ok: true });
});

// ---- Penalty / compensation rules -------------------------------------------------------------
adminRouter.get('/penalties', async (_req, res) => {
  res.json(await prisma.penaltyRule.findMany({ orderBy: [{ clockKey: 'asc' }, { natureOfSupply: 'asc' }] }));
});

const penaltySchema = z.object({
  clockKey: z.string().refine((k) => !!getClock(k), 'Unknown clock'),
  natureOfSupply: z.string().default('*'),
  ratePerUnit: z.number().min(0),
  maxAmount: z.number().min(0),
  perAffectedCustomer: z.boolean().default(false),
  note: z.string().max(500).nullable().optional(),
});

adminRouter.post('/penalties', adminOnly, async (req, res) => {
  const b = penaltySchema.parse(req.body);
  const { clockKey, natureOfSupply, ...vals } = b;
  const row = await prisma.penaltyRule.upsert({ where: { clockKey_natureOfSupply: { clockKey, natureOfSupply } }, create: b, update: vals });
  invalidateRules();
  res.json(row);
});

adminRouter.delete('/penalties/:id', adminOnly, async (req, res) => {
  await prisma.penaltyRule.delete({ where: { id: z.coerce.number().int().parse(req.params.id) } });
  invalidateRules();
  res.json({ ok: true });
});

// ---- Estimate approval limits (report section 2.1) ----------------------------------------------
adminRouter.get('/approval-limits', async (_req, res) => {
  const rules = await loadRules();
  const rows = await prisma.approvalLimit.findMany();
  res.json(APPROVER_ROLES.map((role) => ({ role, upTo: rules.approvalLimits.find((l) => l.role === role)?.upTo ?? null, updatedAt: rows.find((r) => r.role === role)?.updatedAt ?? null })));
});

adminRouter.put('/approval-limits', adminOnly, async (req, res) => {
  const limits = z
    .array(z.object({ role: z.enum(APPROVER_ROLES as [Role, ...Role[]]), upTo: z.number().positive().nullable() }))
    .parse(req.body) as ApprovalLimit[];
  const problem = validateApprovalLimits(limits);
  if (problem) throw new HttpError(422, problem, 'BAD_LIMITS');
  await prisma.$transaction(limits.map((l) => prisma.approvalLimit.upsert({ where: { role: l.role }, create: { role: l.role, upTo: l.upTo }, update: { upTo: l.upTo } })));
  invalidateRules();
  res.json(limits);
});

// ---- Reason codes ------------------------------------------------------------------------------
adminRouter.get('/reason-codes', async (_req, res) => {
  res.json(await prisma.reasonCode.findMany({ orderBy: [{ category: 'asc' }, { code: 'asc' }] }));
});

adminRouter.post('/reason-codes', adminOnly, async (req, res) => {
  const b = z
    .object({ category: z.enum(['NON_CONFORMITY', 'WAYLEAVE', 'OBJECTION', 'DELAY']), code: z.string().trim().min(1).max(20), description: z.string().trim().min(1).max(300), active: z.boolean().default(true) })
    .parse(req.body);
  res.json(await prisma.reasonCode.upsert({ where: { category_code: { category: b.category, code: b.code } }, create: b, update: { description: b.description, active: b.active } }));
});

// ---- Holidays ------------------------------------------------------------------------------------
adminRouter.get('/holidays', async (_req, res) => {
  res.json(await prisma.holiday.findMany({ orderBy: { date: 'asc' } }));
});

adminRouter.post('/holidays', adminOnly, async (req, res) => {
  const b = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(1).max(100) }).parse(req.body);
  const row = await prisma.holiday.upsert({ where: { date: b.date }, create: b, update: { name: b.name } });
  invalidateRules();
  res.json(row);
});

adminRouter.delete('/holidays/:date', adminOnly, async (req, res) => {
  await prisma.holiday.delete({ where: { date: String(req.params.date) } });
  invalidateRules();
  res.json({ ok: true });
});

// ---- CSCs / feeder classes --------------------------------------------------------------------------
adminRouter.put('/cscs/:id', adminOnly, async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = z.object({ name: z.string().trim().min(1).optional(), feederClass: z.number().int().min(1).max(4).optional(), branchId: z.number().int().optional() }).parse(req.body);
  res.json(await prisma.csc.update({ where: { id }, data: b }));
});

adminRouter.post('/cscs', adminOnly, async (req, res) => {
  const b = z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1), feederClass: z.number().int().min(1).max(4), branchId: z.number().int() }).parse(req.body);
  res.status(201).json(await prisma.csc.create({ data: b }));
});

// ---- Users -----------------------------------------------------------------------------------------
adminRouter.get('/users', adminOnly, async (_req, res) => {
  const users = await prisma.user.findMany({ include: { csc: true, branch: true }, orderBy: { username: 'asc' } });
  res.json(users.map(({ passwordHash, ...u }) => u));
});

const roleEnum = z.enum(ROLES.map((r) => r.code) as [string, ...string[]]);

adminRouter.post('/users', adminOnly, async (req, res) => {
  const b = z
    .object({
      username: z.string().trim().toLowerCase().min(3).max(50).regex(/^[a-z0-9._-]+$/),
      fullName: z.string().trim().min(1),
      role: roleEnum,
      cscId: z.number().int().nullable().optional(),
      branchId: z.number().int().nullable().optional(),
      password: z.string().min(8),
    })
    .parse(req.body);
  const { password, ...rest } = b;
  const u = await prisma.user.create({ data: { ...rest, role: rest.role as never, passwordHash: await bcrypt.hash(password, 10) } });
  const { passwordHash, ...out } = u;
  res.status(201).json(out);
});

adminRouter.put('/users/:id', adminOnly, async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = z
    .object({
      fullName: z.string().trim().min(1).optional(),
      role: roleEnum.optional(),
      cscId: z.number().int().nullable().optional(),
      branchId: z.number().int().nullable().optional(),
      active: z.boolean().optional(),
      password: z.string().min(8).optional(),
    })
    .parse(req.body);
  if (id === req.user!.id && (b.active === false || (b.role && b.role !== 'ADMIN'))) throw new HttpError(422, 'You cannot disable or demote your own account', 'SELF_LOCKOUT');
  const { password, ...rest } = b;
  const u = await prisma.user.update({ where: { id }, data: { ...rest, role: rest.role as never, ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) } });
  const { passwordHash, ...out } = u;
  res.json(out);
});

// ---- Maintenance ---------------------------------------------------------------------------------------
/** Re-evaluate stored clock results, e.g. after PUCSL publishes final targets. */
adminRouter.post('/recompute', adminOnly, async (req, res) => {
  const { since } = z.object({ since: z.coerce.date().optional() }).parse(req.body ?? {});
  invalidateRules();
  const reqs = await prisma.serviceRequest.findMany({ where: since ? { updatedAt: { gte: since } } : {}, select: { id: true } });
  for (const r of reqs) await recomputeClockResults(r.id);
  res.json({ recomputed: reqs.length });
});
