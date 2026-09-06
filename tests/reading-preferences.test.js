import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  THEME_TONE_KEY,
  READING_PREFERENCES_KEY,
  DEFAULT_READING_PREFERENCES,
  normalizeReadingPreferences,
  readReadingPreferences,
  writeReadingPreferences,
  applyReadingPreferences,
  READING_BOOTSTRAP_SCRIPT,
} from "../src/utils/readingPreferences.js";

function storageOf(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}
function rootOf() {
  const classes = new Set();
  const properties = {};
  return {
    dataset: {},
    classes,
    properties,
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      remove(...names) {
        names.forEach((name) => classes.delete(name));
      },
    },
    style: {
      setProperty(name, value) {
        properties[name] = value;
      },
      colorScheme: "",
    },
  };
}

test("reading preferences accept only bounded tone and known display choices", () => {
  for (const value of [
    null,
    [],
    "large",
    42,
    { tone: NaN },
    { tone: Infinity },
    { tone: "100", textSize: "giant", density: "hidden", motion: "disable" },
  ])
    assert.deepEqual(
      normalizeReadingPreferences(value),
      DEFAULT_READING_PREFERENCES,
    );
  assert.deepEqual(
    normalizeReadingPreferences({
      tone: 120,
      textSize: "large",
      density: "compact",
      motion: "reduced",
      unknown: "ignored",
    }),
    { tone: 100, textSize: "large", density: "compact", motion: "reduced" },
  );
  assert.equal(normalizeReadingPreferences({ tone: -2 }).tone, 0);
  assert.equal(normalizeReadingPreferences({ tone: 49.6 }).tone, 50);
});

test("reading preferences migrate the existing tone key without overwriting it", () => {
  const storage = storageOf({
    [THEME_TONE_KEY]: "86",
    [READING_PREFERENCES_KEY]: JSON.stringify({
      version: 1,
      textSize: "large",
      density: "compact",
      motion: "system",
      tone: 2,
    }),
  });
  assert.deepEqual(readReadingPreferences(storage).preferences, {
    tone: 86,
    textSize: "large",
    density: "compact",
    motion: "system",
  });
  writeReadingPreferences(storage, { textSize: "normal" });
  assert.equal(storage.getItem(THEME_TONE_KEY), "86");
  assert.deepEqual(JSON.parse(storage.getItem(READING_PREFERENCES_KEY)), {
    version: 1,
    textSize: "normal",
    density: "compact",
    motion: "system",
  });
});

test("fresh preference writes preserve another tab's latest independent choices", () => {
  const storage = storageOf();
  const first = writeReadingPreferences(storage, {
    textSize: "large",
  }).preferences;
  writeReadingPreferences(storage, { density: "compact" });
  const result = writeReadingPreferences(storage, { tone: 71 }, first);
  assert.equal(result.persisted, true);
  assert.deepEqual(result.preferences, {
    tone: 71,
    textSize: "large",
    density: "compact",
    motion: "system",
  });
});

test("storage exceptions keep controls usable and cannot claim persistence", () => {
  const denied = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      assert.fail("Must not write after a read error");
    },
  };
  assert.deepEqual(
    readReadingPreferences(denied).preferences,
    DEFAULT_READING_PREFERENCES,
  );
  assert.ok(readReadingPreferences(undefined).error);
  const result = writeReadingPreferences(
    denied,
    { tone: 88, motion: "reduced" },
    { ...DEFAULT_READING_PREFERENCES, textSize: "large" },
  );
  assert.equal(result.persisted, false);
  assert.match(result.error, /apply in this tab/);
  assert.deepEqual(result.preferences, {
    tone: 88,
    textSize: "large",
    density: "comfortable",
    motion: "reduced",
  });
  const quota = storageOf();
  quota.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(
    writeReadingPreferences(quota, { density: "compact" }).persisted,
    false,
  );
});

test("malformed or future reading settings are preserved while safe tone still applies", () => {
  for (const raw of [
    "broken-json",
    "null",
    "[]",
    '{"version":2,"textSize":"large"}',
  ]) {
    const storage = storageOf({
      [READING_PREFERENCES_KEY]: raw,
      [THEME_TONE_KEY]: "75",
    });
    const result = writeReadingPreferences(storage, { density: "compact" });
    assert.equal(result.persisted, false);
    assert.equal(storage.getItem(READING_PREFERENCES_KEY), raw);
    assert.equal(readReadingPreferences(storage).preferences.tone, 75);
  }
  for (const tone of ["", " ", "NaN", "Infinity", "red"])
    assert.equal(
      readReadingPreferences(storageOf({ [THEME_TONE_KEY]: tone })).preferences
        .tone,
      14,
    );
});

test("prepaint script matches hydrated root attributes for all tone boundaries and settings", () => {
  for (const tone of [0, 14, 35, 36, 67, 68, 100]) {
    const storage = storageOf({
      [THEME_TONE_KEY]: String(tone),
      [READING_PREFERENCES_KEY]: JSON.stringify({
        version: 1,
        textSize: "large",
        density: "compact",
        motion: "reduced",
      }),
    });
    const root = rootOf();
    vm.runInNewContext(READING_BOOTSTRAP_SCRIPT, {
      window: { localStorage: storage },
      document: { documentElement: root },
    });
    const hydrated = rootOf();
    applyReadingPreferences(
      hydrated,
      readReadingPreferences(storage).preferences,
    );
    assert.deepEqual(root.dataset, hydrated.dataset);
    assert.deepEqual(root.properties, hydrated.properties);
    assert.deepEqual(root.classes, hydrated.classes);
    assert.equal(root.style.colorScheme, hydrated.style.colorScheme);
    assert.equal(
      root.dataset.themeMode,
      tone < 36 ? "dark" : tone < 68 ? "balanced" : "light",
    );
  }
});

test("prepaint tolerates an inaccessible storage getter and never interpolates saved script text", () => {
  const root = rootOf();
  vm.runInNewContext(READING_BOOTSTRAP_SCRIPT, {
    window: {
      get localStorage() {
        throw new Error("SecurityError");
      },
    },
    document: { documentElement: root },
  });
  assert.equal(root.dataset.themeTone, "14");
  assert.equal(root.dataset.readingMotion, "system");
  const malicious = storageOf({
    [READING_PREFERENCES_KEY]: JSON.stringify({
      version: 1,
      textSize: "</script><script>evil()</script>",
    }),
    [THEME_TONE_KEY]: "evil()",
  });
  vm.runInNewContext(READING_BOOTSTRAP_SCRIPT, {
    window: { localStorage: malicious },
    document: { documentElement: root },
  });
  assert.equal(root.dataset.readingText, "normal");
  assert.equal(root.dataset.themeTone, "14");
  assert.ok(!READING_BOOTSTRAP_SCRIPT.includes("</script>"));
});
