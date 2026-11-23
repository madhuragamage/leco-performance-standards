import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { Role } from '../domain/catalog.js';
import { prisma } from '../db.js';

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  cscId: number | null;
  branchId: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERROR',
    public details?: unknown,
  ) {
    super(message);
  }
}

export function signToken(u: AuthUser): string {
  return jwt.sign(u, config.jwtSecret, { expiresIn: '12h' });
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
  let payload: AuthUser;
  try {
    payload = jwt.verify(token, config.jwtSecret) as AuthUser;
  } catch {
    throw new HttpError(401, 'Session expired - please sign in again', 'UNAUTHENTICATED');
  }
  // Re-check the account so deactivated users lose access immediately.
  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  if (!user || !user.active) throw new HttpError(401, 'Account is disabled', 'UNAUTHENTICATED');
  req.user = { id: user.id, username: user.username, fullName: user.fullName, role: user.role as Role, cscId: user.cscId, branchId: user.branchId };
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new HttpError(401, 'Not signed in', 'UNAUTHENTICATED');
    if (req.user.role !== 'ADMIN' && !roles.includes(req.user.role)) throw new HttpError(403, 'You do not have permission for this action', 'FORBIDDEN');
    next();
  };
}

export function requireApiKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || key !== config.portalApiKey) throw new HttpError(401, 'Invalid API key', 'BAD_API_KEY');
  next();
}

/** CSC ids the user may see; null = all. */
export async function visibleCscIds(user: AuthUser): Promise<number[] | null> {
  if (['ADMIN', 'GM', 'HENG', 'SDM', 'CE'].includes(user.role)) return null;
  if (user.cscId) return [user.cscId];
  if (user.branchId) {
    const cscs = await prisma.csc.findMany({ where: { branchId: user.branchId }, select: { id: true } });
    return cscs.map((c) => c.id);
  }
  return null;
}

export async function assertCanSeeCsc(user: AuthUser, cscId: number) {
  const ids = await visibleCscIds(user);
  if (ids && !ids.includes(cscId)) throw new HttpError(403, 'This request belongs to a CSC outside your area', 'FORBIDDEN');
}
