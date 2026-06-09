import Link from 'next/link';
import { Code2, ExternalLink, FileJson, ShieldCheck, WalletCards, type LucideIcon } from 'lucide-react';

const ENDPOINT = '/api/paid/snapshot?ticker=AAPL';
const RECIPIENT = 'CmkHJ5W6NS4A2icKRym5gqcMXYAL8eBPMZAWd4QfBGoS';

export const metadata = {
  title: 'Paid Snapshot API',
  description:
    'A tiny pay-per-use SEC snapshot API for agents and scripts. Uses public SEC data and Solana memo verification.',
};

export default function PaidApiPage() {
  return (
    <main className="space-y-10">
      <section className="border-b-2 border-stone-800 pb-8">
        <div className="max-w-3xl">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400 font-bold mb-3">
            Agent-readable paid endpoint
          </div>
          <h1 className="text-3xl md:text-5xl font-black tracking-tight text-stone-100 mb-4">
            Pay once, fetch a source-linked SEC snapshot.
          </h1>
          <p className="text-sm md:text-base text-stone-400 leading-relaxed">
            The public app stays free. This endpoint is a small machine-readable product for scripts,
            agents, and workflows that want a compact JSON summary of a ticker's recent SEC filings.
            It uses only public SEC data and unlocks after a confirmed Solana transfer with the exact memo.
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <InfoTile
          icon={WalletCards}
          label="Price"
          value="0.001 SOL"
          text="Returned as HTTP 402 until the memo-linked payment is visible on-chain."
        />
        <InfoTile
          icon={FileJson}
          label="Output"
          value="JSON"
          text="Company identity, CIK, SIC, fiscal year end, recent 10-K/10-Q/8-K/proxy filings, and SEC source URLs."
        />
        <InfoTile
          icon={ShieldCheck}
          label="Boundary"
          value="Public only"
          text="No private data, logins, forecasts, trading recommendations, or investment advice."
        />
      </section>

      <section className="border-2 border-stone-800 bg-stone-900/30 p-5 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <Code2 className="w-5 h-5 text-amber-400" />
          <h2 className="text-lg font-black text-stone-100 uppercase tracking-wider">How it works</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-stone-500 mb-2">1. Request</div>
            <code className="block text-xs break-all border border-stone-800 bg-stone-950 p-3 text-amber-300">
              GET {ENDPOINT}
            </code>
            <p className="text-xs text-stone-400 leading-relaxed mt-3">
              The endpoint returns HTTP 402 with a recipient, exact memo, Solana Pay URL, and retry URL.
            </p>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-stone-500 mb-2">2. Pay and retry</div>
            <code className="block text-xs break-all border border-stone-800 bg-stone-950 p-3 text-amber-300">
              GET /api/paid/snapshot?ticker=AAPL&amp;memo=EdgarSnapshot:AAPL:&lt;nonce&gt;
            </code>
            <p className="text-xs text-stone-400 leading-relaxed mt-3">
              After the transfer confirms, the endpoint verifies the memo and amount through public Solana RPC.
            </p>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-5">
        <div className="border-2 border-stone-800 bg-stone-900/30 p-5">
          <h2 className="text-sm font-black uppercase tracking-wider text-stone-100 mb-3">
            Payment Details
          </h2>
          <dl className="space-y-3 text-xs">
            <Row label="Network" value="Solana mainnet" />
            <Row label="Recipient" value={RECIPIENT} />
            <Row label="Memo prefix" value="EdgarSnapshot:<TICKER>:<nonce>" />
            <Row label="Verification" value="Confirmed transfer to recipient plus exact memo" />
          </dl>
        </div>
        <div className="border-2 border-amber-700/40 bg-amber-950/20 p-5">
          <h2 className="text-sm font-black uppercase tracking-wider text-amber-300 mb-3">
            Try the payment challenge
          </h2>
          <p className="text-xs text-stone-300 leading-relaxed mb-4">
            This first request is safe to call. It only returns payment instructions and does not create a charge.
          </p>
          <Link
            href={ENDPOINT}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-stone-950 font-black uppercase tracking-widest text-xs transition-colors"
          >
            Open 402 response <ExternalLink className="w-4 h-4" />
          </Link>
        </div>
      </section>

      <section className="border border-stone-800 bg-stone-950/50 p-4">
        <p className="text-[11px] text-stone-500 leading-relaxed">
          For research and educational use only. The API summarizes public SEC records and returns source
          URLs so users can verify filings directly. It is not investment advice, financial advice, legal
          advice, tax advice, a broker-dealer service, or a recommendation to buy, sell, or hold any security.
        </p>
      </section>
    </main>
  );
}

function InfoTile({
  icon: Icon,
  label,
  value,
  text,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  text: string;
}) {
  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-5">
      <Icon className="w-5 h-5 text-amber-400 mb-3" />
      <div className="text-[10px] uppercase tracking-widest text-stone-500 mb-1">{label}</div>
      <div className="text-lg font-black text-stone-100 mb-2">{value}</div>
      <p className="text-xs text-stone-400 leading-relaxed">{text}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3">
      <dt className="uppercase tracking-widest text-stone-500">{label}</dt>
      <dd className="text-stone-200 break-all">{value}</dd>
    </div>
  );
}
