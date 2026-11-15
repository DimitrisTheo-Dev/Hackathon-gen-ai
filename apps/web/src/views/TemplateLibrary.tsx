import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { LibraryTemplate } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { Modal, Notice } from "../components/ui";
import "../templates.css";

const languageNames: Record<string, string> = { el: "Greek", en: "English" };
const FAMILIES: Array<{ family: LibraryTemplate["family"]; title: string; note: string }> = [
  { family: "face", title: "With a presenter", note: "A lip-synced presenter: a fictional person or an illustrated character, never a real one." },
  { family: "no_face", title: "Without a face", note: "Type, diagrams, charts and chat threads. Nobody has to be filmed." },
];

function seconds(range: [number, number]) {
  return `${range[0]} to ${range[1]} s`;
}

/**
 * The template library: short-form formats with a rendered sample each, read from the engine
 * (`GET /v1/templates/library`). Media links are signed and short-lived; a link that stops playing reloads the list.
 */
export function TemplateLibrary({ client }: { client: StudioClient }) {
  const [templates, setTemplates] = useState<LibraryTemplate[] | null>(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const reloads = useRef(0);
  const load = useCallback(() => {
    let active = true;
    client
      .listLibraryTemplates()
      .then((list) => { if (active) { setTemplates(list); setError(""); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "The templates could not be loaded."); });
    return () => { active = false; };
  }, [client]);
  useEffect(() => load(), [load]);
  // An expired signed link fails to load; fetch fresh links, at most a few times per visit.
  const refresh = useCallback(() => {
    if (reloads.current < 3) { reloads.current += 1; load(); }
  }, [load]);
  const open = templates?.find((t) => t.id === openId) ?? null;

  return (
    <div className="tl">
      <header className="tl-intro">
        <h1>Templates</h1>
        <p>Short-form formats for health content, each with a sample rendered in Greek. Pick the one that fits what you want to say.</p>
      </header>
      {error && <Notice error>{error}</Notice>}
      {templates === null && !error && (
        <p className="tl-loading" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Loading templates…</p>
      )}
      {templates?.length === 0 && <p className="tl-empty">No templates are published yet.</p>}
      {!!templates?.length &&
        FAMILIES.map(({ family, title, note }) => {
          const list = templates.filter((t) => t.family === family);
          if (!list.length) return null;
          return (
            <section className="tl-family" key={family} aria-labelledby={`tl-${family}`}>
              <div className="tl-family-head">
                <h2 id={`tl-${family}`}>{title}</h2>
                <p>{note}</p>
              </div>
              <ul className="tl-grid">
                {list.map((t) => (
                  <li key={t.id}>
                    <button className="tl-card" onClick={() => setOpenId(t.id)} aria-label={`${t.name}: ${t.useFor}`}>
                      <span className="tl-poster">
                        {t.posterUrl ? <img src={t.posterUrl} alt="" loading="lazy" decoding="async" onError={refresh} /> : null}
                      </span>
                      <span className="tl-card-text">
                        <strong>{t.name}</strong>
                        <span>{t.useFor}</span>
                        <small>{seconds(t.durationRange)}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      {open && <TemplateDetail template={open} onClose={() => setOpenId(null)} onExpired={refresh} />}
    </div>
  );
}

function TemplateDetail({ template: t, onClose, onExpired }: { template: LibraryTemplate; onClose: () => void; onExpired: () => void }) {
  const sources = [{ language: t.language, url: t.videoUrl }, ...t.variants];
  const [language, setLanguage] = useState(t.language);
  const src = sources.find((s) => s.language === language)?.url ?? t.videoUrl;
  return (
    <Modal title={t.name} onClose={onClose} wide>
      <div className="tl-detail">
        <div className="tl-player">
          {src ? (
            <video key={src} src={src} poster={t.posterUrl ?? undefined} controls playsInline preload="metadata" onError={onExpired} />
          ) : (
            <p className="tl-missing">The sample video is not available right now.</p>
          )}
          {sources.length > 1 && (
            <div className="segmented tl-languages" role="group" aria-label="Sample language">
              {sources.map((s) => (
                <button key={s.language} aria-pressed={language === s.language} onClick={() => setLanguage(s.language)}>
                  {languageNames[s.language] ?? s.language}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="tl-facts">
          <p className="tl-summary">{t.summary}</p>
          <dl>
            <div><dt>Use it for</dt><dd>{t.useFor}</dd></div>
            <div><dt>Length</dt><dd>{seconds(t.durationRange)}, 9:16, {t.fps} fps</dd></div>
            <div><dt>Voice</dt><dd>{t.voice}</dd></div>
            <div><dt>Sample</dt><dd>{t.sampleTopic} ({t.sampleSeconds.toFixed(0)} s, {t.languages.map((code) => languageNames[code] ?? code).join(" and ")})</dd></div>
            <div><dt>Type</dt><dd>{t.fonts.join(", ")}</dd></div>
          </dl>
          <h3>What a new video needs</h3>
          <p className="tl-note">A topic, your brand and a call to action, plus:</p>
          <ul className="tl-inputs">
            {t.inputs.map((input) => <li key={input.key}>{input.label}</li>)}
          </ul>
          <h3>The sample's script</h3>
          <ol className="tl-script">
            {t.script.map((line) => <li key={line.id}>{line.text}</li>)}
          </ol>
          {!!t.stills.length && (
            <>
              <h3>Every beat</h3>
              <ul className="tl-stills">
                {t.stills.map((s) => (
                  <li key={s.beat}>{s.url ? <img src={s.url} alt={`Beat: ${s.beat}`} loading="lazy" decoding="async" /> : null}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
