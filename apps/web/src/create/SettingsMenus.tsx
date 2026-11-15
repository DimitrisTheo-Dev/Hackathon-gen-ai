import { useState, type KeyboardEvent } from "react";
import { languageOf } from "./languages";
import { isLength, LENGTHS, MAX_COPIES, MAX_SECONDS, MIN_SECONDS, type Language } from "./model";
import { LanguageList, Menu, Option } from "./Picker";
import { ASPECTS, FORMATS, lengthLabel, type VideoSettings } from "./settings";
// The menus' own styles. The home composer shows them before the New project flow has ever loaded.
import "./new-project.css";
import "./settings-menus.css";

const words = (seconds: number) => Math.round(seconds * 2.5);

/** A solid box in the frame's shape ("9:16", "16:9"…), fitted into a `size` square: a preview, not a label. */
function Frame({ ratio, size }: { ratio: string; size: number }) {
  const [w, h] = ratio.split(":").map(Number);
  const scale = size / Math.max(w, h);
  const width = Math.max(2, w * scale);
  const height = Math.max(2, h * scale);
  return (
    <svg className="np-frame" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect x={(size - width) / 2} y={(size - height) / 2} width={width} height={height} rx={Math.min(2.5, size / 7)} fill="currentColor" />
    </svg>
  );
}

/**
 * The Describe step's settings as dropdowns: length, format, frame shape, the video's language and its language
 * copies. The New project flow and the home composer both draw them from here, so the two always offer the same
 * choices. `made` lists the copies a saved project already has; the Copies menu is then locked to them.
 */
export function SettingsMenus({ value, onChange, made = null }: { value: VideoSettings; onChange: (change: Partial<VideoSettings>) => void; made?: Language[] | null }) {
  const language = languageOf(value.language);
  const copies = made ?? value.copies;
  const format = FORMATS.find((entry) => entry.id === value.platform) ?? FORMATS[0];
  const [vertical] = ASPECTS;
  return (
    <>
      <Menu label="Length" value={`≈ ${lengthLabel(value.seconds)}`}>
        {(close) => <LengthOptions seconds={value.seconds} onPick={(seconds) => { onChange({ seconds }); close(); }} />}
      </Menu>
      <Menu label="Format" value={format.label}>
        {(close) => (
          <div role="listbox" aria-label="Format">
            {FORMATS.map((entry) => (
              <Option key={entry.label} selected={value.platform === entry.id} onSelect={() => { onChange({ platform: entry.id }); close(); }}>
                {entry.label}
                <span className="np-option-sub">{entry.detail}</span>
              </Option>
            ))}
          </div>
        )}
      </Menu>
      <Menu label="Aspect" value={<><Frame ratio={vertical.ratio} size={12} />{vertical.label} <span className="np-ratio">{vertical.ratio}</span></>}>
        {(close) => (
          <>
            <div className="np-aspects" role="listbox" aria-label="Aspect ratio">
              {ASPECTS.map((aspect) => (
                <Option key={aspect.ratio} selected={aspect.ratio === vertical.ratio} disabled={!aspect.available} onSelect={close}>
                  <Frame ratio={aspect.ratio} size={16} />
                  {aspect.label}
                  <span className="np-ratio">{aspect.ratio}</span>
                </Option>
              ))}
            </div>
            <p className="np-menu-note np-aspects-note">Only vertical renders for now.</p>
          </>
        )}
      </Menu>
      <Menu label="Language" value={<><span className="np-flag" aria-hidden="true">{language.flag}</span>{language.native}</>}>
        {(close) => (
          <LanguageList
            label="Video language"
            selected={[value.language]}
            onPick={(code) => {
              onChange({ language: code, copies: value.copies.filter((entry) => entry !== code) });
              close();
            }}
          />
        )}
      </Menu>
      <Menu
        label="Copies"
        align="end"
        disabled={made !== null}
        hint={made !== null ? "Language copies are made when the project is first saved. Add more languages from the video studio." : undefined}
        value={
          copies.length ? (
            <span className="np-flags">
              {copies.map((code) => (
                <span key={code} className="np-flag" title={languageOf(code).name}>
                  {languageOf(code).flag}
                </span>
              ))}
              <span className="sr-only">{copies.map((code) => languageOf(code).name).join(", ")}</span>
            </span>
          ) : (
            "None"
          )
        }
      >
        {() => (
          <>
            <p className="np-menu-note">Also make this video in up to {MAX_COPIES} more languages. Each copy is its own draft in the project, translated when AI writing is connected.</p>
            <LanguageList
              label="Language copies"
              selected={value.copies}
              exclude={[value.language]}
              limit={MAX_COPIES}
              onPick={(code) => onChange({ copies: value.copies.includes(code) ? value.copies.filter((entry) => entry !== code) : [...value.copies, code].slice(0, MAX_COPIES) })}
            />
          </>
        )}
      </Menu>
    </>
  );
}

/**
 * The preset lengths, then "Custom…" for anything else up to the longest video that can be made (three minutes),
 * typed as minutes and seconds.
 */
function LengthOptions({ seconds, onPick }: { seconds: number; onPick: (seconds: number) => void }) {
  const preset = (LENGTHS as readonly number[]).includes(seconds);
  const [custom, setCustom] = useState(!preset);
  const [minutes, setMinutes] = useState(String(Math.floor(seconds / 60)));
  const [rest, setRest] = useState(String(seconds % 60).padStart(2, "0"));
  const total = Number(minutes || 0) * 60 + Number(rest || 0);
  const valid = /^\d{0,2}$/.test(minutes) && /^\d{0,2}$/.test(rest) && Number(rest || 0) < 60 && isLength(total);
  const set = () => valid && onPick(total);
  // Enter sets the length here; it never reaches a form the menu sits in (the home composer is one).
  const enter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    set();
  };
  return (
    <>
      <div role="listbox" aria-label="Length">
        {LENGTHS.map((entry) => (
          <Option key={entry} selected={seconds === entry} onSelect={() => onPick(entry)}>
            About {entry} seconds
            <span className="np-option-sub">≈ {words(entry)} words</span>
          </Option>
        ))}
        <Option selected={!preset} onSelect={() => setCustom(true)}>
          Custom…
          <span className="np-option-sub">{preset ? `Up to ${MAX_SECONDS / 60} minutes` : `${lengthLabel(seconds)} · ≈ ${words(seconds)} words`}</span>
        </Option>
      </div>
      {custom && (
        <div className="np-custom-length" role="group" aria-label="Custom length" onKeyDown={enter}>
          <label>
            <input inputMode="numeric" autoComplete="off" autoFocus value={minutes} maxLength={2} aria-label="Minutes" onChange={(event) => setMinutes(event.target.value.trim())} />
            <span aria-hidden="true">min</span>
          </label>
          <label>
            <input inputMode="numeric" autoComplete="off" value={rest} maxLength={2} aria-label="Seconds" onChange={(event) => setRest(event.target.value.trim())} />
            <span aria-hidden="true">s</span>
          </label>
          <button type="button" className="np-custom-set" disabled={!valid} onClick={set}>
            Set
          </button>
          <small className={valid ? undefined : "is-error"} role="status">
            {valid ? `≈ ${words(total)} words` : `Between ${MIN_SECONDS} seconds and ${MAX_SECONDS / 60} minutes. Longer videos can’t be rendered yet.`}
          </small>
        </div>
      )}
    </>
  );
}
