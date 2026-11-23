import { describe, expect, it } from 'vitest';
import { SERVICES, getService, requiredApprover, validateApprovalLimits, type ApprovalLimit, type EventLike } from './catalog.js';
import { evaluateClock, evaluateKpis, openItems, pauseTimeline, resolveThreshold, type ClockEval, type Rules, type ThresholdRow } from './sla.js';
import { urgencyOf } from '../services/tasks.js';
import { type Calendar, workingDaysBetween } from './time.js';
import { validateStep, allowedSteps, nextSteps } from './workflow.js';

// 16 Nov 2026 is a Monday. All times are Sri Lanka local (+05:30).
const lk = (s: string) => new Date(`${s}:00+05:30`);
const cal = (holidays: string[] = []): Calendar => ({ offsetMinutes: 330, holidays: new Set(holidays) });
const ev = (stepKey: string, at: string, data?: Record<string, unknown>, reasonCodes?: string[]): EventLike => ({ stepKey, occurredAt: lk(at), data, reasonCodes });

const th = (clockKey: string, internal: number | null, regulatory: number | null, extra: Partial<ThresholdRow> = {}): ThresholdRow => ({
  clockKey,
  natureOfSupply: '*',
  changesRequired: 'ANY',
  feederClass: 0,
  internalTarget: internal,
  regulatoryTarget: regulatory,
  provisional: false,
  ...extra,
});

describe('working days', () => {
  it('counts days after start up to and including end, skipping weekends', () => {
    const c = cal();
    expect(workingDaysBetween(lk('2026-11-16T09:00'), lk('2026-11-16T16:00'), c)).toBe(0); // same day
    expect(workingDaysBetween(lk('2026-11-16T09:00'), lk('2026-11-18T09:00'), c)).toBe(2); // Mon -> Wed
    expect(workingDaysBetween(lk('2026-11-20T15:00'), lk('2026-11-23T09:00'), c)).toBe(1); // Fri -> Mon
  });

  it('skips holidays', () => {
    expect(workingDaysBetween(lk('2026-11-16T09:00'), lk('2026-11-18T09:00'), cal(['2026-11-17']))).toBe(1);
  });

  it('uses Sri Lanka local date, not UTC date', () => {
    // 01:00 Tuesday local is still Monday in UTC
    expect(workingDaysBetween(lk('2026-11-16T09:00'), lk('2026-11-17T01:00'), cal())).toBe(1);
  });
});

describe('threshold resolution', () => {
  const rows = [
    th('X', 5, 10),
    th('X', 3, 10, { natureOfSupply: 'LV_RETAIL' }),
    th('X', 3, 12, { natureOfSupply: 'LV_RETAIL', feederClass: 3 }),
    th('X', 14, 40, { natureOfSupply: 'LV_BULK', changesRequired: 'YES' }),
  ];
  it('picks the most specific row', () => {
    expect(resolveThreshold(rows, 'X', { natureOfSupply: 'LV_RETAIL', feederClass: 3 })?.regulatoryTarget).toBe(12);
    expect(resolveThreshold(rows, 'X', { natureOfSupply: 'LV_RETAIL', feederClass: 1 })?.regulatoryTarget).toBe(10);
    expect(resolveThreshold(rows, 'X', { natureOfSupply: 'LV_BULK', changesRequired: true, feederClass: 1 })?.regulatoryTarget).toBe(40);
    expect(resolveThreshold(rows, 'X', { natureOfSupply: 'LV_BULK', changesRequired: false, feederClass: 1 })?.regulatoryTarget).toBe(10);
  });
  it('treats unknown "changes required" as NO (stricter)', () => {
    expect(resolveThreshold(rows, 'X', { natureOfSupply: 'LV_BULK', changesRequired: null, feederClass: 1 })?.regulatoryTarget).toBe(10);
  });
});

describe('SLA clocks', () => {
  const nc = getService('NEW_CONNECTION');
  const estimate = nc.clocks.find((c) => c.key === 'NEW_CONNECTION.ESTIMATE')!;

  it('excludes customer non-conformity period from elapsed working days', () => {
    const rules: Rules = { thresholds: [th(estimate.key, 3, 10)], penalties: [], calendar: cal() };
    const events = [
      ev('APPLICATION', '2026-11-16T08:30'),
      ev('ACCEPTED', '2026-11-16T09:00'), // Mon
      ev('INSPECTED', '2026-11-17T10:00', { nonConformityFound: true }, ['NC01']), // Tue
      ev('CONFORMITY_RECEIVED', '2026-11-19T10:00', {}, ['NC01']), // Thu -> 2 days excluded
      ev('ESTIMATE_INFORMED', '2026-11-20T11:00'), // Fri
    ];
    const r = evaluateClock(nc, estimate, events, { feederClass: 1, natureOfSupply: 'LV_RETAIL' }, rules);
    expect(r.state).toBe('STOPPED');
    expect(r.gross).toBe(4);
    expect(r.excluded).toBe(2);
    expect(r.elapsed).toBe(2);
    expect(r.compliance).toBe('WITHIN_INTERNAL');
    expect(r.penaltyAmount).toBe(0);
  });

  it('reports a running clock as paused while non-conformity is open', () => {
    const rules: Rules = { thresholds: [th(estimate.key, 3, 10)], penalties: [], calendar: cal() };
    const events = [ev('ACCEPTED', '2026-11-16T09:00'), ev('INSPECTED', '2026-11-17T10:00', { nonConformityFound: true }, ['NC01'])];
    const r = evaluateClock(nc, estimate, events, { feederClass: 1 }, rules, lk('2026-11-20T12:00'));
    expect(r.state).toBe('RUNNING');
    expect(r.paused).toBe(true);
    expect(r.elapsed).toBe(1);
    expect(r.remainingInternal).toBe(2);
    expect(r.remainingRegulatory).toBe(9);
  });

  it('keeps the clock paused until EVERY reported non-conformity is conformed', () => {
    const rules: Rules = { thresholds: [th(estimate.key, 3, 10)], penalties: [], calendar: cal() };
    const events = [
      ev('ACCEPTED', '2026-11-16T09:00'), // Mon
      ev('INSPECTED', '2026-11-17T10:00', { nonConformityFound: true }, ['NC01', 'NC03']), // Tue: two found
      ev('CONFORMITY_RECEIVED', '2026-11-18T10:00', {}, ['NC01']), // Wed: first conformed - still paused
      ev('CONFORMITY_RECEIVED', '2026-11-20T10:00', {}, ['NC03']), // Fri: last conformed - pause ends
      ev('ESTIMATE_INFORMED', '2026-11-23T10:00'), // Mon
    ];
    const tl = pauseTimeline(nc, events, 'NC');
    expect(tl.intervals).toHaveLength(1);
    expect(tl.items.map((i) => [i.code, i.closedAt?.toISOString()])).toEqual([
      ['NC01', lk('2026-11-18T10:00').toISOString()],
      ['NC03', lk('2026-11-20T10:00').toISOString()],
    ]);
    const r = evaluateClock(nc, estimate, events, { feederClass: 1 }, rules);
    expect(r.gross).toBe(5);
    expect(r.excluded).toBe(3); // Tue -> Fri
    expect(r.elapsed).toBe(2);
  });

  it('does not pause when the inspection found no non-conformity', () => {
    const rules: Rules = { thresholds: [th(estimate.key, 3, 10)], penalties: [], calendar: cal() };
    const events = [ev('ACCEPTED', '2026-11-16T09:00'), ev('INSPECTED', '2026-11-17T10:00', { nonConformityFound: false })];
    const r = evaluateClock(nc, estimate, events, { feederClass: 1 }, rules, lk('2026-11-19T12:00'));
    expect(r.paused).toBe(false);
    expect(r.excluded).toBe(0);
    expect(openItems(nc, events, 'NC')).toHaveLength(0);
  });

  it('computes compensation for a breached reconnection, capped', () => {
    const svc = getService('RECONNECTION');
    const clock = svc.clocks[0];
    const rules: Rules = {
      thresholds: [th(clock.key, 0, 2)],
      penalties: [{ clockKey: clock.key, natureOfSupply: '*', ratePerUnit: 500, maxAmount: 5000, perAffectedCustomer: false }],
      calendar: cal(),
    };
    const events = [ev('PAYMENT', '2026-11-16T09:00'), ev('RECONNECTED', '2026-11-23T09:00')]; // 5 working days
    const r = evaluateClock(svc, clock, events, { feederClass: 2 }, rules);
    expect(r.elapsed).toBe(5);
    expect(r.compliance).toBe('BREACHED');
    expect(r.penaltyUnits).toBe(3);
    expect(r.penaltyAmount).toBe(1500);

    const late = [ev('PAYMENT', '2026-10-01T09:00'), ev('RECONNECTED', '2026-11-23T09:00')];
    expect(evaluateClock(svc, clock, late, { feederClass: 2 }, rules).penaltyAmount).toBe(5000);
  });

  it('flags internal-only exceedance without penalty', () => {
    const svc = getService('RECONNECTION');
    const clock = svc.clocks[0];
    const rules: Rules = { thresholds: [th(clock.key, 0, 2)], penalties: [], calendar: cal() };
    const r = evaluateClock(svc, clock, [ev('PAYMENT', '2026-11-16T09:00'), ev('RECONNECTED', '2026-11-17T09:00')], { feederClass: 1 }, rules);
    expect(r.compliance).toBe('INTERNAL_EXCEEDED');
    expect(r.internalMet).toBe(false);
    expect(r.regulatoryMet).toBe(true);
  });

  it('evaluates scheduled outage advance notice (minimum lead) per affected customer per day', () => {
    const svc = getService('SCHEDULED_OUTAGE');
    const clock = svc.clocks[0];
    const rules: Rules = {
      thresholds: [th(clock.key, 48, 48)],
      penalties: [{ clockKey: clock.key, natureOfSupply: '*', ratePerUnit: 50, maxAmount: 500, perAffectedCustomer: true }],
      calendar: cal(),
    };
    const events = [ev('NOTICE_PUBLISHED', '2026-11-16T10:00', { scheduledFor: lk('2026-11-17T10:00').toISOString() })];
    const r = evaluateClock(svc, clock, events, { feederClass: 1, affectedCustomers: 120 }, rules);
    expect(r.elapsed).toBe(24);
    expect(r.compliance).toBe('BREACHED');
    expect(r.penaltyUnits).toBe(1);
    expect(r.penaltyAmount).toBe(50 * 120);
  });

  it('applies the billing-mistake clock only when a mistake was found', () => {
    const svc = getService('BILLING_INQUIRY');
    const rectify = svc.clocks.find((c) => c.key === 'BILLING_INQUIRY.RECTIFY')!;
    const rules: Rules = { thresholds: [], penalties: [], calendar: cal() };
    const none = [ev('INQUIRY', '2026-11-16T09:00'), ev('INQUIRY_COMPLETED', '2026-11-16T10:00', { mistakeFound: false })];
    expect(evaluateClock(svc, rectify, none, { feederClass: 1 }, rules).state).toBe('NOT_APPLICABLE');
    const found = [ev('INQUIRY', '2026-11-16T09:00'), ev('INQUIRY_COMPLETED', '2026-11-16T10:00', { mistakeFound: true })];
    expect(evaluateClock(svc, rectify, found, { feederClass: 1 }, rules, lk('2026-11-16T15:30')).elapsed).toBe(6.5);
  });
});

describe('workflow rules', () => {
  const nc = getService('NEW_CONNECTION');
  const open = { status: 'OPEN' as const };
  const base = [ev('APPLICATION', '2026-11-16T08:30'), ev('ACCEPTED', '2026-11-16T09:00'), ev('INSPECTED', '2026-11-17T09:00'), ev('ESTIMATE_PREPARED', '2026-11-17T12:00')];
  const now = lk('2026-11-20T12:00');

  it('enforces estimate approval authority by amount', () => {
    const req = { ...open, estimateAmount: 600_000 };
    const input = { stepKey: 'ESTIMATE_APPROVED', occurredAt: lk('2026-11-18T09:00') };
    expect(() => validateStep(nc, base, 'BM', req, input, now)).toThrow(/requires approval by SDM/);
    expect(validateStep(nc, base, 'SDM', req, input, now).step.key).toBe('ESTIMATE_APPROVED');
    expect(validateStep(nc, base, 'GM', req, input, now).step.key).toBe('ESTIMATE_APPROVED');
  });

  it('requires prerequisite steps and chronological order', () => {
    expect(() => validateStep(nc, [ev('APPLICATION', '2026-11-16T08:30')], 'TO', open, { stepKey: 'INSPECTED', occurredAt: now, data: { changesRequired: false } }, now)).toThrow(
      /must be recorded first/,
    );
    expect(() => validateStep(nc, base, 'CLERK', open, { stepKey: 'INSPECTION_SCHEDULED', occurredAt: lk('2026-11-15T09:00'), data: { scheduledFor: now.toISOString() } }, now)).toThrow(
      /Cannot be dated before/,
    );
  });

  const inspect = (data: Record<string, unknown>, reasonCodes?: string[]) =>
    validateStep(nc, base.slice(0, 2), 'TO', open, { stepKey: 'INSPECTED', occurredAt: lk('2026-11-17T09:00'), data: { changesRequired: false, wayleaveRequired: false, ...data }, reasonCodes }, now);

  it('asks "non-conformities identified?" at inspection; Yes needs the items, No needs none', () => {
    expect(() => inspect({})).toThrow(/Non-conformities identified/);
    expect(() => inspect({ nonConformityFound: true })).toThrow(/Select each non-conformity/);
    expect(inspect({ nonConformityFound: true }, ['NC01', 'NC03']).reasonCodes).toEqual(['NC01', 'NC03']);
    expect(inspect({ nonConformityFound: false }, ['NC01']).reasonCodes).toEqual([]); // stray codes dropped
  });

  it('moves straight to the next step when no non-conformity was found', () => {
    const events = [...base.slice(0, 2), ev('INSPECTED', '2026-11-17T09:00', { nonConformityFound: false, wayleaveRequired: false })];
    const keys = allowedSteps(nc, events, 'TO', open).map((s) => s.key);
    expect(keys).toEqual(['ESTIMATE_PREPARED']); // no repeating non-conformity / conformity / wayleave options
    expect(nextSteps(nc, events, open).map((s) => s.key)).toEqual(['ESTIMATE_PREPARED']);
  });

  it('blocks the work until each non-conformity is conformed, one by one', () => {
    let events = [...base.slice(0, 2), ev('INSPECTED', '2026-11-17T09:00', { nonConformityFound: true, wayleaveRequired: false }, ['NC01', 'NC03'])];
    expect(allowedSteps(nc, events, 'TO', open).map((s) => s.key)).toEqual(['CONFORMITY_RECEIVED']);
    expect(() => validateStep(nc, events, 'TO', open, { stepKey: 'ESTIMATE_PREPARED', occurredAt: now, data: { estimateAmount: 1000 } }, now)).toThrow(
      /Awaiting customer conformity for NC01, NC03/,
    );
    expect(() => validateStep(nc, events, 'CLERK', open, { stepKey: 'CONFORMITY_RECEIVED', occurredAt: now }, now)).toThrow(/Select the item/);
    expect(() => validateStep(nc, events, 'CLERK', open, { stepKey: 'CONFORMITY_RECEIVED', occurredAt: now, reasonCodes: ['NC02'] }, now)).toThrow(/NC02 is not awaiting/);

    events = [...events, ev('CONFORMITY_RECEIVED', '2026-11-18T09:00', {}, ['NC01'])];
    expect(openItems(nc, events, 'NC').map((i) => i.code)).toEqual(['NC03']);
    expect(allowedSteps(nc, events, 'TO', open).map((s) => s.key)).toEqual(['CONFORMITY_RECEIVED']);

    events = [...events, ev('CONFORMITY_RECEIVED', '2026-11-19T09:00', {}, ['NC03'])];
    expect(allowedSteps(nc, events, 'TO', open).map((s) => s.key)).toEqual(['ESTIMATE_PREPARED']);
  });

  it('offers the wayleave notice only when the inspection said wayleave is required, and only once', () => {
    const noWl = [...base.slice(0, 2), ev('INSPECTED', '2026-11-17T09:00', { nonConformityFound: false, wayleaveRequired: false })];
    expect(allowedSteps(nc, noWl, 'TO', open).map((s) => s.key)).not.toContain('WAYLEAVE_NOTICE');
    const wl = [...base.slice(0, 2), ev('INSPECTED', '2026-11-17T09:00', { nonConformityFound: false, wayleaveRequired: true })];
    expect(allowedSteps(nc, wl, 'TO', open).map((s) => s.key)).toContain('WAYLEAVE_NOTICE');
    const notified = [...wl, ev('WAYLEAVE_NOTICE', '2026-11-17T10:00', {}, ['WL01'])];
    expect(allowedSteps(nc, notified, 'TO', open).map((s) => s.key)).not.toContain('WAYLEAVE_NOTICE');
    const acquired = [...notified, ev('WAYLEAVE_ACQUIRED', '2026-11-18T10:00', {}, ['WL01'])];
    expect(allowedSteps(nc, acquired, 'TO', open).map((s) => s.key)).not.toContain('WAYLEAVE_NOTICE');
  });

  it('measures the conformity KPI until the last non-conformity is conformed', () => {
    const events = [
      ...base.slice(0, 2),
      ev('INSPECTED', '2026-11-17T09:00', { nonConformityFound: true }, ['NC01', 'NC03']),
      ev('CONFORMITY_RECEIVED', '2026-11-18T09:00', {}, ['NC01']),
      ev('CONFORMITY_RECEIVED', '2026-11-20T09:00', {}, ['NC03']),
    ];
    const kpis = evaluateKpis(nc, events, cal());
    expect(kpis.find((k) => k.code === 'NWEST-KPI-4a')?.value).toBe(1); // Mon -> Tue
    expect(kpis.find((k) => k.code === 'NWEST-KPI-4c')?.value).toBe(3); // Tue -> Fri
  });

  it('maps step fields onto the request', () => {
    expect(inspect({ changesRequired: 'true', nonConformityFound: false }).requestUpdates).toEqual({ changesRequired: true, wayleaveRequired: false });
  });

  it('lets a Technical Officer lodge new requests', () => {
    for (const code of ['NEW_CONNECTION', 'METER_TESTING', 'SHIFTING', 'BREAKDOWN', 'NAME_TARIFF_CHANGE', 'OTHER_INQUIRY']) {
      const svc = getService(code);
      expect(svc.steps.find((s) => s.key === svc.intakeStep)?.roles).toContain('TO');
    }
  });

  it('lists only steps the role may record', () => {
    const keys = allowedSteps(nc, base.slice(0, 2), 'CLERK', open).map((s) => s.key);
    expect(keys).toEqual(['INSPECTION_SCHEDULED']); // not ACCEPTED (done), not TO / approver steps
    // once the visit is recorded, scheduling it is no longer offered
    expect(allowedSteps(nc, base, 'CLERK', open).map((s) => s.key)).not.toContain('INSPECTION_SCHEDULED');
  });
});

describe('approval limits', () => {
  const nc = getService('NEW_CONNECTION');
  const events = [ev('APPLICATION', '2026-11-16T08:30'), ev('ACCEPTED', '2026-11-16T09:00'), ev('INSPECTED', '2026-11-17T09:00', { nonConformityFound: false }), ev('ESTIMATE_PREPARED', '2026-11-17T12:00')];
  const input = { stepKey: 'ESTIMATE_APPROVED', occurredAt: lk('2026-11-18T09:00') };
  const now = lk('2026-11-20T12:00');
  const custom: ApprovalLimit[] = [
    { role: 'CSS', upTo: 50_000 },
    { role: 'BM', upTo: 1_000_000 },
    { role: 'SDM', upTo: 3_000_000 },
    { role: 'HENG', upTo: 6_000_000 },
    { role: 'GM', upTo: null },
  ];

  it('applies the limits the administrator has set', () => {
    const req = { status: 'OPEN' as const, estimateAmount: 40_000 };
    expect(() => validateStep(nc, events, 'CSS', req, input, now)).toThrow(/requires approval by BM/); // default 20k
    expect(validateStep(nc, events, 'CSS', { ...req, approvalLimits: custom }, input, now).step.key).toBe('ESTIMATE_APPROVED'); // raised to 50k
    expect(requiredApprover(750_000, custom)).toBe('BM');
  });

  it('rejects inconsistent limit sets', () => {
    expect(validateApprovalLimits(custom)).toBeNull();
    expect(validateApprovalLimits(custom.map((l) => (l.role === 'BM' ? { ...l, upTo: 40_000 } : l)))).toMatch(/BM limit must be higher/);
    expect(validateApprovalLimits(custom.map((l) => (l.role === 'GM' ? { ...l, upTo: 9_000_000 } : l)))).toMatch(/GM\) must have no upper limit/);
    expect(validateApprovalLimits(custom.filter((l) => l.role !== 'SDM'))).toMatch(/required for SDM/);
  });
});

describe('task priority', () => {
  const clock = (over: Partial<ClockEval>): ClockEval => ({
    key: 'X', label: 'X', unit: 'WORKING_DAYS', mode: 'MAX_DURATION', regulated: true, state: 'RUNNING', startedAt: null, endedAt: null,
    gross: 0, excluded: 0, elapsed: 0, internalTarget: 3, regulatoryTarget: 10, provisional: false, internalMet: true, regulatoryMet: true,
    compliance: 'WITHIN_INTERNAL', remainingInternal: 3, remainingRegulatory: 10, paused: false, penaltyUnits: 0, penaltyAmount: 0, ...over,
  });
  it('ranks breaches first, then regulatory due soon, overdue, due soon, on track, awaiting customer', () => {
    expect(urgencyOf([clock({ compliance: 'BREACHED', remainingRegulatory: -2 })]).priority).toBe('BREACHED');
    expect(urgencyOf([clock({ compliance: 'INTERNAL_EXCEEDED', remainingInternal: -6, remainingRegulatory: 1 })]).priority).toBe('REG_DUE_SOON');
    expect(urgencyOf([clock({ compliance: 'INTERNAL_EXCEEDED', remainingInternal: -1, remainingRegulatory: 6 })]).priority).toBe('OVERDUE');
    expect(urgencyOf([clock({ remainingInternal: 0 })]).reason).toBe('LECO target due today');
    expect(urgencyOf([clock({ remainingInternal: 2 })]).priority).toBe('ON_TRACK');
    expect(urgencyOf([clock({ paused: true, compliance: 'BREACHED' })]).priority).toBe('AWAITING_CUSTOMER');
    expect(urgencyOf([]).priority).toBe('NO_DEADLINE');
    // the worst clock of a request decides
    expect(urgencyOf([clock({ remainingInternal: 2 }), clock({ unit: 'MINUTES', remainingInternal: 5, internalTarget: 30, regulatoryTarget: null, remainingRegulatory: null })]).priority).toBe('DUE_SOON');
  });
});

describe('catalogue integrity', () => {
  it.each(SERVICES.map((s) => [s.code, s] as const))('%s has unique steps and valid references', (_code, s) => {
    const keys = s.steps.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const step of s.steps) for (const r of step.requires ?? []) expect(keys).toContain(r);
    for (const c of s.clocks) expect(keys).toEqual(expect.arrayContaining([c.start, c.end]));
    for (const k of s.kpis) for (const ref of [k.from, k.to]) if (!ref.startsWith('@')) expect(keys).toContain(ref);
    expect(keys).toContain(s.intakeStep);
  });
});
