"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Building2 } from "lucide-react";
import styles from "./AnalysisLanding.module.css";

type SectorSample = { sector: string; companies: { ticker: string; cik: string; name: string; industry: string; sic: string }[] };

export default function AnalysisDirectory({ sectors }: { sectors: SectorSample[] }) {
  const [selected, setSelected] = useState(sectors[0]?.sector || "");
  if (!sectors.length) return null;
  return (
    <section className={styles.directory} aria-labelledby="analysis-directory-title">
      <div className={styles.directoryHeading}>
        <div><p className={styles.eyebrow}>Company research directory</p><h2 id="analysis-directory-title">A few places to start.</h2></div>
        <p>Explore examples by sector.<br />Search above for any company in the SEC ticker directory.</p>
      </div>
      <div className={styles.sectors} role="group" aria-label="Browse sample companies by sector">
        {sectors.map(({ sector }, index) => <button key={sector} type="button" aria-pressed={selected === sector}
          aria-controls={`analysis-sector-${index}`} onClick={() => setSelected(sector)}>{sector}</button>)}
      </div>
      {sectors.map(({ sector, companies }, index) => (
        <div key={sector} id={`analysis-sector-${index}`} hidden={selected !== sector}>
          <div className={styles.sampleHeading}><h3>{sector}</h3><span>{companies.length} sample {companies.length === 1 ? "company" : "companies"}</span></div>
          <div className={styles.sampleGrid}>
            {companies.map(company => <Link href={`/analysis/${company.ticker}`} prefetch={false} key={company.cik} className={styles.company}>
              <div className={styles.companyTop}><span className={styles.ticker}>{company.ticker}</span><ArrowUpRight size={20} aria-hidden="true" /></div>
              <h4>{company.name}</h4>
              <div className={styles.industry}><Building2 size={15} aria-hidden="true" /><span>{company.industry || sector}<small>{company.sic ? `SEC industry · SIC ${company.sic}` : "Sector example"}</small></span></div>
              <span className={styles.openCompany}>Open analysis <span aria-hidden="true">↗</span></span>
            </Link>)}
          </div>
        </div>
      ))}
      <p className={styles.directoryFootnote}>A small selection of companies, not a complete market listing. Financial data availability varies by company and reporting period.</p>
    </section>
  );
}
