import type { Prisma, ServiceRequest, ServiceEvent, Csc } from '@prisma/client';
import { prisma } from '../db.js';
import { type EventLike, type Role, getService, findService } from '../domain/catalog.js';
import { type ClockEval, type RequestContext, PAUSE_GROUPS, evaluateClock, evaluateRequest, pauseTimeline, sortEvents } from '../domain/sla.js';
import { WorkflowError, allowedSteps, completesRequest, nextSteps, validateStep } from '../domain/workflow.js';
import { HttpError, type AuthUser } from '../middleware/auth.js';
import { loadRules } from './rules.js';

type RequestWithEvents = ServiceRequest & { events: ServiceEvent[]; csc: Csc };
/** Request columns that step fields may update (FieldDef.requestField). */
type RequestFieldUpdates = Partial<Pick<ServiceRequest, 'changesRequired' | 'wayleaveRequired' | 'estimateAmount' | 'affectedCustomers' | 'accountNo' | 'natureOfSupply'>>;

export function toEventLike(e: Pick<ServiceEvent, 'stepKey' | 'occurredAt' | 'data' | 'reasonCodes'>): EventLike {
  return { stepKey: e.stepKey, occurredAt: e.occurredAt, data: (e.data as Record<string, unknown> | null) ?? null, reasonCodes: e.reasonCodes };
}

export function contextOf(r: ServiceRequest & { csc: Csc }): RequestContext {
  return { natureOfSupply: r.natureOfSupply, changesRequired: r.changesRequired, feederClass: r.csc.feederClass, affectedCustomers: r.affectedCustomers };
}

export interface CreateRequestInput {
  serviceType: string;
  cscId: number;
  source: 'PORTAL' | 'COUNTER' | 'CALL_CENTER' | 'FIELD' | 'ADMS';
  portalReference?: string | null;
  customerName: string;
  accountNo?: string | null;
  nic?: string | null;
  mobile?: string | null;
  email?: string | null;
  address?: string | null;
  natureOfSupply?: string | null;
  subType?: string | null;
  expectedServiceDate?: Date | null;
  details?: Record<string, unknown> | null;
  intakeAt?: Date;
  intakeData?: Record<string, unknown>;
  reasonCodes?: string[];
  notes?: string | null;
}

export async function createRequest(input: CreateRequestInput, actor: AuthUser | null) {
  const service = findService(input.serviceType);
  if (!service) throw new HttpError(400, `Unknown service type ${input.serviceType}`, 'BAD_SERVICE');
  if (input.natureOfSupply && !service.natureOptions.includes(input.natureOfSupply)) {
    throw new HttpError(400, `Nature of supply must be one of ${service.natureOptions.join(', ')}`, 'BAD_NATURE');
  }
  if (input.subType && service.subTypes && !service.subTypes.some((s) => s.code === input.subType)) {
    throw new HttpError(400, `Sub type must be one of ${service.subTypes.map((s) => s.code).join(', ')}`, 'BAD_SUBTYPE');
  }
  const csc = await prisma.csc.findUnique({ where: { id: input.cscId } });
  if (!csc) throw new HttpError(400, 'Unknown CSC', 'BAD_CSC');

  const occurredAt = input.intakeAt ?? new Date();
  // Portal / ADMS intake is system-recorded; staff intake must respect the step's roles.
  const role: Role = actor ? actor.role : 'ADMIN';
  const { data, reasonCodes, requestUpdates } = validateStep(service, [], role, { status: 'OPEN' }, {
    stepKey: service.intakeStep,
    occurredAt,
    data: { ...(input.intakeData ?? {}), ...(input.expectedServiceDate ? { expectedServiceDate: input.expectedServiceDate.toISOString() } : {}) },
    reasonCodes: input.reasonCodes,
  });
  delete (requestUpdates as Record<string, unknown>).expectedServiceDate;

  const year = new Date().getFullYear();
  return prisma.$transaction(async (tx) => {
    const created = await tx.serviceRequest.create({
      data: {
        refNo: `TMP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        serviceType: service.code,
        subType: input.subType ?? null,
        source: input.source,
        portalReference: input.portalReference ?? null,
        cscId: csc.id,
        customerName: input.customerName,
        accountNo: input.accountNo ?? null,
        nic: input.nic ?? null,
        mobile: input.mobile ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        natureOfSupply: input.natureOfSupply ?? null,
        expectedServiceDate: input.expectedServiceDate ?? null,
        details: (input.details ?? undefined) as Prisma.InputJsonValue | undefined,
        currentStep: service.intakeStep,
        ...(requestUpdates as RequestFieldUpdates),
      },
    });
    const refNo = `${service.prefix}/${csc.code}/${year}/${String(created.id).padStart(6, '0')}`;
    await tx.serviceEvent.create({
      data: {
        requestId: created.id,
        stepKey: service.intakeStep,
        occurredAt,
        recordedById: actor?.id ?? null,
        notes: input.notes ?? null,
        reasonCodes,
        data: data as Prisma.InputJsonValue,
      },
    });
    return tx.serviceRequest.update({ where: { id: created.id }, data: { refNo } });
  });
}

export interface RecordEventInput {
  stepKey: string;
  occurredAt: Date;
  notes?: string | null;
  reasonCodes?: string[];
  data?: Record<string, unknown>;
  delayReasons?: string[];
  delayNotes?: string | null;
}

function clockSummary(c: ClockEval) {
  return {
    key: c.key,
    label: c.label,
    elapsed: c.elapsed,
    unit: c.unit,
    internalTarget: c.internalTarget,
    regulatoryTarget: c.regulatoryTarget,
    compliance: c.compliance,
    penaltyAmount: c.penaltyAmount,
  };
}

/**
 * Record a time-stamped step. When the step stops an SLA clock that exceeded a target,
 * "reasons for not meeting the target" are mandatory (report section 1.5.4).
 */
export async function recordEvent(requestId: number, input: RecordEventInput, actor: AuthUser | null) {
  const req = await prisma.serviceRequest.findUnique({ where: { id: requestId }, include: { events: true, csc: true, clockResults: true } });
  if (!req) throw new HttpError(404, 'Request not found', 'NOT_FOUND');
  const service = getService(req.serviceType);
  const role: Role = actor ? actor.role : 'ADMIN';
  const existing = req.events.map(toEventLike);
  const rules = await loadRules();
  const { step, data, reasonCodes, requestUpdates } = validateStep(
    service,
    existing,
    role,
    { status: req.status, estimateAmount: req.estimateAmount, approvalLimits: rules.approvalLimits },
    input,
  );

  const after = sortEvents([...existing, { stepKey: step.key, occurredAt: input.occurredAt, data, reasonCodes }]);
  const ctx = contextOf({ ...req, ...(requestUpdates as Partial<ServiceRequest>) });
  const now = new Date();

  const stopped = service.clocks
    .filter((c) => c.end === step.key && !req.clockResults.some((r) => r.clockKey === c.key))
    .map((c) => evaluateClock(service, c, after, ctx, rules, now))
    .filter((c) => c.state === 'STOPPED');

  const late = stopped.filter((c) => c.internalMet === false || c.regulatoryMet === false);
  const delayReasons = (input.delayReasons ?? []).filter(Boolean);
  if (late.length && delayReasons.length === 0) {
    throw new WorkflowError('Target exceeded - reasons for not meeting the target are required', 422, 'DELAY_REASONS_REQUIRED', late.map(clockSummary));
  }

  const completes = completesRequest(step, data, after);

  await prisma.$transaction(async (tx) => {
    await tx.serviceEvent.create({
      data: {
        requestId,
        stepKey: step.key,
        occurredAt: input.occurredAt,
        recordedById: actor?.id ?? null,
        notes: input.notes ?? null,
        reasonCodes,
        data: data as Prisma.InputJsonValue,
      },
    });
    await tx.serviceRequest.update({
      where: { id: requestId },
      data: {
        ...(requestUpdates as RequestFieldUpdates),
        currentStep: step.key,
        ...(completes ? { status: 'COMPLETED' } : {}),
      },
    });
    for (const c of stopped) {
      await tx.clockResult.create({ data: clockResultData(requestId, c, ctx.feederClass, late.includes(c) ? delayReasons : [], input.delayNotes ?? null) });
    }
  });
  return getRequestDetail(requestId, actor);
}

function clockResultData(requestId: number, c: ClockEval, feederClass: number, delayReasons: string[], delayNotes: string | null) {
  return {
    requestId,
    clockKey: c.key,
    startedAt: c.startedAt!,
    endedAt: c.endedAt!,
    elapsed: c.elapsed,
    excluded: c.excluded,
    unit: c.unit,
    internalTarget: c.internalTarget,
    regulatoryTarget: c.regulatoryTarget,
    internalMet: c.internalMet,
    regulatoryMet: c.regulatoryMet,
    penaltyAmount: c.penaltyAmount,
    delayReasons,
    delayNotes,
    feederClass,
  };
}

/** Rebuild clock snapshots for a request (after a correction), keeping recorded delay reasons. */
export async function recomputeClockResults(requestId: number) {
  const req = await prisma.serviceRequest.findUnique({ where: { id: requestId }, include: { events: true, csc: true, clockResults: true } });
  if (!req) return;
  const service = getService(req.serviceType);
  const rules = await loadRules();
  const events = req.events.map(toEventLike);
  const { clocks } = evaluateRequest(service, events, contextOf(req), rules);
  await prisma.$transaction(async (tx) => {
    for (const c of clocks) {
      const prev = req.clockResults.find((r) => r.clockKey === c.key);
      if (c.state === 'STOPPED') {
        const data = clockResultData(requestId, c, req.csc.feederClass, prev?.delayReasons ?? [], prev?.delayNotes ?? null);
        await tx.clockResult.upsert({ where: { requestId_clockKey: { requestId, clockKey: c.key } }, create: data, update: { ...data, computedAt: new Date() } });
      } else if (prev) {
        await tx.clockResult.delete({ where: { id: prev.id } });
      }
    }
  });
}

export async function deleteEvent(requestId: number, eventId: number) {
  const ev = await prisma.serviceEvent.findFirst({ where: { id: eventId, requestId } });
  if (!ev) throw new HttpError(404, 'Event not found', 'NOT_FOUND');
  await prisma.serviceEvent.delete({ where: { id: eventId } });
  const req = await prisma.serviceRequest.findUnique({ where: { id: requestId }, include: { events: { orderBy: { occurredAt: 'asc' } } } });
  if (req) {
    const service = getService(req.serviceType);
    const last = req.events[req.events.length - 1];
    const stillComplete = req.events.some((e) => {
      const s = service.steps.find((st) => st.key === e.stepKey);
      return s ? completesRequest(s, (e.data as Record<string, unknown>) ?? {}, req.events.map(toEventLike)) : false;
    });
    await prisma.serviceRequest.update({
      where: { id: requestId },
      data: { currentStep: last?.stepKey ?? null, status: req.status === 'CANCELLED' ? 'CANCELLED' : stillComplete ? 'COMPLETED' : 'OPEN' },
    });
  }
  await recomputeClockResults(requestId);
}

export async function getRequestDetail(id: number, actor: AuthUser | null) {
  const req = await prisma.serviceRequest.findUnique({
    where: { id },
    include: {
      csc: { include: { branch: true } },
      events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], include: { recordedBy: { select: { fullName: true, role: true } } } },
      clockResults: true,
      assignedTo: { select: { id: true, fullName: true, role: true } },
      assignments: { orderBy: { at: 'desc' }, include: { assignedTo: { select: { fullName: true } }, assignedBy: { select: { fullName: true } } } },
    },
  });
  if (!req) throw new HttpError(404, 'Request not found', 'NOT_FOUND');
  const service = getService(req.serviceType);
  const rules = await loadRules();
  const events = req.events.map(toEventLike);
  const evaluation = evaluateRequest(service, events, contextOf(req), rules);
  const state = { status: req.status, estimateAmount: req.estimateAmount, approvalLimits: rules.approvalLimits };
  const allowed = actor ? allowedSteps(service, events, actor.role, state).map((s) => s.key) : [];
  // Register of every non-conformity / wayleave / objection item and whether it has been closed.
  const pauseItems = PAUSE_GROUPS.flatMap((g) => pauseTimeline(service, events, g).items);
  const waitingFor = req.status === 'OPEN' ? nextSteps(service, events, state).map((s) => ({ key: s.key, label: s.label, roles: s.roles })) : [];
  return { request: req, evaluation, allowedSteps: allowed, pauseItems, waitingFor };
}

export type { RequestWithEvents };
