import { createContext, useContext } from 'react';
import type { Meta, ServiceDef, User } from './types';

export interface AppCtx {
  user: User;
  meta: Meta;
  logout: () => void;
  reloadMeta: () => Promise<void>;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(AppContext);
  if (!c) throw new Error('AppContext missing');
  return c;
}

export function useService(code: string | undefined): ServiceDef | undefined {
  const { meta } = useApp();
  return meta.services.find((s) => s.code === code);
}

export const MANAGER_ROLES = ['ADMIN', 'GM', 'HENG', 'SDM', 'BM'];
