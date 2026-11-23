/**
 * Seed reference data from the "Draft Report on Performance Monitoring Schemes" (22 Jul 2020).
 *   npm run db:seed            reference data + users
 *   npm run db:seed -- --demo  also generates ~90 days of sample requests
 */
import 'dotenv/config';
import { PrismaClient, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEFAULT_APPROVAL_LIMITS, SERVICES, getService, type ServiceDef } from '../src/domain/catalog.js';
import { evaluateRequest } from '../src/domain/sla.js';
import { defaultCalendar } from '../src/domain/time.js';

const prisma = new PrismaClient();

// Section 1.5.1 - Feeder class assignment (CSC-wise)
const BRANCHES: { code: string; name: string; cscs: [string, string, number][] }[] = [
  { code: 'KOT', name: 'Kotte', cscs: [['PTK', 'Pitakotte', 1], ['KLW', 'Kolonnawa', 2], ['KTW', 'Kotikawatta', 2]] },
  { code: 'KEL', name: 'Kelaniya', cscs: [['KEL', 'Kelaniya', 2], ['WAT', 'Wattala', 1], ['KAN', 'Kandana', 2], ['MAH', 'Mahara', 3]] },
  { code: 'MOR', name: 'Moratuwa', cscs: [['MRN', 'Moratuwa North', 2], ['MRS', 'Moratuwa South', 3], ['KES', 'Keselwatta', 2], ['PAN', 'Panadura', 3]] },
  { code: 'GAL', name: 'Galle', cscs: [['GAL', 'Galle', 2], ['HIK', 'Hikkaduwa', 4], ['AMB', 'Ambalangoda', 4]] },
  { code: 'KAL', name: 'Kalutara', cscs: [['KAL', 'Kalutara', 3], ['PAY', 'Payagala', 4], ['ALU', 'Aluthgama', 3]] },
  { code: 'NEG', name: 'Negombo', cscs: [['NEG', 'Negombo', 2], ['SEE', 'Seeduwa', 3], ['JAE', 'Ja-Ela', 4]] },
  { code: 'NUG', name: 'Nugegoda', cscs: [['NUG', 'Nugegoda', 1], ['MHR', 'Maharagama', 1], ['BOR', 'Boralesgamuwa', 1]] },
];

const REASONS: [string, string, string][] = [
  ['NON_CONFORMITY', 'NC01', 'Internal wiring incomplete / not to standard'],
  ['NON_CONFORMITY', 'NC02', 'Earthing not satisfactory'],
  ['NON_CONFORMITY', 'NC03', 'Meter board / meter position not acceptable'],
  ['NON_CONFORMITY', 'NC04', 'Documents incomplete (deed, NIC, assessment, approvals)'],
  ['NON_CONFORMITY', 'NC05', 'Premises not accessible / customer unavailable'],
  ['NON_CONFORMITY', 'NC06', 'Service pole / stay to be provided by customer'],
  ['NON_CONFORMITY', 'NC07', 'Outstanding dues to be settled'],
  ['WAYLEAVE', 'WL01', 'Neighbour / land-owner consent required'],
  ['WAYLEAVE', 'WL02', 'Road Development Authority / local authority approval required'],
  ['WAYLEAVE', 'WL03', 'Tree cutting permission required'],
  ['WAYLEAVE', 'WL04', 'Disputed right of way'],
  ['OBJECTION', 'OB01', 'Third-party ownership dispute'],
  ['OBJECTION', 'OB02', 'Tenancy / occupancy objection'],
  ['OBJECTION', 'OB03', 'Court order / legal matter pending'],
  ['DELAY', 'D01', 'Material shortage'],
  ['DELAY', 'D02', 'Staff / vehicle not available'],
  ['DELAY', 'D03', 'Contractor delay'],
  ['DELAY', 'D04', 'Adverse weather'],
  ['DELAY', 'D05', 'Interruption approval / upstream (CEB) dependency'],
  ['DELAY', 'D06', 'Customer requested a later date'],
  ['DELAY', 'D07', 'Approval delayed'],
  ['DELAY', 'D08', 'Workload exceeded capacity'],
  ['DELAY', 'D09', 'IT / system issue'],
  ['DELAY', 'SYS', 'Recorded by system integration (portal / ADMS)'],
  ['DELAY', 'D99', 'Other - see notes'],
];

// Fixed-date public holidays only. Poya and other variable holidays must be loaded from the government gazette.
const HOLIDAYS: [string, string][] = [
  ['2026-02-04', 'National Day'],
  ['2026-04-13', 'Day prior to Sinhala & Tamil New Year'],
  ['2026-04-14', 'Sinhala & Tamil New Year'],
  ['2026-05-01', 'May Day'],
  ['2026-12-25', 'Christmas Day'],
];

type T = { clockKey: string; natureOfSupply?: string; changesRequired?: 'ANY' | 'YES' | 'NO'; feederClass?: number; internalTarget: number | null; regulatoryTarget: number | null; provisional: boolean; note: string };

function thresholds(): T[] {
  const out: T[] = [];
  // Section 1.5.5 - estimate thresholds 11/12 (internal) and 21/22 (regulatory) by feeder class
  const est: Record<string, { internal: number; regNo: number[]; regYes: number[] }> = {
    LV_RETAIL: { internal: 3, regNo: [10, 10, 12, 13], regYes: [10, 10, 12, 13] },
    LV_BULK: { internal: 14, regNo: [20, 21, 22, 23], regYes: [40, 40, 42, 43] },
    MV_BULK: { internal: 14, regNo: [20, 21, 22, 23], regYes: [40, 40, 42, 43] },
  };
  for (const [nature, v] of Object.entries(est)) {
    for (const [changes, regs] of [['NO', v.regNo], ['YES', v.regYes]] as const) {
      regs.forEach((reg, i) =>
        out.push({ clockKey: 'NEW_CONNECTION.ESTIMATE', natureOfSupply: nature, changesRequired: changes, feederClass: i + 1, internalTarget: v.internal, regulatoryTarget: reg, provisional: true, note: 'Report s.1.5.5 example thresholds; PUCSL base levels pending' }),
      );
    }
  }
  // Section 1.2 "Present Regulatory and Internal Commitments"
  out.push(
    { clockKey: 'NEW_CONNECTION.SUPPLY', natureOfSupply: 'LV_RETAIL', internalTarget: 3, regulatoryTarget: 10, provisional: true, note: 'Supply Services Code 10 working days; LECO 3' },
    { clockKey: 'NEW_CONNECTION.SUPPLY', natureOfSupply: 'LV_BULK', internalTarget: 20, regulatoryTarget: 40, provisional: true, note: 'Supply Services Code 40 working days; LECO 20' },
    { clockKey: 'NEW_CONNECTION.SUPPLY', natureOfSupply: 'MV_BULK', internalTarget: 20, regulatoryTarget: 40, provisional: true, note: 'Supply Services Code 40 working days; LECO 20' },
    { clockKey: 'RECONNECTION.RECONNECT', internalTarget: 0, regulatoryTarget: 2, provisional: false, note: 'Statutory 2 days; LECO same day' },
    { clockKey: 'METER_TESTING.TEST', natureOfSupply: 'LV_RETAIL', internalTarget: 10, regulatoryTarget: null, provisional: true, note: 'LECO 10 working days; regulatory target pending' },
    { clockKey: 'METER_TESTING.TEST', natureOfSupply: 'LV_BULK', internalTarget: 21, regulatoryTarget: null, provisional: true, note: 'LECO 21 working days; regulatory target pending' },
    { clockKey: 'METER_TESTING.TEST', natureOfSupply: 'MV_BULK', internalTarget: 21, regulatoryTarget: null, provisional: true, note: 'LECO 21 working days; regulatory target pending' },
    { clockKey: 'SHIFTING.ESTIMATE', internalTarget: 3, regulatoryTarget: null, provisional: true, note: 'Placeholder (mirrors retail estimate) - not specified in report' },
    { clockKey: 'SHIFTING.SHIFT', internalTarget: 10, regulatoryTarget: null, provisional: true, note: 'Placeholder - not specified in report; regulatory target pending' },
    { clockKey: 'SCHEDULED_OUTAGE.NOTICE', internalTarget: 48, regulatoryTarget: 48, provisional: false, note: 'Statutory minimum 48 hours notice' },
    { clockKey: 'BILLING_INQUIRY.ANSWER', internalTarget: 1, regulatoryTarget: null, provisional: true, note: 'Placeholder - not specified in report' },
    { clockKey: 'BILLING_INQUIRY.RECTIFY', internalTarget: 48, regulatoryTarget: null, provisional: true, note: 'Placeholder - not specified in report' },
    { clockKey: 'BREAKDOWN.ATTEND', internalTarget: 30, regulatoryTarget: null, provisional: true, note: 'LECO internal 30 minutes' },
    { clockKey: 'BREAKDOWN.RESTORE', internalTarget: 0, regulatoryTarget: null, provisional: true, note: 'Placeholder same-day; regulatory target pending' },
    { clockKey: 'NAME_TARIFF_CHANGE.DECISION', internalTarget: 14, regulatoryTarget: null, provisional: false, note: 'LECO internal 14 days' },
    { clockKey: 'OTHER_INQUIRY.ACK', internalTarget: 2, regulatoryTarget: null, provisional: false, note: 'Complaint procedure: email 2 / post-fax 5 working days' },
    { clockKey: 'OTHER_INQUIRY.RESOLVE', internalTarget: 14, regulatoryTarget: 28, provisional: true, note: 'Complaint procedure: 14 days, max 28 with written extension' },
  );
  return out;
}

// Section 1.3 - compensation to the customer
const PENALTIES: { clockKey: string; natureOfSupply?: string; ratePerUnit: number; maxAmount: number; perAffectedCustomer?: boolean; note: string }[] = [
  { clockKey: 'NEW_CONNECTION.ESTIMATE', ratePerUnit: 100, maxAmount: 1000, note: 'LKR 100 per day of default, max 1000' },
  { clockKey: 'NEW_CONNECTION.SUPPLY', natureOfSupply: 'LV_RETAIL', ratePerUnit: 100, maxAmount: 1000, note: 'LV supply: LKR 100/day, max 1000' },
  { clockKey: 'NEW_CONNECTION.SUPPLY', natureOfSupply: 'LV_BULK', ratePerUnit: 200, maxAmount: 2000, note: 'Bulk supply: LKR 200/day, max 2000' },
  { clockKey: 'NEW_CONNECTION.SUPPLY', natureOfSupply: 'MV_BULK', ratePerUnit: 200, maxAmount: 2000, note: 'Bulk supply: LKR 200/day, max 2000' },
  { clockKey: 'RECONNECTION.RECONNECT', ratePerUnit: 500, maxAmount: 5000, note: 'LKR 500/day, max 5000' },
  { clockKey: 'METER_TESTING.TEST', natureOfSupply: 'LV_RETAIL', ratePerUnit: 100, maxAmount: 1000, note: 'LV supply: LKR 100/day, max 1000' },
  { clockKey: 'METER_TESTING.TEST', natureOfSupply: 'LV_BULK', ratePerUnit: 50, maxAmount: 500, note: 'Bulk: LKR 50/day, max 500 (as tabled in report)' },
  { clockKey: 'METER_TESTING.TEST', natureOfSupply: 'MV_BULK', ratePerUnit: 50, maxAmount: 500, note: 'Bulk: LKR 50/day, max 500 (as tabled in report)' },
  { clockKey: 'SHIFTING.SHIFT', ratePerUnit: 50, maxAmount: 500, note: 'Meter / pole shifting: LKR 50/day, max 500' },
  { clockKey: 'SCHEDULED_OUTAGE.NOTICE', ratePerUnit: 50, maxAmount: 500, perAffectedCustomer: true, note: 'LKR 50 per affected customer per day of default, max 500' },
  { clockKey: 'BILLING_INQUIRY.ANSWER', ratePerUnit: 10, maxAmount: 500, note: 'LKR 10 per hour exceeding, max 500' },
  { clockKey: 'BILLING_INQUIRY.RECTIFY', ratePerUnit: 10, maxAmount: 500, note: 'LKR 10 per hour exceeding, max 500' },
  { clockKey: 'BREAKDOWN.RESTORE', ratePerUnit: 500, maxAmount: 2000, note: 'Cut-out fuses: LKR 500/day, max 2000' },
  { clockKey: 'OTHER_INQUIRY.RESOLVE', ratePerUnit: 25, maxAmount: 2000, note: 'LKR 25/day, max 2000' },
];

async function seedReference() {
  for (const b of BRANCHES) {
    const branch = await prisma.branch.upsert({ where: { code: b.code }, create: { code: b.code, name: b.name }, update: { name: b.name } });
    for (const [code, name, fc] of b.cscs) {
      await prisma.csc.upsert({ where: { code }, create: { code, name, feederClass: fc, branchId: branch.id }, update: { name, branchId: branch.id } });
    }
  }
  for (const [category, code, description] of REASONS) {
    await prisma.reasonCode.upsert({ where: { category_code: { category, code } }, create: { category, code, description }, update: {} });
  }
  for (const [date, name] of HOLIDAYS) await prisma.holiday.upsert({ where: { date }, create: { date, name }, update: {} });
  for (const t of thresholds()) {
    const key = { clockKey: t.clockKey, natureOfSupply: t.natureOfSupply ?? '*', changesRequired: t.changesRequired ?? 'ANY', feederClass: t.feederClass ?? 0 };
    await prisma.threshold.upsert({
      where: { clockKey_natureOfSupply_changesRequired_feederClass: key },
      create: { ...key, internalTarget: t.internalTarget, regulatoryTarget: t.regulatoryTarget, provisional: t.provisional, note: t.note },
      update: {},
    });
  }
  // Section 12 base data ("to be set by PUCSL"): approved SAIDI / SAIFI (p.37) and individual outage hours (p.42).
  const supplyTargets: [number, number, number, number][] = [
    [1, 27.5, 30, 150],
    [2, 30, 32.5, 160],
    [3, 32.5, 35, 170],
    [4, 35, 37.5, 175],
  ];
  for (const [feederClass, saidi, saifi, individualHours] of supplyTargets) {
    await prisma.supplyTarget.upsert({
      where: { feederClass },
      create: { feederClass, saidi, saifi, individualHours, provisional: true, note: 'Report s.12 example base data - to be set by PUCSL' },
      update: {},
    });
  }
  // Section 12.1 base data: energy sales per feeder class and supply cost (report uses 2018 figures).
  // Loaded for the current year as a starting point - replace with the year's actual figures.
  const year = new Date().getFullYear();
  const energy: Record<number, number> = { 1: 337_176_262.73, 2: 588_840_242.21, 3: 380_604_221.65, 4: 265_688_679.42 };
  for (const fc of [1, 2, 3, 4]) {
    await prisma.supplyYearData.upsert({
      where: { year_feederClass: { year, feederClass: fc } },
      create: { year, feederClass: fc, energySalesKwh: energy[fc], supplyCost: 14.54, note: 'Report 2018 energy sales and supply cost - replace with this year\'s figures' },
      update: {},
    });
  }
  for (const l of DEFAULT_APPROVAL_LIMITS) {
    await prisma.approvalLimit.upsert({ where: { role: l.role }, create: { role: l.role, upTo: l.upTo }, update: {} });
  }
  for (const p of PENALTIES) {
    const key = { clockKey: p.clockKey, natureOfSupply: p.natureOfSupply ?? '*' };
    await prisma.penaltyRule.upsert({
      where: { clockKey_natureOfSupply: key },
      create: { ...key, ratePerUnit: p.ratePerUnit, maxAmount: p.maxAmount, perAffectedCustomer: p.perAffectedCustomer ?? false, note: p.note },
      update: {},
    });
  }
}

async function seedUsers() {
  const password = process.env.SEED_PASSWORD ?? 'ChangeMe@123';
  const hash = await bcrypt.hash(password, 10);
  const mor = await prisma.branch.findUniqueOrThrow({ where: { code: 'MOR' } });
  const mrn = await prisma.csc.findUniqueOrThrow({ where: { code: 'MRN' } });
  const users: { username: string; fullName: string; role: string; cscId?: number; branchId?: number }[] = [
    { username: 'admin', fullName: 'System Administrator', role: 'ADMIN' },
    { username: 'gm', fullName: 'General Manager', role: 'GM' },
    { username: 'heng', fullName: 'Head of Engineering', role: 'HENG' },
    { username: 'sdm', fullName: 'Senior Distribution Manager', role: 'SDM' },
    { username: 'ce', fullName: 'Control Engineer', role: 'CE' },
    { username: 'bm.moratuwa', fullName: 'Branch Manager - Moratuwa', role: 'BM', branchId: mor.id },
    { username: 'be.moratuwa', fullName: 'Branch Engineer - Moratuwa', role: 'BE', branchId: mor.id },
    { username: 'ba.moratuwa', fullName: 'Branch Accountant - Moratuwa', role: 'BA', branchId: mor.id },
    { username: 'css.mrn', fullName: 'CSS - Moratuwa North', role: 'CSS', cscId: mrn.id },
    { username: 'to.mrn', fullName: 'Technical Officer - Moratuwa North', role: 'TO', cscId: mrn.id },
    { username: 'clerk.mrn', fullName: 'Clerk - Moratuwa North', role: 'CLERK', cscId: mrn.id },
    { username: 'tech.mrn', fullName: 'Technician - Moratuwa North', role: 'TECHNICIAN', cscId: mrn.id },
    { username: 'agent.mrn', fullName: 'Customer Service Agent - Moratuwa North', role: 'AGENT', cscId: mrn.id },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { username: u.username },
      create: { username: u.username, fullName: u.fullName, role: u.role as never, cscId: u.cscId ?? null, branchId: u.branchId ?? null, passwordHash: hash },
      update: {},
    });
  }
  console.log(`Users seeded (password for new accounts: ${process.env.SEED_PASSWORD ? '$SEED_PASSWORD' : password})`);
}

// ---------------------------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------------------------

type PathStep = [step: string, gapHours: number, data?: Record<string, unknown>, reasonCodes?: string[]];

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <X>(xs: readonly X[]): X => xs[Math.floor(Math.random() * xs.length)];

function pathFor(service: ServiceDef, nature: string): PathStep[] {
  const bulk = nature !== 'LV_RETAIL';
  const changes = Math.random() < 0.3;
  const amount = bulk ? Math.round(rnd(300_000, 4_000_000)) : Math.round(rnd(8_000, 60_000));
  // Visit outcome: no non-conformity (most cases), or one or more, each conformed separately.
  const ncCodes = ['NC01', 'NC02', 'NC03', 'NC04', 'NC05'];
  const visit = (p: number): { found: boolean; codes: string[]; conform: PathStep[] } => {
    if (Math.random() >= p) return { found: false, codes: [], conform: [] };
    const codes = [...ncCodes].sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.35 ? 2 : 1);
    return { found: true, codes, conform: codes.map((c): PathStep => ['CONFORMITY_RECEIVED', rnd(20, 70), {}, [c]]) };
  };
  switch (service.code) {
    case 'NEW_CONNECTION':
    case 'SHIFTING': {
      const v1 = visit(0.2);
      const v2 = visit(0.1);
      const est: PathStep[] = [
        ['APPLICATION', 0], ['ACCEPTED', 3], ['INSPECTION_SCHEDULED', 2, { scheduledFor: null }],
        ['INSPECTED', 24, { changesRequired: changes, wayleaveRequired: false, nonConformityFound: v1.found }, v1.codes], ...v1.conform,
        ['ESTIMATE_PREPARED', bulk ? 72 : 24, { estimateAmount: amount }], ['ESTIMATE_APPROVED', bulk ? 48 : 8], ['ESTIMATE_INFORMED', 8, { channel: 'SMS' }],
      ];
      const check: PathStep[] = [['SITE_CHECKED', 24, { wayleaveRequired: false, nonConformityFound: v2.found }, v2.codes], ...v2.conform];
      if (service.code === 'SHIFTING') return [...est, ['PAYMENT', 72], ['MATERIAL_ISSUED', 24], ...check, ['SHIFTED', bulk ? 200 : 72]];
      return [...est, ['PAYMENT', 96], ['MATERIAL_ISSUED', 24], ...check, ['CONSTRUCTED', bulk ? 300 : 30], ['CONNECTED', 6], ['ACCOUNT_CREATED', 24, { accountNo: String(Math.floor(rnd(1e9, 9e9))) }], ['AGREEMENT_DISPATCHED', 24], ['FIRST_BILL_ISSUED', 600]];
    }
    case 'RECONNECTION': {
      const v = visit(0.1);
      return [['PAYMENT', 0], ...(v.found ? [['NC_REPORTED', rnd(2, 20), {}, v.codes] as PathStep, ...v.conform] : []), ['RECONNECTED', rnd(2, 40)]];
    }
    case 'METER_TESTING':
      return [['APPLICATION', 0], ['PAYMENT', 24], ['TEST_SCHEDULED', 24, { scheduledFor: null }], ['TEST_STARTED', bulk ? 200 : 100], ['TEST_COMPLETED', 48], ['REPORT_GENERATED', 24, { meterErrorPct: Math.round(rnd(-1.5, 1.5) * 100) / 100 }], ['CUSTOMER_UPDATED', 24]];
    case 'BILLING_INQUIRY':
      return [['INQUIRY', 0], ['AGENT_ATTENDED', rnd(0.05, 0.6)], ['INQUIRY_COMPLETED', rnd(0.1, 1.2), { mistakeFound: false }]];
    case 'BREAKDOWN':
      return [['COMPLAINT', 0], ['GANG_ALLOCATED', rnd(0.05, 0.3)], ['ATTENDED', rnd(0.1, 0.8), { nonConformityFound: false }], ['RESTORED', rnd(0.2, 20)]];
    case 'NAME_TARIFF_CHANGE':
      return [['APPLICATION', 0], ['ACCEPTED', 4], ['RECOMMENDED', rnd(48, 200)], ['APPROVED', 48, { decision: 'APPROVED' }], ['DECISION_NOTIFIED', 24, { channel: 'SMS' }]];
    case 'OTHER_INQUIRY':
      return [['REGISTERED', 0, { channel: 'VISIT' }], ['ACKNOWLEDGED', rnd(0.1, 60)], ['OFFICER_ASSIGNED', 24], ['RECOMMENDED', rnd(48, 300)], ['APPROVED', 48], ['DECISION_NOTIFIED', 12]];
    case 'SCHEDULED_OUTAGE':
      return [['NOTICE_PUBLISHED', 0], ['OUTAGE_COMMENCED', rnd(24, 120)]];
    default:
      return [];
  }
}

async function seedDemo(perService = 40, days = 90) {
  const existing = await prisma.serviceRequest.count();
  if (existing > 0) {
    console.log(`Demo data skipped: ${existing} requests already exist.`);
    return;
  }
  const cscs = await prisma.csc.findMany();
  const [thresholdRows, penaltyRows, holidays] = await Promise.all([prisma.threshold.findMany(), prisma.penaltyRule.findMany(), prisma.holiday.findMany()]);
  const rules = { thresholds: thresholdRows, penalties: penaltyRows, calendar: defaultCalendar(holidays.map((h) => h.date)) };
  const delayCodes = ['D01', 'D02', 'D03', 'D04', 'D05', 'D07', 'D08'];
  const names = ['K. Perera', 'S. Fernando', 'N. Silva', 'R. Jayasinghe', 'M. Bandara', 'A. Wickramasinghe', 'D. de Silva', 'P. Gunawardena', 'H. Dissanayake', 'T. Rajapaksha'];
  const now = Date.now();
  let count = 0;

  for (const service of SERVICES) {
    for (let i = 0; i < perService; i++) {
      const csc = pick(cscs);
      const nature = pick(service.natureOptions);
      const slowness = Math.random() < 0.25 ? rnd(1.5, 4) : rnd(0.5, 1.2); // a quarter of jobs run late
      let t = now - rnd(0, days) * 86_400_000;
      // start inside office hours (08:30-16:00 local)
      const local = new Date(t + 330 * 60_000);
      local.setUTCHours(Math.floor(rnd(8, 15)), Math.floor(rnd(0, 59)));
      t = local.getTime() - 330 * 60_000;

      const path = pathFor(service, nature);
      const events: { stepKey: string; occurredAt: Date; data: Record<string, unknown>; reasonCodes: string[] }[] = [];
      const reqFields: Record<string, unknown> = {};
      for (const [step, gap, data, codes] of path) {
        t += gap * slowness * 3_600_000;
        if (t > now) break;
        const d: Record<string, unknown> = { ...(data ?? {}) };
        if ('scheduledFor' in d) d.scheduledFor = new Date(t + 24 * 3_600_000).toISOString();
        if (step === 'NOTICE_PUBLISHED') {
          const lead = Math.random() < 0.15 ? rnd(12, 40) : rnd(50, 120);
          d.scheduledFor = new Date(t + lead * 3_600_000).toISOString();
          d.affectedCustomers = Math.floor(rnd(50, 800));
          d.noticeType = pick(['SMS', 'NEWSPAPER', 'LEAFLET']);
          reqFields.affectedCustomers = d.affectedCustomers;
        }
        if (step === 'OUTAGE_COMMENCED') {
          const pub = events.find((e) => e.stepKey === 'NOTICE_PUBLISHED');
          t = Date.parse(String(pub?.data.scheduledFor));
          if (t > now) break;
        }
        if ('changesRequired' in d) reqFields.changesRequired = d.changesRequired;
        if ('wayleaveRequired' in d) reqFields.wayleaveRequired = d.wayleaveRequired;
        if ('estimateAmount' in d) reqFields.estimateAmount = d.estimateAmount;
        if ('accountNo' in d) reqFields.accountNo = d.accountNo;
        events.push({ stepKey: step, occurredAt: new Date(t), data: d, reasonCodes: codes ?? [] });
      }
      if (!events.length) continue;

      const last = events[events.length - 1];
      const stepDef = service.steps.find((s) => s.key === last.stepKey);
      const completed = typeof stepDef?.completes === 'function' ? stepDef.completes(last.data, events) : stepDef?.completes === true;
      const created = await prisma.serviceRequest.create({
        data: {
          refNo: `TMP-${count}-${Math.random()}`,
          serviceType: service.code,
          subType: service.subTypes ? pick(service.subTypes).code : null,
          source: service.code === 'SCHEDULED_OUTAGE' ? 'ADMS' : Math.random() < 0.6 ? 'PORTAL' : 'COUNTER',
          portalReference: null,
          cscId: csc.id,
          customerName: service.code === 'SCHEDULED_OUTAGE' ? `Scheduled outage - ${csc.name}` : pick(names),
          mobile: '07' + Math.floor(rnd(10_000_000, 99_999_999)),
          natureOfSupply: nature,
          accountNo: ['RECONNECTION', 'METER_TESTING', 'BILLING_INQUIRY', 'BREAKDOWN', 'NAME_TARIFF_CHANGE'].includes(service.code) ? String(Math.floor(rnd(1e9, 9e9))) : null,
          status: completed ? 'COMPLETED' : 'OPEN',
          currentStep: last.stepKey,
          createdAt: events[0].occurredAt,
          ...(reqFields as Partial<Pick<Prisma.ServiceRequestUncheckedCreateInput, 'changesRequired' | 'wayleaveRequired' | 'estimateAmount' | 'accountNo' | 'affectedCustomers'>>),
          events: { create: events.map((e) => ({ stepKey: e.stepKey, occurredAt: e.occurredAt, data: e.data as Prisma.InputJsonValue, reasonCodes: e.reasonCodes })) },
        },
      });
      const year = events[0].occurredAt.getFullYear();
      const svc = getService(service.code);
      await prisma.serviceRequest.update({ where: { id: created.id }, data: { refNo: `${svc.prefix}/${csc.code}/${year}/${String(created.id).padStart(6, '0')}` } });

      const { clocks } = evaluateRequest(svc, events, { natureOfSupply: nature, changesRequired: (reqFields.changesRequired as boolean) ?? null, feederClass: csc.feederClass, affectedCustomers: (reqFields.affectedCustomers as number) ?? null }, rules);
      for (const c of clocks) {
        if (c.state !== 'STOPPED') continue;
        const late = c.internalMet === false || c.regulatoryMet === false;
        await prisma.clockResult.create({
          data: {
            requestId: created.id, clockKey: c.key, startedAt: c.startedAt!, endedAt: c.endedAt!, elapsed: c.elapsed, excluded: c.excluded, unit: c.unit,
            internalTarget: c.internalTarget, regulatoryTarget: c.regulatoryTarget, internalMet: c.internalMet, regulatoryMet: c.regulatoryMet,
            penaltyAmount: c.penaltyAmount, delayReasons: late ? [pick(delayCodes)] : [], feederClass: csc.feederClass,
          },
        });
      }
      if (completed && Math.random() < 0.5) await prisma.serviceRequest.update({ where: { id: created.id }, data: { rating: Math.ceil(rnd(2, 5)) } });
      count++;
    }
  }
  console.log(`Demo data: ${count} requests generated.`);
}

async function main() {
  await seedReference();
  await seedUsers();
  if (process.argv.includes('--demo')) await seedDemo();
  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
