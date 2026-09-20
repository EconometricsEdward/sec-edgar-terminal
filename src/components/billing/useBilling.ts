"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getBillingSnapshot, getServerBillingSnapshot, initializeBilling, refreshBilling, subscribeBilling } from "./billingClient";

export function useBilling() {
  const state = useSyncExternalStore(subscribeBilling, getBillingSnapshot, getServerBillingSnapshot);
  useEffect(() => {
    void initializeBilling();
    const onFocus = () => { void refreshBilling(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return state;
}
