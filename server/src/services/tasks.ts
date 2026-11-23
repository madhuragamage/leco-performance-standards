/**
 * "My tasks": what a signed-in user should do next, in priority order.
 *
 *  - MINE          assigned to me and I can record the next step
 *  - QUEUE         not assigned to anyone who can act, and my role can record the next step
 *  - MINE_WAITING  assigned to me, but the next step belongs to someone else (e.g. approval)
 *
 * Priority comes from the most urgent running SLA clock of the request.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { type Role, type ServiceDef, type StepDef, type Unit, findService } from '../domain/catalog.js';
import { type ClockEval, evaluateRequest, openItems } from '../domain/sla.js';
import { allowedSteps, nextSteps, type RequestState } from '../domain/workflow.js';
import { type AuthUser, visibleCscIds } from '../middleware/auth.js';
import { loadRules } from './rules.js';
import { contextOf, toEventLike } from './requests.js';

export type Priority = 'BREACHED' | 'REG_DUE_SOON' | 'OVERDUE' | 'DUE_SOON' | 'ON_TRACK' | 'NO_DEADLINE' | 'AWAITING_CUSTOMER';
const RANK: Record<Priority, number> = { BREACHED: 0, REG_DUE_SOON: 1, OVERDUE: 2, DUE_SOON: 3, ON_TRACK: 4, NO_DEADLINE: 5, AWAITING_CUSTOMER: 6 };
export const URGENT: Priority[] = ['BREACHED', 'REG_DUE_SOON', 'OVERDUE', 'DUE_SOON'];

/** "Due soon" window per unit: today/next working day, 2 days, 1 hour, 10 minutes. */
const SOON: Record<Unit, number> = { WORKING_DAYS: 1, CALENDAR_DAYS: 2, HOURS: 1, MINUTES: 10 };
const UNIT_TEXT: Record<Unit, [string, string]> = { WORKING_DAYS: ['working day', 'working days'], CALENDAR_DAYS: ['day', 'days'], HOURS: ['hour', 'hours'], MINUTES: ['minute', 'minutes'] };
const toHours = (v: number, u: Unit) => (u === 'MINUTES' ? v / 60 : u === 'HOURS' ? v : v * 24);

function amount(v: number, u: Unit): string {
  const n = Math.abs(Number.isInteger(v) ? v : Math.round(v * 10) / 10);
  return `${n} ${UNIT_TEXT[u][n === 1 ? 0 : 1]}`;
}

export interface Urgency {
  priority: Priority;
  reason: string;
  clockLabel: string | null;
  /** Hours left to the relevant deadline (negative = overdue); used for ordering. */
  hoursLeft: number | null;
}

/** Classify one request from its clocks: the worst running clock wins. */
export function urgencyOf(clocks: ClockEval[]): Urgency {
  const candidates: Urgency[] = [];
  for (const c of clocks) {
    if (c.state !== 'RUNNING') continue;
    if (c.paused) {
      candidates.push({ priority: 'AWAITING_CUSTOMER', reason: 'Awaiting customer (non-conformity / wayleave / objection)', clockLabel: c.label, hoursLeft: null });
      continue;
    }
    if (c.mode === 'MIN_LEAD') {
      candidates.push(
        c.compliance === 'BREACHED'
          ? { priority: 'BREACHED', reason: `Notice is ${amount((c.regulatoryTarget ?? 0) - c.elapsed, c.unit)} short of the minimum`, clockLabel: c.label, hoursLeft: -1 }
          : { priority: 'ON_TRACK', reason: 'Notice period met', clockLabel: c.label, hoursLeft: null },
      );
      continue;
    }
    const ri = c.remainingInternal;
    const rr = c.remainingRegulatory;
    if (c.compliance === 'BREACHED') {
      candidates.push({ priority: 'BREACHED', reason: `Regulatory target exceeded by ${amount(rr ?? 0, c.unit)} - compensation accruing`, clockLabel: c.label, hoursLeft: toHours(rr ?? 0, c.unit) });
    } else if (c.compliance === 'INTERNAL_EXCEEDED') {
      if (rr !== null && rr <= SOON[c.unit]) {
        candidates.push({ priority: 'REG_DUE_SOON', reason: rr <= 0 ? 'Regulatory target due today' : `Regulatory target due in ${amount(rr, c.unit)}`, clockLabel: c.label, hoursLeft: toHours(rr, c.unit) });
      } else {
        candidates.push({ priority: 'OVERDUE', reason: `LECO target exceeded by ${amount(ri ?? 0, c.unit)}`, clockLabel: c.label, hoursLeft: rr !== null ? toHours(rr, c.unit) : toHours(ri ?? 0, c.unit) });
      }
    } else if (ri !== null && ri <= SOON[c.unit]) {
      candidates.push({ priority: 'DUE_SOON', reason: ri <= 0 ? 'LECO target due today' : `LECO target due in ${amount(ri, c.unit)}`, clockLabel: c.label, hoursLeft: toHours(ri, c.unit) });
    } else {
      const left = ri ?? rr;
      candidates.push({ priority: 'ON_TRACK', reason: left !== null ? `${amount(left, c.unit)} to ${ri !== null ? 'LECO' : 'regulatory'} target` : 'No target set', clockLabel: c.label, hoursLeft: left !== null ? toHours(left, c.unit) : null });
    }
  }
  if (!candidates.length) return { priority: 'NO_DEADLINE', reason: 'No SLA clock running', clockLabel: null, hoursLeft: null };
  return candidates.sort((a, b) => RANK[a.priority] - RANK[b.priority] || (a.hoursLeft ?? 1e9) - (b.hoursLeft ?? 1e9))[0];
}

/** Steps a role itself is responsible for now (not via the ADMIN override). */
function actionableFor(service: ServiceDef, events: ReturnType<typeof toEventLike>[], role: Role, state: RequestState): StepDef[] {
  const open = (g?: string) => !!g && openItems(service, events, g).length > 0;
  return allowedSteps(service, events, role, state).filter((s) => s.roles.includes(role) && (!s.optional || (s.pauseEnd && open(s.pauseEnd))));
}

export async function tasksFor(user: AuthUser) {
  const ids = await visibleCscIds(user);
  const where: Prisma.ServiceRequestWhereInput = {
    status: 'OPEN',
    OR: [{ assignedToId: user.id }, ...(ids ? [{ cscId: { in: ids } }] : [{}])],
  };
  const reqs = await prisma.serviceRequest.findMany({
    where,
    include: { events: true, csc: { include: { branch: true } }, assignedTo: { select: { id: true, fullName: true, role: true } } },
  });
  const rules = await loadRules();
  const now = new Date();
  const rows = [];
  for (const r of reqs) {
    const service = findService(r.serviceType);
    if (!service) continue;
    const events = r.events.map(toEventLike);
    const state: RequestState = { status: r.status, estimateAmount: r.estimateAmount, approvalLimits: rules.approvalLimits };
    const mine = actionableFor(service, events, user.role, state);
    const assignee = r.assignedTo;
    const assigneeCanAct = !!assignee && actionableFor(service, events, assignee.role as Role, state).length > 0;

    let bucket: 'MINE' | 'QUEUE' | 'MINE_WAITING';
    if (assignee?.id === user.id) bucket = mine.length ? 'MINE' : 'MINE_WAITING';
    else if (mine.length && !assigneeCanAct) bucket = 'QUEUE';
    else continue;

    const { clocks } = evaluateRequest(service, events, contextOf(r), rules, now);
    const u = urgencyOf(clocks);
    const waiting = nextSteps(service, events, state);
    rows.push({
      requestId: r.id,
      refNo: r.refNo,
      serviceType: r.serviceType,
      serviceName: service.name,
      customerName: r.customerName,
      cscName: r.csc.name,
      branchName: r.csc.branch.name,
      assignedTo: assignee ? { id: assignee.id, fullName: assignee.fullName } : null,
      assignedAt: r.assignedAt,
      bucket,
      nextActions: (bucket === 'MINE_WAITING' ? waiting : mine).map((s) => ({ key: s.key, label: s.label, roles: s.roles })),
      ...u,
      urgent: URGENT.includes(u.priority),
    });
  }
  const bucketRank = { MINE: 0, QUEUE: 1, MINE_WAITING: 2 } as const;
  rows.sort(
    (a, b) =>
      RANK[a.priority] - RANK[b.priority] ||
      bucketRank[a.bucket] - bucketRank[b.bucket] ||
      (a.hoursLeft ?? 1e9) - (b.hoursLeft ?? 1e9) ||
      a.requestId - b.requestId,
  );
  const actionable = rows.filter((r) => r.bucket !== 'MINE_WAITING');
  return {
    rows,
    summary: {
      actionable: actionable.length,
      urgent: actionable.filter((r) => r.urgent).length,
      breached: actionable.filter((r) => r.priority === 'BREACHED').length,
      assignedToMe: rows.filter((r) => r.bucket !== 'QUEUE').length,
    },
  };
}
