// Keep the prepaint runtime self-contained so production minification cannot rename
// an external dependency out from under the inline script.
function createReadingPreferencesRuntime() {
  const THEME_TONE_KEY = "edgar-terminal-theme-tone";
  const READING_PREFERENCES_KEY = "edgar:reading-preferences:v1";
  const READING_PREFERENCES_EVENT = "edgar:reading-preferences-change";
  /** @type {Readonly<{tone: number, textSize: string, density: string, motion: string}>} */
  const DEFAULT_READING_PREFERENCES = Object.freeze({
    tone: 14,
    textSize: "normal",
    density: "comfortable",
    motion: "system",
  });

  function normalizeReadingPreferences(value) {
    const input =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      tone:
        typeof input.tone === "number" && Number.isFinite(input.tone)
          ? Math.max(0, Math.min(100, Math.round(input.tone)))
          : DEFAULT_READING_PREFERENCES.tone,
      textSize: input.textSize === "large" ? "large" : "normal",
      density: input.density === "compact" ? "compact" : "comfortable",
      motion:
        input.motion === "reduced" || input.motion === "full"
          ? input.motion
          : "system",
    };
  }

  function readReadingPreferences(storage) {
    let settings = {};
    let tone = DEFAULT_READING_PREFERENCES.tone;
    let error = "";
    try {
      if (!storage) throw new Error("Storage is unavailable");
      const raw = storage.getItem(READING_PREFERENCES_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          parsed.version !== 1
        )
          throw new Error("Unsupported reading preferences");
        settings = parsed;
      }
    } catch {
      error =
        "Saved reading preferences could not be read. Changes still apply in this tab.";
    }
    try {
      if (!storage) throw new Error("Storage is unavailable");
      const rawTone = storage.getItem(THEME_TONE_KEY);
      // Preserve the existing slider key, but reject empty or nonnumeric values.
      if (
        rawTone !== null &&
        rawTone.trim() !== "" &&
        Number.isFinite(Number(rawTone))
      )
        tone = Number(rawTone);
    } catch {
      error =
        "Saved reading preferences could not be read. Changes still apply in this tab.";
    }
    return {
      preferences: normalizeReadingPreferences(
        Object.assign({}, settings, { tone }),
      ),
      error,
    };
  }

  function writeReadingPreferences(
    storage,
    patch,
    current = DEFAULT_READING_PREFERENCES,
  ) {
    // Read other controls afresh so a tone change does not overwrite another tab's text size.
    const saved = readReadingPreferences(storage);
    const preferences = normalizeReadingPreferences(
      Object.assign({}, saved.error ? current : saved.preferences, patch),
    );
    if (saved.error)
      return { preferences, error: saved.error, persisted: false };
    try {
      if (Object.hasOwn(patch, "tone"))
        storage.setItem(THEME_TONE_KEY, String(preferences.tone));
      if (
        ["textSize", "density", "motion"].some((key) =>
          Object.hasOwn(patch, key),
        )
      ) {
        storage.setItem(
          READING_PREFERENCES_KEY,
          JSON.stringify({
            version: 1,
            textSize: preferences.textSize,
            density: preferences.density,
            motion: preferences.motion,
          }),
        );
      }
      return { preferences, error: "", persisted: true };
    } catch {
      return {
        preferences,
        error:
          "Some reading preferences could not be saved. They still apply in this tab.",
        persisted: false,
      };
    }
  }

  function applyReadingPreferences(root, preferences) {
    if (!root) return;
    const next = normalizeReadingPreferences(preferences);
    const mode =
      next.tone < 36 ? "dark" : next.tone < 68 ? "balanced" : "light";
    root.dataset.themeTone = String(next.tone);
    root.dataset.themeMode = mode;
    root.dataset.readingText = next.textSize;
    root.dataset.readingDensity = next.density;
    root.dataset.readingMotion = next.motion;
    root.classList.remove("et-dark", "et-balanced", "et-light");
    root.classList.add(`et-${mode}`);
    root.style.setProperty("--theme-tone", String(next.tone));
    root.style.setProperty("--theme-light-pct", `${next.tone}%`);
    root.style.setProperty("--theme-dark-pct", `${100 - next.tone}%`);
    root.style.colorScheme = mode === "light" ? "light" : "dark";
  }

  function bootstrap(windowObject, documentObject) {
    let storage;
    try {
      storage = windowObject.localStorage;
    } catch {
      /* Session-only mode. */
    }
    applyReadingPreferences(
      documentObject.documentElement,
      readReadingPreferences(storage).preferences,
    );
  }
  return {
    THEME_TONE_KEY,
    READING_PREFERENCES_KEY,
    READING_PREFERENCES_EVENT,
    DEFAULT_READING_PREFERENCES,
    normalizeReadingPreferences,
    readReadingPreferences,
    writeReadingPreferences,
    applyReadingPreferences,
    bootstrap,
  };
}

export const {
  THEME_TONE_KEY,
  READING_PREFERENCES_KEY,
  READING_PREFERENCES_EVENT,
  DEFAULT_READING_PREFERENCES,
  normalizeReadingPreferences,
  readReadingPreferences,
  writeReadingPreferences,
  applyReadingPreferences,
} = createReadingPreferencesRuntime();

// Only application code is embedded; saved values are read at execution time.
export const READING_BOOTSTRAP_SCRIPT = `(${createReadingPreferencesRuntime.toString()})().bootstrap(window,document);`;
