import { ImageResponse } from 'next/og';
import { isCftcEnabled } from '../utils/cftcFeature.js';

export const alt = 'EDGAR Terminal — source-linked public research';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  const cftcEnabled = isCftcEnabled();
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '64px 72px', color: '#f8fafc', background: 'linear-gradient(135deg, #070a12 0%, #111a2c 62%, #1c2536 100%)', fontFamily: 'Arial, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ width: 58, height: 58, borderRadius: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6c344', color: '#111827', fontSize: 34, fontWeight: 900 }}>↗</div>
          <div style={{ display: 'flex', fontSize: 30, fontWeight: 800, letterSpacing: '-1px' }}>EDGAR/Terminal</div>
        </div>
        <div style={{ display: 'flex', padding: '10px 16px', border: '1px solid #42516b', borderRadius: 999, color: '#cbd5e1', fontSize: 16 }}>PUBLIC · SOURCE-LINKED · ACCOUNTLESS</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 980 }}>
        <div style={{ display: 'flex', color: '#f6c344', fontSize: 18, fontWeight: 700, letterSpacing: '3px', marginBottom: 20 }}>{cftcEnabled ? 'SEC EVIDENCE + OFFICIAL CFTC CONTEXT' : 'SOURCE-LINKED SEC EVIDENCE'}</div>
        <div style={{ display: 'flex', fontSize: 62, lineHeight: 1.04, fontWeight: 850, letterSpacing: '-3px' }}>{cftcEnabled ? <>Research the company.<br />Read futures positioning.</> : <>Research the company.<br />Follow the filing evidence.</>}</div>
        <div style={{ display: 'flex', marginTop: 22, color: '#b8c3d6', fontSize: 24, lineHeight: 1.35 }}>{cftcEnabled ? 'SEC filings and fundamentals with separately presented CFTC Commitments of Traders positioning.' : 'SEC filings and fundamentals with traceable source evidence.'}</div>
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        {(cftcEnabled ? ['SEC FILINGS', 'FUNDAMENTAL LAB', 'CFTC COT POSITIONING'] : ['SEC FILINGS', 'FUNDAMENTAL LAB', 'COMPANY RESEARCH']).map(label => <div key={label} style={{ display: 'flex', padding: '10px 16px', border: '1px solid #35435c', borderRadius: 8, color: '#dbe3ef', fontSize: 16, fontWeight: 700 }}>{label}</div>)}
      </div>
    </div>,
    size,
  );
}
