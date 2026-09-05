import type { Metadata } from 'next';
import { Suspense } from 'react';
import { buildPageMetadata } from '../../utils/siteMetadata';
import FundsWorkspace from './FundsWorkspace';
export const metadata: Metadata = buildPageMetadata({ title: 'Mutual Funds & ETFs — Portfolio Research Workspace', description: 'Discover funds, inspect complete SEC-reported portfolios, compare holdings overlap, and save source-linked fund research.', path: '/fund' });
export default function FundIndexPage() { return <Suspense fallback={<p role="status">Opening fund research…</p>}><FundsWorkspace /></Suspense>; }
