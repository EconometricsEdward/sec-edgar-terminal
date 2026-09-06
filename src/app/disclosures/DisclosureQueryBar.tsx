"use client";
import { useState } from "react";
import { Search, SlidersHorizontal, Square, ArrowUpRight } from "lucide-react";
import {
  buildAdvancedQuery,
  parseDisclosureQuery,
} from "../../utils/disclosureQuery.js";
import { SECTION_OPTIONS } from "../../utils/disclosureResearch.js";
import {
  DISCLOSURE_UNIVERSES,
  DISCLOSURE_MARKET_MAP,
} from "../../utils/disclosureUniverses.js";
import type { SearchSettings } from "./disclosureTypes";
import s from "./disclosures.module.css";

export default function DisclosureQueryBar({
  settings,
  setSettings,
  onSearch,
  busy,
  stop,
}: {
  settings: SearchSettings;
  setSettings: (value: SearchSettings) => void;
  onSearch: (settings: SearchSettings) => void;
  busy: boolean;
  stop: () => void;
}) {
  const [builder, setBuilder] = useState({
    any: "",
    required: "",
    exclude: "",
  });
  const [builderError, setBuilderError] = useState("");
  const update = (
    key: keyof SearchSettings,
    value: string | number | boolean,
  ) => setSettings({ ...settings, [key]: value });
  const today = new Date().toISOString().slice(0, 10);
  const playbooks = [
    {
      name: "Bank liquidity",
      query: "liquidity AND (funding OR deposits)",
      tickers: "JPM,BAC,WFC",
      section: "mda",
      forms: "10-K",
    },
    {
      name: "Covenant pressure",
      query: "(covenant OR liquidity) AND (breach OR waiver)",
      tickers: "F,CCL,AAL",
      section: "all",
      forms: "10-K,10-Q,8-K",
    },
    {
      name: "Cyber incidents",
      query: 'cybersecurity OR "data breach" OR ransomware',
      tickers: "MSFT,UNH,GOOGL",
      section: "all",
      forms: "10-K,10-Q,8-K",
    },
  ];
  return (
    <form
      className={s.searchBox}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(settings);
      }}
    >
      <div className={s.searchTop}>
        <label className={s.queryLabel}>
          <span>Search disclosure language</span>
          <div className={s.queryInput}>
            <Search size={20} aria-hidden="true" />
            <input
              aria-label="Disclosure query"
              value={settings.query}
              onChange={(e) => update("query", e.target.value)}
              placeholder="(liquidity OR covenant) AND (breach OR waiver)"
            />
          </div>
        </label>
        <button className={s.primary} type="submit" disabled={busy}>
          <Search size={16} /> {busy ? "Reviewing…" : "Search filings"}
        </button>
        {busy && (
          <button type="button" onClick={stop}>
            <Square size={14} /> Stop
          </button>
        )}
      </div>
      <div className={s.filterRow}>
        <label>
          Research scope
          <select
            value={settings.mode}
            onChange={(e) => update("mode", e.target.value)}
          >
            <option value="companies">Company evidence</option>
            <option value="index">EDGAR index discovery</option>
          </select>
        </label>
        <label className={s.companyInput}>
          {settings.mode === "index"
            ? "Company focus · optional, up to 5"
            : "Companies · tickers or CIKs"}
          <input
            aria-label="Companies"
            placeholder={
              settings.mode === "index"
                ? "All SEC filers, or JPM"
                : "JPM, BAC, WFC"
            }
            value={settings.tickers}
            onChange={(e) => update("tickers", e.target.value)}
          />
        </label>
        <label>
          Filing forms
          <select
            value={settings.forms}
            onChange={(e) => update("forms", e.target.value)}
          >
            <option value="10-K">Annual · 10-K</option>
            <option value="10-K,10-Q">Reports · 10-K / 10-Q</option>
            <option value="10-Q">Quarterly · 10-Q</option>
            <option value="8-K">Events · 8-K</option>
            <option value="20-F,40-F,6-K">Foreign issuers</option>
            <option value="10-K,10-Q,8-K,S-1,S-3,S-4,DEF 14A,DEFM14A,20-F,40-F,N-CSR,NPORT-P">
              Broad filings
            </option>
          </select>
        </label>
        <details className={s.filters}>
          <summary>
            <SlidersHorizontal size={15} /> Filters & query builder
          </summary>
          <div className={s.advanced}>
            <div className={s.filterRow}>
              <label>
                Filed from
                <input
                  type="date"
                  aria-label="Filed from"
                  min="2001-01-01"
                  max={today}
                  value={settings.start}
                  onChange={(e) => update("start", e.target.value)}
                />
              </label>
              <label>
                Filed through
                <input
                  type="date"
                  aria-label="Filed through"
                  min={settings.start}
                  max={today}
                  value={settings.end}
                  onChange={(e) => update("end", e.target.value)}
                />
              </label>
              <label>
                Search section
                <select
                  value={settings.section}
                  onChange={(e) => update("section", e.target.value)}
                >
                  {SECTION_OPTIONS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Term scope
                <select
                  value={settings.scope}
                  onChange={(e) => update("scope", e.target.value)}
                >
                  <option value="paragraph">Same paragraph</option>
                  <option value="document">
                    Across selected document text
                  </option>
                </select>
              </label>
              <label>
                Filings per company
                <select
                  value={settings.depth}
                  onChange={(e) => update("depth", Number(e.target.value))}
                >
                  {[2, 4, 6, 8, 12].map((n) => (
                    <option key={n} value={n}>
                      {n} latest in date window
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={settings.amendments}
                onChange={(e) => update("amendments", e.target.checked)}
              />{" "}
              Include amendments as separate evidence
            </label>
            <p className={s.muted}>
              Exclusions apply to the selected scope. A section that cannot be
              identified is recorded as unavailable. Index discovery returns
              candidates; the reader verifies these filters.
            </p>
            <div className={s.builder}>
              <h3>Build an expression</h3>
              <div className={s.filterRow}>
                <label>
                  Any of these · comma-separated
                  <input
                    value={builder.any}
                    placeholder="liquidity, covenant"
                    onChange={(e) =>
                      setBuilder({ ...builder, any: e.target.value })
                    }
                  />
                </label>
                <label>
                  Also require · comma-separated
                  <input
                    value={builder.required}
                    placeholder="waiver"
                    onChange={(e) =>
                      setBuilder({ ...builder, required: e.target.value })
                    }
                  />
                </label>
                <label>
                  Exclude · comma-separated
                  <input
                    value={builder.exclude}
                    placeholder="hypothetical"
                    onChange={(e) =>
                      setBuilder({ ...builder, exclude: e.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      const query = buildAdvancedQuery(builder);
                      parseDisclosureQuery(query);
                      update("query", query);
                      setBuilderError("");
                    } catch (error) {
                      setBuilderError(error.message);
                    }
                  }}
                >
                  Use expression <ArrowUpRight size={14} />
                </button>
              </div>
              {builderError && (
                <p role="alert" className={s.error}>
                  {builderError}
                </p>
              )}
              <p className={s.muted}>
                Use AND, OR, NOT, parentheses, and &quot;exact phrases&quot;.
                Adjacent words imply AND; commas imply OR. Matching is
                case-insensitive. No wildcards.
              </p>
            </div>
          </div>
        </details>
      </div>
      <details className={s.playbooks}>
        <summary>Research playbooks & company groups</summary>
        <div className={s.filterRow}>
          {playbooks.map((p) => (
            <button
              type="button"
              key={p.name}
              onClick={() =>
                setSettings({ ...settings, ...p, mode: "companies" })
              }
            >
              {p.name} <ArrowUpRight size={13} />
            </button>
          ))}
          <label>
            Company group
            <select
              defaultValue=""
              onChange={(e) => {
                const group = DISCLOSURE_UNIVERSES.find(
                  (g) => g.id === e.target.value,
                );
                if (group)
                  setSettings({
                    ...settings,
                    tickers: group.tickers.join(","),
                    mode: "companies",
                  });
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                Choose a group…
              </option>
              {DISCLOSURE_UNIVERSES.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label} · {g.tickers.length}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              setSettings({
                ...settings,
                tickers: DISCLOSURE_MARKET_MAP.tickers.join(","),
                depth: 2,
                mode: "companies",
              })
            }
          >
            Cross-sector sample · 40 companies
          </button>
        </div>
      </details>
    </form>
  );
}
