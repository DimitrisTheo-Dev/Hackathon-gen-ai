import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { LoaderCircle, Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";
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
function clock(value: number) {
  const whole = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
/** Posters fade in once decoded, so a slow signed link shows a calm frame instead of a half-drawn image. */
function shown(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.dataset.loaded = "";
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
                {list.map((t, index) => (
                  <li key={t.id}>
                    <button className="tl-card" onClick={() => setOpenId(t.id)} aria-label={`${t.name}: ${t.useFor}`}>
                      <span className="tl-poster">
                        {t.posterUrl ? <img src={t.posterUrl} alt="" loading={index < 5 ? "eager" : "lazy"} decoding="async" onLoad={shown} onError={refresh} /> : null}
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
            <SamplePlayer key={src} src={src} poster={t.posterUrl} title={t.name} onError={onExpired} />
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
              <ol className="tl-stills">
                {t.stills.map((s, index) => {
                  // Each still is one beat of the script; its spoken line names it, not the internal beat id.
                  const line = t.script.find((entry) => entry.id === s.beat)?.text ?? "";
                  return (
                    <li key={s.beat}>
                      {s.url ? <img src={s.url} alt={line ? `Beat ${index + 1}: ${line}` : `Beat ${index + 1}`} loading="lazy" decoding="async" onLoad={shown} /> : <span className="tl-still-missing" />}
                      <span className="tl-still-number" aria-hidden="true">{index + 1}</span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * A small player for the sample: play and pause on the frame or the button, a seek bar, time, sound and full screen.
 * Native controls draw the browser's own focus square, which this design cannot style; these controls take the
 * studio's ring, drawn white over the dark frame.
 */
function SamplePlayer({ src, poster, title, onError }: { src: string; poster: string | null; title: string; onError: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const toggle = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused || element.ended) void element.play().catch(() => undefined);
    else element.pause();
  };
  const fullscreen = () => {
    const element = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!element) return;
    if (frame.current?.requestFullscreen) void frame.current.requestFullscreen().catch(() => undefined);
    else element.webkitEnterFullscreen?.();
  };
  return (
    <div className="tl-video" ref={frame} data-playing={playing || undefined}>
      <video
        ref={video}
        src={src}
        poster={poster ?? undefined}
        playsInline
        preload="metadata"
        muted={muted}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onError={onError}
      />
      {!playing && (
        <button type="button" className="tl-video-big" aria-label={`Play the ${title} sample`} onClick={toggle}>
          <Play size={22} aria-hidden="true" />
        </button>
      )}
      <div className="tl-video-bar">
        <button type="button" className="tl-video-button" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <input
          type="range"
          className="tl-video-seek"
          aria-label="Position in the sample"
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(time, duration || 0)}
          style={{ "--progress": `${duration ? (time / duration) * 100 : 0}%` } as CSSProperties}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (video.current) video.current.currentTime = next;
            setTime(next);
          }}
        />
        <span className="tl-video-time" aria-hidden="true">{clock(time)} / {clock(duration)}</span>
        <button type="button" className="tl-video-button" aria-label={muted ? "Turn sound on" : "Mute"} aria-pressed={muted} onClick={() => setMuted(!muted)}>
          {muted ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="tl-video-button" aria-label="Full screen" onClick={fullscreen}>
          <Maximize size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
