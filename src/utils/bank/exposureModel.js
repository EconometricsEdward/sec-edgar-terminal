import { pickFact } from './parser.js';
import { CREDIT_SEGMENTS, EXPOSURE_VERSION, finite } from './exposureDefinitions.js';
/** Quarter-end monetary facts only. Never substitute another scope, period, or missing value. */
export function buildExposureReport(parsed, { form, retrievedAt, submission } = {}) {
  if (!['031', '041', '051'].includes(form) || !parsed.schemaReferences.some(s => s.includes(`/report${form}/`)) || parsed.schemaReferences.some(s => /report(031|041|051)\//.test(s) && !s.includes(`/report${form}/`))) throw new Error('Source form mismatch');
  const prefix = form === '031' ? 'RCFD' : 'RCON';
  const values = {}, facts = {};
  const fact = code => {
    if (facts[code]) return facts[code];
    let f = pickFact(parsed, code);
    // CDR encodes this single RC-E balance in a duration context. Accept only if
    // all four quarter-end buckets reconcile to the independently reported total.
    if (code === 'RCONHK14' && f.reason === 'item_not_reported_on_required_basis') {
      const candidate = pickFact(parsed, code, 'ytd');
      const check = ['RCONHK12', 'RCONHK13', 'RCONHK15', 'RCONJ474'].map(c => pickFact(parsed, c));
      if ([candidate, ...check].every(x => finite(x.value) && x.value >= 0 && /(^|:)USD$/i.test(x.unit)) && Math.abs(check[3].value - candidate.value - check[0].value - check[1].value - check[2].value) <= 3000)
        f = { ...candidate, contextNote: 'RC-E M4.a(3) quarter-end balance has a CDR YTD context; reconciled with HK12 + HK13 + HK15 to J474 within $3,000 rounding tolerance.' };
    }
    const reason = f.reason || (!/(^|:)USD$/i.test(f.unit) ? 'unsupported_source_unit' : f.value < 0 ? 'negative_balance_requires_review' : null);
    return facts[code] = { code, value: reason ? null : f.value, reason, rawValue: f.rawValue ?? null, unit: f.unit || null, contextRef: f.contextRef || null, contextNote: f.contextNote || null };
  };
  const read = (key, label, codes, group, schedule, scope = 'Domestic offices') => {
    const inputs = codes.map(fact), reason = inputs.find(f => f.reason)?.reason || null;
    values[key] = { label, value: reason ? null : inputs.reduce((s, f) => s + f.value, 0), codes, reason, group, schedule, scope };
    return values[key];
  };
  const derived = (key, label, keys, group, formula, operation) => {
    const inputs = keys.map(k => values[k]);
    const available = inputs.every(m => finite(m?.value));
    values[key] = { label, value: available ? operation(inputs.map(m => m.value)) : null, codes: [...new Set(inputs.flatMap(m => m.codes))], reason: available ? null : 'required_component_unavailable', group, schedule: [...new Set(inputs.map(m => m.schedule))].join(' / '), scope: inputs[0].scope, formula };
    return values[key];
  };
  const domestic = codes => codes.map(c => `RCON${c}`), all = codes => codes.map(c => prefix + c);
  read('loan_total', 'Domestic loans & leases', domestic(['2122']), 'credit', 'RC-C I total');
  const balances = { construction: ['F158','F159'], cre: ['1460','F160','F161'], residential: ['1797','5367','5368'], commercial: form === '031' ? ['1763','1764'] : ['1766'], consumer: ['B538','B539','K137','K207'] };
  const quality = {
    construction: [['F172','F173'],['F174','F175'],['F176','F177']],
    cre: [['3499','F178','F179'],['3500','F180','F181'],['3501','F182','F183']],
    residential: [['5398','C236','C238'],['5399','C237','C239'],['5400','C229','C230']],
    commercial: form === '031' ? [['1251','1254'],['1252','1255'],['1253','1256']] : [['1606'],['1607'],['1608']],
    consumer: [['B575','K213','K216'],['B576','K214','K217'],['B577','K215','K218']],
  };
  for (const segment of CREDIT_SEGMENTS.slice(0, 5)) {
    const k = segment.key;
    read(`loan_${k}`, segment.label, domestic(balances[k]), 'credit', 'RC-C I');
    // RC-N C&I and consumer are consolidated on 031; real estate is domestic.
    const consolidated = form === '031' && ['commercial','consumer'].includes(k);
    for (const [i, status] of ['past30','past90','nonaccrual'].entries()) read(`${k}_${status}`, `${segment.label} · ${['30–89 days past due','90+ days past due','Nonaccrual'][i]}`, (consolidated ? all : domestic)(quality[k][i]), 'credit', 'RC-N', consolidated ? 'Consolidated bank · all offices' : 'Domestic offices');
  }
  const other = derived('loan_other', 'Other loans & leases', ['loan_total', ...Object.keys(balances).map(k => `loan_${k}`)], 'credit', 'Domestic loans & leases − five displayed loan categories', a => a[0] - a.slice(1).reduce((s, v) => s + v, 0));
  if (other.value < 0) { other.value = null; other.reason = 'portfolio_components_exceed_total'; }

  for (const [k, label, codes, schedule] of [
    ['deposits','Domestic deposits',['2200'],'RC 13.a'],
    ['transaction','Transaction accounts',['2215'],'RC-E 7.A'],
    ['mmda','Money market accounts',['6810'],'RC-E M2.a(1)'],
    ['savings','Other savings',['0352'],'RC-E M2.a(2)'],
    ['time_small','Time deposits ≤ $250k',['6648','J473'],'RC-E M2.b–c'],
    ['time_large','Time deposits > $250k',['J474'],'RC-E M2.d'],
    ['uninsured','Reported uninsured estimate',['5597'],'RC-O M2'],
    ['brokered','Brokered deposits',['2365'],'RC-E M1.b'],
    ['noninterest','Noninterest-bearing deposits',['6631'],'RC 13.a(1)'],
  ]) read(k, label, domestic(codes), 'funding', schedule);
  if (form === '031') read('foreign_deposits', 'Foreign-office deposits', ['RCFN2200'], 'funding', 'RC 13.b', 'Foreign offices');
  for (const [i, label] of ['≤ 3 months','3–12 months','1–3 years','> 3 years'].entries()) {
    read(`time_maturity_${i}`, `Time deposits · ${label}`, domestic([`HK${String(7+i).padStart(2,'0')}`, `HK${12+i}`]), 'funding', 'RC-E M3.a + M4.a');
  }
  for (const [i, label] of ['≤ 1 year','1–3 years','3–5 years','> 5 years'].entries()) {
    read(`fhlb_${i}`, `FHLB advances · ${label}`, all([`F0${55+i}`]), 'funding', 'RC-M 5.a(1)', form === '031' ? 'Consolidated bank · all offices' : 'Domestic offices');
  }
  derived('fhlb_total', 'FHLB advances', [0,1,2,3].map(i => `fhlb_${i}`), 'funding', 'Sum of four non-overlapping maturity / repricing buckets', a => a.reduce((s,v) => s+v,0));

  const scope = form === '031' ? 'Consolidated bank · all offices' : 'Domestic offices';
  for (const [k,label,code] of [['htm_cost','HTM · amortized cost','1754'],['htm_fair','HTM · fair value','1771'],['afs_cost','AFS · amortized cost','1772'],['afs_fair','AFS · fair value','1773']]) read(k,label,all([code]),'securities','RC-B 8',scope);
  for (const portfolio of ['htm','afs']) derived(`${portfolio}_gap`,`${portfolio.toUpperCase()} · fair value less amortized cost`,[`${portfolio}_fair`,`${portfolio}_cost`],'securities','Fair value − amortized cost',a=>a[0]-a[1]);
  for (const [i, label] of ['≤ 3 months','3–12 months','1–3 years','3–5 years','5–15 years','> 15 years'].entries()) {
    read(`securities_other_${i}`,`Other debt & eligible pass-throughs · ${label}`,all([`A${549+i}`]),'securities','RC-B M2.a',scope);
    read(`securities_pass_${i}`,`Residential mortgage pass-throughs · ${label}`,all([`A${555+i}`]),'securities','RC-B M2.b',scope);
  }
  read('mbs_life_short','Other MBS · average life ≤ 3 years',all(['A561']),'securities','RC-B M2.c(1)',scope);
  read('mbs_life_long','Other MBS · average life > 3 years',all(['A562']),'securities','RC-B M2.c(2)',scope);
  return { period: parsed.reportDate, rssd: parsed.rssd, form, hash: parsed.sha256, retrievedAt, submission, values, facts, mappingVersion: EXPOSURE_VERSION };
}
