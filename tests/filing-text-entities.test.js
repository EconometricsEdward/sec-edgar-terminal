import test from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml } from '../src/utils/filingTextParser.js';
import { disclosurePassages } from '../src/utils/disclosureResearch.js';
import { searchDisclosurePassageIndex } from '../src/utils/disclosurePassageIndex.js';
import { DISCLOSURE_INDEX_LIMITS } from '../src/utils/disclosurePassageIndex.js';

test('filing text decodes hexadecimal and supplementary Unicode after removing markup', () => {
  assert.equal(stripHtml('<p>&#x2022; Cybersecurity &amp; operational risks &#128200; &#x1F4C8;</p>'),
    '• Cybersecurity & operational risks 📈 📈');
  assert.equal(stripHtml('<p>Leverage &#x3c; 4 and coverage &#62; 1.5.</p>'), 'Leverage < 4 and coverage > 1.5.');
  assert.equal(stripHtml('<p>&#xD800; &#1114112; &#0;</p>'), '� � �');
});

test('previously prepared disclosure text decodes before passage matching and display', async () => {
  const text = '&#x2022; Cybersecurity risks and incidents (including vulnerabilities and breaches)';
  const paragraphs = disclosurePassages(text, '10-K').paragraphs;
  assert.equal(paragraphs[0].text, '• Cybersecurity risks and incidents (including vulnerabilities and breaches)');
  const result = await searchDisclosurePassageIndex({ query: 'cybersecurity', forms: ['10-K'],
    start: '2025-01-01', end: '2026-12-31', section: 'all' }, {}, {
    search: async () => ({ results: [{ cik: '0000789019', accession: '0001193125-26-323660',
      primaryDoc: 'msft-ex19_1.htm', companyName: 'MICROSOFT CORP', ticker: 'MSFT', form: '10-K',
      filingDate: '2026-07-29', reportDate: '2026-06-30', parserVersion: DISCLOSURE_INDEX_LIMITS.parserVersion,
      passage: { ...paragraphs[0], text }, rank: 1 }], hasMore: false }),
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].previews[0].text, paragraphs[0].text);
});
