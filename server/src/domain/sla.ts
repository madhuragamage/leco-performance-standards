/**
 * SLA engine: evaluates every clock of a service request against the two-stage thresholds
 * (LECO internal = Threshold 11/12, regulatory = Threshold 21/22), with customer non-conformity,
 * wayleave and objection periods excluded ("Amended target = standard target + period taken").
 * Pure functions - no database access - so they are unit-testable.
 */
import { type ApprovalLimit, type ClockDef, type EventLike, type ServiceDef, NC_CLEARED, NC_OPENED } from './catalog.js';
import { type Calendar, measure, round2 } from './time.js';

export interface ThresholdRow {
  id?: number;
  clockKey: string;
  natureOfSupply: string; // '*' = any
  changesRequired: string; // 'ANY' | 'YES' | 'NO'
  feederClass: number; // 0 = any
  internalTarget: number | null;
  regulatoryTarget: number | null;
  provisional: boolean;
}

export interface PenaltyRow {
  clockKey: string;
  natureOfSupply: string;
  ratePerUnit: number;
  maxAmount: number;
  perAffectedCustomer: boolean;
}

export interface Rules {
  thresholds: ThresholdRow[];
  penalties: PenaltyRow[];
  calendar: Calendar;
  approvalLimits?: ApprovalLimit[];
}

export interface RequestContext {
  natureOfSupply?: string | null;
  changesRequired?: boolean | null;
  feederClass: number;
  affectedCustomers?: number | null;
}

/**
 * WITHIN_INTERNAL   - meets LECO internal target (and regulatory)
 * INTERNAL_EXCEEDED - LECO internal target exceeded, regulatory still met (or none set)
 * BREACHED          - regulatory target exceeded -> compensation payable
 */
export type Compliance = 'WITHIN_INTERNAL' | 'INTERNAL_EXCEEDED' | 'BREACHED' | 'NO_TARGET';
export type ClockState = 'NOT_APPLICABLE' | 'NOT_STARTED' | 'RUNNING' | 'STOPPED';

export interface ClockEval {
  key: string;
  label: string;
  unit: ClockDef['unit'];
  mode: ClockDef['mode'];
  regulated: boolean;
  lissReport?: string;
  state: ClockState;
  startedAt: Date | null;
  endedAt: Date | null;
  gross: number;
  excluded: number;
  /** Net elapsed (MAX_DURATION) or advance notice given (MIN_LEAD). */
  elapsed: number;
  internalTarget: number | null;
  regulatoryTarget: number | null;
  provisional: boolean;
  internalMet: boolean | null;
  regulatoryMet: boolean | null;
  compliance: Compliance;
  remainingInternal: number | null;
  remainingRegulatory: number | null;
  paused: boolean;
  penaltyUnits: number;
  penaltyAmount: number;
}

export function resolveThreshold(rows: ThresholdRow[], clockKey: string, ctx: RequestContext): ThresholdRow | null {
  // Before inspection "changes required" is unknown: assume NO (the stricter target) so
  // nothing is reported as safe when it is not.
  const changes = ctx.changesRequired ? 'YES' : 'NO';
  let best: ThresholdRow | null = null;
  let bestScore = -1;
  for (const r of rows) {
    if (r.clockKey !== clockKey) continue;
    if (r.natureOfSupply !== '*' && r.natureOfSupply !== ctx.natureOfSupply) continue;
    if (r.changesRequired !== 'ANY' && r.changesRequired !== changes) continue;
    if (r.feederClass !== 0 && r.feederClass !== ctx.feederClass) continue;
    const score = (r.natureOfSupply !== '*' ? 4 : 0) + (r.changesRequired !== 'ANY' ? 2 : 0) + (r.feederClass !== 0 ? 1 : 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

export function resolvePenalty(rows: PenaltyRow[], clockKey: string, nature?: string | null): PenaltyRow | null {
  return (
    rows.find((r) => r.clockKey === clockKey && r.natureOfSupply === nature) ??
    rows.find((r) => r.clockKey === clockKey && r.natureOfSupply === '*') ??
    null
  );
}

export function sortEvents<T extends EventLike>(events: T[]): T[] {
  return [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/** Items (e.g. individual non-conformity codes) an event opens for a pause group, or null. */
export function itemsOpenedBy(service: ServiceDef, e: EventLike, group: string): string[] | null {
  const step = service.steps.find((s) => s.key === e.stepKey);
  if (!step) return null;
  const opens = step.pauseStart === group || (group === 'NC' && step.ncCheck && e.data?.nonConformityFound === true);
  if (!opens) return null;
  return e.reasonCodes?.length ? [...new Set(e.reasonCodes)] : [group];
}

export interface PauseItem {
  group: string;
  code: string;
  openedAt: Date;
  closedAt: Date | null;
}

/**
 * Walk the events and track each open item (non-conformity, wayleave, objection) separately.
 * A pause runs from the moment the first item opens until the moment the LAST open item closes,
 * so a customer with three non-conformities must conform all three before the clock restarts.
 */
export function pauseTimeline(service: ServiceDef, events: EventLike[], group: string) {
  const endKeys = new Set(service.steps.filter((s) => s.pauseEnd === group).map((s) => s.key));
  const open = new Map<string, PauseItem>();
  const items: PauseItem[] = [];
  const intervals: { start: Date; end: Date | null }[] = [];
  let since: Date | null = null;
  for (const e of sortEvents(events)) {
    const opened = itemsOpenedBy(service, e, group);
    if (opened) {
      for (const code of opened) {
        if (open.has(code)) continue;
        const item: PauseItem = { group, code, openedAt: e.occurredAt, closedAt: null };
        open.set(code, item);
        items.push(item);
      }
      if (!since && open.size) since = e.occurredAt;
    } else if (endKeys.has(e.stepKey) && open.size) {
      // Legacy events without item codes close everything that was open.
      const codes = e.reasonCodes?.length ? e.reasonCodes : [...open.keys()];
      for (const code of codes) {
        const item = open.get(code);
        if (!item) continue;
        item.closedAt = e.occurredAt;
        open.delete(code);
      }
      if (since && open.size === 0) {
        intervals.push({ start: since, end: e.occurredAt });
        since = null;
      }
    }
  }
  if (since) intervals.push({ start: since, end: null });
  return { intervals, items, open: [...open.values()] };
}

/** Paused intervals for a pause group (e.g. NC = non-conformity). An open interval has end = null. */
export function pauseIntervals(service: ServiceDef, events: EventLike[], group: string): { start: Date; end: Date | null }[] {
  return pauseTimeline(service, events, group).intervals;
}

/** Items still awaiting closure (e.g. non-conformities the customer has not yet conformed). */
export function openItems(service: ServiceDef, events: EventLike[], group: string): PauseItem[] {
  return pauseTimeline(service, events, group).open;
}

export const PAUSE_GROUPS = ['NC', 'WL', 'OBJ'] as const;

function compare(mode: ClockDef['mode'], value: number, target: number | null): boolean | null {
  if (target === null || target === undefined) return null;
  return mode === 'MAX_DURATION' ? value <= target : value >= target;
}

export function evaluateClock(
  service: ServiceDef,
  clock: ClockDef,
  events: EventLike[],
  ctx: RequestContext,
  rules: Rules,
  now: Date = new Date(),
): ClockEval {
  const sorted = sortEvents(events);
  const th = resolveThreshold(rules.thresholds, clock.key, ctx);
  const base: ClockEval = {
    key: clock.key,
    label: clock.label,
    unit: clock.unit,
    mode: clock.mode,
    regulated: clock.regulated,
    lissReport: clock.lissReport,
    state: 'NOT_STARTED',
    startedAt: null,
    endedAt: null,
    gross: 0,
    excluded: 0,
    elapsed: 0,
    internalTarget: th?.internalTarget ?? null,
    regulatoryTarget: th?.regulatoryTarget ?? null,
    provisional: th?.provisional ?? true,
    internalMet: null,
    regulatoryMet: null,
    compliance: 'NO_TARGET',
    remainingInternal: null,
    remainingRegulatory: null,
    paused: false,
    penaltyUnits: 0,
    penaltyAmount: 0,
  };

  if (clock.appliesIf && !clock.appliesIf(sorted)) {
    // Conditional clocks (e.g. billing mistake rectification) only apply once their condition is met.
    return { ...base, state: 'NOT_APPLICABLE' };
  }

  const startEv = sorted.find((e) => e.stepKey === clock.start);
  if (!startEv) return base;
  const startedAt = startEv.occurredAt;
  const endEv = sorted.find((e) => e.stepKey === clock.end && e.occurredAt.getTime() >= startedAt.getTime());

  let endAt: Date;
  let state: ClockState;
  if (clock.mode === 'MIN_LEAD') {
    const planned = startEv.data?.[clock.leadField ?? ''];
    const plannedAt = planned ? new Date(String(planned)) : null;
    endAt = endEv?.occurredAt ?? (plannedAt && !Number.isNaN(plannedAt.getTime()) ? plannedAt : startedAt);
    state = endEv ? 'STOPPED' : 'RUNNING';
  } else {
    endAt = endEv?.occurredAt ?? now;
    state = endEv ? 'STOPPED' : 'RUNNING';
  }

  const gross = measure(clock.unit, startedAt, endAt, rules.calendar);
  let excluded = 0;
  let paused = false;
  for (const group of clock.excludes) {
    for (const iv of pauseIntervals(service, sorted, group)) {
      const s = new Date(Math.max(iv.start.getTime(), startedAt.getTime()));
      const eRaw = iv.end ?? endAt;
      const e = new Date(Math.min(eRaw.getTime(), endAt.getTime()));
      if (e.getTime() > s.getTime()) excluded += measure(clock.unit, s, e, rules.calendar);
      if (!iv.end && state === 'RUNNING') paused = true;
    }
  }
  excluded = round2(excluded);
  const elapsed = round2(Math.max(0, gross - excluded));

  const internalMet = compare(clock.mode, elapsed, base.internalTarget);
  const regulatoryMet = compare(clock.mode, elapsed, base.regulatoryTarget);

  let compliance: Compliance = 'NO_TARGET';
  if (regulatoryMet === false) compliance = 'BREACHED';
  else if (internalMet === false) compliance = 'INTERNAL_EXCEEDED';
  else if (internalMet === true || regulatoryMet === true) compliance = 'WITHIN_INTERNAL';

  const remaining = (t: number | null) => (t === null || clock.mode === 'MIN_LEAD' ? null : round2(t - elapsed));

  // Compensation (section 1.3): rate per unit (or day) of default, capped; per affected customer for outages.
  let penaltyUnits = 0;
  let penaltyAmount = 0;
  if (regulatoryMet === false && base.regulatoryTarget !== null) {
    const shortfall = clock.mode === 'MAX_DURATION' ? elapsed - base.regulatoryTarget : base.regulatoryTarget - elapsed;
    const perDay = clock.penaltyPer === 'DAY' && (clock.unit === 'HOURS' || clock.unit === 'MINUTES');
    const divisor = perDay ? (clock.unit === 'HOURS' ? 24 : 1440) : 1;
    penaltyUnits = Math.ceil(round2(shortfall / divisor));
    const rule = resolvePenalty(rules.penalties, clock.key, ctx.natureOfSupply);
    if (rule && penaltyUnits > 0) {
      const perCustomer = Math.min(rule.ratePerUnit * penaltyUnits, rule.maxAmount);
      penaltyAmount = rule.perAffectedCustomer ? perCustomer * Math.max(0, ctx.affectedCustomers ?? 0) : perCustomer;
    }
  }

  return {
    ...base,
    state,
    startedAt,
    endedAt: state === 'STOPPED' ? endAt : clock.mode === 'MIN_LEAD' ? endAt : null,
    gross,
    excluded,
    elapsed,
    internalMet,
    regulatoryMet,
    compliance,
    remainingInternal: state === 'RUNNING' ? remaining(base.internalTarget) : null,
    remainingRegulatory: state === 'RUNNING' ? remaining(base.regulatoryTarget) : null,
    paused,
    penaltyUnits,
    penaltyAmount,
  };
}

export interface KpiValue {
  code: string;
  label: string;
  from: string;
  to: string;
  remarks?: string;
  value: number | null;
  unit: string;
}

export function evaluateKpis(service: ServiceDef, events: EventLike[], cal: Calendar): KpiValue[] {
  const sorted = sortEvents(events);
  const nc = pauseIntervals(service, sorted, 'NC');
  // Time stamps a KPI can refer to: real steps, plus "non-conformity first reported" / "all conformed".
  const stamps = (key: string): Date[] => {
    if (key === NC_OPENED) return nc.map((i) => i.start);
    if (key === NC_CLEARED) return nc.filter((i) => i.end).map((i) => i.end!);
    return sorted.filter((e) => e.stepKey === key).map((e) => e.occurredAt);
  };
  return service.kpis.map((k) => {
    const from = stamps(k.from)[0];
    const to = from && stamps(k.to).find((t) => t.getTime() >= from.getTime());
    return {
      ...k,
      unit: service.kpiUnit,
      value: from && to ? measure(service.kpiUnit, from, to, cal) : null,
    };
  });
}

export function evaluateRequest(service: ServiceDef, events: EventLike[], ctx: RequestContext, rules: Rules, now = new Date()) {
  return {
    clocks: service.clocks.map((c) => evaluateClock(service, c, events, ctx, rules, now)),
    kpis: evaluateKpis(service, events, rules.calendar),
  };
}
