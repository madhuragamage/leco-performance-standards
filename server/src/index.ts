import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from './config.js';
import { WorkflowError } from './domain/workflow.js';
import { HttpError, requireAuth } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { metaRouter } from './routes/meta.js';
import { requestsRouter } from './routes/requests.js';
import { monitoringRouter } from './routes/monitoring.js';
import { adminRouter } from './routes/admin.js';
import { intakeRouter } from './routes/intake.js';
import { tasksRouter } from './routes/tasks.js';
import { supplyRouter } from './routes/supply.js';

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigin }));
// Supply quality data files can be large (daily transformer-wise data).
app.use(['/api/supply', '/api/intake/supply'], express.json({ limit: '40mb' }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/intake', intakeRouter);
app.use('/api/meta', requireAuth, metaRouter);
app.use('/api/requests', requireAuth, requestsRouter);
app.use('/api/monitoring', requireAuth, monitoringRouter);
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/tasks', requireAuth, tasksRouter);
app.use('/api/supply', requireAuth, supplyRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

// Serve the built web client in production.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof WorkflowError || err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'VALIDATION', details: err.issues });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'A record with the same unique value already exists', code: 'DUPLICATE' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Record not found', code: 'NOT_FOUND' });
      return;
    }
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({ error: 'Malformed JSON body', code: 'BAD_JSON' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
});

app.listen(config.port, () => {
  console.log(`LECO Performance Standards API listening on http://localhost:${config.port}`);
});
