"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, ArrowUpRight, Route } from "lucide-react";
import { validTicker } from "../../utils/researchWorkspace.js";
import styles from "../../app/home.module.css";
const goals = {
  understand: {
    label: "Company",
    title: "Understand a company",
    steps: (t: string) => [
      {
        title: "Read the financial statements",
        detail: "Choose a comparable reporting basis.",
        href: `/analysis/${t}?view=statements`,
      },
      {
        title: "Inspect credit and liquidity",
        detail: "Review industry-specific risk evidence.",
        href: `/risk?ticker=${t}`,
      },
      {
        title: "Verify the financial evidence",
        detail: "Check source coverage, SEC tags, and reported inputs.",
        href: `/analysis/${t}?view=checks`,
      },
    ],
  },
  disclosure: {
    label: "Disclosures",
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
        href: `/analysis/${t}?view=statements&statement=balance`,
      },
      {
        title: "Review the reporting sequence",
        detail: "Find the original reports and amendments.",
        href: `/filings/${t}?family=quarterly`,
      },
    ],
  },
  report: {
    label: "New report",
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
        title: "Check the source history",
        detail: "Inspect source filings, revisions, and reporting coverage.",
        href: `/analysis/${t}?view=checks`,
      },
    ],
  },
};
const examples: Record<string, string> = {
  AAPL: "Apple Inc.",
  MSFT: "Microsoft Corporation",
  JPM: "JPMorgan Chase & Co.",
};

export default function ResearchWorkflow() {
  const [goal, setGoal] = useState<keyof typeof goals>("understand");
  const [input, setInput] = useState("JPM");
  const [ticker, setTicker] = useState("JPM");
  const [name, setName] = useState(examples.JPM);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  function chooseCompany(value: string, companyName: string) {
    setInput(value);
    setTicker(value);
    setName(companyName);
    setNotice(`Research path ready for ${value}. Choose a step below.`);
  }

  async function apply(event: React.FormEvent) {
    event.preventDefault();
    const value = input.trim().toUpperCase();
    if (!validTicker(value)) {
      setNotice("Enter an exact company ticker.");
      return;
    }
    if (examples[value]) {
      chooseCompany(value, examples[value]);
      return;
    }
    setBusy(true);
    setNotice("Checking the SEC company directory…");
    try {
      const { loadClassifiedTickerMap } = await import(
        "../../utils/tickerMapLoader.js"
      );
      const entry = (await loadClassifiedTickerMap())[value];
      if (!entry)
        throw new Error(
          "Ticker not found. Use the global search to find a company by name.",
        );
      if (entry.isFund)
        throw new Error(
          `${value} is a fund. Open Funds to research its holdings.`,
        );
      chooseCompany(value, entry.name);
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
    <section className={styles.workflow} aria-labelledby="workflow-title">
      <div className={styles.workflowHeader}>
        <div>
          <p className={styles.eyebrow}>From question to evidence</p>
          <h2 id="workflow-title">Your research desk</h2>
        </div>
        <Route size={24} aria-hidden="true" />
      </div>
      <div
        className={styles.workflowTabs}
        role="group"
        aria-label="Choose your research goal"
      >
        {Object.entries(goals).map(([key, value]) => (
          <button
            key={key}
            type="button"
            aria-pressed={goal === key}
            onClick={() => setGoal(key as keyof typeof goals)}
          >
            {value.label}
          </button>
        ))}
      </div>
      <p className={styles.workflowGoal}>{goals[goal].title}</p>
      <form onSubmit={apply}>
        <label htmlFor="workflow-ticker" className={styles.srOnly}>
          Workflow company ticker
        </label>
        <input
          id="workflow-ticker"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setNotice("");
          }}
          disabled={busy}
          maxLength={15}
          autoComplete="off"
          spellCheck={false}
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
      <div className={styles.workflowExamples} role="group" aria-label="Try a company">
        <span>Try</span>
        {Object.entries(examples).map(([symbol, companyName]) => (
          <button
            key={symbol}
            type="button"
            disabled={busy}
            aria-label={`Research ${companyName} (${symbol})`}
            aria-pressed={ticker === symbol}
            onClick={() => chooseCompany(symbol, companyName)}
          >
            {symbol}
          </button>
        ))}
      </div>
      <p className={styles.workflowCompany}>
        <span>{ticker}</span> · {name}
      </p>
      <ol>
        {goals[goal].steps(ticker).map((step, index) => (
          <li key={step.href}>
            <span>0{index + 1}</span>
            <Link href={step.href} prefetch={false}>
              <strong>
                {step.title}
                <ArrowUpRight size={15} aria-hidden="true" />
              </strong>
              <small>{step.detail}</small>
            </Link>
          </li>
        ))}
      </ol>
      <p role="status" className={styles.workflowStatus}>
        {notice}
      </p>
    </section>
  );
}
