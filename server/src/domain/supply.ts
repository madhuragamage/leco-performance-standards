/**
 * Supply quality (report section 12): interruption categories, upload parsing and
 * overall indices (SAIDI / SAIFI / MAIFI) by feeder class.
 */
import { headerKey, parseCsv } from './csv.js';

export interface InterruptionCategory {
  code: string;
  label: string;
  owner: 'LECO' | 'CEB';
  voltage: '33kV' | '11kV' | 'LV';
  type: 'FAULT' | 'PLANNED' | 'MOMENTARY';
}

/** Columns of the report's SAIDI / SAIFI tables (section 12.1) plus the CEB-related categories (KPI table, p.39). */
export const INTERRUPTION_CATEGORIES: InterruptionCategory[] = [
  { code: '11-LECO-F', label: '11kV LECO - Faults', owner: 'LECO', voltage: '11kV', type: 'FAULT' },
  { code: '11-LECO-P', label: '11kV LECO - Planned', owner: 'LECO', voltage: '11kV', type: 'PLANNED' },
  { code: '11-LECO-M', label: '11kV LECO - Momentary', owner: 'LECO', voltage: '11kV', type: 'MOMENTARY' },
  { code: 'LV-LECO-F', label: 'LV LECO - Faults', owner: 'LECO', voltage: 'LV', type: 'FAULT' },
  { code: 'LV-LECO-P', label: 'LV LECO - Planned', owner: 'LECO', voltage: 'LV', type: 'PLANNED' },
  { code: '33-CEB-F', label: '33kV CEB - Faults', owner: 'CEB', voltage: '33kV', type: 'FAULT' },
  { code: '33-CEB-P', label: '33kV CEB - Planned', owner: 'CEB', voltage: '33kV', type: 'PLANNED' },
  { code: '11-CEB-F', label: '11kV CEB - Faults', owner: 'CEB', voltage: '11kV', type: 'FAULT' },
  { code: '11-CEB-P', label: '11kV CEB - Planned', owner: 'CEB', voltage: '11kV', type: 'PLANNED' },
];
const CATEGORY_CODES = new Set(INTERRUPTION_CATEGORIES.map((c) => c.code));

/**
 * Recognise a category written in any of the usual ways:
 * "11-LECO-F", "11-LECO-Faults", "LV LECO Planned", "Sum of 11-LECO-P-Cons.hrs", "33kV CEB Faults".
 */
export function parseCategory(raw: string): string | null {
  const tokens = raw.toUpperCase().replace(/^SUM OF\s+/, '').split(/[^A-Z0-9]+/).filter(Boolean);
  const v = tokens.find((t) => ['11', '11KV', 'LV', '33', '33KV'].includes(t));
  const o = tokens.find((t) => t === 'LECO' || t === 'CEB');
  const t = tokens.find((x) => ['F', 'FAULT', 'FAULTS', 'P', 'PLANNED', 'M', 'MOMENTARY'].includes(x));
  if (!v || !o || !t) return null;
  const code = `${v.replace('KV', '')}-${o}-${t[0]}`;
  return CATEGORY_CODES.has(code) ? code : null;
}

// ---------------------------------------------------------------------------------------------
// Dates and numbers
// ---------------------------------------------------------------------------------------------

export type DateFormat = 'AUTO' | 'YMD' | 'DMY' | 'MDY';

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Parse a date cell. Slash dates are ambiguous (5/8/2019), so they need an explicit format unless the day is > 12. */
export function parseDate(v: string, fmt: DateFormat): { date?: string; error?: string } {
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) {
    const d = validDate(+m[1], +m[2], +m[3]);
    return d ? { date: d } : { error: `Invalid date "${v}"` };
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (!m) return { error: `Unrecognised date "${v}" (use YYYY-MM-DD)` };
  const a = +m[1];
  const b = +m[2];
  const y = +m[3];
  let order = fmt;
  if (order === 'AUTO' || order === 'YMD') {
    if (a > 12 && b <= 12) order = 'DMY';
    else if (b > 12 && a <= 12) order = 'MDY';
    else return { error: `Ambiguous date "${v}" - choose the date format of the file (DD/MM/YYYY or MM/DD/YYYY)` };
  }
  const d = order === 'DMY' ? validDate(y, b, a) : validDate(y, a, b);
  return d ? { date: d } : { error: `Invalid date "${v}"` };
}

export function parseNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.trim().replace(/,/g, '');
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------------------------
// Upload files
// ---------------------------------------------------------------------------------------------

export interface FileError {
  line: number;
  message: string;
}

export interface InterruptionRow {
  line: number;
  date: string;
  tfCode: string;
  category: string;
  consumerHours: number;
  consumerInterruptions: number;
  consumers: number | null;
  /** Estimated energy not supplied, kWh (optional; needed for EENS). */
  ensKwh: number;
}

const ALIASES = {
  date: ['date', 'day', 'interruptiondate', 'outagedate'],
  tf: ['tfid', 'tf', 'tfcode', 'transformer', 'transformerid', 'transformercode', 'tfno'],
  category: ['category', 'interruptioncategory', 'interruptiontype', 'type'],
  hours: ['consumerhours', 'conshrs', 'consumerhourslost', 'hours', 'conshours'],
  interruptions: ['consumerinterruptions', 'consinterruptions', 'consnos', 'interruptions', 'consumerinterruptionsnos'],
  consumers: ['consumers', 'noofconsumers', 'numberofconsumers', 'consumercount'],
  ens: ['enskwh', 'ens', 'energynotsupplied', 'energynotsuppliedkwh', 'eenskwh', 'eens'],
  energy: ['annualenergykwh', 'annualenergy', 'energykwh', 'energysales', 'energysaleskwh', 'yearenergy'],
  csc: ['csc', 'csccode', 'cscname', 'customerservicecentre', 'cussvccentre'],
  name: ['name', 'location', 'tfname', 'transformername', 'description'],
  active: ['active', 'status'],
};

function findColumn(keys: string[], names: string[]): number {
  return keys.findIndex((k) => names.includes(k));
}

/**
 * Transformer-wise interruption data. Two layouts are accepted:
 *  - long: date, tf_id, category, consumer_hours, consumer_interruptions [, consumers]
 *  - wide: date, tf_id [, consumers], then one column per category and measure,
 *          e.g. "11-LECO-F-Cons.hrs", "11-LECO-F-Cons.Interruptions" (as in the report's tables)
 */
export function parseInterruptionFile(text: string, fmt: DateFormat = 'AUTO') {
  const errors: FileError[] = [];
  const warnings: string[] = [];
  const rows: InterruptionRow[] = [];
  const table = parseCsv(text);
  if (table.length < 2) return { rows, errors: [{ line: 1, message: 'The file has no data rows' }], warnings, layout: null as null | 'LONG' | 'WIDE' };
  const header = table[0];
  const keys = header.map(headerKey);
  const iDate = findColumn(keys, ALIASES.date);
  const iTf = findColumn(keys, ALIASES.tf);
  const iCons = findColumn(keys, ALIASES.consumers);
  if (iDate < 0 || iTf < 0) {
    return { rows, errors: [{ line: 1, message: 'Header must include a date column and a transformer (tf_id) column' }], warnings, layout: null };
  }
  const iCat = findColumn(keys, ALIASES.category);
  let layout: 'LONG' | 'WIDE';
  const wideCols: { index: number; category: string; measure: 'hours' | 'interruptions' | 'ens' }[] = [];
  if (iCat >= 0) {
    layout = 'LONG';
    if (findColumn(keys, ALIASES.hours) < 0 || findColumn(keys, ALIASES.interruptions) < 0) {
      return { rows, errors: [{ line: 1, message: 'Header must include consumer_hours and consumer_interruptions columns' }], warnings, layout };
    }
  } else {
    layout = 'WIDE';
    header.forEach((h, i) => {
      if ([iDate, iTf, iCons].includes(i)) return;
      const k = keys[i];
      const measure = /ens|energynotsupplied|kwh/.test(k) ? 'ens' : /hrs|hour/.test(k) ? 'hours' : /interrupt|nos/.test(k) ? 'interruptions' : null;
      const category = parseCategory(h);
      if (measure && category) wideCols.push({ index: i, category, measure });
      else warnings.push(`Column "${h}" ignored${/total/i.test(h) ? ' (totals are calculated)' : ''}`);
    });
    if (!wideCols.length) {
      return { rows, errors: [{ line: 1, message: 'No category columns recognised. Use a "category" column, or columns such as "11-LECO-F-Cons.hrs" and "11-LECO-F-Cons.Interruptions".' }], warnings, layout };
    }
  }
  const iHours = findColumn(keys, ALIASES.hours);
  const iInt = findColumn(keys, ALIASES.interruptions);
  const iEns = layout === 'LONG' ? findColumn(keys, ALIASES.ens) : -1;

  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const line = r + 1;
    const d = parseDate(cells[iDate] ?? '', fmt);
    if (d.error) {
      errors.push({ line, message: d.error });
      continue;
    }
    const tfCode = (cells[iTf] ?? '').trim();
    if (!tfCode) {
      errors.push({ line, message: 'Transformer ID is empty' });
      continue;
    }
    const consumers = iCons >= 0 ? parseNumber(cells[iCons]) : null;
    if (iCons >= 0 && (consumers === null || consumers < 0)) {
      errors.push({ line, message: `Invalid number of consumers "${cells[iCons]}"` });
      continue;
    }
    const push = (category: string, h: number | null, n: number | null, e: number | null, what: string) => {
      if (h === null || n === null || e === null || h < 0 || n < 0 || e < 0) {
        errors.push({ line, message: `Invalid ${what} - consumer hours, interruptions and energy not supplied must be numbers >= 0` });
        return;
      }
      if (h === 0 && n === 0 && e === 0) return;
      rows.push({ line, date: d.date!, tfCode, category, consumerHours: h, consumerInterruptions: n, consumers: consumers !== null && iCons >= 0 ? consumers : null, ensKwh: e });
    };
    if (layout === 'LONG') {
      const category = parseCategory(cells[iCat] ?? '');
      if (!category) {
        errors.push({ line, message: `Unknown category "${cells[iCat]}" (expected one of ${INTERRUPTION_CATEGORIES.map((c) => c.code).join(', ')})` });
        continue;
      }
      push(category, parseNumber(cells[iHours]), parseNumber(cells[iInt]), iEns >= 0 ? parseNumber(cells[iEns]) : 0, `figures for ${category}`);
    } else {
      const byCat = new Map<string, { h: number | null; n: number | null; e: number | null }>();
      for (const c of wideCols) {
        const cur = byCat.get(c.category) ?? { h: 0, n: 0, e: 0 };
        cur[c.measure === 'hours' ? 'h' : c.measure === 'ens' ? 'e' : 'n'] = parseNumber(cells[c.index]);
        byCat.set(c.category, cur);
      }
      for (const [category, v] of byCat) push(category, v.h, v.n, v.e, `figures for ${category}`);
    }
  }
  // The same transformer, date and category twice in one file is almost certainly a mistake.
  const seen = new Map<string, number>();
  for (const row of rows) {
    const k = `${row.date}|${row.tfCode}|${row.category}`;
    if (seen.has(k)) errors.push({ line: row.line, message: `Duplicate of line ${seen.get(k)} (${row.tfCode}, ${row.date}, ${row.category})` });
    else seen.set(k, row.line);
  }
  return { rows, errors, warnings, layout };
}

export interface TransformerRow {
  line: number;
  code: string;
  csc: string;
  consumers: number;
  name: string | null;
  active: boolean;
  /** null = column not in file (keep existing); undefined handled as null. */
  annualEnergyKwh: number | null;
}

/** Transformer register: tf_id, csc (code or name), consumers [, name] [, active]. */
export function parseTransformerFile(text: string) {
  const errors: FileError[] = [];
  const rows: TransformerRow[] = [];
  const table = parseCsv(text);
  if (table.length < 2) return { rows, errors: [{ line: 1, message: 'The file has no data rows' }] };
  const keys = table[0].map(headerKey);
  const iTf = findColumn(keys, ALIASES.tf);
  const iCsc = findColumn(keys, ALIASES.csc);
  const iCons = findColumn(keys, ALIASES.consumers);
  const iName = findColumn(keys, ALIASES.name);
  const iActive = findColumn(keys, ALIASES.active);
  const iEnergy = findColumn(keys, ALIASES.energy);
  if (iTf < 0 || iCsc < 0 || iCons < 0) return { rows, errors: [{ line: 1, message: 'Header must include tf_id, csc and consumers columns' }] };
  const seen = new Map<string, number>();
  for (let r = 1; r < table.length; r++) {
    const c = table[r];
    const line = r + 1;
    const code = (c[iTf] ?? '').trim();
    const csc = (c[iCsc] ?? '').trim();
    const consumers = parseNumber(c[iCons]);
    if (!code) errors.push({ line, message: 'Transformer ID is empty' });
    else if (!csc) errors.push({ line, message: 'CSC is empty' });
    else if (consumers === null || consumers < 0 || !Number.isInteger(consumers)) errors.push({ line, message: `Invalid number of consumers "${c[iCons]}"` });
    else if (seen.has(code)) errors.push({ line, message: `Duplicate of line ${seen.get(code)} (${code})` });
    else {
      const energyCell = iEnergy >= 0 ? (c[iEnergy] ?? '').trim() : '';
      const energy = energyCell === '' ? null : parseNumber(energyCell);
      if (energyCell !== '' && (energy === null || energy < 0)) {
        errors.push({ line, message: `Invalid annual energy "${c[iEnergy]}"` });
        continue;
      }
      seen.set(code, line);
      const act = iActive >= 0 ? (c[iActive] ?? '').trim().toUpperCase() : '';
      rows.push({ line, code, csc, consumers, name: iName >= 0 ? (c[iName] ?? '').trim() || null : null, active: !['N', 'NO', 'FALSE', '0', 'INACTIVE'].includes(act), annualEnergyKwh: energy });
    }
  }
  return { rows, errors };
}

// ---------------------------------------------------------------------------------------------
// Compensation (report section 12)
// ---------------------------------------------------------------------------------------------

const HOURS_PER_YEAR = 8760;
const money = (n: number) => Math.round(n * 100) / 100;

export interface OverallCompInput {
  saidi: number; // actual SAIDI (unrounded)
  saifi: number; // actual SAIFI (unrounded)
  approvedSaidi: number | null;
  approvedSaifi: number | null;
  energyKwh: number; // YearEnergy for the feeder class
  supplyCost: number; // LKR / kWh
}

/**
 * Section 12.1, for feeder class m:
 *   C_SAIDI = (SAIDI - approved SAIDI) x YearEnergy / 8760 x SUPPLYCOST            (0 if SAIDI < approved)
 *   C_SAIFI = (SAIFI - approved SAIFI) x (SAIDI / SAIFI) x YearEnergy / 8760 x SUPPLYCOST   (0 if SAIFI < approved)
 *   C = max(C_SAIDI, C_SAIFI)
 */
export function overallCompensation(i: OverallCompInput) {
  const perHour = (i.energyKwh / HOURS_PER_YEAR) * i.supplyCost; // value of one hour's supply
  const saidiExcess = i.approvedSaidi === null ? 0 : Math.max(0, i.saidi - i.approvedSaidi);
  const saifiExcess = i.approvedSaifi === null ? 0 : Math.max(0, i.saifi - i.approvedSaifi);
  const cSaidi = saidiExcess * perHour;
  const cSaifi = i.saifi > 0 ? saifiExcess * (i.saidi / i.saifi) * perHour : 0;
  const compensation = Math.max(cSaidi, cSaifi);
  return {
    saidiExcess: money(i.approvedSaidi === null ? 0 : i.saidi - i.approvedSaidi),
    saifiExcess: money(i.approvedSaifi === null ? 0 : i.saifi - i.approvedSaifi),
    cSaidi: money(cSaidi),
    cSaifi: money(cSaifi),
    compensation: money(compensation),
    basis: compensation === 0 ? null : cSaidi >= cSaifi ? ('SAIDI' as const) : ('SAIFI' as const),
  };
}

/**
 * Section 12.2: C_EENS = (EENS / ETOT - approved EENS / ETOT) x YearEnergy x CENS
 *             = (EENS - approved EENS) x CENS   (since ETOT = YearEnergy), 0 if negative.
 */
export function eensCompensation(eensKwh: number, approvedEensKwh: number | null, cens: number | null) {
  if (approvedEensKwh === null || cens === null) return { excessKwh: null, compensation: null };
  const excess = eensKwh - approvedEensKwh;
  return { excessKwh: Math.round(excess), compensation: money(Math.max(0, excess) * cens) };
}

/**
 * Section 12.3, per qualifying transformer (customer group), following the report's worked example:
 *   compensation = hours above the specified annual duration x YearEnergy(group) / 8760 x SUPPLYCOST
 * The group amount is then shared among its customers by their annual energy use.
 */
export function individualCompensation(durationHours: number, specifiedHours: number | null, energyKwh: number, supplyCost: number) {
  if (specifiedHours === null) return { exceedingHours: 0, compensation: 0 };
  const exceeding = Math.max(0, durationHours - specifiedHours);
  return { exceedingHours: Math.round(exceeding * 100) / 100, compensation: money((exceeding * energyKwh * supplyCost) / HOURS_PER_YEAR) };
}

/**
 * Share a feeder-class compensation amount among its CSCs by their excess over the approved level
 * ("contributions by each CSC ... based on the target given and the achievement made").
 * CSCs within the approved level contribute nothing. If no CSC is individually over the level
 * (possible only through rounding), the amount is shared by the fallback weights instead.
 */
export function allocateByExcess<K>(total: number, parts: { key: K; excess: number; weight: number }[]): Map<K, number> {
  const out = new Map<K, number>();
  const pos = parts.map((p) => ({ ...p, excess: Math.max(0, p.excess) }));
  const sumExcess = pos.reduce((s, p) => s + p.excess, 0);
  const sumWeight = pos.reduce((s, p) => s + Math.max(0, p.weight), 0);
  for (const p of pos) {
    const share = sumExcess > 0 ? p.excess / sumExcess : sumWeight > 0 ? Math.max(0, p.weight) / sumWeight : 0;
    out.set(p.key, money(total * share));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Indices
// ---------------------------------------------------------------------------------------------

/** Months (YYYY-MM) covered by an inclusive date range. */
export function monthsBetween(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  let y = +fromKey.slice(0, 4);
  let m = +fromKey.slice(5, 7);
  const ey = +toKey.slice(0, 4);
  const em = +toKey.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Consumers on a transformer in a month: latest snapshot up to that month, else the earliest one, else the register value. */
export function consumersIn(month: string, snapshots: { month: string; consumers: number }[], current: number): number {
  let best: { month: string; consumers: number } | undefined;
  for (const s of snapshots) if (s.month <= month && (!best || s.month > best.month)) best = s;
  if (best) return best.consumers;
  if (snapshots.length) return snapshots.reduce((a, b) => (a.month < b.month ? a : b)).consumers;
  return current;
}

export interface Figures {
  hours: number;
  interruptions: number;
}

export interface IndexSet {
  avgConsumers: number;
  categories: Record<string, Figures & { saidi: number | null; saifi: number | null }>;
  /** Total LECO, as in the report's tables: all five LECO categories including momentary. */
  leco: Figures & { saidi: number | null; saifi: number | null };
  /** LECO excluding momentary interruptions (SAIFI as usually defined; momentary reported as MAIFI). */
  lecoSustained: Figures & { saidi: number | null; saifi: number | null };
  ceb: Figures & { saidi: number | null; saifi: number | null };
  maifi: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** SAIDI = consumer hours lost / average consumers; SAIFI = consumer interruptions / average consumers. */
export function computeIndices(totals: Record<string, Figures>, avgConsumers: number): IndexSet {
  const per = (f: Figures) => ({ ...f, saidi: avgConsumers ? r2(f.hours / avgConsumers) : null, saifi: avgConsumers ? r2(f.interruptions / avgConsumers) : null });
  const sum = (pred: (c: InterruptionCategory) => boolean): Figures =>
    INTERRUPTION_CATEGORIES.filter(pred).reduce((acc, c) => ({ hours: acc.hours + (totals[c.code]?.hours ?? 0), interruptions: acc.interruptions + (totals[c.code]?.interruptions ?? 0) }), { hours: 0, interruptions: 0 });
  return {
    avgConsumers: Math.round(avgConsumers),
    categories: Object.fromEntries(INTERRUPTION_CATEGORIES.map((c) => [c.code, per(totals[c.code] ?? { hours: 0, interruptions: 0 })])),
    leco: per(sum((c) => c.owner === 'LECO')),
    lecoSustained: per(sum((c) => c.owner === 'LECO' && c.type !== 'MOMENTARY')),
    ceb: per(sum((c) => c.owner === 'CEB')),
    maifi: avgConsumers ? r2((totals['11-LECO-M']?.interruptions ?? 0) / avgConsumers) : null,
  };
}
