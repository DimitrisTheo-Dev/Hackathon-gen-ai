import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { Check, Clapperboard, Image as ImageIcon, LoaderCircle, Music, Palette, Play, Plus, RotateCcw, Save, Trash2, Type, X } from "lucide-react";
import {
  COMPOSITION_HEIGHT,
  COMPOSITION_WIDTH,
  MAX_COMPOSITION_SECONDS,
  mediaUrlSchema,
  type BrollClip,
  type Campaign,
  type Composition,
  type CompositionCard,
  type CompositionDocument,
  type StudioContext,
} from "@castroom/contracts";
import { ApiError, type StudioClient } from "../data/client";
import { Notice } from "../components/ui";
import { operationKey } from "../lib/operation-key";
import { Reel, type ReelProps } from "../video/Reel";
import * as model from "../video/model";
import "../video/video.css";

type Tab = "captions" | "cards" | "broll" | "audio" | "style";
type Selection = { track: model.Track; id: string } | null;
interface Entry {
  base: CompositionDocument;
  value: Composition;
}
/** Unsaved edits survive switching studio views in this tab. Leaving the page with any of them asks first. */
const unsaved = new Map<string, Entry>();

const TABS: Array<{ id: Tab; label: string; icon: typeof Type }> = [
  { id: "captions", label: "Captions", icon: Type },
  { id: "cards", label: "Cards", icon: Clapperboard },
  { id: "broll", label: "B-roll", icon: ImageIcon },
  { id: "audio", label: "Presenter & music", icon: Music },
  { id: "style", label: "Style", icon: Palette },
];
const CARD_KINDS: Array<{ kind: CompositionCard["kind"]; label: string }> = [
  { kind: "title", label: "Title card" },
  { kind: "lower_third", label: "Lower third" },
  { kind: "cta", label: "Call to action" },
];

function message(error: unknown) {
  return error instanceof ApiError ? error.message : "Something went wrong. Your edits are still here; try again.";
}

/** Seconds input that lets people type freely and only re-formats when they leave the field. */
function TimeField({ label, value, max, disabled, onChange, onCommit }: { label: string; value: number; max: number; disabled: boolean; onChange: (seconds: number) => void; onCommit?: () => void }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <label className="time-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={0.1}
        min={0}
        max={max}
        value={text}
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onChange={(event) => {
          setText(event.target.value);
          if (Number.isFinite(event.target.valueAsNumber)) onChange(model.round(event.target.valueAsNumber));
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(value));
          onCommit?.();
        }}
      />
    </label>
  );
}

/** The video length applies only when the person leaves the field: shortening drops or trims clips. */
function LengthField({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (seconds: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0 && seconds !== value) onCommit(seconds);
    else setText(String(value));
  };
  return (
    <label className="time-field">
      <span>Length (s), up to {MAX_COMPOSITION_SECONDS}</span>
      <input
        type="number"
        inputMode="decimal"
        step={0.5}
        min={1}
        max={MAX_COMPOSITION_SECONDS}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </label>
  );
}

const TRACKS: Array<{ track: model.Track; label: string }> = [
  { track: "broll", label: "B-roll" },
  { track: "cards", label: "Cards" },
  { track: "captions", label: "Captions" },
];

/** Clip lanes with a playhead. Subscribes to the player itself so playback never re-renders the inspector. */
function Timeline({ composition, playerRef, selection, onSelect }: { composition: Composition; playerRef: RefObject<PlayerRef | null>; selection: Selection; onSelect: (track: model.Track, id: string, start: number, end: number) => void }) {
  const [frame, setFrame] = useState(0);
  const total = model.durationInFrames(composition);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const sync = (event: { detail: { frame: number } }) => setFrame(event.detail.frame);
    player.addEventListener("frameupdate", sync);
    player.addEventListener("seeked", sync);
    return () => {
      player.removeEventListener("frameupdate", sync);
      player.removeEventListener("seeked", sync);
    };
  }, [playerRef, composition.fps, total]);
  const seek = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    playerRef.current?.seekTo(Math.min(total - 1, Math.round(share * total)));
  };
  const pct = (seconds: number) => `${(Math.min(seconds, composition.durationSeconds) / composition.durationSeconds) * 100}%`;
  const ticks = Array.from({ length: Math.floor(composition.durationSeconds / 5) + 1 }, (_, index) => index * 5);
  return (
    <div className="video-timeline" aria-label="Timeline">
      <div className="timeline-row timeline-ruler">
        <span className="timeline-label">{model.timeLabel(frame / composition.fps)}</span>
        <div className="timeline-lane" onPointerDown={seek}>
          {ticks.map((second) => (
            <span key={second} className="timeline-tick" style={{ left: pct(second) }}>{second}s</span>
          ))}
        </div>
      </div>
      {composition.presenter.source !== "none" && (
        <div className="timeline-row">
          <span className="timeline-label">Presenter</span>
          <div className="timeline-lane" onPointerDown={seek}><span className="timeline-clip presenter" style={{ left: 0, width: "100%" }} /></div>
        </div>
      )}
      {TRACKS.map(({ track, label }) => (
        <div className="timeline-row" key={track}>
          <span className="timeline-label">{label}</span>
          <div className="timeline-lane" onPointerDown={seek}>
            {(composition[track] as model.Clip[]).filter((clip) => clip.end > clip.start).map((clip, index) => (
              <button
                key={clip.id}
                type="button"
                className={`timeline-clip ${track} ${selection?.id === clip.id ? "selected" : ""}`}
                style={{ left: pct(clip.start), width: `calc(${pct(clip.end - clip.start)} - 2px)` }}
                aria-label={`${label} ${index + 1}, ${model.timeLabel(clip.start)} to ${model.timeLabel(clip.end)}`}
                title={"text" in clip ? clip.text : "title" in clip ? clip.title : clip.url}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSelect(track, clip.id, clip.start, clip.end)}
              />
            ))}
          </div>
        </div>
      ))}
      {composition.music && (
        <div className="timeline-row">
          <span className="timeline-label">Music</span>
          <div className="timeline-lane" onPointerDown={seek}><span className="timeline-clip music" style={{ left: 0, width: "100%" }} /></div>
        </div>
      )}
      <div className="timeline-playhead" style={{ left: `calc(var(--timeline-pad) + var(--timeline-label) + (100% - 2 * var(--timeline-pad) - var(--timeline-label)) * ${Math.min(1, frame / Math.max(1, total - 1))})` }} aria-hidden="true" />
    </div>
  );
}

export default function VideoStudio({
  client,
  context,
  campaign,
  itemId,
  onSelectItem,
}: {
  client: StudioClient;
  context: StudioContext;
  campaign: Campaign;
  itemId: string | null;
  onSelectItem: (id: string) => void;
}) {
  const items = campaign.items.filter((entry) => entry.kind === "avatar_video");
  const item = items.find((entry) => entry.id === itemId) ?? items[0] ?? null;
  const key = item ? `${context.workspace.id}:${item.id}` : "";
  const [stored, setStored] = useState<Entry | null>(() => unsaved.get(key) ?? null);
  // An entry only ever applies to its own item, so a slow response for a previous video can never be edited or saved as this one.
  const entry = stored && item && stored.base.itemId === item.id ? stored : null;
  const requested = useRef(key);
  requested.current = key;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("captions");
  const [selection, setSelection] = useState<Selection>(null);
  const [brokenMedia, setBrokenMedia] = useState<string[]>([]);
  const [brollUrl, setBrollUrl] = useState("");
  const [brollMedia, setBrollMedia] = useState<BrollClip["media"]>("video");
  const [musicUrl, setMusicUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const playerRef = useRef<PlayerRef>(null);
  const canEdit = context.principal.scopes.includes("content:edit");

  const load = useCallback(
    async (discardLocal: boolean) => {
      if (!item) return;
      if (!discardLocal && unsaved.has(key)) {
        setStored(unsaved.get(key)!);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const document = await client.getComposition(item.id);
        if (requested.current !== key) return;
        unsaved.delete(key);
        setStored({ base: document, value: document.composition });
        setConflict(false);
      } catch (failure) {
        if (requested.current === key) setError(message(failure));
      } finally {
        if (requested.current === key) setLoading(false);
      }
    },
    [client, item?.id, key],
  );
  useEffect(() => {
    setStored(unsaved.get(key) ?? null);
    setSelection(null);
    setBrokenMedia([]);
    setNotice("");
    setConflict(false);
    void load(false);
  }, [key]);

  const dirty = !!entry && !model.sameComposition(entry.base.composition, entry.value);
  useEffect(() => {
    if (!entry) return;
    const own = `${context.workspace.id}:${entry.base.itemId}`;
    if (dirty) unsaved.set(own, entry);
    else unsaved.delete(own);
  }, [entry, dirty, context.workspace.id]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (unsaved.size) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const composition = entry?.value ?? null;
  const problems = useMemo(() => (composition ? model.issues(composition) : []), [composition]);
  // Only links still in the edit are reported; fixing or removing one clears its warning.
  const inUse = composition ? new Set([composition.presenter.url, composition.music?.url, entry?.base.presenterMedia?.url, ...composition.broll.map((clip) => clip.url)]) : new Set();
  const broken = brokenMedia.filter((url) => inUse.has(url));
  const invalidRows = new Set(problems.filter((problem) => problem.index !== null).map((problem) => `${problem.track}:${problem.index}`));
  const update = (change: (current: Composition) => Composition) => {
    if (!canEdit) return;
    setNotice("");
    setStored((current) => (current && current.base.itemId === item?.id ? { ...current, value: change(current.value) } : current));
  };
  const now = () => {
    const player = playerRef.current;
    return player && composition ? player.getCurrentFrame() / composition.fps : 0;
  };
  const seek = (seconds: number) => {
    if (!composition) return;
    playerRef.current?.seekTo(Math.min(model.durationInFrames(composition) - 1, model.toFrames(seconds, composition.fps)));
  };
  const select = (track: model.Track, id: string, start: number, end: number) => {
    setSelection({ track, id });
    setTab(track);
    // Land just inside the clip, after its fade-in, so what was clicked is what the preview shows.
    seek(start + Math.min(0.4, (end - start) / 2));
    requestAnimationFrame(() => document.getElementById(`clip-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const onMediaError = useCallback((url: string) => setBrokenMedia((current) => (current.includes(url) ? current : [...current, url])), []);
  const presenterUrl = entry?.base.presenterMedia?.url ?? null;
  const inputProps = useMemo<ReelProps>(() => ({ composition: composition!, presenterUrl, onMediaError }), [composition, presenterUrl, onMediaError]);

  async function save() {
    if (!entry || !item || saving || problems.length || !canEdit) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = { contentId: entry.base.itemId, expectedRevision: entry.base.revision, composition: entry.value };
      const document = await client.saveComposition({ ...payload, operationKey: await operationKey(context.workspace.id, "save_composition", payload) });
      unsaved.delete(`${context.workspace.id}:${document.itemId}`);
      // Edits typed while the save was in flight stay as unsaved changes on top of the new version.
      setStored((current) =>
        current && current.base.itemId === document.itemId
          ? { base: document, value: model.sameComposition(current.value, payload.composition) ? document.composition : current.value }
          : current,
      );
      setNotice(`Video edit saved as version ${document.revision}.`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "revision_conflict") setConflict(true);
      setError(message(failure));
    } finally {
      setSaving(false);
    }
  }
  function addLink(kind: "broll" | "music") {
    const url = (kind === "broll" ? brollUrl : musicUrl).trim();
    if (!mediaUrlSchema.safeParse(url).success) {
      setLinkError("Use an https link to a media file, without a password in it.");
      return;
    }
    setLinkError("");
    if (kind === "broll") {
      update((current) => model.addBroll(current, now(), url, brollMedia));
      setBrollUrl("");
    } else {
      update((current) => ({ ...current, music: { url, volume: 0.25 } }));
      setMusicUrl("");
    }
  }

  if (!item)
    return (
      <div className="empty-state video-empty">
        <Clapperboard size={36} />
        <h1>No presenter videos in this campaign yet.</h1>
        <p>Add a video draft on the canvas, then shape it here.</p>
      </div>
    );

  const status = !entry
    ? "Loading the video edit…"
    : dirty
      ? "Unsaved changes"
      : entry.base.revision === 0
        ? "First draft from the script. Not saved yet."
        : `Saved · version ${entry.base.revision}`;
  const max = composition?.durationSeconds ?? MAX_COMPOSITION_SECONDS;
  const readOnly = !canEdit;
  const rowClass = (track: model.Track, id: string, index: number) => `clip-row ${selection?.id === id ? "selected" : ""} ${invalidRows.has(`${track}:${index}`) ? "invalid" : ""}`;
  const rowTimes = (track: model.Track, clip: model.Clip) => (
    <>
      <button type="button" className="clip-seek" onClick={() => select(track, clip.id, clip.start, clip.end)} aria-label={`Play from ${model.timeLabel(clip.start)}`}>
        <Play size={12} aria-hidden="true" />
        {model.timeLabel(clip.start)}
      </button>
      <TimeField label="Start" value={clip.start} max={max} disabled={readOnly} onChange={(start) => update((current) => model.updateClip(current, track, clip.id, { start }))} onCommit={() => update((current) => model.sortTrack(current, track))} />
      <TimeField label="End" value={clip.end} max={max} disabled={readOnly} onChange={(end) => update((current) => model.updateClip(current, track, clip.id, { end }))} onCommit={() => update((current) => model.sortTrack(current, track))} />
    </>
  );
  const remove = (track: model.Track, id: string, label: string) => (
    <button type="button" className="icon-button clip-remove" aria-label={`Remove ${label}`} disabled={readOnly} onClick={() => update((current) => model.removeClip(current, track, id))}>
      <Trash2 size={15} />
    </button>
  );

  return (
    <div className="video-studio">
      <div className="video-head">
        <div className="video-head-title">
          <label className="sr-only" htmlFor="video-item">Video</label>
          <select id="video-item" value={item.id} onChange={(event) => onSelectItem(event.target.value)}>
            {items.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.title}</option>
            ))}
          </select>
          <small className={dirty ? "video-status dirty" : "video-status"} role="status">{status}</small>
        </div>
        <div className="video-head-actions">
          {dirty && canEdit && (
            <button className="button secondary" disabled={saving} onClick={() => update(() => entry!.base.composition)}>
              <RotateCcw size={14} />Discard changes
            </button>
          )}
          {canEdit && (
            <button className="button primary" disabled={!entry || saving || !!problems.length || (!dirty && entry.base.revision > 0)} onClick={() => void save()}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
              {saving ? "Saving…" : "Save video edit"}
            </button>
          )}
        </div>
      </div>
      {(error || notice || !canEdit || broken.length > 0 || problems.length > 0) && (
        <div className="video-feedback">
          {error && (
            <Notice error>
              {error}
              {conflict && <button className="text-button" onClick={() => void load(true)}>Load the latest version</button>}
              <button className="text-button" onClick={() => setError("")}>Dismiss</button>
            </Notice>
          )}
          {notice && (
            <div className="success-note" role="status">
              <Check size={15} />{notice}
              <button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={14} /></button>
            </div>
          )}
          {!canEdit && <Notice>Your role can watch this video edit but not change it.</Notice>}
          {broken.length > 0 && <Notice error>These links could not be played in the preview: {broken.join(", ")}</Notice>}
          {problems.length > 0 && (
            <Notice error>
              Fix these before saving: {problems.map((problem) => problem.message).join("; ")}.
            </Notice>
          )}
        </div>
      )}
      {!composition ? (
        <div className="video-loading">
          {loading ? <><LoaderCircle className="spin" size={18} /> Opening the video edit…</> : <button className="button secondary" onClick={() => void load(true)}>Try again</button>}
        </div>
      ) : (
        <div className="video-body">
          <section className="video-stage" aria-label="Preview">
            <div className="video-player-frame">
              <Player
                ref={playerRef}
                component={Reel}
                inputProps={inputProps}
                durationInFrames={model.durationInFrames(composition)}
                fps={composition.fps}
                compositionWidth={COMPOSITION_WIDTH}
                compositionHeight={COMPOSITION_HEIGHT}
                controls
                clickToPlay
                doubleClickToFullscreen
                spaceKeyToPlayOrPause
                style={{ width: "100%", height: "100%" }}
                errorFallback={() => <div className="video-player-error">The preview could not draw this frame. Check the last change.</div>}
              />
            </div>
            <Timeline composition={composition} playerRef={playerRef} selection={selection} onSelect={select} />
            <p className="video-note">Preview only. Exporting a finished MP4 is not connected yet. 1080 × 1920 · {composition.fps} fps · {model.timeLabel(composition.durationSeconds)}</p>
          </section>
          <section className="video-inspector" aria-label="Edit the video">
            <div className="segmented video-tabs" role="toolbar" aria-label="Edit">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                  <Icon size={14} />{label}
                  {id === "captions" || id === "cards" || id === "broll" ? <span className="tab-count">{composition[id].length}</span> : null}
                </button>
              ))}
            </div>
            {tab === "captions" && (
              <div className="video-panel">
                <div className="video-panel-head">
                  <p>Short pages of on-screen text. Each word lights up in turn.</p>
                  <div>
                    <button className="text-button" disabled={readOnly} onClick={() => update((current) => model.addCaption(current, now()))}><Plus size={13} />Add at playhead</button>
                    <button className="text-button" disabled={readOnly || !item.script.trim()} onClick={() => update((current) => model.captionsFromItemScript(current, item.script))}><RotateCcw size={13} />Rebuild from script</button>
                  </div>
                </div>
                <ol className="clip-list">
                  {composition.captions.map((cue, index) => (
                    <li key={cue.id} id={`clip-${cue.id}`} className={rowClass("captions", cue.id, index)}>
                      <div className="clip-times">{rowTimes("captions", cue)}{remove("captions", cue.id, `caption ${index + 1}`)}</div>
                      <input aria-label={`Caption ${index + 1} text`} value={cue.text} maxLength={140} disabled={readOnly} onChange={(event) => update((current) => model.updateClip(current, "captions", cue.id, { text: event.target.value }))} />
                    </li>
                  ))}
                </ol>
                {!composition.captions.length && <p className="video-empty-line">No captions. Add one at the playhead or rebuild them from the script.</p>}
              </div>
            )}
            {tab === "cards" && (
              <div className="video-panel">
                <div className="video-panel-head">
                  <p>Titles, name tags and a closing call to action.</p>
                  <div>
                    {CARD_KINDS.map(({ kind, label }) => (
                      <button key={kind} className="text-button" disabled={readOnly} onClick={() => update((current) => model.addCard(current, kind, now()))}><Plus size={13} />{label}</button>
                    ))}
                  </div>
                </div>
                <ol className="clip-list">
                  {composition.cards.map((card, index) => (
                    <li key={card.id} id={`clip-${card.id}`} className={rowClass("cards", card.id, index)}>
                      <div className="clip-times">{rowTimes("cards", card)}{remove("cards", card.id, `card ${index + 1}`)}</div>
                      <div className="clip-fields">
                        <select aria-label={`Card ${index + 1} type`} value={card.kind} disabled={readOnly} onChange={(event) => update((current) => model.updateClip(current, "cards", card.id, { kind: event.target.value as CompositionCard["kind"] }))}>
                          {CARD_KINDS.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}
                        </select>
                        <input aria-label={`Card ${index + 1} title`} placeholder="Title" value={card.title} maxLength={80} disabled={readOnly} onChange={(event) => update((current) => model.updateClip(current, "cards", card.id, { title: event.target.value }))} />
                        <input aria-label={`Card ${index + 1} subtitle`} placeholder="Subtitle (optional)" value={card.subtitle} maxLength={140} disabled={readOnly} onChange={(event) => update((current) => model.updateClip(current, "cards", card.id, { subtitle: event.target.value }))} />
                      </div>
                    </li>
                  ))}
                </ol>
                {!composition.cards.length && <p className="video-empty-line">No cards yet.</p>}
              </div>
            )}
            {tab === "broll" && (
              <div className="video-panel">
                <div className="video-panel-head">
                  <p>Cutaway clips and images. Use https links to files you have the rights to use; each viewer's browser loads them.</p>
                </div>
                {canEdit && (
                  <form className="link-form" onSubmit={(event) => { event.preventDefault(); addLink("broll"); }}>
                    <input type="url" inputMode="url" aria-label="B-roll link" placeholder="https://… .mp4 or .jpg" value={brollUrl} onChange={(event) => setBrollUrl(event.target.value)} />
                    <select aria-label="B-roll type" value={brollMedia} onChange={(event) => setBrollMedia(event.target.value as BrollClip["media"])}>
                      <option value="video">Video</option>
                      <option value="image">Image</option>
                    </select>
                    <button className="button secondary" disabled={!brollUrl.trim()}><Plus size={14} />Add at playhead</button>
                  </form>
                )}
                {linkError && tab === "broll" && <p className="field-error" role="alert">{linkError}</p>}
                <ol className="clip-list">
                  {composition.broll.map((clip, index) => (
                    <li key={clip.id} id={`clip-${clip.id}`} className={rowClass("broll", clip.id, index)}>
                      <div className="clip-times">
                        {rowTimes("broll", clip)}
                        {clip.media === "video" && <TimeField label="Trim" value={clip.trimStart} max={MAX_COMPOSITION_SECONDS} disabled={readOnly} onChange={(trimStart) => update((current) => model.updateClip(current, "broll", clip.id, { trimStart }))} />}
                        {remove("broll", clip.id, `b-roll clip ${index + 1}`)}
                      </div>
                      <div className="clip-fields">
                        <select aria-label={`B-roll ${index + 1} layout`} value={clip.layout} disabled={readOnly} onChange={(event) => update((current) => model.updateClip(current, "broll", clip.id, { layout: event.target.value as BrollClip["layout"] }))}>
                          <option value="split">Split screen</option>
                          <option value="full">Full frame</option>
                        </select>
                        <input aria-label={`B-roll ${index + 1} link`} value={clip.url} disabled={readOnly} onChange={(event) => update((current) => model.updateClip(current, "broll", clip.id, { url: event.target.value.trim() }))} />
                      </div>
                    </li>
                  ))}
                </ol>
                {!composition.broll.length && <p className="video-empty-line">No b-roll yet.</p>}
              </div>
            )}
            {tab === "audio" && (
              <div className="video-panel">
                <fieldset className="video-fieldset" disabled={readOnly}>
                  <legend>Presenter</legend>
                  <div className="field">
                    <label htmlFor="presenter-source">Source</label>
                    <select id="presenter-source" value={composition.presenter.source} onChange={(event) => update((current) => ({ ...current, presenter: { ...current.presenter, source: event.target.value as Composition["presenter"]["source"] } }))}>
                      <option value="item_media">Rendered presenter video</option>
                      <option value="url">Linked clip</option>
                      <option value="none">No presenter</option>
                    </select>
                    {composition.presenter.source === "item_media" && (
                      <small>
                        {entry!.base.presenterMedia
                          ? `Rendered clip, ${model.timeLabel(entry!.base.presenterMedia.durationSeconds)} long.`
                          : "Not rendered yet. The preview shows a placeholder until the presenter video is rendered."}
                      </small>
                    )}
                  </div>
                  {composition.presenter.source === "url" && (
                    <div className="field">
                      <label htmlFor="presenter-url">Clip link</label>
                      <input id="presenter-url" type="url" inputMode="url" placeholder="https://… .mp4" value={composition.presenter.url ?? ""} onChange={(event) => update((current) => ({ ...current, presenter: { ...current.presenter, url: event.target.value.trim() || null } }))} />
                    </div>
                  )}
                  {composition.presenter.source !== "none" && (
                    <div className="video-inline-fields">
                      <TimeField label="Start the clip at (s)" value={composition.presenter.trimStart} max={MAX_COMPOSITION_SECONDS} disabled={readOnly} onChange={(trimStart) => update((current) => ({ ...current, presenter: { ...current.presenter, trimStart } }))} />
                      <label className="range-field">
                        <span>Voice volume {Math.round(composition.presenter.volume * 100)}%</span>
                        <input type="range" min={0} max={1} step={0.05} value={composition.presenter.volume} onChange={(event) => update((current) => ({ ...current, presenter: { ...current.presenter, volume: Number(event.target.value) } }))} />
                      </label>
                    </div>
                  )}
                  {entry!.base.presenterMedia && Math.abs(entry!.base.presenterMedia.durationSeconds - composition.durationSeconds) > 0.05 && (
                    <button type="button" className="text-button" onClick={() => update((current) => model.setDuration(current, entry!.base.presenterMedia!.durationSeconds))}>
                      Match the video length to the presenter clip
                    </button>
                  )}
                </fieldset>
                <fieldset className="video-fieldset" disabled={readOnly}>
                  <legend>Music</legend>
                  {composition.music ? (
                    <>
                      <div className="field">
                        <label htmlFor="music-url">Track link</label>
                        <input id="music-url" type="url" value={composition.music.url} onChange={(event) => update((current) => ({ ...current, music: current.music && { ...current.music, url: event.target.value.trim() } }))} />
                      </div>
                      <div className="video-inline-fields">
                        <label className="range-field">
                          <span>Music volume {Math.round(composition.music.volume * 100)}%</span>
                          <input type="range" min={0} max={1} step={0.05} value={composition.music.volume} onChange={(event) => update((current) => ({ ...current, music: current.music && { ...current.music, volume: Number(event.target.value) } }))} />
                        </label>
                        <button type="button" className="text-button" onClick={() => update((current) => ({ ...current, music: null }))}><Trash2 size={13} />Remove music</button>
                      </div>
                    </>
                  ) : (
                    <form className="link-form" onSubmit={(event) => { event.preventDefault(); addLink("music"); }}>
                      <input type="url" inputMode="url" aria-label="Music link" placeholder="https://… .mp3" value={musicUrl} onChange={(event) => setMusicUrl(event.target.value)} />
                      <button className="button secondary" disabled={!musicUrl.trim()}><Plus size={14} />Add music</button>
                    </form>
                  )}
                  {linkError && tab === "audio" && <p className="field-error" role="alert">{linkError}</p>}
                  <small className="video-hint">Music plays under the whole video and loops if it is shorter. Use tracks you are licensed to publish.</small>
                </fieldset>
              </div>
            )}
            {tab === "style" && (
              <div className="video-panel">
                <fieldset className="video-fieldset" disabled={readOnly}>
                  <legend>Look</legend>
                  <div className="video-inline-fields">
                    <label className="color-field"><span>Accent</span><input type="color" value={composition.style.accent} onChange={(event) => update((current) => ({ ...current, style: { ...current.style, accent: event.target.value } }))} /></label>
                    <label className="color-field"><span>Background</span><input type="color" value={composition.style.background} onChange={(event) => update((current) => ({ ...current, style: { ...current.style, background: event.target.value } }))} /></label>
                  </div>
                  <div className="video-inline-fields">
                    <label className="select-field">
                      <span>Captions</span>
                      <select value={composition.style.captionPosition} onChange={(event) => update((current) => ({ ...current, style: { ...current.style, captionPosition: event.target.value as Composition["style"]["captionPosition"] } }))}>
                        <option value="bottom">Lower third of the frame</option>
                        <option value="center">Center of the frame</option>
                      </select>
                    </label>
                    <label className="select-field">
                      <span>Caption size</span>
                      <select value={composition.style.captionSize} onChange={(event) => update((current) => ({ ...current, style: { ...current.style, captionSize: event.target.value as Composition["style"]["captionSize"] } }))}>
                        <option value="large">Large</option>
                        <option value="medium">Medium</option>
                      </select>
                    </label>
                  </div>
                </fieldset>
                <fieldset className="video-fieldset" disabled={readOnly}>
                  <legend>Timing</legend>
                  <div className="video-inline-fields">
                    <LengthField value={composition.durationSeconds} disabled={readOnly} onCommit={(seconds) => update((current) => model.setDuration(current, seconds))} />
                    <label className="select-field">
                      <span>Frame rate</span>
                      <select value={composition.fps} onChange={(event) => update((current) => ({ ...current, fps: Number(event.target.value) as Composition["fps"] }))}>
                        <option value={24}>24 fps</option>
                        <option value={25}>25 fps</option>
                        <option value={30}>30 fps</option>
                      </select>
                    </label>
                  </div>
                </fieldset>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
