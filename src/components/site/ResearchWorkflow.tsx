"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { loadClassifiedTickerMap } from "../../utils/tickerMapLoader.js";
import { validTicker } from "../../utils/researchWorkspace.js";
import styles from "../../app/home.module.css";
const goals = {
  understand: {
    title: "Understand a company",
    steps: (t: string) => [
      {
        title: "Read the financial statements",
        detail: "Choose a comparable reporting basis.",
        href: `/analysis/${t}`,
      },
      {
        title: "Inspect credit and liquidity",
        detail: "Review industry-specific risk evidence.",
        href: `/risk?ticker=${t}`,
      },
      {
        title: "Keep your review and evidence",
        detail: "Save notes and mark a financial baseline.",
        href: `/analysis/${t}?view=notebook`,
      },
    ],
  },
  disclosure: {
    title: "Investigate liquidity language",
    steps: (t: string) => [
      {
        title: "Find relevant passages",
        detail: "Search liquidity language for this company.",
        href: `/disclosures?query=liquidity&mode=companies&tickers=${t}`,
      },
      {
        title: "Check the financial context",
        detail: "Inspect the balance sheet and its sources.",
        href: `/analysis/${t}?statement=balance`,
      },
      {
        title: "Review the reporting sequence",
        detail: "Find the original reports and amendments.",
        href: `/filings/${t}?family=quarterly`,
      },
    ],
  },
  report: {
    title: "Review a new company report",
    steps: (t: string) => [
      {
        title: "Find the latest report",
        detail: "Open a filing and its relevant sections.",
        href: `/filings/${t}`,
      },
      {
        title: "See the financial changes",
        detail: "Inspect a compatible baseline and period.",
        href: `/analysis/${t}?view=changes`,
      },
      {
        title: "Save the review baseline",
        detail: "Keep notes and evidence for your next visit.",
        href: `/analysis/${t}?view=notebook`,
      },
    ],
  },
};
export default function ResearchWorkflow() {
  const [goal, setGoal] = useState<keyof typeof goals>("understand");
  const [input, setInput] = useState("JPM");
  const [ticker, setTicker] = useState("JPM");
  const [name, setName] = useState("Example workflow · JPMorgan Chase");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function apply(event: React.FormEvent) {
    event.preventDefault();
    const value = input.trim().toUpperCase();
    if (!validTicker(value)) {
      setNotice("Enter an exact company ticker.");
      return;
    }
    setBusy(true);
    setNotice("Checking the SEC company directory…");
    try {
      const entry = (await loadClassifiedTickerMap())[value];
      if (!entry)
        throw new Error(
          "Ticker not found. Use the global search to find a company by name.",
        );
      if (entry.isFund)
        throw new Error(
          `${value} is a fund. Choose the Funds tool below to research its holdings.`,
        );
      setTicker(value);
      setName(entry.name);
      setNotice(`Workflow ready for ${value}. Choose a step below.`);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Company lookup failed. Retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.workflow}>
      <p className={styles.eyebrow}>Build your research path</p>
      <label htmlFor="research-goal">What would you like to do?</label>
      <select
        id="research-goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value as keyof typeof goals)}
      >
        {Object.entries(goals).map(([key, value]) => (
          <option key={key} value={key}>
            {value.title}
          </option>
        ))}
      </select>
      <form onSubmit={apply}>
        <label htmlFor="workflow-ticker" className={styles.srOnly}>
          Workflow company ticker
        </label>
        <input
          id="workflow-ticker"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={15}
          autoComplete="off"
          placeholder="Company ticker"
        />
        <button
          type="submit"
          disabled={busy}
          aria-label="Build company workflow"
        >
          {busy ? "Checking…" : "Build path"}
          <ArrowRight size={15} />
        </button>
      </form>
      <p className={styles.workflowCompany}>
        {ticker} · {name}
      </p>
      <ol>
        {goals[goal].steps(ticker).map((step, index) => (
          <li key={step.href}>
            <span>0{index + 1}</span>
            <Link href={step.href} prefetch={false}>
              <strong>
                {step.title}
                <ArrowUpRight size={15} />
              </strong>
              <small>{step.detail}</small>
            </Link>
          </li>
        ))}
      </ol>
      <p role="status" className={styles.workflowStatus}>
        {notice}
      </p>
    </div>
  );
}
