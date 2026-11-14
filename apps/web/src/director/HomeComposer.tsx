import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { FORMAT_OPTIONS, LANGUAGE_OPTIONS, LENGTH_OPTIONS, type PromptPreferences } from './model';

/** Real requests this studio handles, shown one at a time in the empty home composer. */
export const EXAMPLE_PROMPTS = [
  'A 15-second Reel introducing our spring menu',
  'Three short videos for next week’s product launch',
  'A friendly welcome video for new customers',
  'A 30-second explainer for our booking app',
];

/**
 * The empty composer's example line. It changes every few seconds while the field is empty and the page
 * is visible; with reduced motion it stays on the first example. It is decoration (aria-hidden): the
 * field keeps its own placeholder for assistive technology.
 */
export function PromptCycle({ active }: { active: boolean }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setIndex((value) => (value + 1) % EXAMPLE_PROMPTS.length); }, 3800);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  return (
    <span className="prompt-cycle" aria-hidden="true">
      {/* Keyed: each example enters on its own; the previous one is already gone, so nothing overlaps. */}
      <span className="prompt-cycle-text" key={index}>{EXAMPLE_PROMPTS[index]}</span>
    </span>
  );
}

type Avatar = { id: string; name: string };
/**
 * Optional preferences for a new video, set as small pills in the composer. They start unset; what is
 * picked is written into the request as plain words, so the conversation shows exactly what was asked.
 */
export function PromptTokens({ prefs, onChange, presenters }: { prefs: PromptPreferences; onChange: (next: PromptPreferences) => void; presenters: Avatar[] }) {
  const token = (key: keyof PromptPreferences, label: string, options: ReadonlyArray<{ value: string; label: string }>) => (
    <label className="home-token" data-set={Boolean(prefs[key]) || undefined}>
      {/* The pill is drawn by this face; the native select sits on top of it, invisible, so pickers stay native. */}
      <span className="home-token-face" aria-hidden="true">{options.find((option) => option.value === prefs[key])?.label ?? label}<ChevronDown size={12} strokeWidth={2.25} /></span>
      <select aria-label={label} value={prefs[key] ?? ''} onChange={(event) => onChange({ ...prefs, [key]: event.target.value || undefined })}>
        <option value="">{label}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
  return (
    <div className="home-tokens" role="group" aria-label="Video preferences">
      {token('format', 'Format', FORMAT_OPTIONS)}
      {token('length', 'Length', LENGTH_OPTIONS)}
      {token('language', 'Language', LANGUAGE_OPTIONS)}
      {presenters.length > 0 && token('presenter', 'Presenter', presenters.map((avatar) => ({ value: avatar.id, label: avatar.name })))}
    </div>
  );
}
