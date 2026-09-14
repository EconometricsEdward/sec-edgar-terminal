import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyCftcSources, discoverCompanyCftcContext } from '../src/utils/companyCftcServer.js';
import { createSecResearchJson } from '../src/utils/secResearchData.js';
import { extractFilingReaderText, validateReaderDocument } from '../src/utils/filingsReader.js';

const cik = '0000320193', accession = '0000320193-25-000079', primaryDoc = 'aapl-20250927.htm';
const now = new Date('2026-09-13T12:00:00Z');
const recent = { accessionNumber: [accession], form: ['10-K'], filingDate: ['2025-10-31'], reportDate: ['2025-09-27'], primaryDocument: [primaryDoc] };
const submissions = { cik: 320193, name: 'Apple Inc.', filings: { recent, files: [] } };
const noSource = async () => { assert.fail('This read must not dispatch another SEC request.'); };
const dependencies = { readPrepared: async () => null, read: async () => null, write: async () => true, sample: async () => null, fetchSec: noSource };
const lookupTicker = async () => ({ cik, name: 'Apple Inc.' });

test('company connections reuse fresh prepared submissions and the reader preserves exact visible narrative', async () => {
  const controller = new AbortController();
  const rates = 'Our variable-rate debt accrues interest based on SOFR, creating exposure to changes in interest rates.';
  const hidden = 'Our copper production revenue depends on copper prices and supply conditions.';
  let preparedReads = 0, readerReads = 0;
  const readJson = createSecResearchJson({ ...dependencies,
    readPrepared: async (path, options) => {
      preparedReads++;
      assert.equal(path, `/submissions/CIK${cik}.json`);
      assert.equal(options.allowStale, false);
      return { payload: submissions };
    },
    read: noSource,
  });
  const sources = createCompanyCftcSources({ readJson,
    readDocument: async (sourceCik, document, options) => {
      readerReads++;
      assert.equal(sourceCik, cik);
      assert.deepEqual(document, { accession, primaryDoc });
      assert.equal(options.signal, controller.signal);
      assert.equal(validateReaderDocument(sourceCik, document), `https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/${primaryDoc}`);
      return extractFilingReaderText(`<html><body><ix:header><ix:hidden><p>${hidden}</p></ix:hidden></ix:header><h2>Market risk</h2><p>${rates}</p><p>Other operating risks remain under review throughout the reporting period.</p></body></html>`, primaryDoc);
    },
  });
  const context = await discoverCompanyCftcContext({ ticker: 'AAPL' }, { now, lookupTicker, signal: controller.signal, ...sources });
  assert.equal(context.status, 'ready');
  assert.equal(preparedReads, 1); assert.equal(readerReads, 1);
  assert.deepEqual(context.links.map(link => link.id), ['sofr', 'rates']);
  assert.equal(context.links[0].evidence[0].text, rates);
  assert.equal(context.links[0].evidence[0].url, context.filing.url);
});

test('archived submissions reuse the existing source cache and invalid filenames never reach a source', async () => {
  const cache = new Map(); let fetches = 0;
  const file = `CIK${cik}-submissions-001.json`, path = `/submissions/${file}`;
  const sources = createCompanyCftcSources({ readJson: createSecResearchJson({ ...dependencies,
    read: async (namespace, key) => { assert.equal(namespace, 'research-sec-v1'); return cache.get(key); },
    write: async (namespace, key, payload, ttl) => { assert.equal(namespace, 'research-sec-v1'); assert.equal(ttl, 300); cache.set(key, payload); },
    fetchSec: async url => { fetches++; assert.equal(url, `https://data.sec.gov${path}`); return Response.json(recent); },
  }) });
  assert.deepEqual(await sources.loadSubmissions(file), recent);
  assert.deepEqual(await sources.loadSubmissions(file), recent);
  assert.equal(fetches, 1);
  for (const invalid of ['../CIK0000320193.json', 'https://data.sec.gov/submissions/CIK0000320193.json', 'CIK0000320193.json?cache=0'])
    await assert.rejects(sources.loadSubmissions(invalid), { code: 'SEC_SOURCE_INVALID' });
  assert.equal(fetches, 1);
});

test('a prepared-source outage remains unavailable without bypassing the storage boundary or reading a filing', async () => {
  const sources = createCompanyCftcSources({ readJson: createSecResearchJson({ ...dependencies,
    readPrepared: async (_path, options) => {
      assert.equal(options.allowStale, false);
      throw Object.assign(new Error('Prepared SEC research input requires revalidation.'), { code: 'SEC_PREPARED_UNAVAILABLE' });
    },
    read: noSource,
  }), readDocument: noSource });
  const context = await discoverCompanyCftcContext({ ticker: 'AAPL' }, { now, lookupTicker, ...sources });
  assert.equal(context.status, 'unavailable');
  assert.equal(context.code, 'SEC_PREPARED_UNAVAILABLE');
  assert.equal(context.retryable, true); assert.deepEqual(context.links, []);
});

test('discovery cancellation reaches the shared filing reader instead of leaving its transport running', async () => {
  const controller = new AbortController();
  let began, transportAborted = false;
  const started = new Promise(resolve => { began = resolve; });
  const sources = createCompanyCftcSources({ readJson: async () => submissions,
    readDocument: async (_cik, _document, { signal }) => {
      assert.equal(signal, controller.signal);
      began();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        transportAborted = true; reject(signal.reason);
      }, { once: true }));
    },
  });
  const pending = discoverCompanyCftcContext({ ticker: 'AAPL' }, { now, lookupTicker, signal: controller.signal, ...sources });
  await started;
  controller.abort(new Error('Discovery stopped.'));
  const context = await pending;
  assert.equal(transportAborted, true);
  assert.equal(context.status, 'unavailable'); assert.equal(context.retryable, true);
  assert.deepEqual(context.links, []);
});
