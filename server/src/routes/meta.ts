import { Router } from 'express';
import { prisma } from '../db.js';
import { NATURE_LABELS, ROLES, catalogForClient } from '../domain/catalog.js';
import { loadRules } from '../services/rules.js';

export const metaRouter = Router();

metaRouter.get('/', async (_req, res) => {
  const [branches, cscs, reasonCodes] = await Promise.all([
    prisma.branch.findMany({ orderBy: { name: 'asc' } }),
    prisma.csc.findMany({ orderBy: { name: 'asc' }, include: { branch: { select: { name: true } } } }),
    prisma.reasonCode.findMany({ where: { active: true }, orderBy: [{ category: 'asc' }, { code: 'asc' }] }),
  ]);
  res.json({
    services: catalogForClient(),
    roles: ROLES,
    natureLabels: NATURE_LABELS,
    approvalLimits: (await loadRules()).approvalLimits,
    branches,
    cscs: cscs.map((c) => ({ id: c.id, code: c.code, name: c.name, feederClass: c.feederClass, branchId: c.branchId, branchName: c.branch.name })),
    reasonCodes,
  });
});
