import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compareEvidenceCitation } from "../src/utils/compareEvidenceLinks.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function component(file) {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), file);
  const localRequire = createRequire(path);
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (name.endsWith(".css")) return {};
      if (name.startsWith(".")) {
        for (const extension of [".tsx", ".ts"]) {
          const candidate = resolve(dirname(path), `${name}${extension}`);
          if (existsSync(candidate)) return component(candidate);
        }
      }
      return localRequire(name);
    },
    testModule,
    testModule.exports,
  );
  return testModule.exports;
}

const period = {
  kind: "annual",
  start: "2025-01-01",
  end: "2025-12-31",
};
const source = (value, end, extra = {}) => ({
  taxonomy: "us-gaap",
  tag: "AccountsPayableCurrent",
  label: "Accounts payable",
  value,
  unit: "USD",
  end,
  filed: "2026-02-06",
  form: "10-K",
  accession: "0001018724-26-000004",
  documentUrl:
    "https://www.sec.gov/Archives/edgar/data/1018724/000101872426000004/amzn-20251231.htm",
  ...extra,
});
const point = (value, end, extra = {}) => ({
  value,
  unit: "USD",
  classification: "reported",
  period,
  sources: [source(value, end)],
  ...extra,
});
const opening = point(94_363_000_000, "2024-12-31");
const closing = point(121_909_000_000, "2025-12-31");
const definition = (key, label) => ({ key, label, format: "currency" });
const analysis = component("../src/app/analysis/AnalysisInspector.tsx").default;
const compare = component(
  "../src/app/compare/components/CompareInspector.tsx",
).default;
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
function renderInspector(Component, metric, selected, data = {}) {
  return renderToStaticMarkup(
    createElement(
      Component,
      Component === analysis
        ? {
            selection: { definition: metric, point: selected },
            data: { ticker: "AMZN", cik: "0001018724", ...data },
            settings: { units: "raw", baseline: "year" },
            close: () => {},
            save: () => {},
          }
        : {
            evidence: {
              cell: {
                ticker: "AMZN",
                cik: "0001018724",
                name: "AMAZON.COM, INC.",
                point: selected,
              },
              metric,
            },
            close: () => {},
            save: () => {},
          },
    ),
  );
}

for (const [name, Component] of [
  ["Analysis", analysis],
  ["Compare", compare],
]) {
  test(`${name} inspector distinguishes Amazon opening balance from its later filing and analytical year`, () => {
    const html = renderInspector(
      Component,
      definition("openingAccountsPayable", "Opening accounts payable"),
      opening,
    );
    const text = plain(html);
    assert.match(text, /Opening balance date As of 2024-12-31/);
    assert.match(text, /Analytical period:? Annual: 2025-01-01 to 2025-12-31/);
    assert.match(text, /filing year is not the balance date/);
    assert.match(text, /2026-02-06/);
    assert.match(text, /94,363,000,000|94363000000/);
    assert.match(html, /amzn-20251231.htm/);
    assert.doesNotMatch(text, /121,909,000,000|121909000000/);
  });

  test(`${name} inspector keeps current balances and calculated averages separate`, () => {
    const current = plain(
      renderInspector(
        Component,
        definition("accountsPayable", "Accounts payable"),
        closing,
      ),
    );
    assert.match(current, /Balance-sheet date As of 2025-12-31/);
    assert.doesNotMatch(current, /Opening balance date/);
    const average = plain(
      renderInspector(
        Component,
        definition("averageAssets", "Average assets"),
        {
          value: 721_468_000_000,
          unit: "USD",
          classification: "calculated",
          period,
          formula: "(Opening assets + closing assets) / 2",
          sources: [
            source(624_894_000_000, "2024-12-31", { tag: "Assets" }),
            source(818_042_000_000, "2025-12-31", { tag: "Assets" }),
          ],
        },
      ),
    );
    assert.match(average, /Calculation period 2025-01-01 to 2025-12-31/);
    assert.match(average, /As of 2024-12-31/);
    assert.match(average, /As of 2025-12-31/);
    assert.doesNotMatch(average, /Balance-sheet date As of 2025-12-31/);
  });
}

test("Analysis evidence comparison cards show each opening balance's actual date", () => {
  const metric = definition(
    "openingAccountsPayable",
    "Opening accounts payable",
  );
  const previousPeriod = {
    kind: "annual",
    start: "2024-01-01",
    end: "2024-12-31",
  };
  const previous = point(84_981_000_000, "2023-12-31", {
    period: previousPeriod,
  });
  const text = plain(
    renderInspector(analysis, metric, opening, {
      definitions: [metric],
      periods: [period, previousPeriod],
      metrics: { openingAccountsPayable: [opening, previous] },
    }),
  );
  assert.match(text, /Selected figure.*Opening balance date: As of 2024-12-31/);
  assert.match(
    text,
    /Comparison figure.*Opening balance date: As of 2023-12-31/,
  );
});

test("copied Compare citations preserve the opening observation date and its later filing", () => {
  const evidence = {
    cell: { ticker: "AMZN", cik: "0001018724", point: opening },
    metric: definition("openingAccountsPayable", "Opening accounts payable"),
    settings: { asOf: "2026-09-12" },
  };
  const citation = compareEvidenceCitation(evidence);
  assert.match(citation, /Opening accounts payable: 94363000000 USD/);
  assert.match(citation, /Opening balance date: As of 2024-12-31/);
  assert.match(citation, /Analytical period: Annual: 2025-01-01 to 2025-12-31/);
  assert.match(
    citation,
    /94363000000 USD; As of 2024-12-31; 10-K, filed 2026-02-06/,
  );
  assert.match(citation, /Filing cutoff: 2026-09-12/);
  assert.doesNotMatch(citation, /Observation check:/);
  const mismatch = compareEvidenceCitation({
    ...evidence,
    cell: { ...evidence.cell, point: { ...opening, value: closing.value } },
  });
  assert.match(
    mismatch,
    /Observation check: The displayed reported value does not match its cited source observation/,
  );
});

test("inspectors preserve sub-cent raw source precision independently of headline display", () => {
  const rawValue = 0.123456789012345;
  const metric = definition("accountsPayable", "Accounts payable");
  for (const Component of [analysis, compare]) {
    const text = plain(
      renderInspector(Component, metric, point(rawValue, "2025-12-31")),
    );
    assert.match(text, /0\.123456789012345 USD/);
  }
});
