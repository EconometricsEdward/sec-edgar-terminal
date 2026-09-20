"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

export type BillingPurchase = { id: string; createdAt: string; credits: number; amountCents: number; currency: string; status: string; receiptUrl?: string | null };
export type BillingStatus = {
  configured: boolean;
  checkoutAvailable: boolean;
  auth: { url: string; publishableKey: string } | null;
  user: { id: string; email: string } | null;
  balance: number;
  purchases: BillingPurchase[];
  pack: { id: string; name: string; priceCents: number; credits: number; currency: string };
  termsVersion: string;
  supportEmail: string | null;
  sellerName: string | null;
};
export type BillingSnapshot = { status: BillingStatus | null; loading: boolean; error: string; recovery: boolean };

const initial: BillingSnapshot = { status: null, loading: true, error: "", recovery: false };
let snapshot = initial;
let client: SupabaseClient | null = null;
let initializing: Promise<void> | null = null;
let refreshing: Promise<void> | null = null;
let refreshQueued = false;
let authGeneration = 0;
const listeners = new Set<() => void>();

function publish(next: Partial<BillingSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach(listener => listener());
}
export const subscribeBilling = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getBillingSnapshot = () => snapshot;
export const getServerBillingSnapshot = () => initial;

async function readStatus(token?: string | null): Promise<BillingStatus> {
  const response = await fetch("/api/billing/status", { cache: "no-store", headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Your AI account could not be loaded. Please try again.");
  if (typeof data.configured !== "boolean" || typeof data.checkoutAvailable !== "boolean" || !data.pack) throw new Error("Your AI account returned an unexpected response. Please try again.");
  return data as BillingStatus;
}

export async function getBillingToken() {
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session?.access_token || null;
}

export function refreshBilling(): Promise<void> {
  if (refreshing) { refreshQueued = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshQueued = false;
      const generation = authGeneration;
      try {
        const status = await readStatus(await getBillingToken());
        // Sign-out/account changes must never be overwritten by an older response.
        if (generation === authGeneration) publish({ status, loading: false, error: "" });
        else refreshQueued = true;
      } catch (error) {
        if (generation === authGeneration) publish({ loading: false, error: error instanceof Error ? error.message : "Your AI account is temporarily unavailable." });
        else refreshQueued = true;
      }
    } while (refreshQueued);
    refreshing = null;
  })();
  return refreshing;
}

export function initializeBilling(): Promise<void> {
  if (initializing) return initializing;
  initializing = (async () => {
    try {
      const config = await readStatus();
      publish({ status: config });
      if (config.auth) {
        const { createClient } = await import("@supabase/supabase-js");
        client = createClient(config.auth.url, config.auth.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "edgar-paid-ai-auth-v1" } });
        client.auth.onAuthStateChange((event, session) => {
          authGeneration++;
          if (event === "PASSWORD_RECOVERY") publish({ recovery: true });
          if (event === "SIGNED_OUT" || (snapshot.status?.user && session?.user.id !== snapshot.status.user.id)) {
            publish({ status: snapshot.status ? { ...snapshot.status, user: null, balance: 0, purchases: [] } : null, recovery: event === "PASSWORD_RECOVERY" });
          }
          // Keep async Auth work outside the auth callback's lock.
          setTimeout(() => { void refreshBilling(); }, 0);
        });
        await refreshBilling();
      } else publish({ loading: false });
    } catch (error) {
      initializing = null;
      publish({ loading: false, error: error instanceof Error ? error.message : "AI account services are temporarily unavailable." });
    }
  })();
  return initializing;
}

export async function billingAuth() {
  await initializeBilling();
  if (!client) throw new Error("AI accounts are not available yet. Free research remains available.");
  return client.auth;
}

export async function postBilling(path: "/api/billing/checkout" | "/api/billing/reconcile", body: Record<string, unknown>) {
  const token = await getBillingToken();
  if (!token) throw new Error("Please sign in to your AI account first.");
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "This request could not be completed. Please try again.");
  return data;
}

export function clearRecovery() { publish({ recovery: false }); }
