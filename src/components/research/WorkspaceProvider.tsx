'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { emptyWorkspace, parseWorkspace, writeWorkspace, WORKSPACE_KEY } from '../../utils/researchWorkspace.js';

type Workspace = { version: number; companies: Record<string, any>; peerGroups: any[] };
const Context = createContext<{ data: Workspace; ready: boolean; error: string; update: (fn: (w: Workspace) => Workspace) => boolean } | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Workspace>(emptyWorkspace);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const read = () => {
      try { setData(parseWorkspace(localStorage.getItem(WORKSPACE_KEY))); setError(''); }
      catch { setError('Saved research could not be read. Existing browser data has not been overwritten.'); }
      setReady(true);
    };
    read();
    const sync = (event: StorageEvent) => { if (event.key === WORKSPACE_KEY) read(); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const update = useCallback((fn: (w: Workspace) => Workspace) => {
    try { const next = writeWorkspace(localStorage, fn); setData(next); setError(''); return true; }
    catch { setError('Your changes could not be saved. Browser storage may be full or unavailable. Keep this page open and export your work.'); return false; }
  }, []);
  return <Context.Provider value={{ data, ready, error, update }}>{children}</Context.Provider>;
}

export function useWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error('WorkspaceProvider is required.');
  return context;
}
