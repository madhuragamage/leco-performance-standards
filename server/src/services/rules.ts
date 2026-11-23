import { prisma } from '../db.js';
import { type ApprovalLimit, type Role, DEFAULT_APPROVAL_LIMITS } from '../domain/catalog.js';
import type { Rules } from '../domain/sla.js';
import { defaultCalendar } from '../domain/time.js';

let cache: { rules: Rules & { approvalLimits: ApprovalLimit[] }; at: number } | null = null;
const TTL_MS = 60_000;

export async function loadRules(): Promise<Rules & { approvalLimits: ApprovalLimit[] }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rules;
  const [thresholds, penalties, holidays, limits] = await Promise.all([
    prisma.threshold.findMany(),
    prisma.penaltyRule.findMany(),
    prisma.holiday.findMany({ select: { date: true } }),
    prisma.approvalLimit.findMany(),
  ]);
  const rules = {
    thresholds,
    penalties,
    calendar: defaultCalendar(holidays.map((h) => h.date)),
    approvalLimits: limits.length ? limits.map((l) => ({ role: l.role as Role, upTo: l.upTo })) : DEFAULT_APPROVAL_LIMITS,
  };
  cache = { rules, at: Date.now() };
  return rules;
}

export function invalidateRules() {
  cache = null;
}
