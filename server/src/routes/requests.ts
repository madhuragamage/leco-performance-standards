import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { type Role, findService, getService } from '../domain/catalog.js';
import { evaluateRequest } from '../domain/sla.js';
import { allowedSteps } from '../domain/workflow.js';
import { HttpError, assertCanSeeCsc, requireRole, visibleCscIds } from '../middleware/auth.js';
import { loadRules } from '../services/rules.js';
import { contextOf, createRequest, deleteEvent, getRequestDetail, recomputeClockResults, recordEvent, toEventLike } from '../services/requests.js';

export const requestsRouter = Router();

const optStr = z.string().trim().max(500).optional().nullable();

requestsRouter.get('/', async (req, res) => {
  const q = z
    .object({
      serviceType: z.string().optional(),
      status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']).optional(),
      cscId: z.coerce.number().int().optional(),
      q: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    })
    .parse(req.query);
  const ids = await visibleCscIds(req.user!);
  const where: Prisma.ServiceRequestWhereInput = {
    ...(q.serviceType ? { serviceType: q.serviceType } : {}),
    ...(q.status ? { status: q.status } : {}),
    AND: [...(ids ? [{ cscId: { in: ids } }] : []), ...(q.cscId ? [{ cscId: q.cscId }] : [])],
    ...(q.q
      ? {
          OR: [
            { refNo: { contains: q.q, mode: 'insensitive' } },
            { customerName: { contains: q.q, mode: 'insensitive' } },
            { portalReference: { contains: q.q, mode: 'insensitive' } },
            { accountNo: { contains: q.q, mode: 'insensitive' } },
            { mobile: { contains: q.q } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.serviceRequest.count({ where }),
    prisma.serviceRequest.findMany({
      where,
      include: { csc: true, events: true, assignedTo: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  const rules = await loadRules();
  res.json({
    total,
    page: q.page,
    pageSize: q.pageSize,
    rows: rows.map((r) => {
      const service = findService(r.serviceType);
      const clocks = service ? evaluateRequest(service, r.events.map(toEventLike), contextOf(r), rules).clocks : [];
      const worst = clocks.find((c) => c.compliance === 'BREACHED') ?? clocks.find((c) => c.compliance === 'INTERNAL_EXCEEDED') ?? clocks.find((c) => c.state !== 'NOT_APPLICABLE');
      const { events, ...rest } = r;
      return {
        ...rest,
        serviceName: service?.name ?? r.serviceType,
        currentStepLabel: service?.steps.find((s) => s.key === r.currentStep)?.label ?? r.currentStep,
        compliance: worst?.compliance ?? 'NO_TARGET',
        running: clocks.some((c) => c.state === 'RUNNING'),
        eventCount: events.length,
      };
    }),
  });
});

const createSchema = z.object({
  serviceType: z.string(),
  cscId: z.number().int(),
  source: z.enum(['COUNTER', 'CALL_CENTER', 'FIELD', 'PORTAL', 'ADMS']).default('COUNTER'),
  customerName: z.string().trim().min(1).max(200),
  accountNo: optStr,
  nic: optStr,
  mobile: optStr,
  email: z.string().email().optional().nullable().or(z.literal('')),
  address: optStr,
  natureOfSupply: z.string().optional().nullable(),
  subType: z.string().optional().nullable(),
  expectedServiceDate: z.coerce.date().optional().nullable(),
  occurredAt: z.coerce.date().optional(),
  intakeData: z.record(z.unknown()).optional(),
  reasonCodes: z.array(z.string()).optional(),
  notes: optStr,
});

requestsRouter.post('/', async (req, res) => {
  const b = createSchema.parse(req.body);
  await assertCanSeeCsc(req.user!, b.cscId);
  const created = await createRequest(
    {
      ...b,
      email: b.email || null,
      intakeAt: b.occurredAt,
    },
    req.user!,
  );
  res.status(201).json(created);
});

requestsRouter.get('/:id', async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const detail = await getRequestDetail(id, req.user!);
  await assertCanSeeCsc(req.user!, detail.request.cscId);
  res.json(detail);
});

requestsRouter.patch('/:id', async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = z
    .object({
      customerName: z.string().trim().min(1).max(200).optional(),
      accountNo: optStr,
      nic: optStr,
      mobile: optStr,
      email: optStr,
      address: optStr,
      natureOfSupply: z.string().optional().nullable(),
      subType: z.string().optional().nullable(),
      changesRequired: z.boolean().optional().nullable(),
      wayleaveRequired: z.boolean().optional().nullable(),
      affectedCustomers: z.number().int().min(0).optional().nullable(),
      expectedServiceDate: z.coerce.date().optional().nullable(),
    })
    .parse(req.body);
  const existing = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Request not found', 'NOT_FOUND');
  await assertCanSeeCsc(req.user!, existing.cscId);
  const service = getService(existing.serviceType);
  if (b.natureOfSupply && !service.natureOptions.includes(b.natureOfSupply)) throw new HttpError(400, 'Invalid nature of supply', 'BAD_NATURE');
  await prisma.serviceRequest.update({ where: { id }, data: b });
  // Classification affects which target applies, so stopped clocks are re-evaluated.
  if ('natureOfSupply' in b || 'changesRequired' in b || 'affectedCustomers' in b) await recomputeClockResults(id);
  res.json(await getRequestDetail(id, req.user!));
});

requestsRouter.post('/:id/events', async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = z
    .object({
      stepKey: z.string(),
      occurredAt: z.coerce.date(),
      notes: optStr,
      reasonCodes: z.array(z.string()).optional(),
      data: z.record(z.unknown()).optional(),
      delayReasons: z.array(z.string()).optional(),
      delayNotes: optStr,
    })
    .parse(req.body);
  const existing = await prisma.serviceRequest.findUnique({ where: { id }, select: { cscId: true } });
  if (!existing) throw new HttpError(404, 'Request not found', 'NOT_FOUND');
  await assertCanSeeCsc(req.user!, existing.cscId);
  res.status(201).json(await recordEvent(id, b, req.user!));
});

requestsRouter.delete('/:id/events/:eventId', requireRole('ADMIN', 'BM'), async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const eventId = z.coerce.number().int().parse(req.params.eventId);
  const existing = await prisma.serviceRequest.findUnique({ where: { id }, select: { cscId: true } });
  if (!existing) throw new HttpError(404, 'Request not found', 'NOT_FOUND');
  await assertCanSeeCsc(req.user!, existing.cscId);
  await deleteEvent(id, eventId);
  res.json(await getRequestDetail(id, req.user!));
});

requestsRouter.post('/:id/cancel', requireRole('ADMIN', 'BM', 'CSS', 'CLERK'), async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
  const existing = await prisma.serviceRequest.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'Request not found', 'NOT_FOUND');
  await assertCanSeeCsc(req.user!, existing.cscId);
  if (existing.status !== 'OPEN') throw new HttpError(422, 'Only open requests can be cancelled', 'NOT_OPEN');
  const details = { ...((existing.details as Record<string, unknown>) ?? {}), cancelReason: reason, cancelledBy: req.user!.username };
  await prisma.serviceRequest.update({ where: { id }, data: { status: 'CANCELLED', details } });
  res.json(await getRequestDetail(id, req.user!));
});

// ---- Assignment ------------------------------------------------------------------------------------

/** Roles that may assign work to others. Anyone eligible may take a request themselves. */
const ASSIGNERS: Role[] = ['ADMIN', 'GM', 'HENG', 'SDM', 'BM', 'CSS', 'CLERK', 'BE'];

async function eligibleAssignees(requestId: number) {
  const r = await prisma.serviceRequest.findUnique({ where: { id: requestId }, include: { csc: true, events: true } });
  if (!r) throw new HttpError(404, 'Request not found', 'NOT_FOUND');
  const service = getService(r.serviceType);
  const serviceRoles = new Set(service.steps.flatMap((s) => s.roles));
  const users = await prisma.user.findMany({
    where: {
      active: true,
      role: { in: [...serviceRoles] as never },
      OR: [{ cscId: r.cscId }, { cscId: null, branchId: r.csc.branchId }, { cscId: null, branchId: null }],
    },
    orderBy: { fullName: 'asc' },
  });
  const rules = await loadRules();
  const events = r.events.map(toEventLike);
  const state = { status: r.status, estimateAmount: r.estimateAmount, approvalLimits: rules.approvalLimits };
  const actNow = (role: Role) => allowedSteps(service, events, role, state).some((s) => s.roles.includes(role) && !s.optional);
  return {
    request: r,
    users: users
      .map((u) => ({ id: u.id, fullName: u.fullName, role: u.role, canActNow: actNow(u.role as Role) }))
      .sort((a, b) => Number(b.canActNow) - Number(a.canActNow) || a.fullName.localeCompare(b.fullName)),
  };
}

requestsRouter.get('/:id/assignees', async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const { request, users } = await eligibleAssignees(id);
  await assertCanSeeCsc(req.user!, request.cscId);
  res.json(users);
});

requestsRouter.post('/:id/assign', async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = z.object({ userId: z.number().int().nullable(), note: optStr }).parse(req.body);
  const { request, users } = await eligibleAssignees(id);
  await assertCanSeeCsc(req.user!, request.cscId);
  if (request.status !== 'OPEN') throw new HttpError(422, 'Only open requests can be assigned', 'NOT_OPEN');
  const me = req.user!;
  const isAssigner = ASSIGNERS.includes(me.role);
  const selfTake = b.userId === me.id;
  const selfRelease = b.userId === null && request.assignedToId === me.id;
  if (!isAssigner && !selfTake && !selfRelease) throw new HttpError(403, 'You can only take requests yourself; ask your CSS or Branch Manager to assign others', 'FORBIDDEN');
  if (b.userId !== null && !users.some((u) => u.id === b.userId)) throw new HttpError(422, 'That person cannot work on this request (role or CSC does not match)', 'BAD_ASSIGNEE');
  await prisma.$transaction([
    prisma.serviceRequest.update({ where: { id }, data: { assignedToId: b.userId, assignedAt: b.userId ? new Date() : null } }),
    prisma.requestAssignment.create({ data: { requestId: id, assignedToId: b.userId, assignedById: me.id, note: b.note ?? null } }),
  ]);
  res.json(await getRequestDetail(id, me));
});

requestsRouter.post('/:id/feedback', async (req, res) => {
  const id = z.coerce.number().int().parse(req.params.id);
  const b = z.object({ rating: z.number().int().min(1).max(5), comment: optStr }).parse(req.body);
  const existing = await prisma.serviceRequest.findUnique({ where: { id }, select: { cscId: true } });
  if (!existing) throw new HttpError(404, 'Request not found', 'NOT_FOUND');
  await assertCanSeeCsc(req.user!, existing.cscId);
  await prisma.serviceRequest.update({ where: { id }, data: { rating: b.rating, feedbackComment: b.comment ?? null } });
  res.json(await getRequestDetail(id, req.user!));
});
