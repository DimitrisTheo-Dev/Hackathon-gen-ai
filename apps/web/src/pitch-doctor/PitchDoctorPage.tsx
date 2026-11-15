import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  ArrowRight, ArrowUp, CalendarDays, Check, ChevronLeft, ChevronRight, Clock as ClockIcon, CreditCard, FileText, Grid2X2, Lock,
  Maximize2, Minimize2, Pause, Play, Plug, RotateCcw, Search, Sparkles, Volume2, VolumeX, Zap,
} from "lucide-react";
import { AgentIcon } from "../components/AgentIcon";
import { ClockContext, createClock, useClock, type Clock } from "../pitch/clock";
import { Doctor, DoctorStill } from "./Doctor";
import {
  AGENT_ASK, AGENT_DRAFT_CAPTION, AGENT_DRAFT_TITLE, ASK, BEATS, CLIP_MODE, CUE, DRAFT_TITLE, INTRO_CAPTION, OPENING_V1, OPENING_V2, PRESENTER, PROJECT, PROMPT, TOTAL,
  beatIndexAt, cameraAt, captionIndexAt, cueTimeAt, typedLength, type CueId,
} from "./timeline";
import "../pitch/pitch.css";

/**
 * /pitch-doctor: the one-minute pitch from /pitch with a doctor's sample content. A copy of PitchPage.tsx in
 * which only the sample content differs; the clock, the stylesheet and every beat and cue time are the
 * original's (imported, not copied), so the motion is the same.
 *
 * A presenter speaks to the room; the camera pulls back to show he is one 9:16 draft on the Faceful canvas;
 * three quick beats happen in the studio (an edit becomes version 2, Claude Code adds a draft over MCP,
 * the schedule waits for approval); three lines say why it matters; the camera returns to him for the end card.
 *
 * Truthfulness: the studio is an interface illustration with sample content. By default the presenter is an
 * original, featureless illustration labelled "Dr Panagiotis" and says so. Only with ?clip=1, and only when the
 * files exist in apps/web/public/pitch-doctor/ on this machine, clips of the doctor replace every drawing of him:
 * presenter.webm (with presenter.vtt, his words) in the main draft, reel-1 to reel-3.webm in the other drafts,
 * still-1.jpg in the "Why" card. Those files are AI tests made without his confirmed consent: they are never
 * committed or deployed, and the label then says "AI-generated clip". The
 * sample text is topics and questions only, with no medical claims. Nothing here shows a rendered, published or
 * paid state.
 *
 * Motion: transform and opacity only. The camera is one transform on the world; the 16:9 → 9:16 reframing is
 * two clipping layers that slide (translateX) with exact counter-slides, so no clip-path or size animates.
 */

/** Local only, never committed: see the note above. */
const CLIP_URL = "/pitch-doctor/presenter.webm";
const CAPTIONS_URL = "/pitch-doctor/presenter.vtt";
const STILL_URL = "/pitch-doctor/still-1.jpg";
const reelUrl = (n: 1 | 2 | 3) => `/pitch-doctor/reel-${n}.webm`;
const DEFAULT_CREDIT = "AI-generated clip";

type PresenterSource = "checking" | "illustration" | "clip";
type Camera = ReturnType<typeof cameraAt>;
type Geometry = { vw: number; vh: number; sx: number; sy: number; mx: number; my: number; mw: number; mh: number };

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Is a local clip of the doctor present? A HEAD request; an SPA fallback page does not count. */
function usePresenterSource(): [PresenterSource, string] {
  const [source, setSource] = useState<PresenterSource>("checking");
  useEffect(() => {
    let alive = true;
    if (!CLIP_MODE) { setSource("illustration"); return; }
    fetch(CLIP_URL, { method: "HEAD", cache: "no-store" })
      .then((response) => { if (alive) setSource(response.ok && /^video\//i.test(response.headers.get("content-type") ?? "") ? "clip" : "illustration"); })
      .catch(() => { if (alive) setSource("illustration"); });
    return () => { alive = false; };
  }, []);
  return [source, DEFAULT_CREDIT];
}

const FILL: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };

/** A still of the doctor from the main clip, for the small "Why" card. */
function DoctorPhoto() {
  return <img src={STILL_URL} alt="" style={FILL} />;
}

/** Another clip of the doctor, in another setting, filling a draft's 9:16 preview like the drawing did. Muted. */
function DoctorReel({ n }: { n: 1 | 2 | 3 }) {
  return <video src={reelUrl(n)} style={FILL} muted loop autoPlay playsInline preload="auto" />;
}

function offsetWithin(node: HTMLElement, ancestor: HTMLElement) {
  let x = 0, y = 0;
  let current: HTMLElement | null = node;
  while (current && current !== ancestor) {
    x += current.offsetLeft;
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

/** Where the camera sits: covering the viewport with the presenter's frame, or the whole studio at rest. */
function cameraTransform(camera: Camera, geo: Geometry | null): string {
  if (!geo || camera === "studio") return "translate(0px, 0px) scale(1)";
  const k = Math.max(geo.vw / geo.mw, geo.vh / geo.mh) * 1.002;
  // On the end card he moves right of centre to make room for the words; never so far that an edge shows.
  const room = Math.max(0, (k * geo.mw - geo.vw) / 2 - 8);
  const shift = camera === "end" ? Math.min(geo.vw * 0.16, room) : 0;
  const tx = geo.vw / 2 + shift - geo.sx - k * (geo.mx + geo.mw / 2);
  const ty = geo.vh / 2 - geo.sy - k * (geo.my + geo.mh / 2);
  return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${k.toFixed(4)})`;
}

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export default function PitchDoctorPage() {
  const options = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const speed = Math.min(20, Math.max(0.25, Number(params.get("speed")) || 1));
    const start = Math.min(TOTAL, Math.max(0, Number(params.get("t")) || 0));
    return { speed, start, autoplay: params.get("autoplay") !== "0" };
  }, []);
  const [clock] = useState(() => createClock(options.speed));
  useEffect(() => () => clock.dispose(), [clock]);
  return (
    <ClockContext.Provider value={clock}>
      <Pitch clock={clock} start={options.start} autoplay={options.autoplay} />
    </ClockContext.Provider>
  );
}

function Pitch({ clock, start, autoplay }: { clock: Clock; start: number; autoplay: boolean }) {
  const cueTime = useClock((t) => cueTimeAt(t));
  const beatIndex = useClock((t) => beatIndexAt(t));
  const playing = useClock((_, isPlaying) => isPlaying);
  const ended = useClock((t) => t >= TOTAL);
  const reduced = useReducedMotion();
  const [source, credit] = usePresenterSource();
  const [clipReady, setClipReady] = useState(false);
  const [clipFailed, setClipFailed] = useState(false);
  const [clipShape, setClipShape] = useState<"portrait" | "landscape">("portrait");
  const [clipCue, setClipCue] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [blackout, setBlackout] = useState(false);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const heroMedia = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const progress = useRef<HTMLSpanElement>(null);

  const beat = BEATS[beatIndex];
  const on = (id: CueId) => cueTime >= CUE[id];
  const clipShown = source === "clip" && clipReady && !clipFailed;
  const presenterLabel = clipShown ? credit : "Illustration";

  // ── Page setup: title, noindex, no page scroll while presenting ──
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Faceful: one-minute pitch, doctor sample";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.append(robots);
    document.documentElement.classList.add("pitch-mode");
    return () => { document.title = previousTitle; robots.remove(); document.documentElement.classList.remove("pitch-mode"); };
  }, []);

  // ── Start ──
  useEffect(() => {
    clock.seek(start);
    if (autoplay) clock.play();
  }, [clock, start, autoplay]);

  // ── Camera state: what is shown can lag what the playhead wants, while a cut dips through the canvas colour ──
  const wanted = cameraAt(cueTime);
  const [shown, setShown] = useState<Camera>(wanted);
  const [curtain, setCurtain] = useState(false);
  const [cut, setCut] = useState(true);
  const restartCut = useRef(false);

  // ── Camera geometry: measured from layout (never from transformed boxes) ──
  const measure = useCallback(() => {
    const stageNode = stage.current, worldNode = world.current, media = heroMedia.current;
    if (!stageNode || !worldNode || !media) return;
    const box = stageNode.getBoundingClientRect();
    const { x, y } = offsetWithin(media, worldNode);
    setGeo({ vw: innerWidth, vh: innerHeight, sx: box.left, sy: box.top, mx: x, my: y, mw: media.offsetWidth, mh: media.offsetHeight });
  }, []);
  useLayoutEffect(() => {
    measure();
    // A resize (or entering full screen) re-frames instantly instead of animating the camera.
    const onResize = () => { setCut(true); measure(); };
    addEventListener("resize", onResize);
    void document.fonts?.ready.then(measure);
    return () => removeEventListener("resize", onResize);
  }, [measure]);

  // ── Camera with cuts: reduced motion (and restarts) dip through the canvas colour instead of zooming ──
  useEffect(() => {
    if (wanted === shown) return;
    const dip = reduced || restartCut.current;
    restartCut.current = false;
    if (!dip) { setShown(wanted); return; }
    setCurtain(true);
    const timer = window.setTimeout(() => { setCut(true); setShown(wanted); }, 240);
    return () => window.clearTimeout(timer);
  }, [wanted, shown, reduced]);
  useEffect(() => {
    // A cut lasts two frames: long enough for the new transform to apply without a transition.
    if (!cut) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { setCut(false); setCurtain(false); }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [cut, geo, shown]);

  // ── Progress bar: written straight to the DOM every frame, no React render ──
  useEffect(() => {
    const paint = () => { if (progress.current) progress.current.style.transform = `scaleX(${(clock.t / TOTAL).toFixed(4)})`; };
    paint();
    return clock.subscribe(paint);
  }, [clock]);

  // ── Pause freezes every running animation in the scene (CSS transitions included) ──
  useEffect(() => {
    const node = scene.current;
    if (!node) return;
    for (const animation of node.getAnimations({ subtree: true })) {
      if (playing && animation.playState === "paused") animation.play();
      else if (!playing && animation.playState === "running") animation.pause();
    }
  }, [playing]);

  // ── A hidden tab pauses; it does not resume by itself ──
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) clock.pause(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [clock]);

  // ── The real clip, when present: follows the playhead; sound only in the opening, only if unmuted ──
  useEffect(() => {
    const node = video.current;
    if (!node || source !== "clip") return;
    node.muted = muted || beat.id !== "intro";
    if (playing) void node.play().catch(() => undefined);
    else node.pause();
  }, [source, playing, muted, beat.id, clipReady]);
  useEffect(() => {
    const node = video.current;
    if (!node || source !== "clip") return;
    const tracks = node.textTracks;
    const attach = () => {
      const track = tracks[0];
      if (!track) return;
      track.mode = "hidden";
      track.oncuechange = () => {
        const cue = track.activeCues?.[0] as VTTCue | undefined;
        setClipCue(cue ? cue.text : null);
      };
    };
    attach();
    tracks.addEventListener("addtrack", attach);
    return () => tracks.removeEventListener("addtrack", attach);
  }, [source]);

  // ── Transport ──
  const seekTo = useCallback((to: number) => {
    clock.seek(to);
    const node = video.current;
    if (node && source === "clip" && Number.isFinite(node.duration) && node.duration > 0) {
      const local = to < BEATS[1].start ? to : to >= BEATS[6].start ? 0 : node.currentTime;
      try { node.currentTime = Math.min(local, Math.max(0, node.duration - 0.05)); } catch { /* not seekable yet */ }
    }
  }, [clock, source]);
  const toggle = useCallback(() => { if (clock.playing) clock.pause(); else { if (clock.t >= TOTAL) seekTo(0); clock.play(); } }, [clock, seekTo]);
  const next = useCallback(() => {
    const index = beatIndexAt(clock.t);
    seekTo(index + 1 < BEATS.length ? BEATS[index + 1].start : TOTAL);
  }, [clock, seekTo]);
  const previous = useCallback(() => {
    const index = beatIndexAt(clock.t);
    const into = clock.t - BEATS[index].start;
    seekTo(into > 1.5 || index === 0 ? BEATS[index].start : BEATS[index - 1].start);
  }, [clock, seekTo]);
  const restart = useCallback(() => {
    restartCut.current = cameraAt(cueTimeAt(clock.t)) !== "presenter";
    setBlackout(false);
    seekTo(0);
    clock.play();
  }, [clock, seekTo]);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }, []);
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // ── Keyboard and presentation clickers (PageUp / PageDown, B or . to blank) ──
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button") && (event.key === " " || event.key === "Enter")) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      let handled = true;
      if (key === " " || key === "k") toggle();
      else if (key === "ArrowRight" || key === "PageDown" || key === "n") next();
      else if (key === "ArrowLeft" || key === "PageUp" || key === "p") previous();
      else if (key === "r" || key === "Home") restart();
      else if (key === "End") seekTo(BEATS[BEATS.length - 1].start);
      else if (key === "f") toggleFullscreen();
      else if (key === "m" && source === "clip") setMuted((value) => !value);
      else if (key === "b" || key === ".") { setBlackout((value) => !value); clock.pause(); }
      else if (/^[1-7]$/.test(key)) seekTo(BEATS[Number(key) - 1].start);
      else handled = false;
      if (handled) { event.preventDefault(); setIdle(true); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [toggle, next, previous, restart, seekTo, toggleFullscreen, source, clock]);

  // ── Pointer: controls and cursor appear on movement, hide after a short rest ──
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2200);
    };
    addEventListener("pointermove", wake);
    addEventListener("pointerdown", wake);
    timer = window.setTimeout(() => setIdle(true), 2200);
    return () => { removeEventListener("pointermove", wake); removeEventListener("pointerdown", wake); window.clearTimeout(timer); };
  }, []);

  const worldStyle = { transform: cameraTransform(shown, geo) } as CSSProperties;
  const framed = shown !== "studio";
  // The label steps aside while the camera travels, then names what has arrived.
  const moving = (on("zoomOut") && !on("chrome")) || (on("zoomIn") && !on("endText"));
  const rootClass = [
    "pitch",
    `cam-${shown}`,
    cut || !geo ? "is-cut" : "",
    curtain ? "is-curtain" : "",
    blackout ? "is-blackout" : "",
    idle ? "is-idle" : "",
    ended ? "is-ended" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      ref={root}
      className={rootClass}
      data-beat={beat.id}
      data-beat-index={beatIndex}
      data-cue={cueTime}
      data-playing={playing ? "true" : "false"}
      data-motion={reduced ? "reduced" : "full"}
      data-presenter={clipShown ? "clip" : source === "checking" ? "checking" : "illustration"}
    >
      <main className="pitch-scene" ref={scene} aria-label="Faceful one-minute pitch">
        <h1 className="pitch-sr">Faceful: the video studio you and your AI agent share</h1>
        <div className="pitch-stage" ref={stage}>
          <div className="pw" ref={world} style={worldStyle} aria-hidden={framed ? "true" : undefined}>
            <Studio
              clip={source === "clip"}
              on={on}
              cueTime={cueTime}
              heroMedia={heroMedia}
              hero={
                <HeroMedia
                  on={on}
                  source={source}
                  clipShown={clipShown}
                  clipShape={clipShape}
                  clipCue={clipCue}
                  video={
                    source === "clip" && !clipFailed ? (
                      <video
                        ref={video}
                        className={`ph-video ${clipReady ? "is-ready" : ""}`}
                        src={CLIP_URL}
                        muted
                        loop
                        playsInline
                        preload="auto"
                        onLoadedMetadata={(event) => setClipShape(event.currentTarget.videoWidth >= event.currentTarget.videoHeight ? "landscape" : "portrait")}
                        onCanPlay={() => setClipReady(true)}
                        onError={() => setClipFailed(true)}
                      >
                        <track kind="captions" src={CAPTIONS_URL} srcLang="el" label="Ελληνικά" default />
                      </video>
                    ) : null
                  }
                />
              }
            />
          </div>
        </div>

        {/* The honest label, unscaled and pinned to the screen corner: what the viewer is looking at. */}
        <div className="pitch-corner pitch-overlay">
          <span className={`p-label ${beat.id === "why" || moving ? "is-hidden" : ""}`} data-testid="presenter-label">
            {shown === "studio" ? "Illustration · sample content" : presenterLabel}
          </span>
        </div>

        <Why on={on} clip={source === "clip"} />
        <EndCard on={on} />
        <p className="pitch-sr" aria-live="polite">{beat.label}</p>
      </main>

      <div className="pitch-curtain" aria-hidden="true" />
      <div className="pitch-blackout" aria-hidden="true" />

      <div className="pitch-progress" aria-hidden="true">
        <span className="pitch-progress-fill" ref={progress} />
        {BEATS.slice(1).map((entry) => <i key={entry.id} style={{ left: `${(entry.start / TOTAL) * 100}%` }} />)}
      </div>
      {!playing && !ended && <span className="pitch-paused" aria-hidden="true"><Pause />Paused</span>}

      <div className="pitch-controls" role="toolbar" aria-label="Pitch controls">
        <button type="button" onClick={previous} aria-label="Previous beat" title="Previous beat (←)"><ChevronLeft /></button>
        <button type="button" className="is-primary" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)">{playing ? <Pause /> : <Play />}</button>
        <button type="button" onClick={next} aria-label="Next beat" title="Next beat (→)"><ChevronRight /></button>
        <span className="pitch-controls-beat"><b>{beatIndex + 1}/{BEATS.length}</b>{beat.label}<TimeReadout /></span>
        <button type="button" onClick={restart} aria-label="Restart" title="Restart (R)"><RotateCcw /></button>
        {source === "clip" && <button type="button" onClick={() => setMuted((value) => !value)} aria-label={muted ? "Unmute presenter" : "Mute presenter"} aria-pressed={!muted} title="Sound (M)">{muted ? <VolumeX /> : <Volume2 />}</button>}
        <button type="button" onClick={toggleFullscreen} aria-label={fullscreen ? "Exit full screen" : "Full screen"} title="Full screen (F)">{fullscreen ? <Minimize2 /> : <Maximize2 />}</button>
      </div>
    </div>
  );
}

function TimeReadout() {
  const seconds = useClock((t) => Math.floor(t));
  return <small>{formatTime(seconds)} / {formatTime(TOTAL)}</small>;
}

/** Typed text: the visible prefix follows the playhead, with a caret while typing. */
function Typed({ text, start, seconds, caret = true }: { text: string; start: number; seconds: number; caret?: boolean }) {
  const length = useClock((t) => typedLength(text, t, start, seconds));
  const typing = length > 0 && length < text.length;
  return <>{text.slice(0, length)}{caret && <i className={`p-caret ${typing ? "is-typing" : ""}`} aria-hidden="true" />}</>;
}

/** The reel caption: one chunk at a time, the word being spoken lit. */
function IntroCaption() {
  const index = useClock((t) => captionIndexAt(t));
  const word = useClock((t) => {
    const chunk = INTRO_CAPTION[captionIndexAt(t)];
    if (!chunk) return -1;
    const words = chunk.text.split(" ").length;
    const at = Math.floor(((t - chunk.start) / (chunk.end - chunk.start)) * words);
    return at >= words ? -1 : at;
  });
  return (
    <>
      {INTRO_CAPTION.map((chunk, i) => (
        <span key={chunk.text} className={`ph-line ${i === index ? "is-in" : i < index ? "is-past" : ""}`}>
          <span className="ph-line-text">
            {chunk.text.split(" ").map((part, w) => <span key={`${w}-${part}`}>{w > 0 && " "}<i data-w={part} className={i === index && w === word ? "is-lit" : undefined}>{part}</i></span>)}
          </span>
        </span>
      ))}
    </>
  );
}

/**
 * The presenter's frame. Natively a wide set (2.4:1) with him standing in the middle 9:16 column; on the
 * canvas two clipping layers slide in so only that 9:16 column (the draft's preview) remains.
 */
function HeroMedia({ on, source, clipShown, clipShape, clipCue, video }: {
  on: (id: CueId) => boolean; source: PresenterSource; clipShown: boolean; clipShape: "portrait" | "landscape"; clipCue: string | null; video: ReactNode;
}) {
  // With his clip, the chip's meter follows his own words (a caption cue is up); the drawing keeps the original cues.
  const speaking = clipShown ? clipCue !== null : on("speak") && !on("speakEnd");
  const chrome = on("chrome") && !on("zoomIn");
  const caption = on("zoomIn") ? "none" : on("chrome") ? "opening" : "intro";
  return (
    <div className="ph-clip-l">
      <div className="ph-unshift-l">
        <div className="ph-clip-r">
          <div className="ph-media">
            <div className="ph-set" />
            <span className="ph-orb ph-orb-a" />
            <span className="ph-orb ph-orb-b" />
            <div className={`ph-subject ${clipShown ? "has-clip" : ""} is-${clipShape}`}>
              {source !== "clip" || !clipShown ? <Doctor speaking={speaking} className="ph-eleni" /> : null}
              {video}
            </div>
            <div className={`ph-chrome ${chrome ? "is-in" : ""} ${on("zoomIn") ? "is-gone" : ""}`}>
              <span className={`p-chip ${speaking ? "is-speaking" : ""}`}><span className="p-meter"><i /><i /><i /></span>{PRESENTER}</span>
              <span className="p-draft"><i />Draft</span>
            </div>
            <div className={`ph-caption is-${caption}`}>
              <span className="ph-caption-intro">
                {clipShown ? clipCue && <span className="ph-line is-in"><span className="ph-line-text">{clipCue}</span></span> : <IntroCaption />}
              </span>
              <span className={`ph-line ph-opening ${on("saved") ? "is-past" : caption === "opening" ? "is-in" : ""}`}><span className="ph-line-text">{OPENING_V1}</span></span>
              <span className={`ph-line ph-opening ${on("saved") && caption === "opening" ? "is-in" : ""}`}><span className="ph-line-text">{OPENING_V2}</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The other drafts in his project: neutral topics, each caption a question and nothing more. */
const SIDE_CARDS = [
  { scrub: "blue" as const, title: "Πρώτη επίσκεψη", caption: "Πρώτη επίσκεψη: τι να ρωτήσω;", tone: "b" },
  { scrub: "sage" as const, title: "Τεστ Παπ", caption: "Τεστ Παπ: κάθε πότε;", tone: "c" },
];

/** The studio composition: Projects, the canvas of drafts, the AI Director chat. Sample content throughout. */
function Studio({ clip, on, cueTime, hero, heroMedia }: { clip: boolean; on: (id: CueId) => boolean; cueTime: number; hero: ReactNode; heroMedia: RefObject<HTMLDivElement | null> }) {
  const landed = on("cardLand");
  const between = (from: CueId, to: CueId) => on(from) && !on(to);
  const reviewOpen = between("reviewIn", "whyIn");
  return (
    <div className="pw-shell">
      <aside className="pw-side">
        <span className="pw-brand"><span className="p-mark"><i /><i /><i /></span>Faceful</span>
        <span className="pw-search"><Search />Search<kbd>⌘K</kbd></span>
        <span className="pw-nav"><Sparkles />Create</span>
        <span className="pw-nav"><CalendarDays />Schedule</span>
        <span className="pw-nav"><FileText />Brand kit</span>
        <span className="pw-nav"><CreditCard />Billing</span>
        <span className="pw-label">Projects</span>
        <span className="pw-project is-current"><Grid2X2 />{PROJECT}<b className={landed ? "is-bumped" : ""}><span>3</span><span>4</span></b></span>
        <span className="pw-project"><Grid2X2 />First visit<em>Sample</em><b><span>3</span></b></span>
        <span className="pw-project"><Grid2X2 />Greek Reels<b><span>2</span></b></span>
        <span className="pw-bottom">
          <span className={`pw-agents ${between("terminalIn", "terminalOut") ? "is-busy" : ""}`}><Plug />Agents<small>1 connected<i /></small></span>
          <span className="pw-credits"><Zap />Credits<small>12 left</small></span>
          <span className="pw-user"><span>P</span>{PRESENTER.replace(" ", " ")}<small>Owner</small></span>
        </span>
      </aside>

      <section className="pw-canvas">
        <header className="pw-top"><span className="pw-seg"><span className="is-on"><Grid2X2 />Canvas</span><span><CalendarDays />Schedule</span></span></header>
        <div className="pw-head">
          <div>
            <h2>{PROJECT}</h2>
            <p><span className="pw-count"><span className={landed ? "is-out" : ""}>3 drafts</span><span className={landed ? "is-in" : ""}>4 drafts</span></span> · Times in Europe/Athens</p>
          </div>
          <span className={`pw-review-button ${between("reviewPress", "reviewIn") ? "is-pressed" : ""}`}><CalendarDays />Review schedule</span>
        </div>
        <div className="pw-row">
          <article className={`pw-card pw-card-hero ${between("promptFocus", "askType") ? "is-focus" : ""} ${between("askSend", "terminalIn") ? "is-selected" : ""}`}>
            <div className="pw-preview pw-preview-hero">
              <div className="ph" ref={heroMedia}>{hero}</div>
            </div>
            <div className="pw-meta">
              <strong>{DRAFT_TITLE}</strong>
              <span className="pw-state">
                <i />Draft
                <span className={`pw-version ${on("saved") ? "is-v2" : ""}`}><span>v1</span><span>v2<Check /></span></span>
              </span>
              <span className={`pw-slot ${on("slot") ? "is-in" : ""}`}><ClockIcon />Mon 09:00<small>Needs your approval</small></span>
            </div>
          </article>
          {SIDE_CARDS.map((card, i) => (
            <article key={card.title} className="pw-card">
              <div className={`pw-preview pw-tone-${card.tone}`}>
                {clip ? <span className="pw-figure pw-figure-eleni"><DoctorReel n={i === 0 ? 1 : 2} /></span> : <span className="pw-figure"><DoctorStill scrub={card.scrub} /></span>}
                <span className="pw-preview-top"><span className="p-chip">{PRESENTER}</span><span className="p-draft"><i />Draft</span></span>
                <span className="pw-caption"><span>{card.caption}</span></span>
              </div>
              <div className="pw-meta"><strong>{card.title}</strong><span className="pw-state"><i />Draft<span className="pw-version"><span>v1</span></span></span></div>
            </article>
          ))}
          <article className={`pw-card pw-card-agent ${landed ? "is-in" : ""}`}>
            <div className="pw-preview pw-tone-a">
              <span className="pw-figure pw-figure-eleni">{clip ? <DoctorReel n={3} /> : <Doctor />}</span>
              <span className="pw-preview-top"><span className="p-chip p-chip-agent"><AgentIcon host="claude" size={14} />via MCP · Claude Code</span></span>
              <span className="pw-caption"><span>{AGENT_DRAFT_CAPTION}</span></span>
            </div>
            <div className="pw-meta"><strong>{AGENT_DRAFT_TITLE}</strong><span className="pw-state"><i />Draft<span className="pw-version"><span>v1</span></span></span></div>
          </article>
        </div>

        {/* The clip version leaves the terminal out (Minas, 15 Nov); the chat line and the landing card still show the agent. */}
        <div className={`pw-term ${between("terminalIn", "terminalOut") && !CLIP_MODE ? "is-in" : ""}`}>
          <div className="pw-term-bar"><span className="pw-dots"><i /><i /><i /></span><span>claude · ~/patient-questions</span><span className="pw-term-mcp"><Plug />faceful · MCP</span></div>
          <div className="pw-term-body">
            <p className="t-line t-ask"><span className="t-prompt">›</span><Typed text={AGENT_ASK} start={CUE.cmdType} seconds={1.5} caret={!on("toolCall")} /></p>
            <p className={`t-line t-tool ${on("toolCall") ? "is-in" : ""}`}><span className="t-dot" />faceful · <b>create_draft</b> <span className="t-dim">(MCP)</span></p>
            <p className={`t-line t-arg ${on("toolCall") ? "is-in" : ""}`} style={{ "--d": 1 } as CSSProperties}><span>project</span>“{PROJECT}”</p>
            <p className={`t-line t-arg ${on("toolCall") ? "is-in" : ""}`} style={{ "--d": 2 } as CSSProperties}><span>title</span>“{AGENT_DRAFT_TITLE}”</p>
            <p className={`t-line t-arg ${on("toolCall") ? "is-in" : ""}`} style={{ "--d": 3 } as CSSProperties}><span>language</span>en · presenter {PRESENTER}</p>
            <p className={`t-line t-ok ${on("toolDone") ? "is-in" : ""}`}><span className="t-dim">⎿</span>Draft saved · version 1 · now on the canvas</p>
          </div>
        </div>

        <div className={`pw-sheet ${reviewOpen ? "is-in" : ""}`}>
          <div className="pw-sheet-list">
            <strong>Review schedule</strong>
            <span className="pw-check is-ok"><Check />Script · version 2</span>
            <span className="pw-check is-ok"><Check />Posting time · Europe/Athens</span>
            <span className="pw-check is-wait"><ClockIcon />Video · not rendered yet</span>
          </div>
          <div className={`pw-sheet-gate ${on("boundary") ? "is-emphasis" : ""}`}>
            <span className="pw-gate-time"><ClockIcon />Mon 09:00</span>
            <strong>Needs your approval</strong>
            <span className="pw-gate-line"><Lock />Nothing posts without you.</span>
            <span className="pw-approve">Approve…</span>
          </div>
        </div>
        <p className="pw-footnote">Interface illustration with sample content. Nothing shown was rendered, scheduled or published.</p>
      </section>

      <aside className="pw-chat">
        <header className="pw-chat-head"><span className="pw-chat-icon"><Sparkles /></span><strong>AI Director</strong></header>
        <div className="pw-thread">
          <p className={`pw-msg pw-user pw-prompt ${between("promptFocus", "askType") ? "is-focus" : ""}`}>{PROMPT}</p>
          <div className="pw-msg pw-director"><span className="pw-who"><Sparkles />AI Director</span><p>Three drafts saved in “{PROJECT}”. {PRESENTER} presents each one. Nothing is rendered or scheduled.</p></div>
          <p className={`pw-msg pw-user ${on("askSend") ? "is-in" : "is-pending"}`}>{ASK}</p>
          <div className={`pw-msg pw-proposal ${on("proposal") ? "is-in" : "is-pending"} ${on("saved") ? "is-applied" : ""}`}>
            <strong>Update draft · {DRAFT_TITLE}</strong>
            <del>{OPENING_V1}</del>
            <ins>{OPENING_V2}</ins>
            <span className="pw-proposal-foot">
              <span className={`pw-apply ${between("apply", "saved") ? "is-pressed" : ""}`}>Apply changes</span>
              <span className="pw-saved"><Check />Saved as version 2</span>
            </span>
          </div>
          <div className={`pw-msg pw-activity ${on("activity") ? "is-in" : "is-pending"}`}><AgentIcon host="claude" size={18} /><span><b>Claude Code</b> added a draft · via MCP</span></div>
          <div className={`pw-msg pw-director ${on("reviewIn") ? "is-in" : "is-pending"}`}><span className="pw-who"><Sparkles />AI Director</span><p>Proposed: Monday 09:00, Europe/Athens. Publishing needs your approval.</p></div>
        </div>
        <div className="pw-composer">
          <span className="pw-composer-field">
            {on("askType") && !on("askSend") ? <span className="pw-typed"><Typed text={ASK} start={CUE.askType} seconds={1.2} /></span> : <span className="pw-placeholder">What should we change?</span>}
          </span>
          <span className="pw-composer-bar"><span className="pw-scope">Draft · {DRAFT_TITLE}</span><span className={`pw-send ${between("askType", "askSend") ? "is-ready" : ""} ${cueTime === CUE.askSend ? "is-pressed" : ""}`}><ArrowUp /></span></span>
        </div>
      </aside>
    </div>
  );
}

/** 38 to 52 s: three lines, each with a small visual, arriving as the presenter says them. */
function Why({ on, clip }: { on: (id: CueId) => boolean; clip: boolean }) {
  const open = on("whyIn") && !on("whyOut");
  return (
    <section className={`pwhy ${open ? "is-in" : ""}`} aria-hidden={open ? undefined : "true"}>
      <div className="pwhy-backdrop" />
      <div className="pitch-stage pwhy-stage">
        <p className="pwhy-eyebrow">Why it matters</p>
        <ol className="pwhy-list">
          <li className={on("why1") ? "is-in" : ""}>
            <span className="pwhy-art pwhy-art-1" aria-hidden="true">
              <span className="pwhy-prompt"><Sparkles />One prompt</span>
              <ArrowRight className="pwhy-arrow" />
              <span className="pwhy-card"><span className="pwhy-card-figure">{clip ? <DoctorPhoto /> : <Doctor />}</span><b>v2</b></span>
            </span>
            <span className="pwhy-copy"><strong>One prompt to an editable presenter video.</strong><span>Script, presenter and captions stay editable. Every change is a version.</span></span>
          </li>
          <li className={on("why2") ? "is-in" : ""}>
            <span className="pwhy-art pwhy-art-2" aria-hidden="true">
              <span className="pwhy-term"><span className="pwhy-term-dots"><i /><i /><i /></span><code>› create_draft</code></span>
              <span className="pwhy-link"><Plug /></span>
              <span className="pwhy-mini"><i /><i /><i className="is-agent" /></span>
            </span>
            <span className="pwhy-copy"><strong>Your own AI agent works in the same studio.</strong><span>Claude Code or any MCP client: same projects, same rules. Only you approve.</span></span>
          </li>
          <li className={on("why3") ? "is-in" : ""}>
            <span className="pwhy-art pwhy-art-3" aria-hidden="true">
              <span className="pwhy-pool"><span className="pwhy-pool-a">Studio</span><span className="pwhy-pool-b">Agents</span></span>
              <span className="pwhy-stripe"><CreditCard />Stripe</span>
            </span>
            <span className="pwhy-copy"><strong>One credit balance for you and your agents.</strong><span>Billed through Stripe. The demo uses Stripe’s sandbox.</span></span>
          </li>
        </ol>
      </div>
    </section>
  );
}

function EndCard({ on }: { on: (id: CueId) => boolean }) {
  const open = on("endText");
  return (
    <div className={`pitch-stage pitch-overlay pend ${open ? "is-in" : ""}`} aria-hidden={open ? undefined : "true"}>
      <div className="pend-block">
        <span className="pend-brand"><span className="p-mark"><i /><i /><i /></span>Faceful</span>
        <p className="pend-line">The video studio you and your AI agent share.</p>
        <span className="pend-url">faceful.vercel.app</span>
      </div>
    </div>
  );
}
