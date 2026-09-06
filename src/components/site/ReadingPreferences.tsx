"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import ThemeToneSlider from "../ThemeToneSlider";
import {
  DEFAULT_READING_PREFERENCES,
  READING_PREFERENCES_KEY,
  READING_PREFERENCES_EVENT,
  THEME_TONE_KEY,
  applyReadingPreferences,
  normalizeReadingPreferences,
  readReadingPreferences,
  writeReadingPreferences,
} from "../../utils/readingPreferences.js";
import styles from "./ReadingPreferences.module.css";

type Preferences = {
  tone: number;
  textSize: string;
  density: string;
  motion: string;
};

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export default function ReadingPreferences() {
  const [preferences, setPreferences] = useState<Preferences>(
    DEFAULT_READING_PREFERENCES,
  );
  const [message, setMessage] = useState("");
  const details = useRef<HTMLDetailsElement>(null);
  const unsaved = useRef<Partial<Preferences>>({});

  useEffect(() => {
    const restore = () => {
      const result = readReadingPreferences(browserStorage());
      const next = normalizeReadingPreferences({
        ...result.preferences,
        ...unsaved.current,
      });
      setPreferences(next);
      setMessage(
        Object.keys(unsaved.current).length
          ? "Some reading preferences could not be saved. They still apply in this tab."
          : result.error,
      );
      applyReadingPreferences(document.documentElement, next);
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === READING_PREFERENCES_KEY ||
        event.key === THEME_TONE_KEY
      )
        restore();
    };
    restore();
    window.addEventListener("storage", onStorage);
    window.addEventListener(READING_PREFERENCES_EVENT, restore);
    const onPointerDown = (event: PointerEvent) => {
      if (
        details.current?.open &&
        !details.current.contains(event.target as Node)
      )
        details.current.open = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(READING_PREFERENCES_EVENT, restore);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  const update = (patch: Partial<Preferences>) => {
    const pending = { ...unsaved.current, ...patch };
    const result = writeReadingPreferences(
      browserStorage(),
      pending,
      preferences,
    );
    unsaved.current = result.persisted ? {} : pending;
    setPreferences(result.preferences);
    setMessage(result.error || "Reading preferences saved on this device.");
    applyReadingPreferences(document.documentElement, result.preferences);
  };

  return (
    <details
      ref={details}
      className={styles.control}
      onKeyDown={(event) => {
        if (event.key === "Escape" && details.current?.open) {
          details.current.open = false;
          details.current.querySelector("summary")?.focus();
          event.stopPropagation();
        }
      }}
    >
      <summary className={styles.trigger}>
        <SlidersHorizontal size={15} aria-hidden="true" />
        <span>Reading</span>
      </summary>
      <div className={styles.panel} aria-label="Reading preferences">
        <div className={styles.heading}>
          <strong>Make room for the research</strong>
          <span>Preferences apply across EDGAR Terminal.</span>
        </div>
        <div className={styles.field}>
          <span>Interface tone</span>
          <ThemeToneSlider
            tone={preferences.tone}
            onToneChange={(tone) => update({ tone })}
          />
        </div>
        <label className={styles.field}>
          <span>Reading text</span>
          <select
            value={preferences.textSize}
            onChange={(event) => update({ textSize: event.target.value })}
          >
            <option value="normal">Standard</option>
            <option value="large">Larger paragraphs</option>
          </select>
          <small>Enlarges explanations and source passages.</small>
        </label>
        <label className={styles.field}>
          <span>Result density</span>
          <select
            value={preferences.density}
            onChange={(event) => update({ density: event.target.value })}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact tables</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>Motion</span>
          <select
            value={preferences.motion}
            onChange={(event) => update({ motion: event.target.value })}
          >
            <option value="system">Follow device preference</option>
            <option value="reduced">Reduce animations</option>
            <option value="full">Allow animations</option>
          </select>
        </label>
        <button
          className={styles.reset}
          type="button"
          onClick={() => update(DEFAULT_READING_PREFERENCES)}
        >
          Reset reading preferences
        </button>
        <p className={styles.message} role="status">
          {message || "Saved in this browser. No account required."}
        </p>
      </div>
    </details>
  );
}
