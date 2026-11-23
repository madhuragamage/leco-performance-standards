/**
 * Workflow rules: who may record which step, in what order, with what data.
 * Pure functions - used by the API and by tests.
 */
import { type ApprovalLimit, type EventLike, type Role, type ServiceDef, type StepDef, canApprove, requiredApprover } from './catalog.js';
import { openItems, sortEvents } from './sla.js';

export class WorkflowError extends Error {
  constructor(
    message: string,
    public status = 422,
    public code = 'WORKFLOW_RULE',
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface RequestState {
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  estimateAmount?: number | null;
  /** Live estimate approval limits; defaults to the report's values. */
  approvalLimits?: ApprovalLimit[];
}

export interface StepInput {
  stepKey: string;
  occurredAt: Date;
  data?: Record<string, unknown>;
  reasonCodes?: string[];
}

const CLOCK_SKEW_MS = 5 * 60_000;

function blockers(service: ServiceDef, step: StepDef, events: EventLike[], role: Role, req: RequestState, at?: Date): string[] {
  const out: string[] = [];
  if (req.status !== 'OPEN') out.push(`Request is ${req.status.toLowerCase()}`);
  if (role !== 'ADMIN' && !step.roles.includes(role)) out.push(`Only ${step.roles.join(', ')} may record "${step.label}"`);
  if (step.approvalByAmount) {
    const amount = req.estimateAmount ?? 0;
    if (!canApprove(role, amount, req.approvalLimits)) {
      const who = requiredApprover(amount, req.approvalLimits);
      out.push(who ? `Estimate of LKR ${amount.toLocaleString('en-US')} requires approval by ${who} or above` : `No approval level covers LKR ${amount.toLocaleString('en-US')} - check approval limits`);
    }
  }
  for (const r of step.requires ?? []) {
    const ev = events.find((e) => e.stepKey === r);
    if (!ev) out.push(`"${service.steps.find((s) => s.key === r)?.label ?? r}" must be recorded first`);
    else if (at && ev.occurredAt.getTime() > at.getTime()) out.push(`Cannot be dated before "${service.steps.find((s) => s.key === r)?.label ?? r}"`);
  }
  if (!step.repeatable && events.some((e) => e.stepKey === step.key)) out.push(`"${step.label}" is already recorded`);
  if (step.availableIf && !step.availableIf(events)) out.push(step.availableIfText ?? `"${step.label}" does not apply at this point`);
  if (step.pauseStart && openItems(service, events, step.pauseStart).length) out.push(`Items reported earlier are still awaiting closure`);
  if (step.pauseEnd && !openItems(service, events, step.pauseEnd).length) out.push(`Nothing pending to close`);

  // While the customer still has non-conformities to rectify, the work cannot move on.
  // Only closing them (or handling wayleave / objections, which run in parallel) is allowed.
  const nc = openItems(service, events, 'NC');
  const parallel = !!step.pauseEnd || (!!step.pauseStart && step.pauseStart !== 'NC');
  if (nc.length && !parallel) out.push(`Awaiting customer conformity for ${nc.map((i) => i.code).join(', ')}`);
  return out;
}

/** Steps the given role can record next (ignores data validation). */
export function allowedSteps(service: ServiceDef, events: EventLike[], role: Role, req: RequestState): StepDef[] {
  const sorted = sortEvents(events);
  return service.steps.filter((s) => blockers(service, s, sorted, role, req).length === 0);
}

/** Mandatory steps the request is waiting on now, whoever their owner is. */
export function nextSteps(service: ServiceDef, events: EventLike[], req: RequestState): StepDef[] {
  const sorted = sortEvents(events);
  return service.steps.filter((s) => !s.optional && blockers(service, { ...s, roles: [...s.roles], approvalByAmount: false }, sorted, 'ADMIN', req).length === 0);
}

/** Validate a step and coerce its captured data. Returns request column updates derived from fields. */
export function validateStep(
  service: ServiceDef,
  events: EventLike[],
  role: Role,
  req: RequestState,
  input: StepInput,
  now = new Date(),
): { step: StepDef; data: Record<string, unknown>; reasonCodes: string[]; requestUpdates: Record<string, unknown> } {
  const step = service.steps.find((s) => s.key === input.stepKey);
  if (!step) throw new WorkflowError(`Step ${input.stepKey} does not exist for ${service.name}`, 400, 'UNKNOWN_STEP');
  if (Number.isNaN(input.occurredAt.getTime())) throw new WorkflowError('Invalid date/time', 400, 'BAD_DATE');
  if (input.occurredAt.getTime() > now.getTime() + CLOCK_SKEW_MS) throw new WorkflowError('Date/time cannot be in the future', 422, 'FUTURE_DATE');

  const sorted = sortEvents(events);
  const errs = blockers(service, step, sorted, role, req, input.occurredAt);
  if (errs.length) throw new WorkflowError(errs.join('; '), role !== 'ADMIN' && !step.roles.includes(role) ? 403 : 422, 'STEP_NOT_ALLOWED', errs);

  const raw = input.data ?? {};
  const data: Record<string, unknown> = {};
  const requestUpdates: Record<string, unknown> = {};
  for (const f of step.fields ?? []) {
    let v = raw[f.name];
    if (v === '' || v === undefined || v === null) {
      if (f.required) throw new WorkflowError(`"${f.label}" is required`, 422, 'FIELD_REQUIRED', { field: f.name });
      continue;
    }
    switch (f.type) {
      case 'number':
        v = Number(v);
        if (!Number.isFinite(v)) throw new WorkflowError(`"${f.label}" must be a number`, 422, 'FIELD_INVALID', { field: f.name });
        break;
      case 'boolean':
        v = v === true || v === 'true' || v === 'YES' || v === 1;
        break;
      case 'datetime': {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) throw new WorkflowError(`"${f.label}" must be a date/time`, 422, 'FIELD_INVALID', { field: f.name });
        v = d.toISOString();
        break;
      }
      case 'select':
        if (f.options && !f.options.includes(String(v))) throw new WorkflowError(`"${f.label}" must be one of ${f.options.join(', ')}`, 422, 'FIELD_INVALID', { field: f.name });
        v = String(v);
        break;
      default:
        v = String(v);
    }
    data[f.name] = v;
    if (f.requestField) requestUpdates[f.requestField] = f.type === 'datetime' ? new Date(String(v)) : v;
  }
  // Keep any extra keys the portal / ADMS sends (e.g. external ids), without overriding validated ones.
  for (const [k, v] of Object.entries(raw)) if (!(k in data) && !(step.fields ?? []).some((f) => f.name === k)) data[k] = v;

  // Reason codes: the non-conformities / wayleave issues being reported, or the ones being closed.
  let reasonCodes = [...new Set((input.reasonCodes ?? []).filter(Boolean))];
  if (step.reasonCategory) {
    const needed = step.reasonWhen ? data[step.reasonWhen] === true : true;
    const what = step.reasonCategory.replace('_', '-').toLowerCase();
    if (needed && !reasonCodes.length) throw new WorkflowError(`Select each ${what} identified`, 422, 'REASON_REQUIRED');
    if (!needed) reasonCodes = [];
  }
  if (step.pauseEnd) {
    const open = openItems(service, sorted, step.pauseEnd);
    if (!reasonCodes.length) throw new WorkflowError('Select the item(s) the customer has conformed', 422, 'ITEMS_REQUIRED');
    const unknown = reasonCodes.filter((c) => !open.some((i) => i.code === c));
    if (unknown.length) throw new WorkflowError(`${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not awaiting conformity`, 422, 'ITEMS_INVALID');
    const early = open.filter((i) => reasonCodes.includes(i.code) && i.openedAt.getTime() > input.occurredAt.getTime());
    if (early.length) throw new WorkflowError(`Cannot be dated before ${early.map((i) => i.code).join(', ')} was reported`, 422, 'BAD_DATE');
  }

  return { step, data, reasonCodes, requestUpdates };
}

export function completesRequest(step: StepDef, data: Record<string, unknown>, eventsAfter: EventLike[]): boolean {
  if (typeof step.completes === 'function') return step.completes(data, eventsAfter);
  return step.completes === true;
}
