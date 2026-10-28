import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export interface User { id: string; publicId: string; displayName: string; email: string; role: 'SELLER' | 'BIDDER' }
interface AuthValue { user: User | null; loading: boolean; refresh: () => Promise<void>; login: (email: string, password: string) => Promise<User>; register: (data: {displayName: string; email: string; password: string}) => Promise<User>; logout: () => Promise<void> }
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try { setUser((await api<{user: User | null}>('/auth/me')).user); }
    catch { setUser(null); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const value = useMemo<AuthValue>(() => ({
    user, loading, refresh,
    login: async (email, password) => { const result = await api<{user: User}>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); setUser(result.user); return result.user; },
    register: async (data) => { const result = await api<{user: User}>('/auth/register', { method: 'POST', body: JSON.stringify(data) }); setUser(result.user); return result.user; },
    logout: async () => { await api('/auth/logout', { method: 'POST' }); setUser(null); },
  }), [user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth precisa estar dentro de AuthProvider.');
  return context;
}
