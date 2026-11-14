import type { CSSProperties } from "react";
import { AbsoluteFill, Easing, Html5Audio, Img, OffthreadVideo, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { BrollClip, CaptionCue, Composition, CompositionCard } from "@castroom/contracts";

/**
 * The Faceful reel: a 1080x1920 presenter-led short drawn from a `Composition`.
 * Every input is plain data so the same component can later be rendered to MP4 by a worker;
 * `onMediaError` is preview-only and never needed for a render.
 */
export type ReelProps = {
  composition: Composition;
  /** Resolved presenter clip (signed render URL or a linked clip); null draws a placeholder. */
  presenterUrl: string | null;
  onMediaError?: (url: string) => void;
};

const FONT = 'InterVariable, Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const outCubic = Easing.bezier(0.33, 1, 0.68, 1);
const inOutCubic = Easing.bezier(0.65, 0, 0.35, 1);
/** Where the presenter sits while a split-screen b-roll clip is on top. */
const SPLIT_TOP = 860;
const SAFE_X = 90;

const frames = (seconds: number, fps: number) => Math.round(seconds * fps);
/** Fade in over `fadeIn` seconds from `start`, out over `fadeOut` seconds before `end`. */
function life(t: number, start: number, end: number, fadeIn = 0.25, fadeOut = 0.2) {
  const inP = interpolate(t, [start, start + fadeIn], [0, 1], { ...CLAMP, easing: outCubic });
  const outP = interpolate(t, [end - fadeOut, end], [0, 1], { ...CLAMP, easing: inOutCubic });
  return { opacity: inP * (1 - outP), enter: inP };
}
/** Clips with a usable span, in frames. A half-edited clip (end before start) is skipped, not fatal. */
function spans<T extends { start: number; end: number }>(clips: T[], fps: number) {
  return clips
    .map((clip) => ({ clip, from: frames(clip.start, fps), duration: frames(clip.end, fps) - frames(clip.start, fps) }))
    .filter((entry) => entry.duration >= 1);
}

function Presenter({ url, composition, split, onMediaError }: { url: string | null; composition: Composition; split: number; onMediaError?: (url: string) => void }) {
  const { fps } = useVideoConfig();
  const top = interpolate(split, [0, 1], [0, SPLIT_TOP]);
  const box: CSSProperties = { position: "absolute", left: 0, right: 0, top, bottom: 0, overflow: "hidden", background: "#1c1d20" };
  if (!url)
    return (
      <div style={box}>
        <AbsoluteFill style={{ background: "radial-gradient(120% 70% at 50% 30%, #3a3d44 0%, #202227 60%, #16171a 100%)" }} />
        <div style={{ position: "absolute", left: "50%", top: "34%", width: 300, height: 300, marginLeft: -150, borderRadius: "50%", background: "rgba(255,255,255,0.08)" }} />
        <div style={{ position: "absolute", left: "50%", top: "52%", width: 560, height: 520, marginLeft: -280, borderRadius: "280px 280px 0 0", background: "rgba(255,255,255,0.06)" }} />
        <div style={{ position: "absolute", left: 0, right: 0, top: "66%", textAlign: "center", fontFamily: FONT, fontSize: 30, fontWeight: 600, letterSpacing: "0.12em", color: "rgba(255,255,255,0.36)" }}>
          PRESENTER CLIP
        </div>
      </div>
    );
  return (
    <div style={box}>
      <OffthreadVideo
        src={url}
        trimBefore={frames(composition.presenter.trimStart, fps) || undefined}
        volume={composition.presenter.volume}
        onError={() => onMediaError?.(url)}
        style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 22%" }}
      />
    </div>
  );
}

function Broll({ clip, onMediaError }: { clip: BrollClip; onMediaError?: (url: string) => void }) {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const t = frame / fps;
  const length = clip.end - clip.start;
  const { opacity } = life(t, 0, length, 0.2, 0.2);
  const zoom = interpolate(t, [0, length], [1.04, 1.1], CLAMP);
  const box: CSSProperties =
    clip.layout === "full"
      ? { position: "absolute", inset: 0, overflow: "hidden", opacity }
      : { position: "absolute", left: 0, right: 0, top: 0, height: SPLIT_TOP, overflow: "hidden", opacity };
  const fill: CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
  return (
    <div style={box}>
      {clip.media === "video" ? (
        <OffthreadVideo src={clip.url} muted trimBefore={frames(clip.trimStart, fps) || undefined} onError={() => onMediaError?.(clip.url)} style={fill} />
      ) : (
        <Img src={clip.url} maxRetries={0} onError={() => onMediaError?.(clip.url)} style={{ ...fill, transform: `scale(${zoom})` }} />
      )}
    </div>
  );
}

function Card({ card, accent }: { card: CompositionCard; accent: string }) {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  const { opacity, enter } = life(t, 0, card.end - card.start, 0.35, 0.25);
  const rise = interpolate(enter, [0, 1], [28, 0]);
  if (card.kind === "title")
    return (
      <AbsoluteFill style={{ opacity }}>
        <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(10,10,12,0.62) 0%, rgba(10,10,12,0) 46%)" }} />
        <div style={{ position: "absolute", left: SAFE_X, right: SAFE_X, top: 250, transform: `translateY(${rise}px)`, fontFamily: FONT, color: "white" }}>
          <div style={{ width: 96 * enter, height: 8, borderRadius: 4, background: accent, marginBottom: 34 }} />
          <div style={{ fontSize: 92, fontWeight: 700, lineHeight: 1.04, letterSpacing: "-0.02em", textWrap: "balance", textShadow: "0 4px 24px rgba(0,0,0,0.35)" }}>{card.title}</div>
          {card.subtitle && <div style={{ marginTop: 22, fontSize: 44, fontWeight: 450, lineHeight: 1.2, opacity: 0.86 }}>{card.subtitle}</div>}
        </div>
      </AbsoluteFill>
    );
  if (card.kind === "lower_third")
    return (
      <div style={{ position: "absolute", left: SAFE_X, top: 1150, maxWidth: 1080 - 2 * SAFE_X, opacity, transform: `translateX(${-rise}px)`, fontFamily: FONT }}>
        <div style={{ display: "flex", alignItems: "stretch", borderRadius: 22, overflow: "hidden", background: "rgba(255,255,255,0.95)", boxShadow: "0 18px 50px rgba(0,0,0,0.28)" }}>
          <div style={{ width: 12, background: accent }} />
          <div style={{ padding: "22px 30px 24px 26px" }}>
            <div style={{ fontSize: 46, fontWeight: 700, color: "#17181b", lineHeight: 1.1 }}>{card.title}</div>
            {card.subtitle && <div style={{ marginTop: 6, fontSize: 34, color: "#5b5f66", lineHeight: 1.2 }}>{card.subtitle}</div>}
          </div>
        </div>
      </div>
    );
  return (
    <div style={{ position: "absolute", left: SAFE_X, right: SAFE_X, top: 1200, opacity, transform: `translateY(${rise}px) scale(${interpolate(enter, [0, 1], [0.96, 1])})`, fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", gap: 30, padding: "30px 36px", borderRadius: 36, background: "#fffdf9", boxShadow: "0 26px 60px rgba(0,0,0,0.32)" }}>
        <div style={{ flex: "none", width: 96, height: 96, borderRadius: 48, background: accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 0, height: 0, marginLeft: 8, borderTop: "20px solid transparent", borderBottom: "20px solid transparent", borderLeft: "30px solid white" }} />
        </div>
        <div>
          <div style={{ fontSize: 50, fontWeight: 700, color: "#17181b", lineHeight: 1.08 }}>{card.title}</div>
          {card.subtitle && <div style={{ marginTop: 6, fontSize: 38, color: "#6b6f76", lineHeight: 1.15 }}>{card.subtitle}</div>}
        </div>
      </div>
    </div>
  );
}

/** One caption page. Words light up in turn, spread evenly over the page's time. */
function Caption({ cue, composition }: { cue: CaptionCue; composition: Composition }) {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  const length = cue.end - cue.start;
  // Pages cut rather than fade, so a caption is readable from its first frame.
  const enter = interpolate(t, [0, 0.1], [0.55, 1], { ...CLAMP, easing: outCubic });
  const words = cue.text.split(/\s+/).filter(Boolean);
  const active = Math.min(words.length - 1, Math.floor((t / Math.max(length, 0.01)) * words.length));
  const size = composition.style.captionSize === "large" ? 66 : 52;
  const position: CSSProperties = composition.style.captionPosition === "center" ? { top: 960 - size } : { top: 1460 };
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE_X,
        right: SAFE_X,
        ...position,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        columnGap: size * 0.26,
        rowGap: size * 0.2,
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: size,
        lineHeight: 1.08,
        color: "white",
        textAlign: "center",
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [10, 0])}px)`,
        textShadow: "0 3px 16px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.45)",
      }}
    >
      {words.map((word, index) => (
        <span key={index} style={{ position: "relative", opacity: index === active ? 1 : 0.78 }}>
          {word}
          {index === active && (
            <span style={{ position: "absolute", left: 2, right: 2, bottom: -10, height: 7, borderRadius: 4, background: composition.style.accent, boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
          )}
        </span>
      ))}
    </div>
  );
}

export function Reel({ composition, presenterUrl, onMediaError }: ReelProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  // Split-screen weight: eases in and out around every split b-roll clip.
  const split = Math.max(
    0,
    ...composition.broll
      .filter((clip) => clip.layout === "split" && clip.end > clip.start)
      .map((clip) => life(t, clip.start, clip.end, 0.35, 0.35).opacity),
  );
  const presenter = composition.presenter.source === "url" ? composition.presenter.url : composition.presenter.source === "item_media" ? presenterUrl : null;
  return (
    <AbsoluteFill style={{ background: composition.style.background, fontFamily: FONT }}>
      {composition.presenter.source !== "none" && <Presenter url={presenter} composition={composition} split={split} onMediaError={onMediaError} />}
      {spans(composition.broll, fps).map(({ clip, from, duration }) => (
        <Sequence key={clip.id} from={from} durationInFrames={duration} layout="none" name={`B-roll ${clip.id}`}>
          <Broll clip={clip} onMediaError={onMediaError} />
        </Sequence>
      ))}
      {spans(composition.cards, fps).map(({ clip, from, duration }) => (
        <Sequence key={clip.id} from={from} durationInFrames={duration} layout="none" name={`Card ${clip.id}`}>
          <Card card={clip} accent={composition.style.accent} />
        </Sequence>
      ))}
      {spans(composition.captions, fps).map(({ clip, from, duration }) => (
        <Sequence key={clip.id} from={from} durationInFrames={duration} layout="none" name={`Caption ${clip.id}`}>
          <Caption cue={clip} composition={composition} />
        </Sequence>
      ))}
      {composition.music && <Html5Audio src={composition.music.url} volume={composition.music.volume} loop onError={() => onMediaError?.(composition.music!.url)} />}
    </AbsoluteFill>
  );
}
