/**
 * One-off data migration (Nov 2026): non-conformity moved from a free-standing, repeatable
 * "Non-conformity reported" step to a Yes/No decision on the site-visit step, with each
 * non-conformity conformed individually.
 *
 *   npx tsx scripts/migrate-nc-items.ts          dry run (prints what would change)
 *   npx tsx scripts/migrate-nc-items.ts --apply  apply
 *
 * Safe to run more than once.
 */
import 'dotenv/config';
import type { Prisma, ServiceEvent } from '@prisma/client';
import { prisma } from '../src/db.js';
import { findService } from '../src/domain/catalog.js';
import { pauseTimeline } from '../src/domain/sla.js';
import { recomputeClockResults } from '../src/services/requests.js';

const apply = process.argv.includes('--apply');
const log = (s: string) => console.log((apply ? '' : '[dry run] ') + s);

async function main() {
  const reqs = await prisma.serviceRequest.findMany({ include: { events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } } });
  let touched = 0;
  for (const r of reqs) {
    const service = findService(r.serviceType);
    if (!service) continue;
    const hasStandaloneNc = service.steps.some((s) => s.key === 'NC_REPORTED');
    const visitKeys = service.steps.filter((s) => s.ncCheck).map((s) => s.key);
    // Work on an in-memory copy, then write the differences.
    type Ev = Pick<ServiceEvent, 'stepKey' | 'occurredAt' | 'reasonCodes'> & { id: number | null; data: Record<string, unknown>; deleted?: boolean; changed?: boolean };
    const events: Ev[] = r.events.map((e) => ({ id: e.id, stepKey: e.stepKey, occurredAt: e.occurredAt, reasonCodes: [...e.reasonCodes], data: { ...((e.data as Record<string, unknown>) ?? {}) } }));
    const notes: string[] = [];

    if (!hasStandaloneNc) {
      for (const nc of events.filter((e) => e.stepKey === 'NC_REPORTED')) {
        const paidAt = events.find((e) => e.stepKey === 'PAYMENT' && !e.deleted)?.occurredAt;
        const inSupplyPhase = !!paidAt && nc.occurredAt >= paidAt && visitKeys.includes('SITE_CHECKED');
        const candidates = events.filter(
          (e) => !e.deleted && visitKeys.includes(e.stepKey) && e.occurredAt <= nc.occurredAt && (inSupplyPhase ? e.stepKey === 'SITE_CHECKED' : e.stepKey !== 'SITE_CHECKED'),
        );
        let visit = candidates[candidates.length - 1];
        if (!visit && inSupplyPhase) {
          visit = { id: null, stepKey: 'SITE_CHECKED', occurredAt: nc.occurredAt, reasonCodes: [], data: { wayleaveRequired: false }, changed: true };
          events.push(visit);
          notes.push(`added pre-construction site check at ${nc.occurredAt.toISOString()}`);
        }
        if (!visit) {
          notes.push(`!! no visit step before non-conformity at ${nc.occurredAt.toISOString()} - left unchanged`);
          continue;
        }
        visit.data.nonConformityFound = true;
        visit.reasonCodes = [...new Set([...visit.reasonCodes, ...(nc.reasonCodes.length ? nc.reasonCodes : ['NC'])])];
        visit.changed = true;
        nc.deleted = true;
        notes.push(`non-conformity ${nc.reasonCodes.join(',')} moved onto ${visit.stepKey}`);
      }
    }
    // Visits recorded before the Yes/No question existed: answer it from what happened.
    for (const v of events.filter((e) => !e.deleted && visitKeys.includes(e.stepKey) && typeof e.data.nonConformityFound !== 'boolean')) {
      v.data.nonConformityFound = v.reasonCodes.length > 0;
      v.changed = true;
    }
    // Conformity records must say which items were conformed; drop ones that closed nothing.
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.deleted || e.stepKey !== 'CONFORMITY_RECEIVED' || e.reasonCodes.length) continue;
      const before = events.slice(0, i).filter((x) => !x.deleted).map((x) => ({ ...x, data: x.data }));
      const open = pauseTimeline(service, before, 'NC').open.map((o) => o.code);
      if (open.length) {
        e.reasonCodes = open;
        e.changed = true;
        notes.push(`conformity at ${e.occurredAt.toISOString()} now lists ${open.join(',')}`);
      } else {
        e.deleted = true;
        notes.push(`removed conformity at ${e.occurredAt.toISOString()} (nothing was awaiting conformity)`);
      }
    }

    const changed = events.filter((e) => e.deleted || e.changed);
    if (!changed.length) continue;
    touched++;
    if (notes.length) log(`${r.refNo}: ${notes.join('; ')}`);
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      for (const e of changed) {
        if (e.deleted && e.id) await tx.serviceEvent.delete({ where: { id: e.id } });
        else if (e.deleted) continue;
        else if (e.id) await tx.serviceEvent.update({ where: { id: e.id }, data: { reasonCodes: e.reasonCodes, data: e.data as Prisma.InputJsonValue } });
        else await tx.serviceEvent.create({ data: { requestId: r.id, stepKey: e.stepKey, occurredAt: e.occurredAt, reasonCodes: e.reasonCodes, data: e.data as Prisma.InputJsonValue, notes: 'Added by data migration' } });
      }
      const last = events.filter((e) => !e.deleted).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).pop();
      await tx.serviceRequest.update({ where: { id: r.id }, data: { currentStep: last?.stepKey ?? null } });
    });
    await recomputeClockResults(r.id);
  }
  log(`${touched} request(s) ${apply ? 'migrated' : 'would change'}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
