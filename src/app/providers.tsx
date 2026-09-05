'use client';

import { ReactNode } from 'react';
import { WorkspaceProvider } from '../components/research/WorkspaceProvider';
import { TickerProvider } from '../contexts/TickerContext';

export function Providers({ children }: { children: ReactNode }) {
  return <WorkspaceProvider><TickerProvider>{children}</TickerProvider></WorkspaceProvider>;
}