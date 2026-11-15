import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { CircleAlert, Captions, Check, Clapperboard, FileStack, Film, LoaderCircle, Package, Palette, Play, Plus, RotateCcw, Save, Trash2, Type, Video, X } from "lucide-react";
import {
  COMPOSITION_HEIGHT,
  COMPOSITION_WIDTH,
  MAX_COMPOSITION_SECONDS,
  mediaUrlSchema,
  type AudioClip,
  type Campaign,
  type Composition,
  type CompositionCard,
  type CompositionDocument,
  type DraftFile,
  type ReelRender,
  type StudioContext,
  type VideoClip,
} from "@castroom/contracts";
import { ApiError, type StudioClient } from "../data/client";
import { Notice } from "../components/ui";
import { operationKey } from "../lib/operation-key";
import { Reel, sourceUrl, type ReelMedia, type ReelProps } from "../video/Reel";
import { Timeline, type Selection } from "../video/Timeline";
import { FilesPanel, type FileAction, type UploadRequest } from "../video/FilesPanel";
import { CommitField, RangeField, TimeField, TransitionField } from "../video/fields";
import { putToStorage } from "../video/upload";
import { ShowProduct } from "../video/ShowProduct";
import * as model from "../video/model";
import "../video/video.css";

type Tab = "timeline" | "cards" | "captions" | "transcript" | "files" | "look" | "render";
interface Entry {
  base: CompositionDocument;
  value: Composition;
}
/** Unsaved edits survive switching studio views in this tab. Leaving the page with any of them asks first. */
const unsaved = new Map<string, Entry>();

const TABS: Array<{ id: Tab; label: string; icon: typeof Type }> = [
  { id: "timeline", label: "Video & audio", icon: Video },
  { id: "cards", label: "Cards", icon: Clapperboard },
  { id: "captions", label: "Captions", icon: Captions },
  { id: "transcript", label: "Transcript", icon: Type },
  { id: "files", label: "Files", icon: FileStack },
  { id: "look", label: "Look & labels", icon: Palette },
  { id: "render", label: "Render", icon: Film },
];
const CARD_KINDS: Array<{ kind: CompositionCard["kind"]; label: string }> = [
  { kind: "title", label: "Title card" },
  { kind: "lower_third", label: "Lower third" },
  { kind: "statement", label: "Statement" },
  { kind: "cta", label: "Call to action" },
];
const RENDER_STATES: Record<ReelRender["state"], string> = { queued: "Waiting for a render worker", rendering: "Rendering", succeeded: "Finished", failed: "Failed", cancelled: "Cancelled" };

function message(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Your edits are still here; try again.";
}

export default function VideoStudio({ client, context, campaign, itemId, onSelectItem }: { client: StudioClient; context: StudioContext; campaign: Campaign; itemId: string | null; onSelectItem: (id: string) => void }) {
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
  const [tab, setTab] = useState<Tab>("timeline");
  const [selection, setSelection] = useState<Selection>(null);
  const [brokenMedia, setBrokenMedia] = useState<string[]>([]);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [renders, setRenders] = useState<ReelRender[]>([]);
  const [rendering, setRendering] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkKind, setLinkKind] = useState<"video" | "image" | "voice" | "music" | "sfx">("video");
  const [linkError, setLinkError] = useState("");
  const [wordIndex, setWordIndex] = useState<number | null>(null);
  const [shiftBy, setShiftBy] = useState(0);
  const [showingProduct, setShowingProduct] = useState(false);
  // After a product is placed, the preview jumps to it once the new timeline is in.
  const [seekAfterLoad, setSeekAfterLoad] = useState<number | null>(null);
  const playerRef = useRef<PlayerRef>(null);
  const scopes = context.principal.scopes;
  const canEdit = scopes.includes("content:edit");
  const canRender = scopes.includes("render:write");
  // Only products with a photo can be shown; without any, the control is not offered at all.
  const showable = context.products.filter((product) => product.hasImage);

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
  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      setFiles(await client.listFiles(campaign.id));
    } catch (failure) {
      setError(message(failure));
    } finally {
      setFilesLoading(false);
    }
  }, [client, campaign.id]);
  const loadRenders = useCallback(async () => {
    if (!item) return;
    try {
      const list = await client.listRenders(item.id);
      if (requested.current === key) setRenders(list);
    } catch {
      /* Render history is secondary; the edit stays usable without it. */
    }
  }, [client, item?.id, key]);
  useEffect(() => {
    setStored(unsaved.get(key) ?? null);
    setSelection(null);
    setBrokenMedia([]);
    setNotice("");
    setConflict(false);
    setRenders([]);
    setWordIndex(null);
    void load(false);
    void loadRenders();
  }, [key]);
  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);
  // While a render waits or runs, check on it every few seconds.
  const active = renders.some((render) => render.state === "queued" || render.state === "rendering");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void loadRenders();
      void loadFiles();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, loadRenders, loadFiles]);

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
  const invalidRows = new Set(problems.filter((problem) => problem.index !== null).map((problem) => `${problem.track}:${problem.index}`));
  const fileById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  // Links come from the saved document and from the files list, so a file added since the last save still plays.
  const media = useMemo<ReelMedia>(() => {
    const resolved: ReelMedia["files"] = {};
    for (const [id, value] of Object.entries(entry?.base.files ?? {})) resolved[id] = { url: value.url, mime: value.mime };
    for (const file of files) if (file.state === "ready" && file.url) resolved[file.id] = { url: file.url, mime: file.mime };
    return { itemMedia: entry?.base.itemMedia?.url ?? null, files: resolved };
  }, [entry?.base, files]);
  const inUse = composition ? new Set([...composition.video, ...composition.audio].map((clip) => sourceUrl(clip.source, media))) : new Set<string | null>();
  const broken = brokenMedia.filter((url) => inUse.has(url));
  const onMediaError = useCallback((url: string) => setBrokenMedia((current) => (current.includes(url) ? current : [...current, url])), []);
  const inputProps = useMemo<ReelProps>(() => ({ composition: composition!, media, onMediaError }), [composition, media, onMediaError]);

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
  const select = (track: model.Track, clip: model.Clip) => {
    setSelection({ track, id: clip.id });
    setTab(track === "video" || track === "audio" ? "timeline" : track);
    // Land just inside the clip, after its fade-in, so what was clicked is what the preview shows.
    seek(clip.start + Math.min(0.4, (clip.end - clip.start) / 2));
    requestAnimationFrame(() => document.getElementById(`clip-${clip.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  useEffect(() => {
    if (seekAfterLoad === null || !composition) return;
    const at = seekAfterLoad;
    setSeekAfterLoad(null);
    // One frame later, so the player has the new timeline's length before it seeks into it.
    requestAnimationFrame(() => seek(at + 0.4));
  }, [seekAfterLoad, composition]);
  const sourceName = (source: VideoClip["source"]) =>
    source.kind === "item_media" ? (entry?.base.itemMedia ? "Rendered presenter video" : "Rendered presenter video (not rendered yet)") : source.kind === "url" ? source.url : (fileById.get(source.fileId)?.name ?? entry?.base.files[source.fileId]?.name ?? "A file that is not ready");
  const labelFor = (track: model.Track, clip: model.Clip) => ("text" in clip ? clip.text : "title" in clip ? clip.title : "source" in clip ? sourceName(clip.source) : track);

  async function save() {
    if (!entry || saving || problems.length || !canEdit) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = { contentId: entry.base.itemId, expectedRevision: entry.base.revision, composition: entry.value };
      const document = await client.saveComposition({ ...payload, operationKey: await operationKey(context.workspace.id, "save_composition", payload) });
      unsaved.delete(`${context.workspace.id}:${document.itemId}`);
      // Edits typed while the save was in flight stay as unsaved changes on top of the new version.
      setStored((current) => (current && current.base.itemId === document.itemId ? { base: document, value: model.sameComposition(current.value, payload.composition) ? document.composition : current.value } : current));
      setNotice(`Video edit saved as version ${document.revision}.`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "revision_conflict") setConflict(true);
      setError(message(failure));
    } finally {
      setSaving(false);
    }
  }
  async function uploadFile(request: UploadRequest) {
    if (!item) return;
    const fields = { campaignId: campaign.id, itemId: item.id, kind: request.kind, name: request.name, mime: request.mime, bytes: request.bytes, sha256: request.sha256, durationSeconds: request.durationSeconds, meta: {} };
    const ticket = await client.requestUpload({ ...fields, operationKey: await operationKey(context.workspace.id, "request_file_upload", fields) });
    await putToStorage(ticket, request.file);
    if (ticket.upload) await client.completeUpload({ fileId: ticket.file.id, operationKey: crypto.randomUUID() });
    await loadFiles();
    setNotice(`${request.name} saved as a draft file.`);
  }
  async function saveText(input: { kind: DraftFile["kind"]; name: string; mime: "text/markdown" | "text/plain" | "application/json"; text: string }) {
    const fields = { campaignId: campaign.id, itemId: item?.id ?? null, ...input, durationSeconds: null, meta: {} };
    await client.saveTextFile({ ...fields, operationKey: await operationKey(context.workspace.id, "save_text_file", fields) });
    await loadFiles();
    setNotice(`${input.name} saved as a draft file.`);
  }
  async function archive(file: DraftFile) {
    if (!window.confirm(`Archive ${file.name}? It disappears from the list and can no longer be added to a timeline.`)) return;
    try {
      await client.archiveFile({ fileId: file.id, operationKey: crypto.randomUUID() });
      await loadFiles();
    } catch (failure) {
      setError(message(failure));
    }
  }
  async function useFile(file: DraftFile, action: FileAction) {
    const at = now();
    const length = file.durationSeconds ?? 4;
    const source = { kind: "file" as const, fileId: file.id };
    if (action.kind === "audio") update((current) => model.addAudioClip(current, { source, role: action.role, at: action.role === "music" ? 0 : at, length: action.role === "music" ? current.durationSeconds : length }));
    else if (action.kind === "video") update((current) => model.addVideoClip(current, { source, media: "video", at, length, layer: action.layer }));
    else if (action.kind === "image" && action.target === "overlay") update((current) => model.addVideoClip(current, { source, media: "image", at, length: 3, layer: 1 }));
    else if (action.kind === "image") update((current) => model.addCard(current, "statement", at, file.id));
    else if (action.kind === "transcript" && file.url) {
      try {
        const words = model.parseWords(await (await fetch(file.url, { credentials: "omit" })).text());
        update((current) => model.captionsFromTranscript({ ...current, transcript: { language: current.transcript?.language ?? item?.language ?? "en", words, sourceFileId: file.id } }));
        setTab("transcript");
        setNotice(`${words.length} words loaded. Captions were rebuilt from them.`);
        return;
      } catch (failure) {
        setError(message(failure));
        return;
      }
    }
    setTab(action.kind === "image" && action.target === "statement" ? "cards" : "timeline");
    setNotice(`${file.name} added at ${model.timeLabel(at)}.`);
  }
  function addLink() {
    const url = linkUrl.trim();
    if (!mediaUrlSchema.safeParse(url).success) {
      setLinkError("Use an https link to a media file, without a password in it.");
      return;
    }
    setLinkError("");
    const source = { kind: "url" as const, url };
    if (linkKind === "video" || linkKind === "image") update((current) => model.addVideoClip(current, { source, media: linkKind, at: now(), length: 3, layer: 1 }));
    else update((current) => model.addAudioClip(current, { source, role: linkKind, at: linkKind === "music" ? 0 : now(), length: linkKind === "music" ? current.durationSeconds : 3 }));
    setLinkUrl("");
  }
  async function render() {
    if (!entry || !item || rendering || dirty || entry.base.revision === 0) return;
    setRendering(true);
    setError("");
    try {
      const payload = { contentId: item.id, expectedRevision: entry.base.revision };
      await client.queueRender({ ...payload, operationKey: await operationKey(context.workspace.id, "queue_reel_render", payload) });
      await loadRenders();
      setNotice("Render queued. A render worker will pick it up.");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setRendering(false);
    }
  }
  async function cancel(target: ReelRender) {
    try {
      await client.cancelRender({ renderId: target.id, operationKey: crypto.randomUUID() });
      await loadRenders();
    } catch (failure) {
      setError(message(failure));
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

  // Without an edit, a failure replaces the preview (below), so the header never keeps claiming it is still loading.
  const loadFailed = !entry && !loading && !!error;
  const status = !entry ? (loadFailed ? "Not loaded" : "Loading the video edit…") : dirty ? "Unsaved changes" : entry.base.revision === 0 ? "First draft from the script. Not saved yet." : `Saved · version ${entry.base.revision}`;
  const max = composition?.durationSeconds ?? MAX_COMPOSITION_SECONDS;
  const readOnly = !canEdit;
  const rowClass = (track: model.Track, id: string, index: number) => `clip-row ${selection?.id === id ? "selected" : ""} ${invalidRows.has(`${track}:${index}`) ? "invalid" : ""}`;
  const indexIn = (track: model.Track, id: string) => (composition ? (composition[track] as model.Clip[]).findIndex((clip) => clip.id === id) : -1);
  const times = (track: model.Track, clip: model.Clip, withIn = false) => (
    <>
      <button type="button" className="clip-seek" onClick={() => select(track, clip)} aria-label={`Play from ${model.timeLabel(clip.start)}`}>
        <Play size={12} aria-hidden="true" />
        {model.timeLabel(clip.start)}
      </button>
      <TimeField label="Start" value={clip.start} max={max} disabled={readOnly} onChange={(start) => update((current) => model.updateClip(current, track, clip.id, { start }))} onCommit={() => update((current) => model.sortTrack(current, track))} />
      <TimeField label="End" value={clip.end} max={max} disabled={readOnly} onChange={(end) => update((current) => model.updateClip(current, track, clip.id, { end }))} onCommit={() => update((current) => model.sortTrack(current, track))} />
      {withIn && "in" in clip && <TimeField label="In (s)" value={clip.in} max={3600} disabled={readOnly} onChange={(value) => update((current) => model.updateClip(current, track, clip.id, { in: value }))} />}
    </>
  );
  const remove = (track: model.Track, id: string, label: string) => (
    <button type="button" className="icon-button clip-remove" aria-label={`Remove ${label}`} disabled={readOnly} onClick={() => update((current) => model.removeClip(current, track, id))}>
      <Trash2 size={15} />
    </button>
  );
  const imageFiles = files.filter((file) => file.state === "ready" && file.mime.startsWith("image/"));

  return (
    <div className="video-studio">
      <div className="video-head">
        <div className="video-head-title">
          <label className="sr-only" htmlFor="video-item">Video</label>
          <select id="video-item" value={item.id} onChange={(event) => onSelectItem(event.target.value)}>
            {items.map((option) => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select>
          <small className={dirty ? "video-status dirty" : "video-status"} role="status">{status}</small>
        </div>
        <div className="video-head-actions">
          {canEdit && showable.length > 0 && (
            <button className="button secondary" disabled={!entry} onClick={() => setShowingProduct(true)}>
              <Package size={14} aria-hidden="true" />
              Show product
            </button>
          )}
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
      {((error && !loadFailed) || notice || !canEdit || broken.length > 0 || problems.length > 0) && (
        <div className="video-feedback">
          {error && !loadFailed && (
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
          {problems.length > 0 && <Notice error>Fix these before saving: {problems.map((problem) => problem.message).join("; ")}.</Notice>}
        </div>
      )}
      {!composition ? (
        loadFailed ? (
          <div className="video-failed" role="alert">
            <span className="video-failed-icon" aria-hidden="true"><CircleAlert size={18} /></span>
            <strong>Couldn’t open this video edit</strong>
            <p>{error}</p>
            <button className="button secondary" onClick={() => void load(true)}><RotateCcw size={14} aria-hidden="true" />Try again</button>
          </div>
        ) : (
          <div className="video-loading">
            {loading ? <><LoaderCircle className="spin" size={18} /> Opening the video edit…</> : <button className="button secondary" onClick={() => void load(true)}>Open the video edit</button>}
          </div>
        )
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
          </section>
          {/* The timeline runs the full width under the preview and the inspector, the way an editor's does. */}
          <div className="video-timeline-area">
            <Timeline composition={composition} playerRef={playerRef} selection={selection} labelFor={labelFor} onSelect={select} />
            <p className="video-note">1080 × 1920 · {composition.fps} fps · {model.timeLabel(composition.durationSeconds)}. The preview and the MP4 render draw the same frames.</p>
          </div>
          <section className="video-inspector" aria-label="Edit the video">
            <div className="segmented video-tabs" role="toolbar" aria-label="Edit">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                  <Icon size={14} />{label}
                  {id === "timeline" ? <span className="tab-count">{composition.video.length + composition.audio.length}</span> : id === "cards" || id === "captions" ? <span className="tab-count">{composition[id].length}</span> : id === "files" ? <span className="tab-count">{files.length}</span> : null}
                </button>
              ))}
            </div>

            {tab === "timeline" && (
              <div className="video-panel">
                <div className="video-panel-head">
                  <p>Clips play from their in-point. The main picture is usually the presenter; overlays sit on top, full frame, in a split screen or in a window. Add files from the Files tab, or link one here.</p>
                </div>
                {canEdit && (
                  <form className="link-form" onSubmit={(event) => { event.preventDefault(); addLink(); }}>
                    <input type="url" inputMode="url" aria-label="Media link" placeholder="https://… .mp4, .jpg or .mp3" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} />
                    <select aria-label="Use the link as" value={linkKind} onChange={(event) => setLinkKind(event.target.value as typeof linkKind)}>
                      <option value="video">Video overlay</option>
                      <option value="image">Image overlay</option>
                      <option value="voice">Voice</option>
                      <option value="music">Music</option>
                      <option value="sfx">Sound effect</option>
                    </select>
                    <button className="button secondary" disabled={!linkUrl.trim()}><Plus size={14} />Add at playhead</button>
                  </form>
                )}
                {linkError && <p className="field-error" role="alert">{linkError}</p>}
                <h3 className="track-heading">Video</h3>
                <ol className="clip-list">
                  {composition.video.map((clip) => {
                    const index = indexIn("video", clip.id);
                    const set = (patch: Partial<VideoClip>) => update((current) => model.updateClip(current, "video", clip.id, patch));
                    return (
                      <li key={clip.id} id={`clip-${clip.id}`} className={rowClass("video", clip.id, index)}>
                        <div className="clip-source">{clip.layer === 0 ? "Main picture" : "Overlay"} · {clip.media === "image" ? "Image" : "Video"} · {sourceName(clip.source)}</div>
                        <div className="clip-times">{times("video", clip, clip.media === "video")}{remove("video", clip.id, `video clip ${index + 1}`)}</div>
                        <div className="clip-fields">
                          <label className="select-field">
                            <span>Layer</span>
                            <select value={clip.layer} disabled={readOnly} onChange={(event) => set({ layer: Number(event.target.value) as 0 | 1, layout: Number(event.target.value) === 0 ? "full" : clip.layout })}>
                              <option value={0}>Main picture</option>
                              <option value={1}>Overlay</option>
                            </select>
                          </label>
                          {clip.layer === 1 && (
                            <label className="select-field">
                              <span>Layout</span>
                              <select value={clip.layout} disabled={readOnly} onChange={(event) => set({ layout: event.target.value as VideoClip["layout"] })}>
                                <option value="split">Split screen</option>
                                <option value="full">Full frame</option>
                                <option value="window">Window</option>
                              </select>
                            </label>
                          )}
                          {clip.media === "video" && <RangeField label="Sound" value={clip.volume} disabled={readOnly} onChange={(volume) => set({ volume })} />}
                        </div>
                        <div className="clip-fields">
                          <TransitionField label="In" value={clip.transitionIn} disabled={readOnly} onChange={(transitionIn) => set({ transitionIn })} />
                          <TransitionField label="Out" value={clip.transitionOut} disabled={readOnly} onChange={(transitionOut) => set({ transitionOut })} />
                          {clip.media === "video" && (
                            <label className="time-field">
                              <span>Lip-sync delay (frames)</span>
                              <input type="number" min={-12} max={12} step={1} value={clip.syncOffsetFrames} disabled={readOnly} onChange={(event) => Number.isInteger(event.target.valueAsNumber) && set({ syncOffsetFrames: Math.max(-12, Math.min(12, event.target.valueAsNumber)) })} />
                            </label>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {!composition.video.length && <p className="video-empty-line">No video clips. Add an avatar clip from the Files tab.</p>}
                <h3 className="track-heading">Audio</h3>
                <ol className="clip-list">
                  {composition.audio.map((clip) => {
                    const index = indexIn("audio", clip.id);
                    const set = (patch: Partial<AudioClip>) => update((current) => model.updateClip(current, "audio", clip.id, patch));
                    return (
                      <li key={clip.id} id={`clip-${clip.id}`} className={rowClass("audio", clip.id, index)}>
                        <div className="clip-source">{clip.role === "sfx" ? "SFX" : clip.role === "voice" ? "Voice" : "Music"} · {sourceName(clip.source)}</div>
                        <div className="clip-times">{times("audio", clip, true)}{remove("audio", clip.id, `audio clip ${index + 1}`)}</div>
                        <div className="clip-fields">
                          <label className="select-field">
                            <span>Role</span>
                            <select value={clip.role} disabled={readOnly} onChange={(event) => set({ role: event.target.value as AudioClip["role"] })}>
                              <option value="voice">Voice</option>
                              <option value="music">Music</option>
                              <option value="sfx">Sound effect</option>
                            </select>
                          </label>
                          <RangeField label="Volume" value={clip.volume} disabled={readOnly} onChange={(volume) => set({ volume })} />
                          <TimeField label="Fade in (s)" value={clip.fadeIn} max={10} disabled={readOnly} onChange={(fadeIn) => set({ fadeIn })} />
                          <TimeField label="Fade out (s)" value={clip.fadeOut} max={10} disabled={readOnly} onChange={(fadeOut) => set({ fadeOut })} />
                          <label className="check-field"><input type="checkbox" checked={clip.loop} disabled={readOnly} onChange={(event) => set({ loop: event.target.checked })} />Loop</label>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {!composition.audio.length && <p className="video-empty-line">No separate audio. The main picture plays its own sound.</p>}
              </div>
            )}

            {tab === "cards" && (
              <div className="video-panel">
                <div className="video-panel-head">
                  <p>Titles, name tags, full-screen statements and a closing call to action. A statement replaces the picture and hides captions while it is up.</p>
                  <div>
                    {CARD_KINDS.map(({ kind, label }) => <button key={kind} className="text-button" disabled={readOnly} onClick={() => update((current) => model.addCard(current, kind, now()))}><Plus size={13} />{label}</button>)}
                  </div>
                </div>
                <ol className="clip-list">
                  {composition.cards.map((card, index) => {
                    const set = (patch: Partial<CompositionCard>) => update((current) => model.updateClip(current, "cards", card.id, patch));
                    return (
                      <li key={card.id} id={`clip-${card.id}`} className={rowClass("cards", card.id, index)}>
                        <div className="clip-times">{times("cards", card)}{remove("cards", card.id, `card ${index + 1}`)}</div>
                        <div className="clip-fields">
                          <select aria-label={`Card ${index + 1} type`} value={card.kind} disabled={readOnly} onChange={(event) => set({ kind: event.target.value as CompositionCard["kind"] })}>
                            {CARD_KINDS.map(({ kind, label }) => <option key={kind} value={kind}>{label}</option>)}
                          </select>
                          <input aria-label={`Card ${index + 1} title`} placeholder="Title" value={card.title} maxLength={80} disabled={readOnly} onChange={(event) => set({ title: event.target.value })} />
                          <input aria-label={`Card ${index + 1} subtitle`} placeholder="Subtitle (optional)" value={card.subtitle} maxLength={140} disabled={readOnly} onChange={(event) => set({ subtitle: event.target.value })} />
                          <select aria-label={`Card ${index + 1} image`} value={card.imageFileId ?? ""} disabled={readOnly} onChange={(event) => set({ imageFileId: event.target.value || null })}>
                            <option value="">No image</option>
                            {imageFiles.map((file) => <option key={file.id} value={file.id}>{file.name} v{file.version}</option>)}
                            {card.imageFileId && !imageFiles.some((file) => file.id === card.imageFileId) && <option value={card.imageFileId}>Current image</option>}
                          </select>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {!composition.cards.length && <p className="video-empty-line">No cards yet.</p>}
              </div>
            )}

            {tab === "captions" && (
              <div className="video-panel">
                <div className="video-panel-head">
                  <p>Short pages of on-screen text. With a transcript, each word lights up exactly when it is spoken.</p>
                  <div>
                    <button className="text-button" disabled={readOnly} onClick={() => update((current) => model.addCaption(current, now()))}><Plus size={13} />Add at playhead</button>
                    <button className="text-button" disabled={readOnly || !composition.transcript?.words.length} onClick={() => update((current) => model.captionsFromTranscript(current))}><RotateCcw size={13} />Rebuild from transcript</button>
                    <button className="text-button" disabled={readOnly || !item.script.trim()} onClick={() => update((current) => model.captionsFromItemScript(current, item.script))}><RotateCcw size={13} />Rebuild from script</button>
                  </div>
                </div>
                <ol className="clip-list">
                  {composition.captions.map((cue, index) => (
                    <li key={cue.id} id={`clip-${cue.id}`} className={rowClass("captions", cue.id, index)}>
                      <div className="clip-times">{times("captions", cue)}{remove("captions", cue.id, `caption ${index + 1}`)}</div>
                      <input aria-label={`Caption ${index + 1} text`} value={cue.text} maxLength={140} disabled={readOnly} onChange={(event) => update((current) => model.updateClip(current, "captions", cue.id, { text: event.target.value }))} />
                    </li>
                  ))}
                </ol>
                {!composition.captions.length && <p className="video-empty-line">No captions. Add one at the playhead or rebuild them.</p>}
              </div>
            )}

            {tab === "transcript" && (
              <div className="video-panel">
                <div className="video-panel-head">
                  <p>Word timings on the timeline. Load them from a transcript draft file (Files tab, "Use as transcript"), then fix any word here. Click a word to hear it.</p>
                </div>
                {!composition.transcript ? (
                  <p className="video-empty-line">No transcript yet. Upload a word-timing JSON as a transcript draft, or let an agent add one.</p>
                ) : (
                  <>
                    <div className="video-inline-fields">
                      <label className="select-field">
                        <span>Language</span>
                        <input value={composition.transcript.language} maxLength={12} disabled={readOnly} onChange={(event) => update((current) => ({ ...current, transcript: current.transcript && { ...current.transcript, language: event.target.value.trim() || item.language } }))} />
                      </label>
                      <label className="time-field">
                        <span>Shift all words (s)</span>
                        <input type="number" step={0.04} value={shiftBy} disabled={readOnly} onChange={(event) => setShiftBy(Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : 0)} />
                      </label>
                      <button className="button secondary" disabled={readOnly || !shiftBy} onClick={() => { update((current) => model.shiftTranscript(current, shiftBy)); setShiftBy(0); }}>Shift</button>
                      <button className="text-button" disabled={readOnly} onClick={() => update((current) => ({ ...current, transcript: null }))}><Trash2 size={13} />Remove transcript</button>
                    </div>
                    <p className="video-hint">{composition.transcript.words.length} words{composition.transcript.sourceFileId ? ` from ${fileById.get(composition.transcript.sourceFileId)?.name ?? "a draft file"}` : ""}.</p>
                    <div className="word-grid">
                      {composition.transcript.words.map((word, index) => (
                        <button key={index} type="button" className={`word-chip ${wordIndex === index ? "selected" : ""} ${word.end < word.start ? "invalid" : ""}`} title={`${model.timeLabel(word.start)} to ${model.timeLabel(word.end)}`} onClick={() => { setWordIndex(index); seek(word.start); }}>
                          {word.t}
                        </button>
                      ))}
                    </div>
                    {wordIndex !== null && composition.transcript.words[wordIndex] && (
                      <div className="video-inline-fields word-editor">
                        <label className="select-field">
                          <span>Word</span>
                          <input value={composition.transcript.words[wordIndex].t} maxLength={60} disabled={readOnly} onChange={(event) => event.target.value.trim() && update((current) => ({ ...current, transcript: current.transcript && { ...current.transcript, words: current.transcript.words.map((word, i) => (i === wordIndex ? { ...word, t: event.target.value.trim() } : word)) } }))} />
                        </label>
                        <TimeField label="Start" value={composition.transcript.words[wordIndex].start} max={max} disabled={readOnly} onChange={(start) => update((current) => ({ ...current, transcript: current.transcript && { ...current.transcript, words: current.transcript.words.map((word, i) => (i === wordIndex ? { ...word, start } : word)) } }))} />
                        <TimeField label="End" value={composition.transcript.words[wordIndex].end} max={max} disabled={readOnly} onChange={(end) => update((current) => ({ ...current, transcript: current.transcript && { ...current.transcript, words: current.transcript.words.map((word, i) => (i === wordIndex ? { ...word, end } : word)) } }))} />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {tab === "files" && (
              <FilesPanel files={files} loading={filesLoading} canEdit={canEdit} itemTitle={item.title} onUpload={uploadFile} onSaveText={saveText} onArchive={archive} onUse={(file, action) => void useFile(file, action)} onRefresh={() => void loadFiles()} />
            )}

            {tab === "look" && (
              <div className="video-panel">
                <fieldset className="video-fieldset" disabled={readOnly}>
                  <legend>Honesty labels</legend>
                  <label className="check-field"><input type="checkbox" checked={composition.labels.aiAvatar} onChange={(event) => update((current) => ({ ...current, labels: { ...current.labels, aiAvatar: event.target.checked } }))} />Show “AI avatar” on every frame</label>
                  {!composition.labels.aiAvatar && <small className="field-error">Turn this off only when the presenter is a real recording of a real person.</small>}
                  <div className="field">
                    <label htmlFor="disclaimer">Disclaimer line</label>
                    <input id="disclaimer" maxLength={160} placeholder="e.g. Educational content, not medical advice." value={composition.labels.disclaimer} onChange={(event) => update((current) => ({ ...current, labels: { ...current.labels, disclaimer: event.target.value } }))} />
                  </div>
                </fieldset>
                <fieldset className="video-fieldset" disabled={readOnly}>
                  <legend>Look</legend>
                  <div className="video-inline-fields">
                    <label className="color-field"><span>Accent</span><input type="color" value={composition.style.accent} onChange={(event) => update((current) => ({ ...current, style: { ...current.style, accent: event.target.value } }))} /></label>
                    <label className="color-field"><span>Background</span><input type="color" value={composition.style.background} onChange={(event) => update((current) => ({ ...current, style: { ...current.style, background: event.target.value } }))} /></label>
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
                  <label className="check-field"><input type="checkbox" checked={composition.style.duckMusic} onChange={(event) => update((current) => ({ ...current, style: { ...current.style, duckMusic: event.target.checked } }))} />Lower the music while the voice speaks</label>
                </fieldset>
                <fieldset className="video-fieldset" disabled={readOnly}>
                  <legend>Timing</legend>
                  <div className="video-inline-fields">
                    <CommitField label={`Length (s), up to ${MAX_COMPOSITION_SECONDS}`} value={composition.durationSeconds} min={1} max={MAX_COMPOSITION_SECONDS} step={0.5} disabled={readOnly} onCommit={(seconds) => update((current) => model.setDuration(current, seconds))} />
                    <label className="select-field">
                      <span>Frame rate</span>
                      <select value={composition.fps} onChange={(event) => update((current) => ({ ...current, fps: Number(event.target.value) as Composition["fps"] }))}>
                        <option value={24}>24 fps</option>
                        <option value={25}>25 fps</option>
                        <option value={30}>30 fps</option>
                      </select>
                    </label>
                    {entry!.base.itemMedia?.durationSeconds && Math.abs(entry!.base.itemMedia.durationSeconds - composition.durationSeconds) > 0.05 ? (
                      <button type="button" className="text-button" onClick={() => update((current) => model.setDuration(current, entry!.base.itemMedia!.durationSeconds!))}>Match the rendered presenter ({model.timeLabel(entry!.base.itemMedia.durationSeconds)})</button>
                    ) : null}
                  </div>
                </fieldset>
              </div>
            )}

            {tab === "render" && (
              <div className="video-panel">
                <div className="video-panel-head">
                  <p>A render worker draws the saved edit with the same Remotion composition as this preview and saves the MP4 as a render draft file.</p>
                  <button className="text-button" onClick={() => void loadRenders()}>Refresh</button>
                </div>
                {canRender ? (
                  <div className="video-inline-fields">
                    <button className="button primary" disabled={rendering || dirty || !entry || entry.base.revision === 0 || active} onClick={() => void render()}>
                      {rendering ? <LoaderCircle size={14} className="spin" /> : <Film size={14} />}Render version {entry?.base.revision || ""}
                    </button>
                    <small className="video-hint">{dirty || entry?.base.revision === 0 ? "Save the edit first; renders use the saved version." : active ? "A render of this video is already waiting or running." : "Renders run on your render workers, not in this browser."}</small>
                  </div>
                ) : (
                  <Notice>Your role cannot start renders in this workspace.</Notice>
                )}
                <ol className="render-list">
                  {renders.map((entryRender) => (
                    <li key={entryRender.id} className={`render-row ${entryRender.state}`}>
                      <div className="render-main">
                        <strong>Version {entryRender.compositionRevision}</strong>
                        <small>{RENDER_STATES[entryRender.state]}{entryRender.state === "rendering" ? ` · ${Math.round(entryRender.progress * 100)}%` : ""}{entryRender.workerId ? ` · ${entryRender.workerId}` : ""} · {new Date(entryRender.createdAt).toLocaleString()}</small>
                        {entryRender.state === "rendering" && <progress max={1} value={entryRender.progress} />}
                        {entryRender.error && <small className="field-error">{entryRender.error}</small>}
                      </div>
                      {entryRender.outputFile?.url && <video className="render-video" src={entryRender.outputFile.url} controls preload="metadata" />}
                      <div className="file-actions">
                        {entryRender.outputFile?.url && <a className="text-button" href={entryRender.outputFile.url} target="_blank" rel="noreferrer">Open MP4</a>}
                        {canRender && (entryRender.state === "queued" || entryRender.state === "rendering") && <button className="text-button" onClick={() => void cancel(entryRender)}>Cancel</button>}
                      </div>
                    </li>
                  ))}
                </ol>
                {!renders.length && <p className="video-empty-line">No renders of this video yet.</p>}
              </div>
            )}
          </section>
        </div>
      )}
      {showingProduct && entry && (
        <ShowProduct
          client={client}
          workspaceId={context.workspace.id}
          item={item}
          products={showable}
          composition={entry.base.composition}
          revision={entry.base.revision}
          dirty={dirty}
          onClose={() => setShowingProduct(false)}
          onReload={() => load(true)}
          onPlaced={(result, product, endCard) => {
            setShowingProduct(false);
            void Promise.all([load(true), loadFiles()]).then(() => {
              setNotice(`${product.name} is on screen at ${model.timeLabel(result.placedAt)}${endCard ? " and on the end card" : ""}. Saved as version ${result.compositionRevision}.`);
              setSeekAfterLoad(result.placedAt);
            });
          }}
        />
      )}
    </div>
  );
}
