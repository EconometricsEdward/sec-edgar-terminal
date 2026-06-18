'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Moon, SunMedium } from 'lucide-react';

const STORAGE_KEY = 'edgar-terminal-theme-tone';
const DEFAULT_TONE = 14;

function clampTone(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TONE;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function modeForTone(tone: number): 'dark' | 'balanced' | 'light' {
  if (tone < 36) return 'dark';
  if (tone < 68) return 'balanced';
  return 'light';
}

function applyTone(value: number) {
  if (typeof document === 'undefined') return;

  const tone = clampTone(value);
  const mode = modeForTone(tone);
  const root = document.documentElement;
  const body = document.body;

  root.dataset.themeTone = String(tone);
  root.dataset.themeMode = mode;

  root.classList.remove('et-dark', 'et-balanced', 'et-light');
  root.classList.add(`et-${mode}`);

  body?.classList.remove('et-dark', 'et-balanced', 'et-light');
  body?.classList.add(`et-${mode}`);

  root.style.setProperty('--theme-tone', String(tone));
  root.style.setProperty('--theme-light-pct', `${tone}%`);
  root.style.setProperty('--theme-dark-pct', `${100 - tone}%`);
  root.style.colorScheme = mode === 'light' ? 'light' : 'dark';
}

function toneLabel(tone: number): string {
  if (tone <= 24) return 'Dark';
  if (tone <= 58) return 'Balanced';
  if (tone <= 82) return 'Light';
  return 'Bright';
}

export default function ThemeToneSlider() {
  const [tone, setTone] = useState(DEFAULT_TONE);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const next = clampTone(stored == null ? DEFAULT_TONE : Number(stored));
    setTone(next);
    applyTone(next);
  }, []);

  const updateTone = (nextValue: number) => {
    const next = clampTone(nextValue);
    setTone(next);
    applyTone(next);
    window.localStorage.setItem(STORAGE_KEY, String(next));
  };

  const rangeStyle = {
    '--theme-tone-progress': `${tone}%`,
  } as CSSProperties & Record<string, string>;

  return (
    <div className="theme-tone-control" title="Adjust interface tone">
      <Moon className="theme-tone-icon" aria-hidden="true" />

      <label className="theme-tone-label">
        <span className="sr-only">Interface tone</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={tone}
          onChange={(event) => updateTone(Number(event.target.value))}
          className="theme-tone-range"
          style={rangeStyle}
          aria-label="Adjust interface tone from dark to light"
        />
      </label>

      <SunMedium className="theme-tone-icon" aria-hidden="true" />

      <output className="theme-tone-output" aria-live="polite">
        {toneLabel(tone)}
      </output>
    </div>
  );
}
