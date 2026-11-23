/**
 * Intake API for the online customer application portal (and ADMS for scheduled outages).
 * Authenticated with the shared secret in the X-API-Key header.
 */
import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { findService } from '../domain/catalog.js';
import { evaluateRequest, openItems } from '../domain/sla.js';
import { type InterruptionRow, parseCategory } from '../domain/supply.js';
import { importInterruptions, importTransformers } from '../services/supply.js';
import { HttpError, requireApiKey } from '../middleware/auth.js';
import { loadRules } from '../services/rules.js';
import { contextOf, createRequest, recordEvent, toEventLike } from '../services/requests.js';

export const intakeRouter = Router();
intakeRouter.use(requireApiKey);

/** Steps the portal itself may report (customer-side actions). */
const PORTAL_STEPS = new Set(['PAYMENT', 'CONFORMITY_RECEIVED']);

async function logged<T>(req: Request, portalRef: string | undefined, fn: () => Promise<T>): Promise<T> {
  // Bulk supply feeds are not copied into the log - only their size.
  const payload = (req.originalUrl.includes('/supply/') ? { rows: Array.isArray(req.body?.rows) ? req.body.rows.length : 0 } : req.body) as Prisma.InputJsonValue;
  try {
    const out = await fn();
    await prisma.intakeLog.create({ data: { endpoint: `${req.method} ${req.originalUrl}`, portalRef: portalRef ?? null, ok: true, payload } });
    return out;
  } catch (e) {
    await prisma.intakeLog
      .create({ data: { endpoint: `${req.method} ${req.originalUrl}`, portalRef: portalRef ?? null, ok: false, message: (e as Error).message.slice(0, 1000), payload } })
      .catch(() => undefined);
    throw e;
  }
}

async function cscByCode(code: string) {
  const csc = await prisma.csc.findFirst({ where: { OR: [{ code }, { name: { equals: code, mode: 'insensitive' } }] } });
  if (!csc) throw new HttpError(400, `Unknown CSC "${code}"`, 'BAD_CSC');
  return csc;
}

const applicationSchema = z.object({
  portalReference: z.string().trim().min(1).max(100),
  serviceType: z.string(),
  cscCode: z.string().trim().min(1),
  submittedAt: z.coerce.date(),
  customer: z.object({
    name: z.string().trim().min(1).max(200),
    nic: z.string().max(20).optional().nullable(),
    mobile: z.string().max(20).optional().nullable(),
    email: z.string().email().optional().nullable(),
    address: z.string().max(500).optional().nullable(),
    accountNo: z.string().max(30).optional().nullable(),
  }),
  natureOfSupply: z.string().optional().nullable(),
  subType: z.string().optional().nullable(),
  expectedServiceDate: z.coerce.date().optional().nullable(),
  details: z.record(z.unknown()).optional(),
});

intakeRouter.post('/applications', async (req, res) => {
  const b = applicationSchema.parse(req.body);
  await logged(req, b.portalReference, async () => {
    const existing = await prisma.serviceRequest.findUnique({ where: { portalReference: b.portalReference } });
    if (existing) {
      // Idempotent: the portal may retry.
      res.status(200).json({ requestId: existing.id, refNo: existing.refNo, status: existing.status, duplicate: true });
      return;
    }
    const service = findService(b.serviceType);
    if (!service) throw new HttpError(400, `Unknown service type ${b.serviceType}`, 'BAD_SERVICE');
    if (service.code === 'SCHEDULED_OUTAGE') throw new HttpError(400, 'Use /api/intake/outages for scheduled outages', 'BAD_SERVICE');
    const csc = await cscByCode(b.cscCode);
    const created = await createRequest(
      {
        serviceType: service.code,
        cscId: csc.id,
        source: 'PORTAL',
        portalReference: b.portalReference,
        customerName: b.customer.name,
        accountNo: b.customer.accountNo,
        nic: b.customer.nic,
        mobile: b.customer.mobile,
        email: b.customer.email,
        address: b.customer.address,
        natureOfSupply: b.natureOfSupply,
        subType: b.subType,
        expectedServiceDate: b.expectedServiceDate,
        details: b.details,
        intakeAt: b.submittedAt,
      },
      null,
    );
    res.status(201).json({ requestId: created.id, refNo: created.refNo, status: created.status, duplicate: false });
  });
});

async function byPortalRef(ref: string) {
  const r = await prisma.serviceRequest.findUnique({ where: { portalReference: ref } });
  if (!r) throw new HttpError(404, `No request with portal reference ${ref}`, 'NOT_FOUND');
  return r;
}

intakeRouter.post('/applications/:portalRef/events', async (req, res) => {
  const b = z
    .object({
      stepKey: z.string(),
      occurredAt: z.coerce.date(),
      notes: z.string().max(1000).optional(),
      data: z.record(z.unknown()).optional(),
      /** For CONFORMITY_RECEIVED: the non-conformity codes the customer has rectified. */
      items: z.array(z.string()).optional(),
    })
    .parse(req.body);
  await logged(req, req.params.portalRef, async () => {
    if (!PORTAL_STEPS.has(b.stepKey)) throw new HttpError(403, `The portal may only report: ${[...PORTAL_STEPS].join(', ')}`, 'STEP_NOT_ALLOWED');
    const r = await byPortalRef(req.params.portalRef);
    // Customer-side steps never stop a clock late on LECO's account, but if one does, record a system reason.
    const { items, ...rest } = b;
    const detail = await recordEvent(r.id, { ...rest, reasonCodes: items, delayReasons: ['SYS'], delayNotes: 'Recorded via customer portal' }, null);
    res.status(201).json({ refNo: detail.request.refNo, status: detail.request.status, currentStep: detail.request.currentStep });
  });
});

intakeRouter.post('/applications/:portalRef/feedback', async (req, res) => {
  const b = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }).parse(req.body);
  await logged(req, req.params.portalRef, async () => {
    const r = await byPortalRef(req.params.portalRef);
    await prisma.serviceRequest.update({ where: { id: r.id }, data: { rating: b.rating, feedbackComment: b.comment ?? null } });
    res.json({ ok: true });
  });
});

/** Customer-facing progress for the portal's "track my application" page. */
intakeRouter.get('/applications/:portalRef', async (req, res) => {
  const r = await prisma.serviceRequest.findUnique({
    where: { portalReference: req.params.portalRef },
    include: { events: { orderBy: { occurredAt: 'asc' } }, csc: true },
  });
  if (!r) throw new HttpError(404, 'Not found', 'NOT_FOUND');
  const service = findService(r.serviceType)!;
  const rules = await loadRules();
  const events = r.events.map(toEventLike);
  const { clocks } = evaluateRequest(service, events, contextOf(r), rules);
  const codes = await prisma.reasonCode.findMany({ where: { category: 'NON_CONFORMITY' } });
  res.json({
    pendingNonConformities: openItems(service, events, 'NC').map((i) => ({ code: i.code, description: codes.find((c) => c.code === i.code)?.description ?? i.code, reportedAt: i.openedAt })),
    refNo: r.refNo,
    serviceType: r.serviceType,
    serviceName: service.name,
    csc: r.csc.name,
    status: r.status,
    currentStep: service.steps.find((s) => s.key === r.currentStep)?.label ?? r.currentStep,
    timeline: r.events.map((e) => ({ step: service.steps.find((s) => s.key === e.stepKey)?.label ?? e.stepKey, at: e.occurredAt })),
    awaitingCustomer: clocks.some((c) => c.paused),
    commitments: clocks
      .filter((c) => c.state !== 'NOT_APPLICABLE' && c.regulated)
      .map((c) => ({ measure: c.label, state: c.state, elapsed: c.elapsed, unit: c.unit, regulatoryTarget: c.regulatoryTarget })),
  });
});

// ---- Supply quality feed (ADMS / outage management) ---------------------------------------------

/**
 * Transformer-wise interruption figures, pushed daily or at any interval.
 * Re-sending the same date / transformer / category replaces the earlier figure.
 */
intakeRouter.post('/supply/interruptions', async (req, res) => {
  const b = z
    .object({
      dryRun: z.boolean().default(false),
      rows: z
        .array(
          z.object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            tfId: z.string().trim().min(1),
            category: z.string(),
            consumerHours: z.number().min(0),
            consumerInterruptions: z.number().min(0),
            consumers: z.number().int().min(0).optional(),
            ensKwh: z.number().min(0).optional(),
          }),
        )
        .min(1)
        .max(200_000),
    })
    .parse(req.body);
  await logged(req, `supply:${b.rows.length} rows`, async () => {
    const errors: { line: number; message: string }[] = [];
    const rows: InterruptionRow[] = [];
    const seen = new Set<string>();
    b.rows.forEach((r, i) => {
      const category = parseCategory(r.category);
      if (!category) return errors.push({ line: i + 1, message: `Unknown category "${r.category}"` });
      const k = `${r.date}|${r.tfId}|${category}`;
      if (seen.has(k)) return errors.push({ line: i + 1, message: `Duplicate row for ${r.tfId}, ${r.date}, ${category}` });
      seen.add(k);
      rows.push({ line: i + 1, date: r.date, tfCode: r.tfId, category, consumerHours: r.consumerHours, consumerInterruptions: r.consumerInterruptions, consumers: r.consumers ?? null, ensKwh: r.ensKwh ?? 0 });
    });
    const out = await importInterruptions(rows, errors, [], { dryRun: b.dryRun, actor: null, source: 'API', filename: 'API feed' });
    res.status(out.ok ? (out.imported ? 201 : 200) : 422).json(out);
  });
});

/** Transformer register: tf_id, CSC and consumers (snapshot for the given month, default this month). */
intakeRouter.post('/supply/transformers', async (req, res) => {
  const b = z
    .object({
      dryRun: z.boolean().default(false),
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
      rows: z.array(z.object({ tfId: z.string().trim().min(1), csc: z.string().trim().min(1), consumers: z.number().int().min(0), name: z.string().optional(), active: z.boolean().default(true), annualEnergyKwh: z.number().min(0).optional() })).min(1).max(100_000),
    })
    .parse(req.body);
  await logged(req, `transformers:${b.rows.length} rows`, async () => {
    const rows = b.rows.map((r, i) => ({ line: i + 1, code: r.tfId, csc: r.csc, consumers: r.consumers, name: r.name ?? null, active: r.active, annualEnergyKwh: r.annualEnergyKwh ?? null }));
    const out = await importTransformers(rows, [], { dryRun: b.dryRun, month: b.month ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7), actor: null, source: 'API' });
    res.status(out.ok ? (out.imported ? 201 : 200) : 422).json(out);
  });
});

intakeRouter.post('/outages', async (req, res) => {
  const b = z
    .object({
      externalReference: z.string().trim().min(1).max(100),
      cscCode: z.string(),
      publishedAt: z.coerce.date(),
      scheduledFor: z.coerce.date(),
      affectedCustomers: z.number().int().min(0),
      noticeType: z.enum(['SMS', 'NEWSPAPER', 'RADIO', 'LEAFLET', 'WEB']).optional(),
      natureOfSupply: z.enum(['LV_NETWORK', 'HV_NETWORK']).default('LV_NETWORK'),
      area: z.string().max(300).optional(),
    })
    .parse(req.body);
  await logged(req, b.externalReference, async () => {
    const existing = await prisma.serviceRequest.findUnique({ where: { portalReference: b.externalReference } });
    if (existing) {
      res.status(200).json({ requestId: existing.id, refNo: existing.refNo, duplicate: true });
      return;
    }
    const csc = await cscByCode(b.cscCode);
    const created = await createRequest(
      {
        serviceType: 'SCHEDULED_OUTAGE',
        cscId: csc.id,
        source: 'ADMS',
        portalReference: b.externalReference,
        customerName: b.area ? `Scheduled outage - ${b.area}` : 'Scheduled outage',
        natureOfSupply: b.natureOfSupply,
        intakeAt: b.publishedAt,
        intakeData: { scheduledFor: b.scheduledFor.toISOString(), affectedCustomers: b.affectedCustomers, noticeType: b.noticeType },
      },
      null,
    );
    res.status(201).json({ requestId: created.id, refNo: created.refNo, duplicate: false });
  });
});
