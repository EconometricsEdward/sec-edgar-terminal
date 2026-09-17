"use client";

import { useEffect, useState } from 'react';
import { clearPortfolioMarketComparison, loadPortfolioMarketComparison } from '../../../utils/portfolioMarketComparisonClient.js';

type State = {
  summaries: Record<string, { status: 'ready' | 'unavailable'; summary: any }>;
  loading: boolean;
  error: string;
};

export function usePortfolioMarketComparison(active: boolean) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<State>({ summaries: {}, loading: false, error: '' });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setState(current => ({ ...current, loading: true, error: '' }));
    loadPortfolioMarketComparison({ signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ summaries: data.summaries, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState(current => ({ ...current, loading: false, error: error?.message || 'Market positioning is temporarily unavailable.' }));
    });
    return () => controller.abort();
  }, [active, revision]);
  const refresh = () => {
    clearPortfolioMarketComparison();
    setRevision(current => current + 1);
  };
  return { ...state, refresh };
}
