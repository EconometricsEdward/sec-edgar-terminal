import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAnalysisScenario } from "../src/utils/analysisScenarios.js";
import * as scenarioMath from "../src/utils/analysisScenarios.js";
import * as editing from "../src/utils/analysisScenarioEditing.js";
import * as notebook from "../src/utils/analysisNotebook.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function compile(path) {
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name === "react/jsx-runtime") return require(name);
    if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
    if (name.endsWith("analysisScenarios.js")) return scenarioMath;
    if (name.endsWith("analysisScenarioEditing.js")) return editing;
    if (name.endsWith("analysisNotebook.js")) return notebook;
    if (name === "./AnalysisScenarioCalibration") return compile("../src/app/analysis/AnalysisScenarioCalibration.tsx");
    if (name.endsWith(".css")) return new Proxy({}, { get: (_target, key) => key === "__esModule" ? false : String(key) });
    throw new Error(`Unexpected scenario lab dependency: ${name}`);
  }, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}
const Lab = compile("../src/app/analysis/AnalysisScenarioLab.tsx").default;
const period = { start: "2025-01-01", end: "2025-12-31", kind: "annual" };
function company(lens = "corporate") {
  const fields = [
    ["revenue", 1000, "RevenueFromContractWithCustomerExcludingAssessedTax", true],
    ["operatingIncome", 200, "OperatingIncomeLoss", true],
    ["netIncome", 120, "NetIncomeLoss", true],
    ["operatingCashFlow", 180, "NetCashProvidedByUsedInOperatingActivities", true],
    ["capex", 60, "PaymentsToAcquirePropertyPlantAndEquipment", true],
    ["cash", 100, "CashAndCashEquivalentsAtCarryingValue"],
    ["totalAssets", 800, "Assets"],
    ["stockholdersEquity", 300, "StockholdersEquity"],
    ["shortTermDebt", 50, "DebtCurrent"],
    ["longTermDebt", 200, "LongTermDebtNoncurrent"],
    ["deposits", 400, "Deposits"],
  ];
  return { lens, periods: [period], definitions: fields.map(([key]) => ({ key, label: key, format: "currency" })), metrics: Object.fromEntries(fields.map(([key, value, tag, flow]) => [key, [{ value, period, classification: "reported", sources: [{ taxonomy: "us-gaap", tag, value, unit: "USD", start: flow ? period.start : null, end: period.end }] }]])) };
}
const props = (settings = {}, extra = {}, data = company()) => ({
  scenario: buildAnalysisScenario(data, settings, 0), settings: { units: "raw", ...settings },
  drafts: {}, errors: {}, onDraft() {}, onApply() {}, onDiscard() {}, onInspect() {}, ...extra,
});
const descendants = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(descendants) : [node, ...descendants(node.props?.children)];
const render = (input) => renderToStaticMarkup(Lab(input));

test("connected controls are draft-only until applied and do not replace the independent result model", () => {
  const calls = [];
  const input = props({}, { drafts: { scenarioCashMode: "connected", scenarioRevenue: "-10" }, onDraft: (...args) => calls.push(args), onApply: () => calls.push("apply") });
  const tree = Lab(input);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /role="switch" aria-checked="true"/);
  assert.match(html, /Tax on positive incremental earnings/);
  assert.match(html, /Independent exercises/);
  assert.match(html, /Apply assumptions to change the results model/);
  assert.match(html, /Applied results · unapplied edits/);
  assert.doesNotMatch(html, /<label[^>]+>Incremental loss/);
  assert.equal(input.scenario.operating.rows.find(row => row.key === "Revenue").selection.point.value, 1000);
  const toggle = descendants(tree).find(node => node.props?.role === "switch");
  toggle.props.onClick();
  assert.deepEqual(calls, [["scenarioCashMode", "independent"]]);
  descendants(tree).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls, [["scenarioCashMode", "independent"], "apply"]);
});

test("connected results expose a cash shortfall, source inspection and all calculations without the independent loss control", () => {
  const html = render(props({ scenarioCashMode: "connected", scenarioWorkingCapital: 20 }));
  assert.match(html, /Earnings → cash → financial strength/);
  assert.match(html, /Funding shortfall:/);
  assert.match(html, /not a funded balance sheet/);
  assert.match(html, /Inputs incomplete · inspect why/);
  assert.match(html, /Inspect hypothetical cash before any unmodeled funding summary/);
  assert.match(html, /All results &amp; source calculations/);
  assert.match(html, /Operating cash flow/);
  assert.match(html, /A negative value releases cash/);
  assert.match(html, /An earnings decline receives no assumed tax relief/);
  assert.doesNotMatch(html, /id="scenario-scenarioLoss"/);
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});

test("incomplete connected source data stays visible as unavailable rather than disappearing from cash effects", () => {
  const data = company();
  data.metrics.capex = [{ value: null, period, reason: "Capital spending unavailable", sources: [] }];
  const html = render(props({ scenarioCashMode: "connected", scenarioCapexChange: 20 }, {}, data));
  assert.match(html, /Cash before unmodeled funding/);
  assert.match(html, /Inspect capital spending change:/);
  assert.match(html, /Capital spending unavailable/);
  assert.match(html, /Inputs incomplete · inspect why/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("bank-specific deposit and usable-cash controls remain available without a corporate connected switch", () => {
  const html = render(props({}, {}, company("banking")));
  assert.match(html, /id="scenario-scenarioFunding"/);
  assert.match(html, /id="scenario-scenarioCashAvailable"/);
  assert.match(html, /id="scenario-scenarioReplacementFunding"/);
  assert.match(html, /id="scenario-scenarioLoss"/);
  assert.match(html, /Cash after withdrawals/);
  assert.doesNotMatch(html, /role="switch"|id="scenario-scenarioTaxRate"/);
});

test("source inspection receives the original calculated point and errors reveal their assumption group", () => {
  let inspected;
  const input = props({ scenarioCashMode: "connected" }, { errors: { scenarioWorkingCapital: "Enter a complete number." }, onInspect: selection => { inspected = selection; } });
  const tree = Lab(input);
  const sourceButton = descendants(tree).find(node => node.props?.["aria-label"] === "Inspect hypothetical operating income summary");
  sourceButton.props.onClick();
  assert.equal(inspected, input.scenario.operating.rows.find(row => row.key === "OperatingIncome").selection);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /<details class="assumptionGroup" open=""><summary><span>Taxes/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /Enter a complete number/);
});
