import { buildPageMetadata } from "../../utils/siteMetadata";
import LegalShell from "../terms/LegalShell";

export const metadata = buildPageMetadata({ title: "Privacy Notice", description: "How EDGAR Terminal handles public research requests, browser storage and site analytics.", path: "/privacy" });

export default function PrivacyPage() {
  return <LegalShell title="Privacy notice" intro="This notice explains what reaches the service and what stays in your browser when you use EDGAR Terminal.">
    <section><h2>Research without an account</h2>
      <p>The public research pages do not require an account. Search terms, selected public companies or funds, and research requests reach EDGAR Terminal so it can retrieve and organize public data. Hosting and security services process ordinary connection and request information, such as an IP address and browser information, to deliver the site and protect against abuse.</p>
      <p>Saved portfolios, page preferences and supported local work use your browser’s storage. They do not automatically sync across devices. The interactive portfolio research tools send the public company identifiers needed for research; private notes and allocation values remain local unless you choose a tool or export that includes them. Programmatic API requests transmit whatever fields you include.</p>
    </section>
    <section><h2>Service providers and analytics</h2>
      <p>Service providers host and secure the application and store prepared public research data. These include Vercel, Supabase and Upstash. Public-data retrieval uses source services such as SEC and CFTC endpoints. Providers may process connection and operational information in the United States or other locations where they operate.</p>
      <p>Vercel Analytics and Speed Insights measure page usage and application performance. The site does not use these features to sell personal information or build cross-site advertising profiles. Browser “Do Not Track” signals do not change necessary security and request processing. External websites operate under their own privacy notices.</p>
      <p>Necessary records may be disclosed to address abuse, enforce service terms or comply with a valid legal obligation.</p>
    </section>
    <section><h2>Storage and your choices</h2>
      <p>You can remove locally saved research and preferences by clearing this site’s browser data. Export work you want to keep first. Clearing browser data does not erase hosting or security records already processed by service providers.</p>
      <p>Operational information is retained as needed to deliver the service, investigate errors, protect against abuse and meet legal obligations. Shared research caches contain public-source data; browser-local portfolios are not a synchronized account archive.</p>
      <p>Use the project support link below for privacy questions or to ask how to make a request concerning personal information. The issue tracker is public, so do not include private information in a post. Identity verification may be needed before a request can be addressed.</p>
    </section>
    <section><h2>Children and notice changes</h2>
      <p>EDGAR Terminal is not directed to children under 13 and does not knowingly seek their personal information. Contact the project if you believe a child has supplied personal information.</p>
      <p>Updates to this notice appear with a revised effective date. Material changes will be communicated through the site.</p>
    </section>
  </LegalShell>;
}
