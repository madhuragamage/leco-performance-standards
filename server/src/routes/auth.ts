import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError, requireAuth, signToken, type AuthUser } from '../middleware/auth.js';
import type { Role } from '../domain/catalog.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const body = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { username: body.username.trim().toLowerCase() }, include: { csc: true, branch: true } });
  if (!user || !user.active || !(await bcrypt.compare(body.password, user.passwordHash))) {
    throw new HttpError(401, 'Invalid username or password', 'BAD_CREDENTIALS');
  }
  const au: AuthUser = { id: user.id, username: user.username, fullName: user.fullName, role: user.role as Role, cscId: user.cscId, branchId: user.branchId };
  res.json({ token: signToken(au), user: { ...au, cscName: user.csc?.name ?? null, branchName: user.branch?.name ?? null } });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.user!.id }, include: { csc: true, branch: true } });
  res.json({ ...req.user, cscName: u?.csc?.name ?? null, branchName: u?.branch?.name ?? null });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const body = z.object({ currentPassword: z.string(), newPassword: z.string().min(8) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) throw new HttpError(400, 'Current password is incorrect', 'BAD_PASSWORD');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(body.newPassword, 10) } });
  res.json({ ok: true });
});
