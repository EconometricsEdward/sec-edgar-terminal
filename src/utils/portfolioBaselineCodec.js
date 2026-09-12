/** Compact checkpoint observations; the public comparison model remains expanded. */
export const PORTFOLIO_BASELINE_METRIC_LIMIT = 128;

const V1_ENCODING = "portfolio-checkpoint-tuples-v1";
const V2_ENCODING = "portfolio-checkpoint-tuples-v2";
const MAX_COMPANIES = 100;
const MAX_DESCRIPTORS = 5000;
const MAX_EVIDENCE = MAX_COMPANIES * PORTFOLIO_BASELINE_METRIC_LIMIT;
const MAX_POOL_ENTRIES = 5000;
const MAX_PACKED_CHUNKS = 100;
const PACKED_CHUNK_LIMIT = 15000;
const PERIOD_KEYS = [
  "start",
  "end",
  "kind",
  "fy",
  "year",
  "quarter",
  "months",
  "fp",
];
const DEFINITION_KEYS = [
  "unit",
  "classification",
  "formula",
  "tags",
  "calculations",
];
const COMPANY_STATUSES = ["ready", "partial", "failed", "unsupported"];
const SOURCE_PREFIXES = [
  "https://www.sec.gov/Archives/edgar/data/",
  "https://sec.gov/Archives/edgar/data/",
  "https://data.sec.gov/",
];
const COMPANY_FIELDS = [
  "cik",
  "ticker",
  "name",
  "status",
  "checked",
  "period",
  "metrics",
  "filings",
];
const METRIC_FIELDS = [
  "value",
  "unit",
  "label",
  "period",
  "definition",
  "sources",
];
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const BASE36_PATTERN = /^[0-9a-z]+$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function invalid(message = "Invalid comparison checkpoint encoding.") {
  throw new Error(message);
}

function reference(value, length) {
  if (!Number.isInteger(value) || value < 0 || value >= length)
    invalid("Invalid comparison checkpoint reference.");
  return value;
}

function base36Reference(value, length) {
  if (typeof value !== "string" || !BASE36_PATTERN.test(value))
    invalid("Invalid comparison checkpoint reference.");
  return reference(Number.parseInt(value, 36), length);
}

function canonicalJson(value, keys) {
  try {
    const parsed = JSON.parse(value);
    if (
      !plain(parsed) ||
      JSON.stringify(parsed) !== value ||
      JSON.stringify(Object.keys(parsed)) !==
        JSON.stringify(keys.filter((key) => own(parsed, key)))
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function packPeriod(value) {
  const parsed = canonicalJson(value, PERIOD_KEYS);
  if (
    !parsed ||
    Object.values(parsed).some((entry) => typeof entry !== "string")
  )
    return value;
  let mask = 0;
  const entries = [];
  PERIOD_KEYS.forEach((key, index) => {
    if (!own(parsed, key)) return;
    mask |= 1 << index;
    entries.push(parsed[key]);
  });
  return [mask, ...entries];
}

function unpackPeriod(value) {
  if (typeof value === "string") return value;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    !Number.isInteger(value[0]) ||
    value[0] < 0 ||
    value[0] >= 1 << PERIOD_KEYS.length
  )
    invalid("Invalid comparison checkpoint periods.");
  const mask = value[0];
  const expected = PERIOD_KEYS.reduce(
    (count, _key, index) => count + ((mask >> index) & 1),
    1,
  );
  if (
    value.length !== expected ||
    value.slice(1).some((entry) => typeof entry !== "string")
  )
    invalid("Invalid comparison checkpoint periods.");
  const period = {};
  let cursor = 1;
  PERIOD_KEYS.forEach((key, index) => {
    if ((mask >> index) & 1) period[key] = value[cursor++];
  });
  const decoded = JSON.stringify(period);
  if (decoded.length > 1000)
    invalid("Invalid comparison checkpoint periods.");
  return decoded;
}

function packDefinitions(values) {
  const strings = [],
    lookup = new Map();
  const intern = (value) => {
    if (!lookup.has(value)) {
      lookup.set(value, strings.length);
      strings.push(value);
    }
    return lookup.get(value);
  };
  const definitions = values.map((value) => {
    const parsed = canonicalJson(value, DEFINITION_KEYS);
    if (
      !parsed ||
      DEFINITION_KEYS.slice(0, 3).some(
        (key) => typeof parsed[key] !== "string",
      ) ||
      !Array.isArray(parsed.tags) ||
      parsed.tags.some((entry) => typeof entry !== "string") ||
      !Array.isArray(parsed.calculations) ||
      parsed.calculations.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== 6 ||
          row.some((entry) => typeof entry !== "string"),
      )
    )
      return value;
    return [
      intern(parsed.unit),
      intern(parsed.classification),
      intern(parsed.formula),
      parsed.tags.map(intern),
      parsed.calculations.map((row) => row.map(intern)),
    ];
  });
  return strings.length <= MAX_POOL_ENTRIES
    ? { definitions, definitionStrings: strings }
    : { definitions: values, definitionStrings: [] };
}

function unpackDefinitions(values, strings) {
  if (
    !Array.isArray(values) ||
    values.length > MAX_POOL_ENTRIES ||
    !Array.isArray(strings) ||
    strings.length > MAX_POOL_ENTRIES ||
    strings.some(
      (entry) => typeof entry !== "string" || entry.length > 16000,
    )
  )
    invalid("Invalid comparison checkpoint definitions.");
  const resolve = (id) => strings[reference(id, strings.length)];
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (
      !Array.isArray(value) ||
      value.length !== 5 ||
      !Array.isArray(value[3]) ||
      value[3].length > MAX_POOL_ENTRIES ||
      !Array.isArray(value[4]) ||
      value[4].length > MAX_POOL_ENTRIES ||
      value[4].some((row) => !Array.isArray(row) || row.length !== 6)
    )
      invalid("Invalid comparison checkpoint definitions.");
    const decoded = JSON.stringify({
      unit: resolve(value[0]),
      classification: resolve(value[1]),
      formula: resolve(value[2]),
      tags: value[3].map(resolve),
      calculations: value[4].map((row) => row.map(resolve)),
    });
    if (decoded.length > 16000)
      invalid("Invalid comparison checkpoint definitions.");
    return decoded;
  });
}

function packSource(value) {
  const index = SOURCE_PREFIXES.findIndex((prefix) => value.startsWith(prefix));
  return index < 0
    ? `r${value}`
    : `${index}${value.slice(SOURCE_PREFIXES[index].length)}`;
}

function unpackSource(value) {
  if (typeof value !== "string" || value.length < 2)
    invalid("Invalid comparison checkpoint sources.");
  const code = value[0];
  const decoded =
    code === "r"
      ? value.slice(1)
      : /^[0-2]$/.test(code)
        ? `${SOURCE_PREFIXES[Number(code)]}${value.slice(1)}`
        : null;
  if (!decoded || decoded.length > 2000)
    invalid("Invalid comparison checkpoint sources.");
  return decoded;
}

function packFilings(cik, filings) {
  return filings
    .map((accession) => {
      const digits = accession.replaceAll("-", "");
      return digits.slice(0, 10) === cik ? digits.slice(10) : digits;
    })
    .join(".");
}

function unpackFilings(cik, value) {
  if (typeof value !== "string" || value.length > 800)
    invalid("Invalid comparison checkpoint filings.");
  if (!value) return [];
  const tokens = value.split(".");
  if (
    tokens.length > 40 ||
    tokens.some(
      (token) => !/^\d+$/.test(token) || ![8, 18].includes(token.length),
    )
  )
    invalid("Invalid comparison checkpoint filings.");
  return tokens.map((token) => {
    const digits = token.length === 8 ? `${cik}${token}` : token;
    return `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
  });
}

function makeChunks(records) {
  const chunks = [];
  let chunk = "";
  for (const record of records) {
    const separator = chunk ? ";" : "";
    if (
      chunk &&
      chunk.length + separator.length + record.length > PACKED_CHUNK_LIMIT
    ) {
      chunks.push(chunk);
      chunk = record;
    } else chunk += `${separator}${record}`;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function unpackEvidence(chunks, periodCount, definitionCount, sourceCount) {
  if (
    !Array.isArray(chunks) ||
    chunks.length > MAX_PACKED_CHUNKS ||
    chunks.some(
      (chunk) =>
        typeof chunk !== "string" ||
        !chunk ||
        chunk.length > PACKED_CHUNK_LIMIT,
    )
  )
    invalid("Invalid comparison checkpoint evidence.");
  const evidence = [];
  for (const chunk of chunks) {
    for (const record of chunk.split(";")) {
      const fields = record.split(".");
      if (fields.length < 2 || fields.length > 10)
        invalid("Invalid comparison checkpoint evidence.");
      evidence.push([
        base36Reference(fields[0], periodCount),
        base36Reference(fields[1], definitionCount),
        fields.slice(2).map((id) => base36Reference(id, sourceCount)),
      ]);
      if (evidence.length > MAX_EVIDENCE)
        invalid("Invalid comparison checkpoint evidence.");
    }
  }
  return evidence;
}

function unpackV1(value) {
  const { metricEncoding: _encoding, metricDescriptors, ...rest } = value;
  if (
    !Array.isArray(metricDescriptors) ||
    metricDescriptors.length > 2000 ||
    !Array.isArray(value.companies) ||
    value.companies.length > MAX_COMPANIES
  )
    invalid();
  if (
    metricDescriptors.some(
      (descriptor) =>
        !Array.isArray(descriptor) ||
        descriptor.length !== 2 ||
        typeof descriptor[0] !== "string" ||
        descriptor[0].length > 100 ||
        typeof descriptor[1] !== "string" ||
        descriptor[1].length > 200,
    )
  )
    invalid("Invalid comparison checkpoint descriptors.");
  return {
    ...rest,
    companies: value.companies.map((company) => {
      if (
        !company.metrics ||
        typeof company.metrics !== "object" ||
        Object.keys(company.metrics).length > PORTFOLIO_BASELINE_METRIC_LIMIT
      )
        invalid("Invalid comparison checkpoint metrics.");
      return {
        ...company,
        metrics: Object.fromEntries(
          Object.entries(company.metrics).map(([key, point]) => {
            if (!Array.isArray(point) || point.length !== 5)
              invalid("Invalid comparison checkpoint reference.");
            const [unit, label] =
              metricDescriptors[reference(point[1], metricDescriptors.length)];
            return [
              key,
              {
                value: point[0],
                unit,
                label,
                period: point[2],
                definition: point[3],
                sources: point[4],
              },
            ];
          }),
        ),
      };
    }),
  };
}

function unpackV2(value) {
  const {
    metricEncoding: _encoding,
    metricDescriptors,
    metricSchemas,
    evidenceDescriptors,
    definitionStrings,
    companies: encodedCompanies,
    ...packed
  } = value;
  if (
    !Array.isArray(metricDescriptors) ||
    metricDescriptors.length > MAX_DESCRIPTORS ||
    metricDescriptors.some(
      (descriptor) =>
        !Array.isArray(descriptor) ||
        descriptor.length !== 3 ||
        descriptor.some((entry) => typeof entry !== "string"),
    ) ||
    !Array.isArray(metricSchemas) ||
    metricSchemas.length > MAX_COMPANIES ||
    !Array.isArray(encodedCompanies) ||
    encodedCompanies.length > MAX_COMPANIES ||
    !Array.isArray(packed.sources) ||
    packed.sources.length > MAX_POOL_ENTRIES ||
    !Array.isArray(packed.periods) ||
    packed.periods.length > MAX_POOL_ENTRIES
  )
    invalid();
  const sources = packed.sources.map(unpackSource);
  const periods = packed.periods.map(unpackPeriod);
  const definitions = unpackDefinitions(packed.definitions, definitionStrings);
  const evidence = unpackEvidence(
    evidenceDescriptors,
    periods.length,
    definitions.length,
    sources.length,
  );
  for (const schema of metricSchemas) {
    if (
      !Array.isArray(schema) ||
      schema.length > PORTFOLIO_BASELINE_METRIC_LIMIT
    )
      invalid("Invalid comparison checkpoint metric schema.");
    const keys = new Set();
    for (const descriptorId of schema) {
      const descriptor =
        metricDescriptors[reference(descriptorId, metricDescriptors.length)];
      if (keys.has(descriptor[0]))
        invalid("Invalid comparison checkpoint metric schema.");
      keys.add(descriptor[0]);
    }
  }
  const companies = encodedCompanies.map((company) => {
    if (
      !Array.isArray(company) ||
      company.length !== 9 ||
      typeof company[0] !== "string" ||
      !Number.isInteger(company[3]) ||
      !COMPANY_STATUSES[company[3]] ||
      ![0, 1].includes(company[4]) ||
      typeof company[7] !== "string" ||
      company[7].length > 16000
    )
      invalid("Invalid comparison checkpoint company.");
    const schema = metricSchemas[reference(company[6], metricSchemas.length)];
    const records = company[7] ? company[7].split(";") : [];
    if (records.length !== schema.length)
      invalid("Invalid comparison checkpoint metrics.");
    const metrics = Object.fromEntries(
      records.map((record, index) => {
        const separator = record.indexOf(",");
        if (separator < 0 || separator !== record.lastIndexOf(","))
          invalid("Invalid comparison checkpoint metric vector.");
        const valueText = record.slice(0, separator);
        const value = valueText === "" ? null : Number(valueText);
        if (
          valueText !== "" &&
          (!NUMBER_PATTERN.test(valueText) || !Number.isFinite(value))
        )
          invalid("Invalid comparison checkpoint metric value.");
        const evidenceId = base36Reference(
          record.slice(separator + 1),
          evidence.length,
        );
        const [period, definition, sourceIds] = evidence[evidenceId];
        const [key, unit, label] = metricDescriptors[schema[index]];
        return [
          key,
          {
            value,
            unit,
            label,
            period,
            definition,
            sources: [...sourceIds],
          },
        ];
      }),
    );
    return {
      cik: company[0],
      ticker: company[1],
      name: company[2],
      status: COMPANY_STATUSES[company[3]],
      checked: company[4] === 1,
      period: reference(company[5], periods.length),
      metrics,
      filings: unpackFilings(company[0], company[8]),
    };
  });
  return { ...packed, sources, periods, definitions, companies };
}

export function packPortfolioBaseline(value) {
  if (!value || value.metricEncoding) return value;
  if (
    !Array.isArray(value.companies) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.periods) ||
    !Array.isArray(value.definitions) ||
    value.companies.some(
      (company) =>
        !plain(company) ||
        Object.keys(company).length !== COMPANY_FIELDS.length ||
        Object.keys(company).some((key) => !COMPANY_FIELDS.includes(key)) ||
        !plain(company.metrics) ||
        Object.values(company.metrics).some(
          (point) =>
            !plain(point) ||
            Object.keys(point).length !== METRIC_FIELDS.length ||
            Object.keys(point).some((key) => !METRIC_FIELDS.includes(key)),
        ),
    )
  )
    return value;
  const metricDescriptors = [],
    descriptorLookup = new Map(),
    metricSchemas = [],
    schemaLookup = new Map(),
    evidence = [],
    evidenceLookup = new Map();
  const companies = value.companies.map((company) => {
    const schema = [],
      records = [];
    for (const [key, point] of Object.entries(company.metrics)) {
      const descriptorSignature = JSON.stringify([key, point.unit, point.label]);
      if (!descriptorLookup.has(descriptorSignature)) {
        descriptorLookup.set(descriptorSignature, metricDescriptors.length);
        metricDescriptors.push([key, point.unit, point.label]);
      }
      schema.push(descriptorLookup.get(descriptorSignature));
      const evidenceSignature = JSON.stringify([
        point.period,
        point.definition,
        point.sources,
      ]);
      if (!evidenceLookup.has(evidenceSignature)) {
        evidenceLookup.set(evidenceSignature, evidence.length);
        evidence.push([point.period, point.definition, ...point.sources]);
      }
      const metricValue =
        point.value === null
          ? ""
          : Object.is(point.value, -0)
            ? "-0"
            : String(point.value);
      records.push(
        `${metricValue},${evidenceLookup.get(evidenceSignature).toString(36)}`,
      );
    }
    const schemaSignature = JSON.stringify(schema);
    if (!schemaLookup.has(schemaSignature)) {
      schemaLookup.set(schemaSignature, metricSchemas.length);
      metricSchemas.push(schema);
    }
    return [
      company.cik,
      company.ticker,
      company.name,
      COMPANY_STATUSES.indexOf(company.status),
      company.checked ? 1 : 0,
      company.period,
      schemaLookup.get(schemaSignature),
      records.join(";"),
      packFilings(company.cik, company.filings),
    ];
  });
  if (
    metricDescriptors.length > MAX_DESCRIPTORS ||
    evidence.length > MAX_EVIDENCE ||
    metricSchemas.length > MAX_COMPANIES
  )
    return value;
  const { definitions, definitionStrings } = packDefinitions(value.definitions);
  return {
    ...value,
    sources: value.sources.map(packSource),
    periods: value.periods.map(packPeriod),
    definitions,
    metricEncoding: V2_ENCODING,
    metricDescriptors,
    metricSchemas,
    evidenceDescriptors: makeChunks(
      evidence.map((entry) => entry.map((id) => id.toString(36)).join(".")),
    ),
    definitionStrings,
    companies,
  };
}

export function unpackPortfolioBaseline(value) {
  if (!value?.metricEncoding) return value;
  if (value.metricEncoding === V1_ENCODING) return unpackV1(value);
  if (value.metricEncoding === V2_ENCODING) return unpackV2(value);
  invalid("Invalid comparison checkpoint encoding.");
}
