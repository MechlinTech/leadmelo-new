'use client';
import { createContext, useContext } from 'react';

type AppRole = { canWrite: boolean; role: string };
const Ctx = createContext<AppRole>({ canWrite: false, role: 'MEMBER' });
export function AppRoleProvider({ canWrite, role, children }: AppRole & { children: React.ReactNode }) {
  return <Ctx.Provider value={{ canWrite, role }}>{children}</Ctx.Provider>;
}
export const useAppRole = () => useContext(Ctx);
