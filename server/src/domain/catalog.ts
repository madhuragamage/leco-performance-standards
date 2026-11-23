/**
 * Service catalogue: the workflows described in "Draft Report on Performance Monitoring
 * Schemes - LECO Customer Services" (22 Jul 2020), sections 2-11.
 *
 * Each service is a set of time-stamped steps ("Date 1", "Date 2", ...), one or more
 * SLA clocks (the regulated measures of performance), and KPI definitions (section x.2 tables).
 * Targets and penalties are NOT here - they live in the database (Threshold / PenaltyRule)
 * so they can be changed when PUCSL publishes base-level targets.
 */

export type Role =
  | 'ADMIN' | 'GM' | 'HENG' | 'SDM' | 'BM' | 'CSS' | 'TO' | 'CLERK'
  | 'TECHNICIAN' | 'AGENT' | 'BE' | 'BA' | 'CE';

export const ROLES: { code: Role; label: string }[] = [
  { code: 'ADMIN', label: 'System Administrator' },
  { code: 'GM', label: 'General Manager' },
  { code: 'HENG', label: 'Head of Engineering' },
  { code: 'SDM', label: 'Senior Distribution Manager' },
  { code: 'BM', label: 'Branch Manager' },
  { code: 'CSS', label: 'Customer Service Superintendent' },
  { code: 'TO', label: 'Technical Officer' },
  { code: 'CLERK', label: 'Clerk / NC Clerk' },
  { code: 'TECHNICIAN', label: 'Technician' },
  { code: 'AGENT', label: 'Customer Service Agent' },
  { code: 'BE', label: 'Branch Engineer / Test Engineer' },
  { code: 'BA', label: 'Branch Accountant' },
  { code: 'CE', label: 'Control Engineer / Controller' },
];

export type Unit = 'WORKING_DAYS' | 'CALENDAR_DAYS' | 'HOURS' | 'MINUTES';

export const NATURE_OF_SUPPLY = {
  customer: ['LV_RETAIL', 'LV_BULK', 'MV_BULK'],
  network: ['LV_NETWORK', 'HV_NETWORK'],
} as const;

export const NATURE_LABELS: Record<string, string> = {
  LV_RETAIL: 'LV Retail',
  LV_BULK: 'LV Bulk',
  MV_BULK: 'MV Bulk',
  LV_NETWORK: 'LV Network',
  HV_NETWORK: 'HV Network',
};

export interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'datetime';
  options?: string[];
  required?: boolean;
  /** When set, the value is also written to this ServiceRequest column. */
  requestField?: 'changesRequired' | 'wayleaveRequired' | 'estimateAmount' | 'affectedCustomers' | 'accountNo' | 'natureOfSupply';
}

export interface EventLike {
  stepKey: string;
  occurredAt: Date;
  data?: Record<string, unknown> | null;
  reasonCodes?: string[];
}

export interface StepDef {
  key: string;
  label: string;
  /** Roles allowed to record this step (ADMIN can always). */
  roles: Role[];
  description?: string;
  /** Steps that must already exist. */
  requires?: string[];
  /** May be recorded more than once (pause cycles). */
  repeatable?: boolean;
  optional?: boolean;
  /**
   * Opens / closes items that pause SLA clocks (customer non-conformity, wayleave, objections).
   * pauseStart: every reason code on the event becomes an open item.
   * pauseEnd: the reason codes on the event are the items closed (e.g. each non-conformity the customer conformed).
   * The clock stays paused until every open item of the group is closed.
   */
  pauseStart?: string;
  pauseEnd?: string;
  /**
   * Site-visit step that answers "Non-conformities identified?". When Yes, the selected
   * non-conformity codes open NC items; when No, the workflow simply moves on.
   */
  ncCheck?: boolean;
  /** Reason codes from this category must be supplied... */
  reasonCategory?: 'NON_CONFORMITY' | 'WAYLEAVE' | 'OBJECTION';
  /** ...but only when this boolean field is true (e.g. nonConformityFound). */
  reasonWhen?: string;
  /** Extra availability rule, e.g. wayleave notice only when the inspection found wayleave required. */
  availableIf?: (events: EventLike[]) => boolean;
  availableIfText?: string;
  fields?: FieldDef[];
  /** Approval authority depends on estimate amount (CSS/BM/SDM/HEng/GM). */
  approvalByAmount?: boolean;
  /** Recording this step completes the request. A function lets completion depend on captured data. */
  completes?: boolean | ((data: Record<string, unknown>, events: EventLike[]) => boolean);
}

export interface ClockDef {
  key: string; // fully-qualified: SERVICE.CLOCK
  label: string;
  start: string;
  end: string;
  unit: Unit;
  /** MAX_DURATION: elapsed must be <= target. MIN_LEAD: advance notice must be >= target. */
  mode: 'MAX_DURATION' | 'MIN_LEAD';
  /** For MIN_LEAD clocks: data field on the start event holding the planned end time. */
  leadField?: string;
  /** Pause groups excluded from elapsed time. */
  excludes: string[];
  /** Penalty counted per UNIT of default, or per DAY (for hour-measured MIN_LEAD clocks). */
  penaltyPer: 'UNIT' | 'DAY';
  lissReport?: string;
  regulated: boolean;
  /** Whether this clock applies to a given request (e.g. "rectify billing mistakes" only if a mistake was found). */
  appliesIf?: (events: EventLike[]) => boolean;
  measure: string;
}

export interface KpiDef {
  code: string;
  label: string;
  from: string;
  to: string;
  remarks?: string;
}

export interface ServiceDef {
  code: string;
  name: string;
  prefix: string;
  section: string;
  kpiPrefix: string;
  intakeStep: string;
  natureOptions: readonly string[];
  subTypes?: { code: string; label: string }[];
  /** Whether "changes required to distribution system" applies (section 1.5.2). */
  hasChangesFlag: boolean;
  kpiUnit: Unit;
  steps: StepDef[];
  clocks: ClockDef[];
  kpis: KpiDef[];
}

/**
 * Virtual KPI time stamps: the first moment non-conformities were reported, and the moment
 * the last open non-conformity was conformed (non-conformity may be raised on different steps).
 */
export const NC_OPENED = '@NC_OPENED';
export const NC_CLEARED = '@NC_CLEARED';

// ---------------------------------------------------------------------------
// Reusable step building blocks
// ---------------------------------------------------------------------------

/** Staff who may lodge a customer request at the counter, by phone, or in the field. */
const LODGERS: Role[] = ['CLERK', 'AGENT', 'TO'];

/** "Non-conformities identified?" decision captured on a site-visit step. */
const NC_CHECK = {
  ncCheck: true,
  reasonCategory: 'NON_CONFORMITY',
  reasonWhen: 'nonConformityFound',
} as const satisfies Partial<StepDef>;

const NC_FIELD: FieldDef = { name: 'nonConformityFound', label: 'Non-conformities identified?', type: 'boolean', required: true };

/** Customer conforms one or more of the open non-conformities. Offered only while some are open. */
const conformity = (): StepDef => ({
  key: 'CONFORMITY_RECEIVED',
  label: 'Customer reported conformity',
  roles: ['CLERK', 'TO', 'TECHNICIAN', 'AGENT'],
  repeatable: true,
  optional: true,
  pauseEnd: 'NC',
  description: 'Tick each non-conformity the customer has rectified. The clock stays paused, and the work cannot proceed, until every reported non-conformity is conformed.',
});

/**
 * For services where the technician's visit IS the work (reconnection, meter test):
 * the visit either completes the work, or is recorded as "non-conformity found".
 */
const ncVisit = (requires: string, roles: Role[]): StepDef => ({
  key: 'NC_REPORTED',
  label: 'Visit made - non-conformity found, work not done',
  roles,
  requires: [requires],
  repeatable: true,
  optional: true,
  pauseStart: 'NC',
  reasonCategory: 'NON_CONFORMITY',
  description: 'Only if the visit could not be completed. Select every non-conformity found; each must be conformed by the customer.',
});

/** Wayleave notice is offered only when the latest inspection / site check said wayleave is required. */
function wayleaveRequiredNow(events: EventLike[]): boolean {
  let last: EventLike | undefined;
  for (const e of events) if (typeof e.data?.wayleaveRequired === 'boolean' && (!last || e.occurredAt >= last.occurredAt)) last = e;
  if (!last || last.data?.wayleaveRequired !== true) return false;
  return !events.some((e) => e.stepKey === 'WAYLEAVE_NOTICE' && e.occurredAt >= last!.occurredAt);
}

const wayleave = (): StepDef[] => [
  {
    key: 'WAYLEAVE_NOTICE',
    label: 'Wayleave requirement notified to customer',
    roles: ['TO'],
    repeatable: true,
    optional: true,
    pauseStart: 'WL',
    reasonCategory: 'WAYLEAVE',
    availableIf: wayleaveRequiredNow,
    availableIfText: 'Only when the inspection / site check found wayleave clearance is required',
    description: 'Issue the wayleave requirement report and obtain acknowledgement. Clock pauses until the wayleave is acquired.',
  },
  {
    key: 'WAYLEAVE_ACQUIRED',
    label: 'Wayleave acquired',
    roles: ['TO'],
    repeatable: true,
    optional: true,
    pauseEnd: 'WL',
    description: 'Amended target = standard target + period taken for acquiring wayleave.',
  },
];

/** Scheduling steps stop being offered once the visit itself has been recorded. */
const onlyBefore = (stepKey: string, label: string): Pick<StepDef, 'availableIf' | 'availableIfText'> => ({
  availableIf: (events) => !events.some((e) => e.stepKey === stepKey),
  availableIfText: `Not needed once "${label}" is recorded`,
});

const estimateSteps = (): StepDef[] => [
  { key: 'APPLICATION', label: 'Application lodged', roles: LODGERS, description: 'Customer lodges application (online portal / counter / QMS / field).',
    fields: [{ name: 'expectedServiceDate', label: 'Customer expected date of service', type: 'datetime' }] },
  { key: 'ACCEPTED', label: 'Application accepted, reference issued', roles: ['CLERK'], requires: ['APPLICATION'],
    description: 'LECO staff member checks and accepts the application (valid application date).' },
  { key: 'INSPECTION_SCHEDULED', label: 'Inspection scheduled', roles: ['CLERK'], requires: ['ACCEPTED'], ...onlyBefore('INSPECTED', 'Site visit and inspection'),
    fields: [{ name: 'scheduledFor', label: 'Scheduled inspection date/time', type: 'datetime', required: true }, { name: 'officer', label: 'Technical Officer', type: 'text' }] },
  { key: 'INSPECTED', label: 'Site visit and inspection', roles: ['TO'], requires: ['ACCEPTED'], ...NC_CHECK,
    description: 'Take measurements, check wayleave clearance, locate meter positioning, and check for non-conformities.',
    fields: [
      { name: 'changesRequired', label: 'Changes required to distribution system?', type: 'boolean', required: true, requestField: 'changesRequired' },
      { name: 'wayleaveRequired', label: 'Wayleave clearance required?', type: 'boolean', required: true, requestField: 'wayleaveRequired' },
      NC_FIELD,
    ] },
  conformity(),
  ...wayleave(),
  { key: 'ESTIMATE_PREPARED', label: 'Estimate prepared', roles: ['TO'], requires: ['INSPECTED'],
    fields: [{ name: 'estimateAmount', label: 'Estimate amount (LKR)', type: 'number', required: true, requestField: 'estimateAmount' }] },
  { key: 'ESTIMATE_APPROVED', label: 'Estimate approved', roles: ['CSS', 'BM', 'SDM', 'HENG', 'GM'], requires: ['ESTIMATE_PREPARED'], approvalByAmount: true,
    description: 'Approval authority depends on the estimate amount (limits set by the administrator under Targets & setup -> Approval limits).' },
  { key: 'ESTIMATE_INFORMED', label: 'Estimate informed to customer', roles: ['CLERK'], requires: ['ESTIMATE_APPROVED'],
    fields: [{ name: 'channel', label: 'Channel', type: 'select', options: ['SMS', 'PHONE', 'POST', 'COLLECTED_AT_CSC', 'PORTAL'], required: true }] },
];

const constructionSteps = (finalStep: StepDef): StepDef[] => [
  { key: 'PAYMENT', label: 'Estimate paid', roles: ['CLERK'], requires: ['ESTIMATE_INFORMED'],
    fields: [{ name: 'receiptNo', label: 'Receipt no', type: 'text' }, { name: 'amount', label: 'Amount (LKR)', type: 'number' },
      { name: 'connectionType', label: 'Type of connection', type: 'select', options: ['HV', 'LV', 'SERVICE_POLE', 'DIRECT_SERVICE'] }] },
  { key: 'INTERRUPTION_SCHEDULED', label: 'Interruption scheduled', roles: ['TO'], requires: ['PAYMENT'], optional: true,
    fields: [{ name: 'interruptionDate', label: 'Interruption date', type: 'datetime' }] },
  { key: 'MATERIAL_ISSUED', label: 'Material issued / contractor allocated', roles: ['TO', 'CSS'], requires: ['PAYMENT'] },
  { key: 'SITE_CHECKED', label: 'Pre-construction site check', roles: ['TO', 'CSS'], requires: ['PAYMENT'], ...NC_CHECK,
    description: 'Confirm the site is ready for construction (report "Non conformity / Wayleave", Date 21).',
    fields: [{ name: 'wayleaveRequired', label: 'Wayleave clearance required?', type: 'boolean', required: true, requestField: 'wayleaveRequired' }, NC_FIELD] },
  { key: 'CONSTRUCTED', label: 'Service construction completed', roles: ['CSS'], requires: ['MATERIAL_ISSUED', 'SITE_CHECKED'] },
  finalStep,
];

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const NEW_CONNECTION: ServiceDef = {
  code: 'NEW_CONNECTION',
  name: 'New Connection - Estimate & Supply (Retail/Bulk)',
  prefix: 'NC',
  section: '2 & 3',
  kpiPrefix: 'NWEST / NEWCON',
  intakeStep: 'APPLICATION',
  natureOptions: NATURE_OF_SUPPLY.customer,
  hasChangesFlag: true,
  kpiUnit: 'WORKING_DAYS',
  steps: [
    ...estimateSteps(),
    ...constructionSteps({ key: 'CONNECTED', label: 'Supply connected (energised)', roles: ['CSS'], requires: ['CONSTRUCTED'] }),
    { key: 'ACCOUNT_CREATED', label: 'Account created', roles: ['CLERK'], requires: ['CONNECTED'], fields: [{ name: 'accountNo', label: 'Account no', type: 'text', required: true, requestField: 'accountNo' }] },
    { key: 'AGREEMENT_DISPATCHED', label: 'Agreement dispatched', roles: ['CLERK'], requires: ['CONNECTED'] },
    { key: 'FIRST_BILL_ISSUED', label: 'First bill issued', roles: ['CLERK', 'BA'], requires: ['ACCOUNT_CREATED'], completes: true },
  ],
  clocks: [
    { key: 'NEW_CONNECTION.ESTIMATE', label: 'Provision of estimate', start: 'ACCEPTED', end: 'ESTIMATE_INFORMED', unit: 'WORKING_DAYS', mode: 'MAX_DURATION',
      excludes: ['NC', 'WL'], penaltyPer: 'UNIT', lissReport: 'R1', regulated: true,
      measure: 'No of working days from the day of submission of a valid application' },
    { key: 'NEW_CONNECTION.SUPPLY', label: 'Provision of new supply', start: 'PAYMENT', end: 'CONNECTED', unit: 'WORKING_DAYS', mode: 'MAX_DURATION',
      excludes: ['NC', 'WL'], penaltyPer: 'UNIT', lissReport: 'R2', regulated: true,
      measure: "No of working days from the date of applicant's acceptance of the offer (payment)" },
  ],
  kpis: [
    { code: 'NWEST-KPI-1', label: 'Application acceptance progress', from: 'APPLICATION', to: 'ACCEPTED', remarks: 'Lodging date from QMS / online portal' },
    { code: 'NWEST-KPI-2-1', label: 'Appointment maintaining progress', from: 'INSPECTION_SCHEDULED', to: 'INSPECTED' },
    { code: 'NWEST-KPI-2', label: 'Inspection progress', from: 'ACCEPTED', to: 'INSPECTED' },
    { code: 'NWEST-KPI-3', label: 'Estimate preparation progress', from: 'ACCEPTED', to: 'ESTIMATE_PREPARED' },
    { code: 'NWEST-KPI-4a', label: 'Non-conformity reporting progress', from: 'ACCEPTED', to: NC_OPENED },
    { code: 'NWEST-KPI-4c', label: 'Customer conformity progress', from: NC_OPENED, to: NC_CLEARED, remarks: 'Until every non-conformity is conformed' },
    { code: 'NWEST-KPI-4b', label: 'Wayleave reporting progress', from: 'ACCEPTED', to: 'WAYLEAVE_NOTICE' },
    { code: 'NWEST-KPI-5', label: 'Wayleave acquisition progress', from: 'WAYLEAVE_NOTICE', to: 'WAYLEAVE_ACQUIRED' },
    { code: 'NWEST-KPI-6', label: 'Estimate approval progress', from: 'ESTIMATE_PREPARED', to: 'ESTIMATE_APPROVED' },
    { code: 'NWEST-KPI-7', label: 'Estimate informing progress', from: 'ESTIMATE_APPROVED', to: 'ESTIMATE_INFORMED' },
    { code: 'NWEST-KPI-8', label: 'Estimate progress (overall)', from: 'ACCEPTED', to: 'ESTIMATE_INFORMED' },
    { code: 'NEWCON-KPI-1', label: 'Interruption scheduling progress', from: 'PAYMENT', to: 'INTERRUPTION_SCHEDULED' },
    { code: 'NEWCON-KPI-5', label: 'Material issuing progress', from: 'PAYMENT', to: 'MATERIAL_ISSUED' },
    { code: 'NEWCON-KPI-6', label: 'Construction progress', from: 'PAYMENT', to: 'CONSTRUCTED' },
    { code: 'NEWCON-KPI-7', label: 'Supply energising progress', from: 'CONSTRUCTED', to: 'CONNECTED' },
    { code: 'NEWCON-KPI-8', label: 'Supply progress (overall)', from: 'PAYMENT', to: 'CONNECTED' },
    { code: 'NEWCON-KPI-9', label: 'Account creation progress', from: 'CONNECTED', to: 'ACCOUNT_CREATED' },
    { code: 'NEWCON-KPI-10', label: 'Agreement dispatch progress', from: 'CONNECTED', to: 'AGREEMENT_DISPATCHED' },
    { code: 'NEWCON-KPI-11', label: 'First bill issuing progress', from: 'CONNECTED', to: 'FIRST_BILL_ISSUED' },
  ],
};

const RECONNECTION: ServiceDef = {
  code: 'RECONNECTION',
  name: 'Reconnection after Payment',
  prefix: 'RC',
  section: '4',
  kpiPrefix: 'RECON',
  intakeStep: 'PAYMENT',
  natureOptions: NATURE_OF_SUPPLY.customer,
  hasChangesFlag: false,
  kpiUnit: 'WORKING_DAYS',
  steps: [
    { key: 'DISCONNECTED', label: 'Physical disconnection', roles: ['TECHNICIAN', 'CLERK'], optional: true },
    { key: 'PAYMENT', label: 'Due charges paid / agreement reached', roles: ['CLERK'],
      fields: [{ name: 'receiptNo', label: 'Receipt no', type: 'text' }, { name: 'amount', label: 'Amount (LKR)', type: 'number' }] },
    { key: 'RECONNECTED', label: 'Supply reconnected', roles: ['TECHNICIAN'], requires: ['PAYMENT'], completes: true },
    ncVisit('PAYMENT', ['TECHNICIAN', 'TO']),
    conformity(),
  ],
  clocks: [
    { key: 'RECONNECTION.RECONNECT', label: 'Reconnection after disconnection for non-payment', start: 'PAYMENT', end: 'RECONNECTED', unit: 'WORKING_DAYS',
      mode: 'MAX_DURATION', excludes: ['NC'], penaltyPer: 'UNIT', lissReport: 'R3', regulated: true,
      measure: 'No of working days from the day of making the payment or reaching an agreement' },
  ],
  kpis: [
    { code: 'RECON-KPI-1', label: 'Customer payment progress', from: 'DISCONNECTED', to: 'PAYMENT' },
    { code: 'RECON-KPI-2', label: 'Non-conformity identification progress', from: 'PAYMENT', to: NC_OPENED },
    { code: 'RECON-KPI-3', label: 'Conformity progress', from: NC_OPENED, to: NC_CLEARED },
    { code: 'RECON-KPI-4', label: 'Reconnection progress', from: 'PAYMENT', to: 'RECONNECTED' },
  ],
};

const meterErrorExceeded = (events: EventLike[]) =>
  events.some((e) => e.stepKey === 'REPORT_GENERATED' && Math.abs(Number(e.data?.meterErrorPct ?? 0)) > 2.5);

const METER_TESTING: ServiceDef = {
  code: 'METER_TESTING',
  name: 'Testing of Revenue Meters (Retail/Bulk)',
  prefix: 'MT',
  section: '5',
  kpiPrefix: 'MTTSTN',
  intakeStep: 'APPLICATION',
  natureOptions: NATURE_OF_SUPPLY.customer,
  hasChangesFlag: false,
  kpiUnit: 'WORKING_DAYS',
  subTypes: [{ code: 'SERIES_METER', label: 'Series meter' }, { code: 'ELECTRONIC', label: 'Electronic (meter lab)' }],
  steps: [
    { key: 'APPLICATION', label: 'Application lodged', roles: LODGERS },
    { key: 'PAYMENT', label: 'Testing fee paid', roles: ['CLERK'], requires: ['APPLICATION'],
      fields: [{ name: 'receiptNo', label: 'Receipt no', type: 'text' }] },
    { key: 'ASSIGNED_TO_METER_LAB', label: 'Job assigned to meter lab', roles: ['TECHNICIAN', 'BE'], requires: ['PAYMENT'], optional: true,
      description: 'Bulk and special requests.' },
    { key: 'TEST_SCHEDULED', label: 'Meter test scheduled', roles: ['TECHNICIAN', 'BE'], requires: ['PAYMENT'], ...onlyBefore('TEST_STARTED', 'Meter test started'),
      fields: [{ name: 'scheduledFor', label: 'Scheduled date/time', type: 'datetime' }] },
    { key: 'TEST_STARTED', label: 'Meter test started (series meter fixed / electronic test)', roles: ['TECHNICIAN', 'TO'], requires: ['PAYMENT'] },
    ncVisit('PAYMENT', ['TECHNICIAN', 'TO']),
    conformity(),
    { key: 'TEST_COMPLETED', label: 'Test completed (series meter removed)', roles: ['TECHNICIAN', 'TO'], requires: ['TEST_STARTED'] },
    { key: 'REPORT_GENERATED', label: 'Test report generated', roles: ['BE'], requires: ['TEST_COMPLETED'],
      fields: [{ name: 'meterErrorPct', label: 'Meter error %', type: 'number', required: true }] },
    { key: 'CUSTOMER_UPDATED', label: 'Test results notified to customer', roles: ['BE'], requires: ['REPORT_GENERATED'],
      completes: (_d, events) => !meterErrorExceeded(events) },
    { key: 'REFUND_PAID', label: 'Refund paid', roles: ['BA'], requires: ['CUSTOMER_UPDATED'], optional: true },
    { key: 'BILL_CORRECTED', label: 'Bill corrected', roles: ['BA'], requires: ['CUSTOMER_UPDATED'], optional: true, completes: true },
  ],
  clocks: [
    { key: 'METER_TESTING.TEST', label: 'Testing of revenue meter', start: 'PAYMENT', end: 'TEST_STARTED', unit: 'WORKING_DAYS', mode: 'MAX_DURATION',
      excludes: ['NC'], penaltyPer: 'UNIT', lissReport: 'R4', regulated: true,
      measure: 'No of working days upon making the payment for testing' },
  ],
  kpis: [
    { code: 'MTTSTN-KPI-1', label: 'Scheduling progress', from: 'PAYMENT', to: 'TEST_SCHEDULED' },
    { code: 'MTTSTN-KPI-2', label: 'Meter lab assigning progress', from: 'PAYMENT', to: 'ASSIGNED_TO_METER_LAB', remarks: 'Bulk and special requests' },
    { code: 'MTTSTN-KPI-3', label: 'Non-conformity identification progress', from: 'PAYMENT', to: NC_OPENED },
    { code: 'MTTSTN-KPI-4', label: 'Conformity progress', from: NC_OPENED, to: NC_CLEARED },
    { code: 'MTTSTN-KPI-5', label: 'Test starting progress', from: 'PAYMENT', to: 'TEST_STARTED' },
    { code: 'MTTSTN-KPI-6', label: 'Test complete progress', from: 'PAYMENT', to: 'TEST_COMPLETED' },
    { code: 'MTTSTN-KPI-7', label: 'Report generation progress', from: 'TEST_COMPLETED', to: 'REPORT_GENERATED' },
    { code: 'MTTSTN-KPI-8', label: 'Overall test progress', from: 'PAYMENT', to: 'CUSTOMER_UPDATED' },
    { code: 'MTTSTN-KPI-9', label: 'Refund progress', from: 'CUSTOMER_UPDATED', to: 'REFUND_PAID', remarks: 'Meter error exceeds +-2.5%' },
    { code: 'MTTSTN-KPI-10', label: 'Bill correction progress', from: 'TEST_COMPLETED', to: 'BILL_CORRECTED', remarks: 'Meter error exceeds +-2.5%' },
  ],
};

const SHIFTING: ServiceDef = {
  code: 'SHIFTING',
  name: 'Shifting of Pole / Line / Service Wire / Meter',
  prefix: 'SH',
  section: '6',
  kpiPrefix: 'SHFTN',
  intakeStep: 'APPLICATION',
  natureOptions: [...NATURE_OF_SUPPLY.customer, ...NATURE_OF_SUPPLY.network],
  hasChangesFlag: true,
  kpiUnit: 'WORKING_DAYS',
  subTypes: [
    { code: 'POLE', label: 'Pole shifting' },
    { code: 'LINE', label: 'Line shifting' },
    { code: 'SERVICE_WIRE', label: 'Service wire shifting' },
    { code: 'METER', label: 'Meter shifting' },
  ],
  steps: [
    ...estimateSteps(),
    ...constructionSteps({ key: 'SHIFTED', label: 'Meter / line / pole shifted', roles: ['CSS'], requires: ['MATERIAL_ISSUED', 'SITE_CHECKED'], completes: true }),
  ].filter((s) => s.key !== 'CONSTRUCTED'),
  clocks: [
    { key: 'SHIFTING.ESTIMATE', label: 'Shifting estimate (internal)', start: 'ACCEPTED', end: 'ESTIMATE_INFORMED', unit: 'WORKING_DAYS', mode: 'MAX_DURATION',
      excludes: ['NC', 'WL'], penaltyPer: 'UNIT', regulated: false,
      measure: 'No of working days from valid application to estimate informed' },
    { key: 'SHIFTING.SHIFT', label: 'Shifting after payment', start: 'PAYMENT', end: 'SHIFTED', unit: 'WORKING_DAYS', mode: 'MAX_DURATION',
      excludes: ['NC', 'WL'], penaltyPer: 'UNIT', lissReport: 'R5/R6', regulated: true,
      measure: 'No of working days upon making the payment for shifting' },
  ],
  kpis: [
    { code: 'SHFTN-KPI-1', label: 'Application acceptance progress', from: 'APPLICATION', to: 'ACCEPTED' },
    { code: 'SHFTN-KPI-2-1', label: 'Appointment maintaining progress', from: 'INSPECTION_SCHEDULED', to: 'INSPECTED' },
    { code: 'SHFTN-KPI-2', label: 'Inspection progress', from: 'ACCEPTED', to: 'INSPECTED' },
    { code: 'SHFTN-KPI-3', label: 'Estimate preparation progress', from: 'ACCEPTED', to: 'ESTIMATE_PREPARED' },
    { code: 'SHFTN-KPI-4', label: 'Non-conformity reporting progress', from: 'ACCEPTED', to: NC_OPENED },
    { code: 'SHFTN-KPI-5', label: 'Wayleave acquisition progress', from: 'WAYLEAVE_NOTICE', to: 'WAYLEAVE_ACQUIRED' },
    { code: 'SHFTN-KPI-6', label: 'Estimate approval progress', from: 'ESTIMATE_PREPARED', to: 'ESTIMATE_APPROVED' },
    { code: 'SHFTN-KPI-7', label: 'Estimate informing progress', from: 'ESTIMATE_APPROVED', to: 'ESTIMATE_INFORMED' },
    { code: 'SHFTN-KPI-8', label: 'Estimate progress (overall)', from: 'ACCEPTED', to: 'ESTIMATE_INFORMED' },
    { code: 'SHFTN-KPI-9', label: 'Interruption scheduling progress', from: 'PAYMENT', to: 'INTERRUPTION_SCHEDULED' },
    { code: 'SHFTN-KPI-13', label: 'Material issuing progress', from: 'PAYMENT', to: 'MATERIAL_ISSUED' },
    { code: 'SHFTN-KPI-14', label: 'Shifting progress (overall)', from: 'PAYMENT', to: 'SHIFTED' },
  ],
};

const SCHEDULED_OUTAGE: ServiceDef = {
  code: 'SCHEDULED_OUTAGE',
  name: 'Announcing Scheduled Outages',
  prefix: 'SO',
  section: '7',
  kpiPrefix: 'INTSCH',
  intakeStep: 'NOTICE_PUBLISHED',
  natureOptions: NATURE_OF_SUPPLY.network,
  hasChangesFlag: false,
  kpiUnit: 'HOURS',
  steps: [
    { key: 'NOTICE_PUBLISHED', label: 'Interruption notice published', roles: ['CE'],
      description: 'Normally fed from the Advanced Distribution Management System (ADMS).',
      fields: [
        { name: 'scheduledFor', label: 'Scheduled interruption date/time', type: 'datetime', required: true },
        { name: 'affectedCustomers', label: 'No. of affected customers', type: 'number', required: true, requestField: 'affectedCustomers' },
        { name: 'noticeType', label: 'Type of notice', type: 'select', options: ['SMS', 'NEWSPAPER', 'RADIO', 'LEAFLET', 'WEB'] },
      ] },
    { key: 'OUTAGE_COMMENCED', label: 'Interruption commenced', roles: ['CE'], requires: ['NOTICE_PUBLISHED'], completes: true },
  ],
  clocks: [
    { key: 'SCHEDULED_OUTAGE.NOTICE', label: 'Advance notice of scheduled outage', start: 'NOTICE_PUBLISHED', end: 'OUTAGE_COMMENCED', unit: 'HOURS',
      mode: 'MIN_LEAD', leadField: 'scheduledFor', excludes: [], penaltyPer: 'DAY', lissReport: 'R7', regulated: true,
      measure: 'Advance notice given to customers (minimum)' },
  ],
  kpis: [{ code: 'INTSCH-KPI-1', label: 'Scheduling progress (notice lead time)', from: 'NOTICE_PUBLISHED', to: 'OUTAGE_COMMENCED' }],
};

const mistakeFound = (events: EventLike[]) =>
  events.some((e) => (e.stepKey === 'INQUIRY_COMPLETED' && e.data?.mistakeFound === true) || e.stepKey === 'MISTAKE_RECTIFIED');

const BILLING_INQUIRY: ServiceDef = {
  code: 'BILLING_INQUIRY',
  name: 'Billing and Payment Inquiry',
  prefix: 'BI',
  section: '8',
  kpiPrefix: 'BPINQ',
  intakeStep: 'INQUIRY',
  natureOptions: NATURE_OF_SUPPLY.customer,
  hasChangesFlag: false,
  kpiUnit: 'HOURS',
  steps: [
    { key: 'INQUIRY', label: 'Inquiry received (QMS token / portal)', roles: LODGERS },
    { key: 'AGENT_ATTENDED', label: 'Agent attended', roles: ['AGENT', 'CLERK'], requires: ['INQUIRY'] },
    { key: 'INQUIRY_COMPLETED', label: 'Inquiry answered / closed', roles: ['AGENT', 'CLERK'], requires: ['INQUIRY'],
      fields: [{ name: 'mistakeFound', label: 'Billing mistake found that needs rectification?', type: 'boolean', required: true }],
      completes: (d) => d.mistakeFound !== true },
    { key: 'MISTAKE_RECTIFIED', label: 'Billing mistake rectified', roles: ['BA', 'CLERK'], requires: ['INQUIRY_COMPLETED'], optional: true, completes: true },
  ],
  clocks: [
    { key: 'BILLING_INQUIRY.ANSWER', label: 'Answering the query', start: 'INQUIRY', end: 'INQUIRY_COMPLETED', unit: 'HOURS', mode: 'MAX_DURATION',
      excludes: [], penaltyPer: 'UNIT', regulated: true, measure: 'No of hours taken to answer the query' },
    { key: 'BILLING_INQUIRY.RECTIFY', label: 'Rectifying billing mistakes', start: 'INQUIRY', end: 'MISTAKE_RECTIFIED', unit: 'HOURS', mode: 'MAX_DURATION',
      excludes: [], penaltyPer: 'UNIT', regulated: true, appliesIf: mistakeFound, measure: 'No of hours to rectify the mistakes, if any' },
  ],
  kpis: [
    { code: 'BPINQ-KPI-1', label: 'Agent attendance progress', from: 'INQUIRY', to: 'AGENT_ATTENDED' },
    { code: 'BPINQ-KPI-2', label: 'Attending inquiry progress', from: 'INQUIRY', to: 'INQUIRY_COMPLETED' },
  ],
};

const BREAKDOWN: ServiceDef = {
  code: 'BREAKDOWN',
  name: 'Service Breakdown Restoration',
  prefix: 'BD',
  section: '9',
  kpiPrefix: 'SBDR',
  intakeStep: 'COMPLAINT',
  natureOptions: NATURE_OF_SUPPLY.customer,
  hasChangesFlag: false,
  kpiUnit: 'MINUTES',
  subTypes: [{ code: 'CUTOUT_FUSE', label: 'Cut-out fuse' }, { code: 'SERVICE_WIRE', label: 'Service wire' }, { code: 'OTHER', label: 'Other' }],
  steps: [
    { key: 'COMPLAINT', label: 'Breakdown complaint (1910 / CSC / portal)', roles: LODGERS },
    { key: 'GANG_ALLOCATED', label: 'Gang allocated', roles: ['AGENT', 'CLERK'], requires: ['COMPLAINT'], fields: [{ name: 'gang', label: 'Gang', type: 'text' }] },
    { key: 'ATTENDED', label: 'Breakdown attended', roles: ['TECHNICIAN'], requires: ['COMPLAINT'], ...NC_CHECK, fields: [NC_FIELD] },
    conformity(),
    { key: 'RESTORED', label: 'Supply restored', roles: ['TECHNICIAN'], requires: ['ATTENDED'], completes: true },
  ],
  clocks: [
    { key: 'BREAKDOWN.ATTEND', label: 'Breakdown attendance', start: 'COMPLAINT', end: 'ATTENDED', unit: 'MINUTES', mode: 'MAX_DURATION',
      excludes: [], penaltyPer: 'UNIT', regulated: false, measure: 'Minutes from complaint to attendance (LECO internal: 30 minutes)' },
    { key: 'BREAKDOWN.RESTORE', label: 'Breakdown restoration / replacing cut-out fuses', start: 'COMPLAINT', end: 'RESTORED', unit: 'WORKING_DAYS', mode: 'MAX_DURATION',
      excludes: ['NC'], penaltyPer: 'UNIT', regulated: true, measure: 'No of working days from the day of making the complaint' },
  ],
  kpis: [
    { code: 'SBDR-KPI-1', label: 'Gang allocation progress', from: 'COMPLAINT', to: 'GANG_ALLOCATED' },
    { code: 'SBDR-KPI-2', label: 'BD attendance progress', from: 'GANG_ALLOCATED', to: 'ATTENDED' },
    { code: 'SBDR-KPI-3', label: 'Non-conformity reporting progress', from: 'COMPLAINT', to: NC_OPENED },
    { code: 'SBDR-KPI-4', label: 'Breakdown restoration progress', from: 'ATTENDED', to: 'RESTORED' },
    { code: 'SBDR-KPI-5', label: 'Overall service restoration progress', from: 'COMPLAINT', to: 'RESTORED' },
  ],
};

const NAME_TARIFF_CHANGE: ServiceDef = {
  code: 'NAME_TARIFF_CHANGE',
  name: 'Name Change / Tariff Change Requests',
  prefix: 'NT',
  section: '10',
  kpiPrefix: 'NCTC',
  intakeStep: 'APPLICATION',
  natureOptions: NATURE_OF_SUPPLY.customer,
  hasChangesFlag: false,
  kpiUnit: 'CALENDAR_DAYS',
  subTypes: [{ code: 'NAME_CHANGE', label: 'Name change' }, { code: 'TARIFF_CHANGE', label: 'Tariff change' }],
  steps: [
    { key: 'APPLICATION', label: 'Application lodged', roles: LODGERS },
    { key: 'ACCEPTED', label: 'Application accepted, reference issued', roles: ['CLERK'], requires: ['APPLICATION'] },
    { key: 'INSPECTION_SCHEDULED', label: 'Inspection scheduled', roles: ['CLERK'], requires: ['ACCEPTED'], optional: true, ...onlyBefore('INSPECTED', 'Site visit and inspection'),
      fields: [{ name: 'scheduledFor', label: 'Scheduled date/time', type: 'datetime', required: true }] },
    { key: 'INSPECTED', label: 'Site visit and inspection', roles: ['TO'], requires: ['ACCEPTED'], optional: true, ...NC_CHECK,
      fields: [{ name: 'objectionFound', label: '3rd-party objection received?', type: 'boolean', required: true }, NC_FIELD] },
    conformity(),
    { key: 'OBJECTION_NOTICE', label: '3rd-party objection reported to customer', roles: ['TO'], requires: ['ACCEPTED'], optional: true,
      pauseStart: 'OBJ', reasonCategory: 'OBJECTION',
      availableIf: (events) => events.some((e) => e.data?.objectionFound === true) && !events.some((e) => e.stepKey === 'OBJECTION_NOTICE'),
      availableIfText: 'Only when the inspection recorded a 3rd-party objection' },
    { key: 'OBJECTION_SETTLED', label: 'Objection settled', roles: ['TO'], repeatable: true, optional: true, pauseEnd: 'OBJ' },
    { key: 'RECOMMENDED', label: 'Recommendation made', roles: ['TO'], requires: ['ACCEPTED'] },
    { key: 'APPROVED', label: 'Decision approved', roles: ['CSS', 'BE', 'BM'], requires: ['RECOMMENDED'],
      fields: [{ name: 'decision', label: 'Decision', type: 'select', options: ['APPROVED', 'REJECTED'], required: true }] },
    { key: 'DECISION_NOTIFIED', label: 'Decision notified to customer', roles: ['CLERK'], requires: ['APPROVED'], completes: true,
      fields: [{ name: 'channel', label: 'Channel', type: 'select', options: ['SMS', 'PHONE', 'POST', 'PORTAL'], required: true }] },
  ],
  clocks: [
    { key: 'NAME_TARIFF_CHANGE.DECISION', label: 'Name / tariff change decision', start: 'ACCEPTED', end: 'DECISION_NOTIFIED', unit: 'CALENDAR_DAYS',
      mode: 'MAX_DURATION', excludes: ['NC', 'OBJ'], penaltyPer: 'UNIT', regulated: false, measure: 'Days from acceptance to decision notification (LECO internal: 14 days)' },
  ],
  kpis: [
    { code: 'NCTC-KPI-1', label: 'Application acceptance progress', from: 'APPLICATION', to: 'ACCEPTED' },
    { code: 'NCTC-KPI-2', label: 'Appointment maintaining progress', from: 'INSPECTION_SCHEDULED', to: 'INSPECTED' },
    { code: 'NCTC-KPI-3', label: 'Inspection progress', from: 'ACCEPTED', to: 'INSPECTED' },
    { code: 'NCTC-KPI-4a', label: 'Non-conformity reporting progress', from: 'ACCEPTED', to: NC_OPENED },
    { code: 'NCTC-KPI-4b', label: 'Objection reporting progress', from: 'ACCEPTED', to: 'OBJECTION_NOTICE' },
    { code: 'NCTC-KPI-5', label: 'Recommendation progress', from: 'INSPECTED', to: 'RECOMMENDED' },
    { code: 'NCTC-KPI-6', label: 'Decision approval progress', from: 'RECOMMENDED', to: 'APPROVED' },
    { code: 'NCTC-KPI-7', label: 'Decision notification progress', from: 'APPROVED', to: 'DECISION_NOTIFIED' },
    { code: 'NCTC-KPI-8', label: 'Change request progress (overall)', from: 'ACCEPTED', to: 'DECISION_NOTIFIED' },
  ],
};

const OTHER_INQUIRY: ServiceDef = {
  code: 'OTHER_INQUIRY',
  name: 'Other Service Inquiries / Complaints',
  prefix: 'IQ',
  section: '11',
  kpiPrefix: 'INQ',
  intakeStep: 'REGISTERED',
  natureOptions: NATURE_OF_SUPPLY.customer,
  hasChangesFlag: false,
  kpiUnit: 'CALENDAR_DAYS',
  steps: [
    { key: 'REGISTERED', label: 'Inquiry / complaint registered', roles: LODGERS,
      fields: [{ name: 'channel', label: 'Received via', type: 'select', options: ['VISIT', 'TELEPHONE', 'POST', 'FAX', 'EMAIL', 'PORTAL'] }] },
    { key: 'ACKNOWLEDGED', label: 'Acknowledgement / reference sent', roles: ['AGENT', 'CLERK'], requires: ['REGISTERED'] },
    { key: 'OFFICER_ASSIGNED', label: 'Officer assigned', roles: ['BM', 'CSS', 'BE'], requires: ['REGISTERED'], fields: [{ name: 'officer', label: 'Officer', type: 'text' }] },
    { key: 'INSPECTED', label: 'Inspection', roles: ['TO', 'BE'], requires: ['REGISTERED'], optional: true, ...NC_CHECK, fields: [NC_FIELD] },
    conformity(),
    { key: 'PERIOD_EXTENDED', label: 'Period extension informed in writing (with reasons)', roles: ['BM'], requires: ['REGISTERED'], optional: true,
      description: 'If not resolvable within 14 days, inform the customer of reasons and time needed (max 28 days).',
      fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true }] },
    { key: 'RECOMMENDED', label: 'Recommendation', roles: ['TO', 'BE', 'CSS'], requires: ['REGISTERED'] },
    { key: 'APPROVED', label: 'Approved by Branch Manager', roles: ['BM'], requires: ['RECOMMENDED'] },
    { key: 'DECISION_NOTIFIED', label: 'Decision sent to customer, inquiry closed', roles: ['AGENT', 'CLERK'], requires: ['APPROVED'], completes: true },
  ],
  clocks: [
    { key: 'OTHER_INQUIRY.ACK', label: 'Acknowledgement of complaint', start: 'REGISTERED', end: 'ACKNOWLEDGED', unit: 'WORKING_DAYS', mode: 'MAX_DURATION',
      excludes: [], penaltyPer: 'UNIT', regulated: false, measure: 'Working days to acknowledge (email 2, post/fax 5, visit/phone immediately)' },
    { key: 'OTHER_INQUIRY.RESOLVE', label: 'Resolution of complaint', start: 'REGISTERED', end: 'DECISION_NOTIFIED', unit: 'CALENDAR_DAYS', mode: 'MAX_DURATION',
      excludes: ['NC'], penaltyPer: 'UNIT', regulated: true, measure: 'Days after receipt of the request (14 days; max 28 with written extension)' },
  ],
  kpis: [
    { code: 'INQ-KPI-1', label: 'Acknowledgement sending progress', from: 'REGISTERED', to: 'ACKNOWLEDGED' },
    { code: 'INQ-KPI-2', label: 'Inspection progress', from: 'REGISTERED', to: 'INSPECTED' },
    { code: 'INQ-KPI-3', label: 'Recommendation progress', from: 'INSPECTED', to: 'RECOMMENDED' },
    { code: 'INQ-KPI-4', label: 'Non-conformity reporting progress', from: 'REGISTERED', to: NC_OPENED },
    { code: 'INQ-KPI-6', label: 'Decision approval progress', from: 'RECOMMENDED', to: 'APPROVED' },
    { code: 'INQ-KPI-7', label: 'Decision notification progress', from: 'APPROVED', to: 'DECISION_NOTIFIED' },
    { code: 'INQ-KPI-8', label: 'Overall progress', from: 'REGISTERED', to: 'DECISION_NOTIFIED' },
  ],
};

export const SERVICES: ServiceDef[] = [
  NEW_CONNECTION,
  RECONNECTION,
  METER_TESTING,
  SHIFTING,
  SCHEDULED_OUTAGE,
  BILLING_INQUIRY,
  BREAKDOWN,
  NAME_TARIFF_CHANGE,
  OTHER_INQUIRY,
];

const byCode = new Map(SERVICES.map((s) => [s.code, s]));
const clockByKey = new Map(SERVICES.flatMap((s) => s.clocks.map((c) => [c.key, c] as const)));

export function getService(code: string): ServiceDef {
  const s = byCode.get(code);
  if (!s) throw new Error(`Unknown service type: ${code}`);
  return s;
}

export function findService(code: string): ServiceDef | undefined {
  return byCode.get(code);
}

export function getClock(key: string): ClockDef | undefined {
  return clockByKey.get(key);
}

export function allClocks(): ClockDef[] {
  return [...clockByKey.values()];
}

export function getStep(service: ServiceDef, key: string): StepDef | undefined {
  return service.steps.find((s) => s.key === key);
}

export interface ApprovalLimit {
  role: Role;
  /** Highest estimate amount (LKR) this role may approve; null = no limit. */
  upTo: number | null;
}

/** Approval hierarchy, lowest authority first. Limits must increase along it. */
export const APPROVER_ROLES: Role[] = ['CSS', 'BM', 'SDM', 'HENG', 'GM'];

/** Default estimate approval authority (report section 2.1). The live values are in the ApprovalLimit table. */
export const DEFAULT_APPROVAL_LIMITS: ApprovalLimit[] = [
  { role: 'CSS', upTo: 20_000 },
  { role: 'BM', upTo: 500_000 },
  { role: 'SDM', upTo: 2_500_000 },
  { role: 'HENG', upTo: 5_000_000 },
  { role: 'GM', upTo: null },
];

const fits = (amount: number, l: ApprovalLimit) => l.upTo === null || amount <= l.upTo;

/** Lowest role whose authority covers the amount, or null if nobody's does. */
export function requiredApprover(amount: number, limits: ApprovalLimit[] = DEFAULT_APPROVAL_LIMITS): Role | null {
  const ordered = APPROVER_ROLES.map((r) => limits.find((l) => l.role === r)).filter((l): l is ApprovalLimit => !!l);
  return ordered.find((l) => fits(amount, l))?.role ?? null;
}

/** A role may approve if its authority limit covers the amount. */
export function canApprove(role: Role, amount: number, limits: ApprovalLimit[] = DEFAULT_APPROVAL_LIMITS): boolean {
  if (role === 'ADMIN') return true;
  const limit = limits.find((l) => l.role === role);
  return !!limit && fits(amount, limit);
}

/** Validate a full set of limits: every approver role present, increasing, top level unlimited. */
export function validateApprovalLimits(limits: ApprovalLimit[]): string | null {
  let prev = -1;
  for (const [i, role] of APPROVER_ROLES.entries()) {
    const l = limits.find((x) => x.role === role);
    if (!l) return `A limit is required for ${role}`;
    const top = i === APPROVER_ROLES.length - 1;
    if (top && l.upTo !== null) return 'The highest level (GM) must have no upper limit, so every estimate has an approver';
    if (!top) {
      if (l.upTo === null) return `Only the highest level can be unlimited (${role})`;
      if (!(l.upTo > 0)) return `${role} limit must be greater than zero`;
      if (l.upTo <= prev) return `${role} limit must be higher than the level below it`;
      prev = l.upTo;
    }
  }
  return null;
}

/** Serialisable view of the catalogue for the web client. */
export function catalogForClient() {
  return SERVICES.map((s) => ({
    code: s.code,
    name: s.name,
    prefix: s.prefix,
    section: s.section,
    kpiPrefix: s.kpiPrefix,
    intakeStep: s.intakeStep,
    natureOptions: s.natureOptions,
    subTypes: s.subTypes ?? [],
    hasChangesFlag: s.hasChangesFlag,
    kpiUnit: s.kpiUnit,
    steps: s.steps.map(({ completes, availableIf, ...rest }) => ({
      ...rest,
      conditionalAvailability: !!availableIf,
      completes: completes === true ? true : typeof completes === 'function' ? 'conditional' : false,
    })),
    clocks: s.clocks.map(({ appliesIf, ...rest }) => ({ ...rest, conditional: !!appliesIf })),
    kpis: s.kpis,
  }));
}
