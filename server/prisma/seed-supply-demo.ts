/**
 * Demo supply-quality data: a transformer register (codes starting "DEMO-") and daily
 * transformer-wise interruption figures from 1 January to today, shaped on the report's 2018 indices.
 *
 *   npx tsx prisma/seed-supply-demo.ts           create
 *   npx tsx prisma/seed-supply-demo.ts --remove  remove all demo transformers and their data
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PREFIX = 'DEMO-';

// Annual SAIDI (hours) and SAIFI per category by feeder class - LECO values from report section 12.1 (2018).
const PROFILE: Record<string, Record<number, [number, number]>> = {
  '11-LECO-F': { 1: [14.43, 28.38], 2: [20.26, 36.82], 3: [27.27, 53.84], 4: [21.41, 32.41] },
  '11-LECO-P': { 1: [11.46, 4.9], 2: [18.35, 7.72], 3: [20.84, 5.23], 4: [25.8, 8.12] },
  '11-LECO-M': { 1: [0.25, 3.78], 2: [0.2, 3.31], 3: [0.21, 3.53], 4: [0.13, 1.27] },
  'LV-LECO-F': { 1: [0.33, 0.32], 2: [0.42, 0.55], 3: [0.34, 0.35], 4: [0.35, 0.37] },
  'LV-LECO-P': { 1: [0.04, 0.03], 2: [0.11, 0.02], 3: [0.02, 0.01], 4: [0.23, 0.07] },
  '33-CEB-F': { 1: [3, 4], 2: [3.5, 4.5], 3: [4, 5], 4: [4.5, 5.5] },
  '33-CEB-P': { 1: [2, 1.5], 2: [2, 1.5], 3: [2.5, 1.5], 4: [2.5, 2] },
  '11-CEB-F': { 1: [1, 1.5], 2: [1.2, 2], 3: [1.5, 2], 4: [1.5, 2.5] },
  '11-CEB-P': { 1: [0.8, 0.5], 2: [0.8, 0.5], 3: [1, 0.6], 4: [1, 0.6] },
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

async function remove() {
  const tfs = await prisma.transformer.findMany({ where: { code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = tfs.map((t) => t.id);
  const r = await prisma.interruptionRecord.deleteMany({ where: { transformerId: { in: ids } } });
  await prisma.transformer.deleteMany({ where: { id: { in: ids } } });
  await prisma.supplyUpload.deleteMany({ where: { filename: 'demo-data', records: { none: {} } } });
  console.log(`Removed ${ids.length} demo transformers and ${r.count} interruption records.`);
}

async function create() {
  if (await prisma.transformer.count({ where: { code: { startsWith: PREFIX } } })) {
    console.log('Demo supply data already present (run with --remove first to regenerate).');
    return;
  }
  const cscs = await prisma.csc.findMany();
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const months = Array.from({ length: Number(today.slice(5, 7)) }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

  // ~25 transformers per CSC, 80-400 consumers each
  const tfData = cscs.flatMap((c) => Array.from({ length: 25 }, (_, i) => ({ code: `${PREFIX}${c.code}${String(i + 1).padStart(3, '0')}`, name: `${c.name} TF ${i + 1}`, cscId: c.id, consumers: Math.round(rnd(80, 400)) })));
  await prisma.transformer.createMany({ data: tfData });
  const tfs = await prisma.transformer.findMany({ where: { code: { startsWith: PREFIX } }, include: { csc: true } });
  // Consumer numbers grow slightly through the year.
  await prisma.transformerConsumers.createMany({
    data: tfs.flatMap((t) => months.map((m, i) => ({ transformerId: t.id, month: m, consumers: Math.round(t.consumers * (1 - (months.length - 1 - i) * 0.002)) }))),
  });
  const upload = await prisma.supplyUpload.create({ data: { kind: 'INTERRUPTIONS', source: 'WEB', filename: 'demo-data', rows: 0, periodFrom: `${year}-01-01`, periodTo: today } });

  const records: { date: string; transformerId: number; category: string; consumerHours: number; consumerInterruptions: number; ensKwh: number; cscId: number; feederClass: number; uploadId: number }[] = [];
  const start = Date.parse(`${year}-01-01T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  for (let t = start; t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    for (const tf of tfs) {
      const fc = tf.csc.feederClass;
      // Each CSC runs a little better or worse than its feeder class average.
      const cscFactor = 0.75 + ((tf.cscId * 37) % 50) / 100;
      for (const [cat, prof] of Object.entries(PROFILE)) {
        const [saidi, saifi] = prof[fc];
        const events = saifi * cscFactor / 365; // expected interruptions per consumer per day
        if (Math.random() >= Math.min(events, 0.9)) continue;
        const affected = Math.round(tf.consumers * rnd(0.6, 1));
        const duration = cat === '11-LECO-M' ? rnd(0.005, 0.02) : (saidi / saifi) * rnd(0.4, 1.6);
        const consumerHours = Math.round(affected * duration * 100) / 100;
        // Energy not supplied: ~0.6 kW average demand per consumer.
        records.push({ date, transformerId: tf.id, category: cat, consumerHours, consumerInterruptions: affected, ensKwh: Math.round(consumerHours * 0.6 * 10) / 10, cscId: tf.cscId, feederClass: fc, uploadId: upload.id });
      }
    }
  }
  for (let i = 0; i < records.length; i += 5000) await prisma.interruptionRecord.createMany({ data: records.slice(i, i + 5000) });
  await prisma.supplyUpload.update({ where: { id: upload.id }, data: { rows: records.length } });
  console.log(`Demo supply data: ${tfs.length} transformers, ${records.length} interruption records (${year}-01-01 to ${today}).`);
}

(process.argv.includes('--remove') ? remove() : create())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
