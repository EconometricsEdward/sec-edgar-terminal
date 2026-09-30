import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { extractInlineFilingIdentity } from '../src/utils/riskNoteFacts.js';
import { supplementRiskProfileFacts } from '../src/utils/riskProfileSources.js';
import { assessRisk } from '../src/utils/riskAnalysis.js';
import { buildRiskResearchModel } from '../src/app/risk/riskResearchModel.js';

const identities = JSON.parse(readFileSync(new URL('./fixtures/risk-filing-identity-2026-09-30.json', import.meta.url), 'utf8'));
const purchases = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/risk-capital-purchases-2026-09-30.json.gz', import.meta.url))));

test('original Ford, Citi and Southern filing identity fragments accept their actual typography', () => {
  for (const { ticker, cik, filing, html } of identities) {
    const identity = extractInlineFilingIdentity(html, { cik, filing });
    assert.equal(identity?.documentPeriodEndDate, '2026-06-30', ticker);
    assert.equal(identity?.fiscalPeriod, 'Q2', ticker);
    const restored = supplementRiskProfileFacts({}, html, { cik, filing });
    assert.ok(restored.addedFacts > 0, ticker);
    assert.ok(restored.facts['us-gaap'].Assets.units.USD.some(value => value.end === '2026-06-30'), ticker);
  }
});

test('original multi-filing Amazon and Nvidia observations replay capital spending and cash remaining', () => {
  const expected = { AMZN: { annual: [131819000000, 7695000000], ttm: [173028000000, -11625000000] },
    NVDA: { annual: [6042000000, 96676000000], ttm: [7354000000, 127006000000] } };
  for (const company of purchases) for (const basis of ['annual', 'ttm']) {
    const profile = assessRisk(company.facts, company.sic, company.cik, { basis });
    const point = profile.reportedFlows.capitalExpenditure.at(-1);
    assert.equal(point.value, expected[company.ticker][basis][0], `${company.ticker} ${basis} purchases`);
    const cash = buildRiskResearchModel(profile, company).drivers.flatMap(driver => driver.metrics).find(metric => metric.id === 'cash_after_capex');
    assert.equal(cash.value, expected[company.ticker][basis][1], `${company.ticker} ${basis} cash after purchases`);
    assert.ok(point.sources.every(source => source.tag === 'PaymentsToAcquireProductiveAssets'));
    assert.match(cash.note, /may include intangible assets/);
  }
});
