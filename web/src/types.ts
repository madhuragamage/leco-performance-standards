export type Unit = 'WORKING_DAYS' | 'CALENDAR_DAYS' | 'HOURS' | 'MINUTES';
export type Compliance = 'WITHIN_INTERNAL' | 'INTERNAL_EXCEEDED' | 'BREACHED' | 'NO_TARGET';

export interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'datetime';
  options?: string[];
  required?: boolean;
  requestField?: string;
}

export interface StepDef {
  key: string;
  label: string;
  roles: string[];
  description?: string;
  requires?: string[];
  repeatable?: boolean;
  optional?: boolean;
  pauseStart?: string;
  pauseEnd?: string;
  ncCheck?: boolean;
  reasonCategory?: string;
  /** Reason codes required only when this boolean field is Yes. */
  reasonWhen?: string;
  availableIfText?: string;
  conditionalAvailability?: boolean;
  fields?: FieldDef[];
  approvalByAmount?: boolean;
  completes: boolean | 'conditional';
}

export interface ClockDef {
  key: string;
  label: string;
  start: string;
  end: string;
  unit: Unit;
  mode: 'MAX_DURATION' | 'MIN_LEAD';
  regulated: boolean;
  lissReport?: string;
  measure: string;
  conditional: boolean;
}

export interface ServiceDef {
  code: string;
  name: string;
  prefix: string;
  section: string;
  kpiPrefix: string;
  intakeStep: string;
  natureOptions: string[];
  subTypes: { code: string; label: string }[];
  hasChangesFlag: boolean;
  kpiUnit: Unit;
  steps: StepDef[];
  clocks: ClockDef[];
  kpis: { code: string; label: string; from: string; to: string; remarks?: string }[];
}

export interface Csc {
  id: number;
  code: string;
  name: string;
  feederClass: number;
  branchId: number;
  branchName: string;
}

export interface ReasonCode {
  id: number;
  category: string;
  code: string;
  description: string;
  active: boolean;
}

export interface Meta {
  services: ServiceDef[];
  roles: { code: string; label: string }[];
  natureLabels: Record<string, string>;
  approvalLimits: { role: string; upTo: number | null }[];
  branches: { id: number; code: string; name: string }[];
  cscs: Csc[];
  reasonCodes: ReasonCode[];
}

export interface User {
  id: number;
  username: string;
  fullName: string;
  role: string;
  cscId: number | null;
  branchId: number | null;
  cscName?: string | null;
  branchName?: string | null;
}

export interface ClockEval {
  key: string;
  label: string;
  unit: Unit;
  mode: 'MAX_DURATION' | 'MIN_LEAD';
  regulated: boolean;
  lissReport?: string;
  state: 'NOT_APPLICABLE' | 'NOT_STARTED' | 'RUNNING' | 'STOPPED';
  startedAt: string | null;
  endedAt: string | null;
  gross: number;
  excluded: number;
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

export interface ServiceEvent {
  id: number;
  stepKey: string;
  occurredAt: string;
  recordedAt: string;
  notes: string | null;
  reasonCodes: string[];
  data: Record<string, unknown> | null;
  recordedBy: { fullName: string; role: string } | null;
}

export interface ServiceRequest {
  id: number;
  refNo: string;
  serviceType: string;
  subType: string | null;
  source: string;
  portalReference: string | null;
  cscId: number;
  csc: { id: number; code: string; name: string; feederClass: number; branch?: { name: string } };
  customerName: string;
  accountNo: string | null;
  nic: string | null;
  mobile: string | null;
  email: string | null;
  address: string | null;
  natureOfSupply: string | null;
  changesRequired: boolean | null;
  wayleaveRequired: boolean | null;
  affectedCustomers: number | null;
  estimateAmount: number | null;
  expectedServiceDate: string | null;
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  currentStep: string | null;
  rating: number | null;
  feedbackComment: string | null;
  assignedTo: { id: number; fullName: string; role: string } | null;
  assignedAt: string | null;
  assignments: { id: number; at: string; note: string | null; assignedTo: { fullName: string } | null; assignedBy: { fullName: string } | null }[];
  details: Record<string, unknown> | null;
  createdAt: string;
  events: ServiceEvent[];
  clockResults: { clockKey: string; delayReasons: string[]; delayNotes: string | null; penaltyAmount: number }[];
}

export interface RequestDetail {
  request: ServiceRequest;
  evaluation: {
    clocks: ClockEval[];
    kpis: { code: string; label: string; from: string; to: string; remarks?: string; value: number | null; unit: Unit }[];
  };
  allowedSteps: string[];
  /** Non-conformity / wayleave / objection items and whether each has been closed. */
  pauseItems: { group: 'NC' | 'WL' | 'OBJ'; code: string; openedAt: string; closedAt: string | null }[];
  /** Mandatory steps the request is waiting on (any owner). */
  waitingFor: { key: string; label: string; roles: string[] }[];
}

export interface PendingRow {
  requestId: number;
  refNo: string;
  portalReference: string | null;
  serviceType: string;
  serviceName: string;
  cscName: string;
  branchName: string;
  feederClass: number;
  customerName: string;
  natureOfSupply: string | null;
  clockKey: string;
  clockLabel: string;
  mode: string;
  startedAt: string;
  elapsed: number;
  excluded: number;
  unit: Unit;
  internalTarget: number | null;
  regulatoryTarget: number | null;
  provisional: boolean;
  remainingInternal: number | null;
  remainingRegulatory: number | null;
  compliance: Compliance;
  paused: boolean;
  presentStatus: string;
  reasonCodes: string[];
  accruedPenalty: number;
}

export type Priority = 'BREACHED' | 'REG_DUE_SOON' | 'OVERDUE' | 'DUE_SOON' | 'ON_TRACK' | 'NO_DEADLINE' | 'AWAITING_CUSTOMER';

export interface TaskRow {
  requestId: number;
  refNo: string;
  serviceType: string;
  serviceName: string;
  customerName: string;
  cscName: string;
  branchName: string;
  assignedTo: { id: number; fullName: string } | null;
  assignedAt: string | null;
  bucket: 'MINE' | 'QUEUE' | 'MINE_WAITING';
  nextActions: { key: string; label: string; roles: string[] }[];
  priority: Priority;
  reason: string;
  clockLabel: string | null;
  hoursLeft: number | null;
  urgent: boolean;
}

export interface TaskSummary {
  actionable: number;
  urgent: number;
  breached: number;
  assignedToMe: number;
}

export interface Stat {
  total: number;
  internalOk: number;
  regulatoryOk: number;
  breached: number;
  internalPct: number | null;
  regulatoryPct: number | null;
  penalty: number;
  avgElapsed: number | null;
}

export interface Dashboard {
  overall: Stat;
  byClock: (Stat & { clockKey: string; label: string; serviceType: string; serviceName: string; unit: Unit; regulated: boolean })[];
  byCsc: (Stat & { cscId: number; name: string; branch: string; feederClass: number })[];
  open: {
    running: number;
    internalExceeded: number;
    breached: number;
    paused: number;
    accruedPenalty: number;
    byService: { serviceType: string; serviceName: string; running: number; internalExceeded: number; breached: number; paused: number }[];
  };
  trend: (Stat & { month: string })[];
  serviceQuality: {
    asOf: string;
    monthLabel: string;
    overall: { month: Stat; ytd: Stat };
    services: { serviceType: string; serviceName: string; regulated: boolean; month: Stat; ytd: Stat }[];
  };
  intake: { serviceType: string; source: string; count: number }[];
  feedback: { average: number | null; count: number };
}
