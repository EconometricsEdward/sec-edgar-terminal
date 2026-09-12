"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BadgeDollarSign,
  Banknote,
  BarChart3,
  Building2,
  ChartScatter,
  CircleGauge,
  Layers3,
  Scale,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  FINANCIAL_PROFILE_ALL_SECTORS,
  FINANCIAL_PROFILE_UNCOVERED_SECTOR,
  buildPortfolioFinancialProfile,
  normalizeFinancialProfileSector,
  resolveFinancialProfileMetricLens,
} from "../../../utils/portfolioFinancialProfile.js";
import { canonicalPortfolioCik } from "../../../utils/portfolioModel.js";
import s from "./PortfolioFinancialProfile.module.css";

const PortfolioInsightTools = dynamic(() => import("./PortfolioInsightTools"), {
  loading: () => <p role="status">Opening financial analysis…</p>,
});
const PortfolioConnections = dynamic(() => import("./PortfolioConnections"), {
  loading: () => <p role="status">Connecting financial statements…</p>,
});
const CashEarnings = dynamic(() => import("./CashEarnings"), {
  loading: () => <p role="status">Building the cash and earnings view…</p>,
});
const PortfolioFinancialTools = dynamic(
  () => import("./PortfolioFinancialTools"),
  { loading: () => <p role="status">Opening comparison tools…</p> },
);

type View = "overview" | "measures" | "health" | "relationships" | "compare";
type HealthView = "weighted" | "buffers" | "overlap" | "statements";
type Props = {
  report: any;
  catalogReport: any;
  companies: any[];
  capturedAt?: string | null;
  onInspectCompany: (rowId: string) => void;
  onDisclosure?: (query: string, ciks: string[]) => void;
  financialRequest?: { metricId: string; nonce: number } | null;
};

const VIEWS: { id: View; label: string; icon: typeof Sparkles }[] = [
  { id: "overview", label: "Overview", icon: Sparkles },
  { id: "measures", label: "Measures", icon: BarChart3 },
  { id: "health", label: "Financial health", icon: ShieldCheck },
  { id: "relationships", label: "Relationships", icon: ChartScatter },
  { id: "compare", label: "Compare", icon: Scale },
];

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const compact = (value: unknown, digits = 1) =>
  finite(value)
    ? value.toLocaleString("en-US", {
        notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
        maximumFractionDigits: digits,
      })
    : "—";
const percent = (value: unknown) => (finite(value) ? `${compact(value, 1)}%` : "—");
const companyCountLabel = (value: number) =>
  `${value} ${value === 1 ? "company" : "companies"}`;
const valueLabel = (value: unknown, unit: string) => {
  if (!finite(value)) return "Unavailable";
  if (unit === "USD")
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    });
  if (unit === "%") return `${compact(value, 2)}%`;
  return `${compact(value, 2)}${unit ? ` ${unit}` : ""}`;
};
const dateLabel = (value: string | null | undefined) =>
  value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "Unavailable";
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export const freeCashFlowDirection = (point: any, includeValue = false) => {
  if (!finite(point?.freeCashFlow)) return "FCF unavailable";
  const direction =
    point.freeCashFlow > 0
      ? "Positive FCF"
      : point.freeCashFlow < 0
        ? "Negative FCF"
        : "Zero FCF";
  return includeValue
    ? `${direction} · ${valueLabel(point.freeCashFlow, "USD")}`
    : direction;
};

function financialProfileRevision(catalogReport: any, capturedAt?: string | null) {
  let hash = 2166136261;
  const mix = (value: unknown) => {
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  mix(capturedAt);
  for (const issuer of catalogReport?.concentration?.issuers || []) {
    mix(issuer.cik);
    mix(issuer.lens);
    mix(issuer.sector);
    mix(issuer.weightPct);
    mix(issuer.weightComplete);
  }
  for (const metric of catalogReport?.metrics || []) {
    mix(metric.id || metric.key);
    for (const row of metric.observations || []) {
      mix(row.cik);
      mix(row.value);
      mix(row.periodKey);
      mix(row.lens);
    }
  }
  return (hash >>> 0).toString(36);
}

export function buildFinancialHealthScope(
  report: any,
  catalogReport: any,
  companies: any[],
  lens: string,
  sector = FINANCIAL_PROFILE_ALL_SECTORS,
  selectedCiks?: string[],
) {
  const normalizedCiks = (
    Array.isArray(selectedCiks)
      ? selectedCiks
      : (catalogReport?.concentration?.issuers || [])
          .filter(
            (row: any) =>
              row.kind === "company" &&
              row.lens === lens &&
              (sector === FINANCIAL_PROFILE_ALL_SECTORS ||
                normalizeFinancialProfileSector(row.sector) === sector),
          )
          .map((row: any) => row.cik)
  )
    .map((value: any) => canonicalPortfolioCik(value))
    .filter((value: string | null): value is string => Boolean(value));
  const ciks = new Set<string>(normalizedCiks);
  const inScope = (value: unknown) => {
    const cik = canonicalPortfolioCik(value as string);
    return Boolean(cik && ciks.has(cik));
  };
  return {
    report: {
      ...report,
      concentration: {
        ...report.concentration,
        issuers: (report?.concentration?.issuers || []).filter((row: any) =>
          inScope(row.cik),
        ),
      },
    },
    companies: companies.filter((company: any) => inScope(company.cik)),
    catalogReport: {
      ...catalogReport,
      concentration: {
        ...catalogReport?.concentration,
        issuers: (catalogReport?.concentration?.issuers || []).filter(
          (row: any) => inScope(row.cik),
        ),
      },
      metrics: (catalogReport?.metrics || []).map((metric: any) => ({
        ...metric,
        observations: (metric.observations || []).filter((row: any) =>
          inScope(row.cik),
        ),
        eligibleCiks: (metric.eligibleCiks || []).filter(inScope),
        missingCiks: (metric.missingCiks || []).filter(inScope),
        notApplicableCiks: (metric.notApplicableCiks || []).filter(inScope),
      })),
    },
    companyCount: ciks.size,
  };
}

function SectorPicker({
  profile,
  sector,
  lens,
  onSectorChange,
  onLensChange,
}: {
  profile: any;
  sector: string;
  lens: string;
  onSectorChange: (sector: string) => void;
  onLensChange: (lens: string) => void;
}) {
  const activeCohorts = profile.lensGroups.filter(
    (group: any) => group.companyCount > 0,
  );
  const sectorCount = profile.sectorGroups.filter(
    (group: any) =>
      group.id !== FINANCIAL_PROFILE_ALL_SECTORS &&
      group.id !== FINANCIAL_PROFILE_UNCOVERED_SECTOR,
  ).length;
  const uncovered = profile.sectorGroups.find(
    (group: any) => group.id === FINANCIAL_PROFILE_UNCOVERED_SECTOR,
  );
  const source = profile.sectorDefinition;
  const sourceProvider =
    source?.sectorSourceProviders?.length === 1
      ? `${source.sectorSourceProviders[0]} `
      : "";
  const sourceNote = source?.sectorSourceAsOf
    ? `${sourceProvider}fund-reported classification as of ${dateLabel(source.sectorSourceAsOf)}`
    : source?.sectorSourceLatestAsOf
      ? `${sourceProvider}fund-reported sources through ${dateLabel(source.sectorSourceLatestAsOf)} · ${source.sectorSourceCompanyCount} of ${source.companyCount} companies`
      : "";
  return (
    <section className={s.lensPanel} aria-labelledby="financial-lens-title">
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>Portfolio sectors</p>
          <h3 id="financial-lens-title">Choose a sector</h3>
        </div>
        <span>
          {sectorCount} sectors available
          {uncovered?.companyCount
            ? ` · ${uncovered.companyCount} without sector coverage`
            : ""}
          {sourceNote ? ` · ${sourceNote}` : ""}
        </span>
      </div>
      <div className={s.lensGrid}>
        {profile.sectorGroups.map((group: any) => (
          <button
            type="button"
            key={group.id}
            aria-pressed={sector === group.id}
            disabled={group.companyCount === 0}
            onClick={() => onSectorChange(group.id)}
          >
            <span>
              <Layers3 size={16} aria-hidden="true" />
              {group.label}
            </span>
            <strong>
              {profile.weighted
                ? percent(group.knownWeightPct)
                : group.companyCount}
            </strong>
            <small>
              {profile.weighted
                ? `${companyCountLabel(group.companyCount)}${group.lensCount > 1 ? ` · ${group.lensCount} sets` : ""}`
                : `${group.companyCount === 1 ? "company" : "companies"}${group.lensCount > 1 ? ` · ${group.lensCount} sets` : ""}`}
            </small>
          </button>
        ))}
      </div>
      <div className={s.cohortBar}>
        <div>
          <Building2 size={17} aria-hidden="true" />
          <p>
            <span>
              {profile.hasCompatibleCohort
                ? "Accounting-compatible measure set"
                : "Financial evidence status"}
            </span>
            <strong>
              {profile.hasCompatibleCohort
                ? profile.lensDefinition?.label || lens
                : "Accounting model not classified"}
            </strong>
            <small>
              {profile.hasCompatibleCohort
                ? `${profile.companyCount} of ${profile.sectorCompanyCount} companies in ${profile.sectorDefinition?.label || "the selected sector"}`
                : `${companyCountLabel(profile.sectorCompanyCount)} remain outside comparable ratio summaries`}
            </small>
          </p>
        </div>
        {!profile.hasCompatibleCohort ? (
          <span>A compatible financial measure set is not available yet.</span>
        ) : activeCohorts.length > 1 ? (
          <label>
            Financial measure set
            <select value={lens} onChange={(event) => onLensChange(event.target.value)}>
              {activeCohorts.map((group: any) => (
                <option value={group.id} key={group.id}>
                  {group.label} ({group.companyCount})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span>Financial ratios stay comparable within this sector.</span>
        )}
      </div>
    </section>
  );
}

function CompatibleCohortUnavailable({ profile }: { profile: any }) {
  return (
    <section className={s.card} role="status">
      <p className={s.eyebrow}>Financial measures unavailable</p>
      <h3>No comparable accounting cohort is classified for this sector.</h3>
      <p className={s.muted}>
        {companyCountLabel(profile.sectorCompanyCount)} remain visible in sector
        coverage, but ratio summaries and comparisons stay unavailable until
        their financial statement model is confirmed.
      </p>
    </section>
  );
}

function MetricRail({ metric }: { metric: any }) {
  if (!finite(metric?.p10) || !finite(metric?.p90)) return <span className={s.emptyRail} />;
  const spread = metric.p90 - metric.p10 || 1;
  const place = (value: number) => `${clamp(((value - metric.p10) / spread) * 100, 0, 100)}%`;
  return (
    <span className={s.metricRail} aria-hidden="true">
      <i
        className={s.iqr}
        style={{ left: place(metric.p25), right: `${100 - Number.parseFloat(place(metric.p75))}%` }}
      />
      <i className={s.median} style={{ left: place(metric.median) }} />
    </span>
  );
}

function PillarCard({
  pillar,
  weighted,
  onOpen,
}: {
  pillar: any;
  weighted: boolean;
  onOpen: (metricId: string) => void;
}) {
  const metric = pillar.metric;
  const headline = weighted && finite(metric?.weightedMedian)
    ? metric.weightedMedian
    : metric?.median;
  return (
    <button
      type="button"
      className={s.pillar}
      onClick={() => metric && onOpen(metric.id)}
      disabled={!metric?.measuredCompanyCount}
    >
      <span className={s.pillarLabel}>{pillar.label}</span>
      <strong>{valueLabel(headline, metric?.unit || "")}</strong>
      <small>
        {weighted && finite(metric?.weightedMedian)
          ? "Allocation-weighted median"
          : "Company median"}
      </small>
      <MetricRail metric={metric} />
      <span className={s.pillarMeta}>
        {metric?.measuredCompanyCount || 0} measured
        {weighted
          ? ` · ${percent(metric?.coveredWeightPct)} allocation`
          : ` of ${metric?.eligibleCompanyCount || 0} eligible companies`}
      </span>
      <span className={s.pillarAction}>Explore measure <ArrowUpRight size={13} aria-hidden="true" /></span>
    </button>
  );
}

function AllocationFootprints({ profile }: { profile: any }) {
  const screens = profile.breadthScreens.filter((entry: any) => entry.applicable);
  return (
    <section className={s.card} aria-labelledby="footprints-title">
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>{profile.weighted ? "Allocation footprints" : "Company footprints"}</p>
          <h4 id="footprints-title">
            {profile.weighted
              ? "What kind of financials does the allocation own?"
              : "What kind of financials are represented?"}
          </h4>
        </div>
        <span>Factual tests, not a composite score</span>
      </div>
      <div className={s.footprintGrid}>
        {screens.map((entry: any) => {
          const share = finite(entry.shareOfMeasuredWeightPct)
            ? entry.shareOfMeasuredWeightPct
            : entry.shareOfMeasuredCompaniesPct;
          return (
            <article key={entry.id}>
              <div>
                <span>{entry.label}</span>
                <strong>{percent(share)}</strong>
              </div>
              <span className={s.progress} aria-hidden="true">
                <i style={{ width: `${clamp(share || 0, 0, 100)}%` }} />
              </span>
              <small>
                {entry.matchedCompanyCount} of {entry.measuredCompanyCount} measured companies
                {finite(entry.matchedWeightPct) ? ` · ${percent(entry.matchedWeightPct)} original allocation` : ""}
              </small>
              {entry.missingCompanyCount > 0 && (
                <em>{entry.missingCompanyCount} eligible companies lack this measure</em>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FingerprintChart({
  profile,
  onInspectCompany,
}: {
  profile: any;
  onInspectCompany: Props["onInspectCompany"];
}) {
  const fingerprint = profile.corporateFingerprint;
  const [selectedCik, setSelectedCik] = useState("");
  const selectorId = useId();
  if (!fingerprint?.applicable)
    return (
      <section className={s.card}>
        <p className={s.eyebrow}>Financial fingerprint</p>
        <h4>Growth and margin map</h4>
        <p className={s.muted}>This paired view is designed for operating-company statements. Choose a sector and measure set that contains operating companies to explore it.</p>
      </section>
    );
  if (!fingerprint.points.length)
    return (
      <section className={s.card}>
        <p className={s.eyebrow}>Financial fingerprint</p>
        <h4>No aligned growth and margin evidence</h4>
        <p className={s.muted}>Both measures need the same full reporting period. Missing values are not estimated.</p>
      </section>
    );

  const width = 780;
  const height = 430;
  const left = 72;
  const right = 754;
  const top = 28;
  const bottom = 354;
  const xMetric = profile.metricSummaries.find((metric: any) => metric.id === fingerprint.axes.x.metricId);
  const yMetric = profile.metricSummaries.find((metric: any) => metric.id === fingerprint.axes.y.metricId);
  const xMin = Math.min(xMetric?.p10 ?? -1, 0);
  const xMax = Math.max(xMetric?.p90 ?? 1, 0);
  const yMin = Math.min(yMetric?.p10 ?? -1, 0);
  const yMax = Math.max(yMetric?.p90 ?? 1, 0);
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const px = (value: number) => left + ((clamp(value, xMin, xMax) - xMin) / xSpan) * (right - left);
  const py = (value: number) => bottom - ((clamp(value, yMin, yMax) - yMin) / ySpan) * (bottom - top);
  const zeroX = px(0);
  const zeroY = py(0);
  const selected = fingerprint.points.find((point: any) => point.cik === selectedCik);

  return (
    <section
      className={[s.card, s.fingerprint].filter(Boolean).join(" ") || undefined}
      aria-labelledby="fingerprint-title"
    >
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>Financial fingerprint</p>
          <h4 id="fingerprint-title">Growth × profitability, holding by holding</h4>
        </div>
        <span>
          {fingerprint.pairedCompanyCount} aligned companies
          {profile.weighted
            ? ` · ${percent(fingerprint.knownWeightPct)} allocation`
            : ` · ${percent((fingerprint.pairedCompanyCount / Math.max(1, fingerprint.eligibleCompanyCount)) * 100)} of eligible companies`}
        </span>
      </div>
      <p className={s.muted}>
        {profile.weighted
          ? "Bubble area reflects known holding weight. "
          : "Each company has equal bubble area because no allocation was supplied. "}
        Teal marks positive free cash flow, coral marks negative free cash flow, and gray means zero or unavailable. The view is clipped to the 10th–90th percentile rails so extreme values do not flatten the picture.
      </p>
      <label className={s.companySelector} htmlFor={selectorId}>
        Inspect a company in the map
        <select
          id={selectorId}
          value={selectedCik}
          onChange={(event) => setSelectedCik(event.target.value)}
        >
          <option value="">Choose an aligned company</option>
          {[...fingerprint.points]
            .sort((a: any, b: any) =>
              String(a.ticker || a.name).localeCompare(String(b.ticker || b.name)),
            )
            .map((point: any) => (
              <option key={point.cik} value={point.cik}>
                {point.ticker || point.name} · {valueLabel(point.x, "%")} growth · {valueLabel(point.y, "%")} margin · {freeCashFlowDirection(point)}
              </option>
            ))}
        </select>
      </label>
      <div className={s.chartShell}>
        <svg viewBox={`0 0 ${width} ${height}`} className={s.chart} role="group" aria-labelledby="fingerprint-svg-title fingerprint-svg-desc">
          <title id="fingerprint-svg-title">Portfolio revenue growth and net margin fingerprint</title>
          <desc id="fingerprint-svg-desc">Each bubble is one operating company with revenue growth and net margin from the same reporting period. Use the company selector before this chart to inspect an exact observation. {profile.weighted ? "Bubble size represents known portfolio allocation." : "Bubbles have equal size because no allocation was supplied."} Color represents free cash flow direction.</desc>
          <rect x={left} y={top} width={zeroX - left} height={zeroY - top} className={s.quadrantSoft} />
          <rect x={zeroX} y={top} width={right - zeroX} height={zeroY - top} className={s.quadrantStrong} />
          <rect x={left} y={zeroY} width={zeroX - left} height={bottom - zeroY} className={s.quadrantWeak} />
          <rect x={zeroX} y={zeroY} width={right - zeroX} height={bottom - zeroY} className={s.quadrantMixed} />
          {[0, 0.25, 0.5, 0.75, 1].map((part) => (
            <g key={part}>
              <line x1={left} x2={right} y1={top + part * (bottom - top)} y2={top + part * (bottom - top)} className={s.gridLine} />
              <line x1={left + part * (right - left)} x2={left + part * (right - left)} y1={top} y2={bottom} className={s.gridLine} />
            </g>
          ))}
          <line x1={zeroX} x2={zeroX} y1={top} y2={bottom} className={s.zeroLine} />
          <line x1={left} x2={right} y1={zeroY} y2={zeroY} className={s.zeroLine} />
          <text x={right - 10} y={top + 19} textAnchor="end" className={s.quadrantLabel}>Growing + profitable</text>
          <text x={left + 10} y={top + 19} className={s.quadrantLabel}>Contracting + profitable</text>
          <text x={right - 10} y={bottom - 12} textAnchor="end" className={s.quadrantLabel}>Growing + loss-making</text>
          <text x={left + 10} y={bottom - 12} className={s.quadrantLabel}>Contracting + loss-making</text>
          <text x={(left + right) / 2} y={height - 23} textAnchor="middle" className={s.axisTitle}>{fingerprint.axes.x.label}</text>
          <text transform={`translate(20 ${(top + bottom) / 2}) rotate(-90)`} textAnchor="middle" className={s.axisTitle}>{fingerprint.axes.y.label}</text>
          <text x={left} y={bottom + 20} className={s.tick}>{valueLabel(xMin, fingerprint.axes.x.unit)}</text>
          <text x={right} y={bottom + 20} textAnchor="end" className={s.tick}>{valueLabel(xMax, fingerprint.axes.x.unit)}</text>
          <text x={left - 9} y={top + 4} textAnchor="end" className={s.tick}>{valueLabel(yMax, fingerprint.axes.y.unit)}</text>
          <text x={left - 9} y={bottom} textAnchor="end" className={s.tick}>{valueLabel(yMin, fingerprint.axes.y.unit)}</text>
          {fingerprint.points.map((point: any) => {
            const radius = finite(point.weightPct) ? clamp(4 + Math.sqrt(point.weightPct) * 3.2, 5, 14) : 5;
            return (
              <circle
                key={point.cik}
                cx={px(point.x)}
                cy={py(point.y)}
                r={point.cik === selectedCik ? radius + 2 : radius}
                aria-hidden="true"
                data-selected={point.cik === selectedCik}
                data-tone={point.tone}
                className={s.bubble}
                onClick={() => setSelectedCik(point.cik)}
              >
                <title>{`${point.ticker || point.name}: ${valueLabel(point.x, "%")} growth, ${valueLabel(point.y, "%")} net margin, ${freeCashFlowDirection(point)}`}</title>
              </circle>
            );
          })}
        </svg>
      </div>
      <div className={s.chartFooter}>
        <div className={s.legend} aria-label="Free cash flow legend">
          <span><i data-tone="positive" /> Positive FCF</span>
          <span><i data-tone="negative" /> Negative FCF</span>
          <span><i data-tone="neutral" /> Zero / unavailable FCF</span>
        </div>
        <span>{fingerprint.periodMismatchCompanyCount} period mismatches excluded · {fingerprint.missingMetricCompanyCount} without both axes</span>
      </div>
      {selected && (
        <div className={s.selectedCompany} role="status">
          <div>
            <strong>{selected.ticker || selected.name}</strong>
            <span>{selected.name} · {selected.sector || "Sector unavailable"}</span>
          </div>
          <dl>
            <div><dt>Revenue growth</dt><dd>{valueLabel(selected.x, "%")}</dd></div>
            <div><dt>Net margin</dt><dd>{valueLabel(selected.y, "%")}</dd></div>
            <div><dt>Free cash flow direction</dt><dd>{freeCashFlowDirection(selected, true)}</dd></div>
            {profile.weighted ? (
              <div><dt>Known allocation</dt><dd>{percent(selected.weightPct)}</dd></div>
            ) : (
              <div><dt>Share of mapped companies</dt><dd>{percent(100 / fingerprint.pairedCompanyCount)}</dd></div>
            )}
          </dl>
          <button type="button" onClick={() => onInspectCompany(selected.rowId || profile.metricSummaries.find((metric: any) => metric.id === "revenueGrowth")?.observations.find((row: any) => row.cik === selected.cik)?.rowId)}>
            Inspect evidence <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </section>
  );
}

function AttentionList({
  profile,
  onInspectCompany,
}: {
  profile: any;
  onInspectCompany: Props["onInspectCompany"];
}) {
  const choices = [...profile.attentionConditions]
    .filter((entry: any) => entry.applicable && entry.measuredCompanyCount > 0)
    .sort((a: any, b: any) =>
      profile.weighted
        ? (b.matchedWeightPct || 0) - (a.matchedWeightPct || 0)
        : (b.shareOfMeasuredCompaniesPct || 0) -
          (a.shareOfMeasuredCompaniesPct || 0),
    );
  const [selectedId, setSelectedId] = useState(choices[0]?.id || "");
  const activeId = choices.some((entry: any) => entry.id === selectedId)
    ? selectedId
    : choices[0]?.id || "";
  const selected = choices.find((entry: any) => entry.id === activeId);
  return (
    <section className={s.card} aria-labelledby="attention-title">
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>Attention map</p>
          <h4 id="attention-title">Where a closer reading may pay off</h4>
        </div>
        <span>
          Ranked by {profile.weighted ? "matched original allocation" : "share of measured companies"}
        </span>
      </div>
      <p className={s.muted}>These are mechanical conditions from reported facts—not risk ratings or predictions. Select one to see the holdings and evidence behind it.</p>
      {choices.length ? (
        <>
          <div className={s.attentionGrid}>
            {choices.map((entry: any) => (
              <button
                type="button"
                key={entry.id}
                aria-pressed={activeId === entry.id}
                onClick={() => setSelectedId(entry.id)}
              >
                <span>{entry.label}</span>
                <strong>{percent(profile.weighted ? entry.matchedWeightPct : entry.shareOfMeasuredCompaniesPct)}</strong>
                <small>{entry.matchedCompanyCount} matched · {entry.measuredCompanyCount} measured</small>
                {entry.limitedEvidence && <em>Limited evidence</em>}
              </button>
            ))}
          </div>
          {selected && (
            <div className={s.attentionDetail}>
              <div>
                <strong>{selected.label}</strong>
                <p>{selected.description}</p>
                <small>
                  {profile.weighted
                    ? `${percent(selected.measuredWeightPct)} allocation measured`
                    : `${selected.measuredCompanyCount} of ${selected.eligibleCompanyCount} eligible companies measured`}
                  {` · ${selected.missingCompanyCount} eligible companies unavailable`}
                </small>
              </div>
              <div className={s.companyChips}>
                {selected.rows.slice(0, 10).map((row: any) => (
                  <button type="button" key={row.cik} onClick={() => onInspectCompany(row.rowId)}>
                    {row.ticker || row.name}
                    <span>{valueLabel(row.value, selected.unit)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className={s.empty}>No attention conditions can be assessed for this sector and financial measure set with the current evidence.</p>
      )}
    </section>
  );
}

function MetricAtlas({
  profile,
  onOpen,
}: {
  profile: any;
  onOpen: (metricId: string) => void;
}) {
  return (
    <section className={s.card} aria-labelledby="atlas-title">
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>Measure atlas</p>
          <h4 id="atlas-title">A broader financial profile, at a glance</h4>
        </div>
        <span>{profile.metricCount} supported ratio measures</span>
      </div>
      <div className={s.atlasGroups}>
        {profile.categories.filter((category: any) => category.metrics.some((metric: any) => metric.measuredCompanyCount > 0)).map((category: any) => (
          <section key={category.id}>
            <div className={s.atlasHeading}>
              <div><strong>{category.label}</strong><span>{category.description}</span></div>
              <small>{category.metrics.filter((metric: any) => metric.measuredCompanyCount > 0).length} measures</small>
            </div>
            <div className={s.atlasMetrics}>
              {category.metrics.filter((metric: any) => metric.measuredCompanyCount > 0).slice(0, 6).map((metric: any) => (
                <button type="button" key={metric.id} onClick={() => onOpen(metric.id)}>
                  <span>{metric.label}</span>
                  <strong>{valueLabel(metric.weightedMedian ?? metric.median, metric.unit)}</strong>
                  <MetricRail metric={metric} />
                  <small>
                    {metric.measuredCompanyCount}/{metric.eligibleCompanyCount} companies
                    {profile.weighted
                      ? ` · ${percent(metric.coveredWeightPct)} allocation`
                      : ` · ${percent((metric.measuredCompanyCount / Math.max(1, metric.eligibleCompanyCount)) * 100)} measured`}
                  </small>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function Overview({
  profile,
  catalogReport,
  capturedAt,
  onOpenMetric,
  onInspectCompany,
}: {
  profile: any;
  catalogReport: any;
  capturedAt?: string | null;
  onOpenMetric: (id: string) => void;
  onInspectCompany: Props["onInspectCompany"];
}) {
  const periodRange = profile.periodRange;
  return (
    <div className={s.overview}>
      <section className={s.hero}>
        <div className={s.heroTop}>
          <div>
            <p className={s.eyebrow}>The businesses behind the portfolio</p>
            <h3>See the financial shape behind the holdings.</h3>
            <p>Understand the portfolio’s growth, profitability, cash generation and balance-sheet character—then open the exact company and SEC evidence behind every measure.</p>
          </div>
          <span className={s.liveBadge}><Activity size={14} aria-hidden="true" /> SEC-backed snapshot</span>
        </div>
        <div className={s.heroStats}>
          <div><span>Companies with financial evidence</span><strong>{profile.measuredCompanyCount}<em> / {profile.companyCount}</em></strong><small>{profile.sectorDefinition?.label} · {profile.hasCompatibleCohort ? profile.lensDefinition?.label : "no compatible measure set"}</small></div>
          <div>
            <span>{profile.weighted ? "Known allocation represented" : "Companies represented"}</span>
            <strong>
              {profile.weighted
                ? percent(profile.measuredWeightPct)
                : <>{profile.measuredCompanyCount}<em> / {profile.companyCount}</em></>}
            </strong>
            <small>
              {profile.weighted
                ? "Original portfolio denominator"
                : `${percent((profile.measuredCompanyCount / Math.max(1, profile.companyCount)) * 100)} of companies in this measure set`}
            </small>
          </div>
          <div><span>Supported measures</span><strong>{profile.metricCount}</strong><small>{catalogReport.metrics.length} catalog measures across all models</small></div>
          <div><span>Reporting ends</span><strong className={s.dateStat}>{dateLabel(periodRange.earliestEnd)}<em> → </em>{dateLabel(periodRange.latestEnd)}</strong><small>{periodRange.periodCount} exact full-period cohorts · captured {capturedAt ? dateLabel(capturedAt.slice(0, 10)) : "date unavailable"}</small></div>
        </div>
      </section>
      {finite(profile.exclusions?.unknownLensCompanyCount) &&
        profile.exclusions.unknownLensCompanyCount > 0 && (
          <aside className={s.scopeNotice} aria-label="Unclassified business models">
            <Building2 size={17} aria-hidden="true" />
            <p>
              <strong>
                {profile.exclusions.unknownLensCompanyCount}{" "}
                {profile.exclusions.unknownLensCompanyCount === 1
                  ? "company needs"
                  : "companies need"}{" "}
                a confirmed business model.
              </strong>{" "}
              They remain in portfolio coverage but stay outside model-specific
              financial summaries so unlike accounting models are never blended.
              {profile.weighted &&
              finite(profile.exclusions.unknownLensKnownWeightPct)
                ? ` They represent ${percent(profile.exclusions.unknownLensKnownWeightPct)} of original allocation.`
                : ""}
            </p>
          </aside>
        )}
      <div className={s.pillarGrid}>
        {profile.featuredPillars.map((pillar: any) => (
          <PillarCard key={pillar.id} pillar={pillar} weighted={catalogReport.weighted} onOpen={onOpenMetric} />
        ))}
      </div>
      <AllocationFootprints profile={profile} />
      <FingerprintChart profile={profile} onInspectCompany={onInspectCompany} />
      <MetricAtlas profile={profile} onOpen={onOpenMetric} />
      <AttentionList profile={profile} onInspectCompany={onInspectCompany} />
    </div>
  );
}

export function MeasureExplorer({
  profile,
  requestedMetric,
  onRequestedMetric,
  onInspectCompany,
}: {
  profile: any;
  requestedMetric: string;
  onRequestedMetric: (id: string) => void;
  onInspectCompany: Props["onInspectCompany"];
}) {
  const available = profile.metricSummaries.filter((metric: any) => metric.measuredCompanyCount > 0);
  const metric = available.find((entry: any) => entry.id === requestedMetric) || available[0];
  const categoryLabel =
    profile.categories.find((entry: any) => entry.id === metric?.category)
      ?.label || metric?.category;
  const [selectedBin, setSelectedBin] = useState<number | null>(null);
  const [limit, setLimit] = useState(20);
  if (!metric) return <p className={s.empty}>No ratio measures have supported evidence for this sector and financial measure set.</p>;
  const histogram = metric.histogram?.bins || [];
  const maxCount = Math.max(1, ...histogram.map((bin: any) => bin.count));
  const rows = selectedBin === null ? metric.observations : histogram[selectedBin]?.rows || [];
  return (
    <section className={s.measureExplorer} aria-labelledby="measure-explorer-title">
      <div className={s.measureHeading}>
        <div>
          <p className={s.eyebrow}>Company distributions{profile.weighted ? " with allocation context" : ""}</p>
          <h3 id="measure-explorer-title">Explore every supported financial measure.</h3>
          <p>
            Each company contributes one observation. {profile.weighted
              ? "Allocation-weighted statistics reweight only measured holdings and never pretend the holdings form a consolidated company."
              : "Company statistics give every observed issuer equal influence; no portfolio exposure is inferred."}
          </p>
        </div>
        <label>
          Financial measure
          <select value={metric.id} onChange={(event) => { onRequestedMetric(event.target.value); setSelectedBin(null); setLimit(20); }}>
            {profile.categories.map((category: any) => (
              <optgroup label={category.label} key={category.id}>
                {category.metrics.filter((entry: any) => entry.measuredCompanyCount > 0).map((entry: any) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <section className={s.measureCard}>
        <div className={s.measureTitle}>
          <div><span>{categoryLabel}</span><h4>{metric.label}</h4><p>{metric.formula || "Reported or evidence-backed calculated company measure."}</p></div>
          {metric.periods.length > 1 && <span className={s.coverageBadge}>{metric.periods.length} reporting cohorts</span>}
        </div>
        <div className={s.measureStats}>
          <div>
            <span>{profile.weighted ? "Allocation-weighted median" : "Company average"}</span>
            <strong>{valueLabel(profile.weighted ? metric.weightedMedian : metric.unweightedMean, metric.unit)}</strong>
            <small>{profile.weighted ? `${metric.weightedCompanyCount} companies with positive known weight` : `${metric.measuredCompanyCount} equally weighted company observations`}</small>
          </div>
          <div><span>Company median</span><strong>{valueLabel(metric.median, metric.unit)}</strong><small>Unweighted issuer midpoint</small></div>
          <div><span>Middle 50%</span><strong>{finite(metric.p25) && finite(metric.p75) ? `${valueLabel(metric.p25, metric.unit)} – ${valueLabel(metric.p75, metric.unit)}` : "Unavailable"}</strong><small>25th to 75th percentile</small></div>
          <div><span>Evidence coverage</span><strong>{metric.measuredCompanyCount}<em> / {metric.eligibleCompanyCount}</em></strong><small>{profile.weighted ? `${percent(metric.coveredWeightPct)} original allocation · ` : ""}{metric.missingCompanyCount} missing · {metric.notApplicableCompanyCount} N/A</small></div>
        </div>
        {finite(metric.weightedMean) && finite(metric.weightedMedian) && Math.abs(metric.weightedMean - metric.weightedMedian) > Math.max(10, Math.abs(metric.weightedMedian) * 2) && (
          <p className={s.outlierNote}><CircleGauge size={16} aria-hidden="true" /> The weighted mean is {valueLabel(metric.weightedMean, metric.unit)}, far from the weighted median. Extreme values can distort the mean, so the median leads this view.</p>
        )}
        <div className={s.histogram} aria-label={`${metric.label} company distribution`}>
          {histogram.map((bin: any, index: number) => (
            <button
              type="button"
              key={`${bin.index}-${bin.min}-${bin.max}`}
              aria-pressed={selectedBin === index}
              aria-label={`${bin.count} companies from ${valueLabel(bin.min, metric.unit)} to ${valueLabel(bin.max, metric.unit)}`}
              onClick={() => { setSelectedBin(selectedBin === index ? null : index); setLimit(20); }}
            >
              <strong>{bin.count}</strong>
              <span><i style={{ height: `${Math.max(3, (bin.count / maxCount) * 100)}%` }} /></span>
              <small>{valueLabel(bin.min, metric.unit)}<br />to {valueLabel(bin.max, metric.unit)}</small>
            </button>
          ))}
        </div>
      </section>
      <section className={s.observations}>
        <div className={s.sectionHeading}>
          <div><h4>{selectedBin === null ? "Measured companies" : "Companies in selected range"}</h4><span>{rows.length} observations</span></div>
          {selectedBin !== null && <button type="button" onClick={() => setSelectedBin(null)}>Clear range</button>}
        </div>
        <div className={s.tableWrap} role="region" aria-label={`${metric.label} company evidence`} tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Company</th><th scope="col">{metric.label}</th><th scope="col">{profile.weighted ? "Known allocation" : "Share of measured companies"}</th><th scope="col">Reporting end</th><th scope="col">Evidence</th></tr></thead>
            <tbody>
              {rows.slice(0, limit).map((row: any) => (
                <tr key={row.cik}>
                  <th scope="row"><button type="button" onClick={() => onInspectCompany(row.rowId)}>{row.ticker || row.name}</button><span>{row.name}</span></th>
                  <td>{valueLabel(row.value, metric.unit)}</td>
                  <td>{profile.weighted ? percent(row.weightPct) : percent(100 / metric.measuredCompanyCount)}</td>
                  <td>{dateLabel(row.periodEnd)}</td>
                  <td>{row.sourceUrl ? <a href={row.sourceUrl} target="_blank" rel="noopener noreferrer">SEC filing <ArrowUpRight size={13} aria-hidden="true" /></a> : <button type="button" onClick={() => onInspectCompany(row.rowId)}>Inspect evidence</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={s.tableFooter}>
          <span>Showing {Math.min(limit, rows.length)} of {rows.length}. Zero and negative values are retained; missing values are not converted to zero.</span>
          {limit < rows.length && <button type="button" onClick={() => setLimit((value) => value + 20)}>Show next 20</button>}
        </div>
      </section>
    </section>
  );
}

export function FinancialHealth({
  profile,
  report,
  companies,
  capturedAt,
  onInspectCompany,
  onDisclosure,
}: {
  profile: any;
  report: any;
  companies: any[];
  capturedAt?: string | null;
  onInspectCompany: Props["onInspectCompany"];
  onDisclosure?: Props["onDisclosure"];
}) {
  const [healthView, setHealthView] = useState<HealthView>("weighted");
  const corporate =
    profile.hasCompatibleCohort && profile.lens === "corporate";
  const statementCompatible =
    profile.hasCompatibleCohort &&
    ["corporate", "banking"].includes(profile.lens);
  return (
    <div className={s.health}>
      <div className={s.toolIntro}>
        <div>
          <p className={s.eyebrow}>Pressure-test the financial character</p>
          <h3>Follow profitability, liquidity, leverage and cash.</h3>
        </div>
        <p>
          Use comparable cohorts and exact periods. These tools surface what to
          investigate; they do not manufacture a portfolio-level balance sheet.
        </p>
      </div>
      <div className={s.healthScope} role="status">
        <Building2 size={17} aria-hidden="true" />
        <p>
          <strong>
            {profile.sectorDefinition?.label} · {profile.hasCompatibleCohort
              ? `${profile.lensDefinition?.label || profile.lens} only`
              : "no compatible financial measure set"}
          </strong>
          <span>
            {profile.hasCompatibleCohort
              ? `${companyCountLabel(profile.companyCount)} in this financial-health cohort. ${profile.sector === FINANCIAL_PROFILE_ALL_SECTORS ? "Incompatible accounting models" : "Other sectors and incompatible accounting models"} are excluded, not blended.`
              : `${companyCountLabel(profile.sectorCompanyCount)} are not assigned to a comparable accounting model, so ratio-based financial health remains unavailable.`}
          </span>
        </p>
      </div>
      <nav className={s.subnav} aria-label="Financial health tools">
        <button
          type="button"
          aria-pressed={healthView === "weighted"}
          onClick={() => setHealthView("weighted")}
        >
          <CircleGauge size={16} aria-hidden="true" /> Ratio summaries
        </button>
        <button
          type="button"
          aria-pressed={healthView === "buffers"}
          disabled={!corporate}
          title={corporate ? undefined : "Designed for operating companies"}
          onClick={() => setHealthView("buffers")}
        >
          <Banknote size={16} aria-hidden="true" /> Cash &amp; debt
        </button>
        <button
          type="button"
          aria-pressed={healthView === "overlap"}
          disabled={!corporate}
          title={corporate ? undefined : "Designed for operating companies"}
          onClick={() => setHealthView("overlap")}
        >
          <BadgeDollarSign size={16} aria-hidden="true" /> Condition builder
        </button>
        <button
          type="button"
          aria-pressed={healthView === "statements"}
          disabled={!statementCompatible}
          title={
            statementCompatible
              ? undefined
              : "Available for operating companies and banks"
          }
          onClick={() => setHealthView("statements")}
        >
          <Activity size={16} aria-hidden="true" /> Statement connections
        </button>
      </nav>
      {!corporate && (
        <p className={s.healthAvailability}>
          Cash-and-debt and condition diagnostics remain disabled because their
          definitions are specific to operating-company statements.
        </p>
      )}
      {healthView !== "statements" ? (
        <PortfolioInsightTools
          report={report}
          companies={companies}
          view={healthView}
          onInspect={onInspectCompany}
        />
      ) : (
        <div className={s.connectedTools}>
          <PortfolioConnections
            report={report}
            companies={companies}
            onInspect={onInspectCompany}
            onDisclosure={onDisclosure}
          />
          {corporate && (
            <CashEarnings
              report={report}
              companies={companies}
              capturedAt={capturedAt}
              onInspect={onInspectCompany}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function PortfolioFinancialProfile({
  report,
  catalogReport,
  companies,
  capturedAt,
  onInspectCompany,
  onDisclosure,
  financialRequest,
}: Props) {
  const titleId = useId();
  const handledFinancialRequestNonce = useRef<number | null>(null);
  const [view, setView] = useState<View>("overview");
  const [sector, setSector] = useState<string>(FINANCIAL_PROFILE_ALL_SECTORS);
  const [lens, setLens] = useState<string>(
    () => buildPortfolioFinancialProfile(catalogReport).lens,
  );
  const [metricId, setMetricId] = useState("netMargin");
  const [measureView, setMeasureView] = useState<"explore" | "peers">("explore");
  const profile = useMemo(
    () => buildPortfolioFinancialProfile(catalogReport, { sector, lens }),
    [catalogReport, sector, lens],
  );
  const profileRevision = useMemo(
    () => financialProfileRevision(catalogReport, capturedAt),
    [catalogReport, capturedAt],
  );
  const healthScope = useMemo(
    () =>
      buildFinancialHealthScope(
        report,
        catalogReport,
        companies,
        profile.lens,
        profile.sector,
        profile.companyCiks,
      ),
    [
      report,
      catalogReport,
      companies,
      profile.lens,
      profile.sector,
      profile.companyCiks,
    ],
  );
  useEffect(() => {
    if (!financialRequest?.metricId) return;
    if (handledFinancialRequestNonce.current === financialRequest.nonce) return;
    handledFinancialRequestNonce.current = financialRequest.nonce;
    setSector(FINANCIAL_PROFILE_ALL_SECTORS);
    setLens((current) =>
      resolveFinancialProfileMetricLens(
        catalogReport,
        financialRequest.metricId,
        current,
      ) || current,
    );
    setMetricId(financialRequest.metricId);
    setMeasureView("explore");
    setView("measures");
  }, [catalogReport, financialRequest]);
  const changeLens = (next: string) => {
    setLens(next);
    const nextProfile = buildPortfolioFinancialProfile(catalogReport, { sector: profile.sector, lens: next });
    setMetricId(nextProfile.featuredPillars.find((pillar: any) => pillar.metric?.measuredCompanyCount)?.metricId || nextProfile.metricSummaries.find((metric: any) => metric.measuredCompanyCount)?.id || "");
  };
  const changeSector = (next: string) => {
    const nextProfile = buildPortfolioFinancialProfile(catalogReport, { sector: next });
    setSector(nextProfile.sector);
    setLens(nextProfile.lens);
    setMetricId(nextProfile.featuredPillars.find((pillar: any) => pillar.metric?.measuredCompanyCount)?.metricId || nextProfile.metricSummaries.find((metric: any) => metric.measuredCompanyCount)?.id || "");
  };
  const openMetric = (id: string) => {
    setMetricId(id);
    setMeasureView("explore");
    setView("measures");
  };
  return (
    <section className={s.root} aria-labelledby={titleId}>
      <h2 id={titleId} className={s.srOnly}>Portfolio financial profile</h2>
      <nav className={s.nav} aria-label="Financial profile sections">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>
            <Icon size={17} aria-hidden="true" /> {label}
          </button>
        ))}
      </nav>
      <SectorPicker profile={profile} sector={profile.sector} lens={profile.lens} onSectorChange={changeSector} onLensChange={changeLens} />
      {view === "overview" && <Overview key={`overview:${profile.sector}:${profile.lens}:${profileRevision}`} profile={profile} catalogReport={catalogReport} capturedAt={capturedAt} onOpenMetric={openMetric} onInspectCompany={onInspectCompany} />}
      {view !== "overview" && !profile.hasCompatibleCohort ? (
        <CompatibleCohortUnavailable profile={profile} />
      ) : null}
      {view === "measures" && profile.hasCompatibleCohort && (
        <>
          <nav className={s.subnav} aria-label="Financial measure tools">
            <button type="button" aria-pressed={measureView === "explore"} onClick={() => setMeasureView("explore")}><BarChart3 size={16} aria-hidden="true" /> Measure explorer</button>
            <button type="button" aria-pressed={measureView === "peers"} onClick={() => setMeasureView("peers")}><Layers3 size={16} aria-hidden="true" /> Peer benchmarks</button>
          </nav>
          {measureView === "explore" ? <MeasureExplorer key={`${profile.sector}:${profile.lens}:${metricId}:${profileRevision}`} profile={profile} requestedMetric={metricId} onRequestedMetric={setMetricId} onInspectCompany={onInspectCompany} /> : <PortfolioFinancialTools key={`peers:${profile.sector}:${profile.lens}:${profileRevision}`} report={healthScope.catalogReport} onInspectCompany={onInspectCompany} view="peers" lens={profile.lens} onLensChange={changeLens} />}
        </>
      )}
      {view === "health" && profile.hasCompatibleCohort && (
        <FinancialHealth
          key={`health:${profile.sector}:${profile.lens}:${profileRevision}`}
          profile={profile}
          report={healthScope.report}
          companies={healthScope.companies}
          capturedAt={capturedAt}
          onInspectCompany={onInspectCompany}
          onDisclosure={onDisclosure}
        />
      )}
      {view === "relationships" && profile.hasCompatibleCohort && <PortfolioFinancialTools key={`relationships:${profile.sector}:${profile.lens}:${profileRevision}`} report={healthScope.catalogReport} onInspectCompany={onInspectCompany} view="relationships" lens={profile.lens} onLensChange={changeLens} />}
      {view === "compare" && profile.hasCompatibleCohort && <PortfolioFinancialTools key={`compare:${profile.sector}:${profile.lens}:${profileRevision}`} report={healthScope.catalogReport} onInspectCompany={onInspectCompany} view="compare" lens={profile.lens} onLensChange={changeLens} />}
    </section>
  );
}
