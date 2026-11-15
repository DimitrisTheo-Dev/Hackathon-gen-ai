import { useEffect, useState } from 'react';
import { SettingsMenus } from '../create/SettingsMenus';
import { defaultSettings } from '../create/settings';
import type { PromptPreferences } from './model';

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

/**
 * The New project flow's own settings, as pills in the composer: length, format, the video's language and its
 * language copies. They show the flow's defaults; what the person changes is carried into the flow when the request
 * opens it, or written into the request as plain words when it goes to the Director.
 */
export function PromptTokens({ prefs, onChange }: { prefs: PromptPreferences; onChange: (next: PromptPreferences) => void }) {
  const [defaults] = useState(defaultSettings);
  return (
    <div className="home-tokens" role="group" aria-label="Video settings">
      <SettingsMenus value={{ ...defaults, ...prefs }} onChange={(change) => onChange({ ...prefs, ...change })} />
    </div>
  );
}
