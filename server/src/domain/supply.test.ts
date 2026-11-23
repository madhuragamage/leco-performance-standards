import { describe, expect, it } from 'vitest';
import { allocateByExcess, computeIndices, consumersIn, eensCompensation, individualCompensation, overallCompensation, monthsBetween, parseCategory, parseDate, parseInterruptionFile, parseTransformerFile } from './supply.js';

describe('interruption categories', () => {
  it('recognises the ways categories are written in the report and in extracts', () => {
    expect(parseCategory('11-LECO-F')).toBe('11-LECO-F');
    expect(parseCategory('11-LECO-Faults-Cons.Interruptions')).toBe('11-LECO-F');
    expect(parseCategory('Sum of 11-LECO-M-Cons.hrs22')).toBe('11-LECO-M');
    expect(parseCategory('LV LECO Planned')).toBe('LV-LECO-P');
    expect(parseCategory('33kV CEB Faults')).toBe('33-CEB-F');
    expect(parseCategory('Total-LECO-Cons.hrs')).toBeNull();
    expect(parseCategory('LV-CEB-F')).toBeNull(); // no such category
  });
});

describe('dates', () => {
  it('accepts ISO and unambiguous slash dates; asks for a format otherwise', () => {
    expect(parseDate('2026-11-20', 'AUTO').date).toBe('2026-11-20');
    expect(parseDate('20/11/2026', 'AUTO').date).toBe('2026-11-20');
    expect(parseDate('5/8/2026', 'AUTO').error).toMatch(/Ambiguous/);
    expect(parseDate('5/8/2026', 'DMY').date).toBe('2026-08-05');
    expect(parseDate('5/8/2026', 'MDY').date).toBe('2026-05-08');
    expect(parseDate('31/02/2026', 'DMY').error).toMatch(/Invalid/);
  });
});

describe('interruption files', () => {
  it('reads the long layout', () => {
    const csv = 'date,tf_id,category,consumer_hours,consumer_interruptions\n2026-11-20,BZ0001,11-LECO-F,450.5,225\n2026-11-20,BZ0001,LV-LECO-P,"1,200",120\n2026-11-20,BZ0002,11-LECO-F,0,0\n';
    const r = parseInterruptionFile(csv);
    expect(r.errors).toEqual([]);
    expect(r.layout).toBe('LONG');
    expect(r.rows.map((x) => [x.tfCode, x.category, x.consumerHours, x.consumerInterruptions])).toEqual([
      ['BZ0001', '11-LECO-F', 450.5, 225],
      ['BZ0001', 'LV-LECO-P', 1200, 120],
    ]); // all-zero rows are skipped
  });

  it('reads the wide layout used in the report tables, ignoring total columns', () => {
    const csv = [
      'Date,TF ID,No of Consumers,11-LECO-F-Cons.hrs,11-LECO-F-Cons.Interruptions,11-LECO-P-Cons.hrs,11-LECO-P-Cons.Interruptions,Total-LECO-Cons.hrs',
      '2026-11-20,BZ0001,225,450,225,0,0,450',
    ].join('\n');
    const r = parseInterruptionFile(csv);
    expect(r.layout).toBe('WIDE');
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ line: 2, date: '2026-11-20', tfCode: 'BZ0001', category: '11-LECO-F', consumerHours: 450, consumerInterruptions: 225, consumers: 225, ensKwh: 0 }]);
    expect(r.warnings.join()).toMatch(/Total-LECO-Cons.hrs/);
  });

  it('reports bad rows with line numbers', () => {
    const csv = 'date,tf_id,category,consumer_hours,consumer_interruptions\n2026-11-20,BZ0001,11-XYZ-F,1,1\n2026-11-20,,11-LECO-F,1,1\n2026-11-20,BZ1,11-LECO-F,-5,1\n2026-11-20,BZ2,11-LECO-F,1,1\n2026-11-20,BZ2,11-LECO-F,2,2\n';
    const lines = parseInterruptionFile(csv).errors.map((e) => e.line);
    expect(lines).toEqual([2, 3, 4, 6]);
  });

  it('reads the transformer register', () => {
    const r = parseTransformerFile('TF ID,CSC,No of Consumers,Name\nBZ0001,Moratuwa North,225,Rawatawatte\nBZ0002,MRN,145,\nBZ0001,MRN,1,\n');
    expect(r.rows.map((x) => [x.code, x.csc, x.consumers])).toEqual([
      ['BZ0001', 'Moratuwa North', 225],
      ['BZ0002', 'MRN', 145],
    ]);
    expect(r.errors[0].message).toMatch(/Duplicate/);
  });
});

describe('indices', () => {
  it('reproduces the report 2018 Feeder Class 1 SAIDI / SAIFI (section 12.1)', () => {
    const avgConsumers = 1_516_953 / 12; // "Sum of No of Consumers" over 12 months / 12
    const idx = computeIndices(
      {
        '11-LECO-F': { hours: 1_824_534, interruptions: 3_587_569 },
        '11-LECO-P': { hours: 1_448_126, interruptions: 619_678 },
        '11-LECO-M': { hours: 31_165, interruptions: 477_579 },
        'LV-LECO-F': { hours: 41_923, interruptions: 39_837 },
        'LV-LECO-P': { hours: 5_569, interruptions: 4_124 },
      },
      avgConsumers,
    );
    expect(idx.avgConsumers).toBe(126_413);
    expect(idx.categories['11-LECO-F'].saidi).toBe(14.43);
    expect(idx.categories['11-LECO-P'].saidi).toBe(11.46);
    expect(idx.leco.saidi).toBe(26.51);
    expect(idx.leco.saifi).toBe(37.41);
    expect(idx.categories['11-LECO-F'].saifi).toBe(28.38);
    expect(idx.maifi).toBe(3.78);
    expect(idx.ceb.saidi).toBe(0);
  });

  it('reproduces the report overall compensation (section 12.1, 2018 data)', () => {
    // From the report's tables: Sum of consumers / 12, consumer hours and interruptions, energy sales, supply cost 14.54
    const fc = (cons: number, hrs: number, ints: number, energyKwh: number, approvedSaidi: number, approvedSaifi: number) =>
      overallCompensation({ saidi: hrs / (cons / 12), saifi: ints / (cons / 12), approvedSaidi, approvedSaifi, energyKwh, supplyCost: 14.54 });
    const fc1 = fc(1_516_953, 3_351_317, 4_728_787, 337_176_262.73, 27.5, 30);
    const fc2 = fc(2_649_187, 8_685_774, 10_689_870, 588_840_242.21, 30, 32.5);
    const fc3 = fc(1_712_335, 6_945_747, 8_984_658, 380_604_221.65, 32.5, 35);
    const fc4 = fc(1_195_331, 4_773_739, 4_208_017, 265_688_679.42, 35, 37.5);
    // Report: SAIDI compensations 0 / 9,132,398.23 / 10,218,679.34 / 5,699,350.00
    expect(fc1.cSaidi).toBe(0);
    expect(fc2.cSaidi).toBeCloseTo(9_132_398, -1); // report value, within LKR 5
    expect(fc3.cSaidi).toBeCloseTo(10_218_679, -1); // report value, within LKR 5
    expect(fc4.cSaidi).toBeCloseTo(5_699_350, -1); // report value, within LKR 5
    // SAIFI compensations 2,938,025.84 / 12,644,056.40 / 13,656,975.45 / 2,373,604.94
    expect(fc1.cSaifi).toBeCloseTo(2_938_026, -1); // report value, within LKR 5
    expect(fc2.cSaifi).toBeCloseTo(12_644_056, -1); // report value, within LKR 5
    expect(fc3.cSaifi).toBeCloseTo(13_656_975, -1); // report value, within LKR 5
    expect(fc4.cSaifi).toBeCloseTo(2_373_605, -1); // report value, within LKR 5
    // Overall = max per feeder class; total 34,938,407.69
    expect([fc1.basis, fc2.basis, fc3.basis, fc4.basis]).toEqual(['SAIFI', 'SAIFI', 'SAIFI', 'SAIDI']);
    expect(fc1.compensation + fc2.compensation + fc3.compensation + fc4.compensation).toBeCloseTo(34_938_407.69, -1);
  });

  it('reproduces the report group compensation for individual supply quality (section 12.3)', () => {
    expect(individualCompensation(187, 150, 270_000, 14.5)).toEqual({ exceedingHours: 37, compensation: 16_535.96 });
    expect(individualCompensation(184, 160, 245_000, 14.5).compensation).toBe(9_732.88);
    expect(individualCompensation(175, 170, 325_205, 14.5).compensation).toBe(2_691.48);
    expect(individualCompensation(140, 150, 270_000, 14.5).compensation).toBe(0);
  });

  it('shares feeder-class compensation among CSCs by their excess over the approved level', () => {
    // approved SAIDI 30; CSC A 40 h on 1,000 consumers, B 35 h on 2,000, C 25 h (within level)
    const parts = [
      { key: 'A', excess: (40 - 30) * 1000, weight: 40_000 },
      { key: 'B', excess: (35 - 30) * 2000, weight: 70_000 },
      { key: 'C', excess: (25 - 30) * 3000, weight: 75_000 },
    ];
    const m = allocateByExcess(1_000_000, parts);
    expect([m.get('A'), m.get('B'), m.get('C')]).toEqual([500_000, 500_000, 0]);
    // nobody individually over: fall back to weights
    const f = allocateByExcess(100, [{ key: 'A', excess: -1, weight: 1 }, { key: 'B', excess: 0, weight: 3 }]);
    expect([f.get('A'), f.get('B')]).toEqual([25, 75]);
  });

  it('computes EENS compensation only when the base data is set', () => {
    expect(eensCompensation(1_200_000, 1_000_000, 50)).toEqual({ excessKwh: 200_000, compensation: 10_000_000 });
    expect(eensCompensation(900_000, 1_000_000, 50).compensation).toBe(0);
    expect(eensCompensation(900_000, null, 50).compensation).toBeNull();
  });

  it('carries consumer numbers forward between monthly snapshots', () => {
    const snaps = [{ month: '2026-03', consumers: 100 }, { month: '2026-06', consumers: 120 }];
    expect(consumersIn('2026-01', snaps, 130)).toBe(100); // before the first snapshot: earliest
    expect(consumersIn('2026-05', snaps, 130)).toBe(100);
    expect(consumersIn('2026-11', snaps, 130)).toBe(120);
    expect(consumersIn('2026-11', [], 130)).toBe(130);
    expect(monthsBetween('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});
