"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, CreditCard, LogOut, Mail, RefreshCw } from "lucide-react";
import { billingAuth, clearRecovery, getBillingSnapshot, initializeBilling, postBilling, refreshBilling } from "./billingClient";
import { paymentMessage, verifiedCheckoutUrl } from "./billingPresentation.js";
import { useBilling } from "./useBilling";
import styles from "../../app/ai/ai.module.css";

type AuthMode = "signin" | "signup" | "reset" | "update";
function message(error: unknown) { return error instanceof Error ? error.message : "The request could not be completed. Please try again."; }
function formatMoney(cents: number, currency: string) { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100); }

export default function AiAccount() {
  const { status, loading, error, recovery } = useBilling();
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupAgreed, setSignupAgreed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [checkoutSession, setCheckoutSession] = useState("");
  const reconciled = useRef("");
  const checkoutRequest = useRef<string | null>(null);
  const accountId = status?.user?.id;

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("checkout") === "cancelled") setNotice("Checkout was cancelled. No new responses have been added.");
    const sessionId = query.get("session_id");
    if (sessionId && /^cs_[A-Za-z0-9_]{1,250}$/.test(sessionId)) setCheckoutSession(sessionId);
    const authError = new URLSearchParams(window.location.hash.slice(1)).get("error_description");
    if (authError) setFailure(authError.slice(0, 240));
  }, []);

  useEffect(() => {
    if (recovery || (status?.user && new URLSearchParams(window.location.search).get("recovery") === "1")) setMode("update");
  }, [recovery, status?.user]);

  useEffect(() => {
    if (!accountId || !checkoutSession || reconciled.current === `${accountId}:${checkoutSession}`) return;
    reconciled.current = `${accountId}:${checkoutSession}`;
    void (async () => {
      setNotice("Checking your payment with the payment service…");
      try {
        const result = await postBilling("/api/billing/reconcile", { sessionId: checkoutSession });
        if (getBillingSnapshot().status?.user?.id !== accountId) return;
        setNotice(paymentMessage(result));
        await refreshBilling();
      } catch (err) { if (getBillingSnapshot().status?.user?.id === accountId) setFailure(message(err)); }
    })();
  }, [checkoutSession, accountId]);

  const changeMode = (next: AuthMode) => { setMode(next); setPassword(""); setFailure(""); setNotice(""); };

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    setWorking(true); setFailure(""); setNotice("");
    try {
      const auth = await billingAuth();
      const address = email.trim();
      if (mode === "reset") {
        const { error: authError } = await auth.resetPasswordForEmail(address, { redirectTo: `${window.location.origin}/ai?recovery=1` });
        if (authError) throw authError;
        setNotice("If an account uses that email, a password reset link is on its way. Check your inbox and spam folder.");
      } else if (mode === "update") {
        const { error: authError } = await auth.updateUser({ password });
        if (authError) throw authError;
        clearRecovery(); setMode("signin"); setPassword("");
        window.history.replaceState({}, "", "/ai#account");
        setNotice("Your password has been updated.");
      } else if (mode === "signup") {
        if (!signupAgreed) throw new Error("Please review and accept the account terms first.");
        const { data, error: authError } = await auth.signUp({ email: address, password, options: { emailRedirectTo: `${window.location.origin}/ai?confirmed=1` } });
        if (authError) throw authError;
        setPassword("");
        if (!data.session) { setVerificationEmail(address); setNotice("Check your email to verify your account, then sign in. If you already have an account, use Sign in or reset your password."); }
        else setNotice("Your account is ready.");
      } else {
        const { error: authError } = await auth.signInWithPassword({ email: address, password });
        if (authError) {
          if (authError.code === "email_not_confirmed") setVerificationEmail(address);
          throw authError;
        }
        setPassword(""); setVerificationEmail("");
      }
      await refreshBilling();
    } catch (err) { setFailure(message(err)); }
    finally { setWorking(false); }
  }

  async function resendVerification() {
    if (working || !verificationEmail) return;
    setWorking(true); setFailure("");
    try {
      const auth = await billingAuth();
      const { error: authError } = await auth.resend({ type: "signup", email: verificationEmail, options: { emailRedirectTo: `${window.location.origin}/ai?confirmed=1` } });
      if (authError) throw authError;
      setNotice("A verification email has been requested. Check your inbox and spam folder before trying again.");
    } catch (err) { setFailure(message(err)); }
    finally { setWorking(false); }
  }

  async function signOut() {
    setWorking(true); setFailure("");
    try {
      const auth = await billingAuth();
      const { error: authError } = await auth.signOut();
      if (authError) throw authError;
      setTermsAccepted(false); setNotice("You are signed out of your AI account."); await refreshBilling();
    } catch (err) { setFailure(message(err)); }
    finally { setWorking(false); }
  }

  async function checkout() {
    if (working || !termsAccepted || !status?.checkoutAvailable || !status.user || error) return;
    setWorking(true); setFailure("");
    try {
      checkoutRequest.current ||= crypto.randomUUID();
      const result = await postBilling("/api/billing/checkout", { termsAccepted: true, termsVersion: status.termsVersion, requestId: checkoutRequest.current });
      window.location.assign(verifiedCheckoutUrl(result.url));
    } catch (err) { setFailure(message(err)); setWorking(false); }
  }

  async function checkPayment() {
    if (!checkoutSession || working) return;
    setWorking(true); setFailure("");
    try {
      const result = await postBilling("/api/billing/reconcile", { sessionId: checkoutSession });
      setNotice(paymentMessage(result));
      await refreshBilling();
    } catch (err) { setFailure(message(err)); }
    finally { setWorking(false); }
  }

  return <section id="account" className={styles.account} aria-labelledby="account-title" aria-busy={loading || working}>
    <div className={styles.accountHeading}><div><p className={styles.eyebrow}>YOUR AI ACCOUNT</p><h2 id="account-title">{status?.user ? "Ready for your research." : "Keep your responses with you."}</h2></div><CreditCard size={22} aria-hidden="true" /></div>
    {loading ? <p className={styles.notice} role="status">Loading account availability…</p> : null}
    {error ? <div className={styles.error} role="alert"><p>{error}</p><button type="button" disabled={working} onClick={() => { void initializeBilling().then(refreshBilling); }}>Try again</button></div> : null}
    {!loading && !status?.auth && !error ? <div className={styles.notice}><strong>Hosted AI access is being prepared.</strong><p>Purchases and accounts are not available yet. You can keep using the free research tools, data answers and browser AI.</p></div> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {failure ? <p className={styles.error} role="alert">{failure}</p> : null}
    {status?.user && mode !== "update" ? <>
      <div className={styles.identity}><span>{status.user.email}</span><button type="button" disabled={working} onClick={() => { void signOut(); }}><LogOut size={14} aria-hidden="true" />Sign out</button></div>
      <div className={styles.balance}><div><strong>{status.balance.toLocaleString()}</strong><span>responses available</span></div><button type="button" className={styles.secondary} disabled={working} onClick={() => { void refreshBilling(); }}><RefreshCw size={14} aria-hidden="true" />Refresh</button></div>
      {checkoutSession ? <button type="button" className={styles.secondary} disabled={working} onClick={() => { void checkPayment(); }}>Check payment</button> : null}
      <p className={styles.hint}>Open Chat on any research page and choose Hosted AI. Your credits follow your account across devices.</p>
      <div className={styles.purchase}>
        {!status.checkoutAvailable ? <p className={styles.notice}>New purchases are temporarily unavailable. Existing responses remain in your account.</p> : null}
        <label className={styles.consent}><input type="checkbox" checked={termsAccepted} disabled={!status.checkoutAvailable || working} onChange={event => setTermsAccepted(event.target.checked)} /><span>I agree to the <Link href="/terms" prefetch={false}>Terms</Link> and <Link href="/refunds" prefetch={false}>Refund Policy</Link>, and acknowledge the <Link href="/privacy" prefetch={false}>Privacy Policy</Link>. This is a one-time purchase with no automatic renewal.</span></label>
        <button type="button" className={styles.primary} disabled={!termsAccepted || !status.checkoutAvailable || !!error || working} onClick={() => { void checkout(); }}>{working ? "Please wait…" : `Buy ${status.pack.credits} responses · ${formatMoney(status.pack.priceCents, status.pack.currency)}`}<ArrowUpRight size={16} aria-hidden="true" /></button>
        <p className={styles.hint}>USD. Applicable tax and the final total are shown at checkout. U.S. billing addresses only at launch. No automatic refill.</p>
      </div>
      <div className={styles.history}><h3>Recent purchases</h3>{status.purchases?.length ? <ul>{status.purchases.map(purchase => <li key={purchase.id}><div><strong>{purchase.credits} responses · {formatMoney(purchase.amountCents, purchase.currency)}</strong><span>{new Date(purchase.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · {purchase.status.replaceAll("_", " ")}</span><small>Reference: {purchase.id}</small></div>{status.supportEmail ? <a href={`mailto:${status.supportEmail}?subject=${encodeURIComponent(`AI purchase support: ${purchase.id}`)}&body=${encodeURIComponent(`Account: ${status.user!.email}\nPurchase: ${purchase.id}\n\nPlease describe your request:\n`)}`}>Support / refund</a> : null}</li>)}</ul> : <p className={styles.hint}>No purchases yet.</p>}</div>
    </> : status?.auth && !loading ? <>
      {mode !== "update" ? <div className={styles.authTabs} aria-label="Account action"><button type="button" aria-pressed={mode === "signin"} onClick={() => changeMode("signin")} disabled={working}>Sign in</button><button type="button" aria-pressed={mode === "signup"} onClick={() => changeMode("signup")} disabled={working}>Create account</button></div> : null}
      <form className={styles.authForm} onSubmit={submitAuth}>
        {mode === "reset" ? <p className={styles.hint}>Enter your account email to request a password reset link.</p> : mode === "update" ? <p className={styles.hint}>Choose a new password for your AI account.</p> : <p className={styles.hint}>An account is only needed for paid hosted AI. Your free research tools remain available without one.</p>}
        {mode !== "update" ? <label>Email<input name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={working} /></label> : null}
        {mode !== "reset" ? <label>{mode === "update" ? "New password" : "Password"}<input name="password" type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} required minLength={mode === "signin" ? 1 : 12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={working} />{mode !== "signin" ? <small>Use at least 12 characters.</small> : null}</label> : null}
        {mode === "signup" ? <label className={styles.consent}><input type="checkbox" required checked={signupAgreed} onChange={event => setSignupAgreed(event.target.checked)} disabled={working} /><span>I am at least 18 and agree to the <Link href="/terms" prefetch={false}>Terms</Link> and acknowledge the <Link href="/privacy" prefetch={false}>Privacy Policy</Link>.</span></label> : null}
        <button type="submit" className={styles.primary} disabled={working || (mode === "update" && !status.user)}>{working ? "Please wait…" : mode === "signup" ? "Create account" : mode === "reset" ? "Send reset link" : mode === "update" ? "Save new password" : "Sign in"}</button>
        {mode === "signin" ? <button className={styles.textButton} type="button" disabled={working} onClick={() => changeMode("reset")}>Forgot your password?</button> : null}
      </form>
      {verificationEmail ? <button type="button" className={styles.secondary} disabled={working} onClick={() => { void resendVerification(); }}><Mail size={14} aria-hidden="true" />Resend verification email</button> : null}
    </> : null}
    {status?.sellerName || status?.supportEmail ? <div className={styles.support}>{status.sellerName ? <span>Sold by {status.sellerName}</span> : null}{status.supportEmail ? <a href={`mailto:${status.supportEmail}`}>Billing & account support</a> : null}</div> : null}
  </section>;
}
