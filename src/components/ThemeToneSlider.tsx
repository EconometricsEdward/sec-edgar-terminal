"use client";

import { type CSSProperties } from "react";
import { Moon, SunMedium } from "lucide-react";

export default function ThemeToneSlider({
  tone = 14,
  onToneChange,
}: {
  tone?: number;
  onToneChange?: (tone: number) => void;
}) {
  const label = tone < 36 ? "Dark" : tone < 68 ? "Balanced" : "Light";
  const rangeStyle = { "--theme-tone-progress": `${tone}%` } as CSSProperties;

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
          onChange={(event) => onToneChange?.(Number(event.target.value))}
          className="theme-tone-range"
          style={rangeStyle}
          aria-label="Adjust interface tone from dark to light"
          aria-valuetext={`${label}, ${tone} of 100`}
        />
      </label>
      <SunMedium className="theme-tone-icon" aria-hidden="true" />
      <output className="theme-tone-output">{label}</output>
    </div>
  );
}
