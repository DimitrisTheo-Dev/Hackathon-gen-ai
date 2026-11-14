import type { CSSProperties } from "react";
import { AbsoluteFill, Easing, Freeze, Html5Audio, Img, OffthreadVideo, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { AudioClip, CaptionCue, ClipSource, Composition, CompositionCard, Transition, TranscriptWord, VideoClip } from "@castroom/contracts";

/**
 * The Faceful reel: a 1080x1920 presenter-led short drawn from a timeline `Composition`.
 * Every input is plain data, so the studio preview and the render workers draw the same frames.
 * `onMediaError` is preview-only and never needed for a render.
 */
export type ReelMedia = { itemMedia: string | null; files: Record<string, { url: string; mime: string }> };
export type ReelProps = {
  composition: Composition;
  media: ReelMedia;
  onMediaError?: (url: string) => void;
};

const FONT = 'InterVariable, Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const outCubic = Easing.bezier(0.33, 1, 0.68, 1);
const inOutCubic = Easing.bezier(0.65, 0, 0.35, 1);
/** Where the main picture sits while a split-screen overlay is on top. */
const SPLIT_TOP = 860;
const SAFE_X = 90;
const DUCK = 0.32;

const frames = (seconds: number, fps: number) => Math.round(seconds * fps);
export function sourceUrl(source: ClipSource, media: ReelMedia): string | null {
  if (source.kind === "url") return source.url;
  if (source.kind === "item_media") return media.itemMedia;
  return media.files[source.fileId]?.url ?? null;
}
/** Fade in over `fadeIn` seconds from `start`, out over `fadeOut` seconds before `end`. */
function life(t: number, start: number, end: number, fadeIn = 0.25, fadeOut = 0.2) {
  const inP = fadeIn > 0 ? interpolate(t, [start, start + fadeIn], [0, 1], { ...CLAMP, easing: outCubic }) : t >= start ? 1 : 0;
  const outP = fadeOut > 0 ? interpolate(t, [end - fadeOut, end], [0, 1], { ...CLAMP, easing: inOutCubic }) : t >= end ? 1 : 0;
  return { opacity: inP * (1 - outP), enter: inP };
}
/** Clips with a usable span, in frames. A half-edited clip (end before start) is skipped, not fatal. */
function spans<T extends { start: number; end: number }>(clips: T[], fps: number) {
  return clips
    .map((clip) => ({ clip, from: frames(clip.start, fps), duration: frames(clip.end, fps) - frames(clip.start, fps) }))
    .filter((entry) => entry.duration >= 1);
}
/** Opacity and transform for a clip's entrance and exit, `t` seconds into a clip of `length` seconds. */
function transitionStyle(t: number, length: number, enter: Transition, exit: Transition): CSSProperties {
  const p = (kind: Transition, phase: number) => (kind.kind === "cut" || kind.duration <= 0 ? 1 : interpolate(phase, [0, kind.duration], [0, 1], { ...CLAMP, easing: outCubic }));
  const a = p(enter, t);
  const b = p(exit, length - t);
  const opacity = (enter.kind === "fade" || enter.kind === "zoom" ? a : 1) * (exit.kind === "fade" || exit.kind === "zoom" ? b : 1);
  const y = (enter.kind === "slide_up" ? (1 - a) * 100 : 0) - (exit.kind === "slide_up" ? (1 - b) * 100 : 0);
  const scale = (enter.kind === "zoom" ? 1.12 - 0.12 * a : 1) * (exit.kind === "zoom" ? 1 + 0.08 * (1 - b) : 1);
  return { opacity, transform: `translateY(${y}%) scale(${scale})` };
}

function Media({ clip, url, muted, trimFrames, onMediaError }: { clip: VideoClip; url: string; muted: boolean; trimFrames: number; onMediaError?: (url: string) => void }) {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  const fill: CSSProperties = { width: "100%", height: "100%", objectFit: "cover", objectPosition: clip.layer === 0 ? "50% 22%" : "50% 50%" };
  if (clip.media === "image") {
    const zoom = interpolate(t, [0, clip.end - clip.start], [1.03, 1.1], CLAMP);
    return <Img src={url} maxRetries={0} onError={() => onMediaError?.(url)} style={{ ...fill, transform: `scale(${zoom})` }} />;
  }
  return <OffthreadVideo src={url} muted={muted} volume={clip.volume} trimBefore={trimFrames > 0 ? trimFrames : undefined} onError={() => onMediaError?.(url)} style={fill} />;
}

function Placeholder() {
  return (
    <AbsoluteFill style={{ background: "radial-gradient(120% 70% at 50% 30%, #3a3d44 0%, #202227 60%, #16171a 100%)" }}>
      <div style={{ position: "absolute", left: "50%", top: "34%", width: 300, height: 300, marginLeft: -150, borderRadius: "50%", background: "rgba(255,255,255,0.08)" }} />
      <div style={{ position: "absolute", left: "50%", top: "52%", width: 560, height: 520, marginLeft: -280, borderRadius: "280px 280px 0 0", background: "rgba(255,255,255,0.06)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: "66%", textAlign: "center", fontFamily: FONT, fontSize: 30, fontWeight: 600, letterSpacing: "0.12em", color: "rgba(255,255,255,0.36)" }}>PRESENTER CLIP</div>
    </AbsoluteFill>
  );
}

/** One video clip. Main-layer clips move to the lower half while a split overlay is up. */
function VideoLayerClip({ clip, media, split, onMediaError }: { clip: VideoClip; media: ReelMedia; split: number; onMediaError?: (url: string) => void }) {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const t = frame / fps;
  const length = clip.end - clip.start;
  const url = sourceUrl(clip.source, media);
  const motion = transitionStyle(t, length, clip.transitionIn, clip.transitionOut);
  let box: CSSProperties;
  if (clip.layer === 0) box = { position: "absolute", left: 0, right: 0, top: interpolate(split, [0, 1], [0, SPLIT_TOP]), bottom: 0, overflow: "hidden", background: "#1c1d20" };
  else if (clip.layout === "full") box = { position: "absolute", inset: 0, overflow: "hidden" };
  else if (clip.layout === "split") box = { position: "absolute", left: 0, right: 0, top: 0, height: SPLIT_TOP, overflow: "hidden" };
  else box = { position: "absolute", left: SAFE_X, right: SAFE_X, top: 300, height: 900, borderRadius: 40, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,0.35)" };
  // A lip-sync offset delays the picture against its own sound, so the sound plays from a separate audio element.
  const offset = clip.media === "video" ? clip.syncOffsetFrames : 0;
  const trim = frames(clip.in, fps);
  const separateAudio = offset !== 0 && clip.volume > 0 && !!url;
  const muted = separateAudio || clip.volume === 0;
  // Delaying past the in-point holds the first frame for the gap, then plays from the in-point.
  const hold = offset - trim;
  let picture = <Placeholder />;
  if (url && hold > 0)
    picture = (
      <>
        <Sequence durationInFrames={hold} layout="none"><Freeze frame={0}><Media clip={clip} url={url} muted trimFrames={0} onMediaError={onMediaError} /></Freeze></Sequence>
        <Sequence from={hold} layout="none"><Media clip={clip} url={url} muted={muted} trimFrames={0} onMediaError={onMediaError} /></Sequence>
      </>
    );
  else if (url) picture = <Media clip={clip} url={url} muted={muted} trimFrames={trim - offset} onMediaError={onMediaError} />;
  return (
    <div style={{ ...box, ...motion }}>
      {picture}
      {separateAudio && <Html5Audio src={url} volume={clip.volume} trimBefore={trim > 0 ? trim : undefined} />}
    </div>
  );
}

function AudioLayerClip({ clip, media, voiceAt, duck }: { clip: AudioClip; media: ReelMedia; voiceAt: (absoluteFrame: number) => boolean; duck: boolean }) {
  const { fps } = useVideoConfig();
  const url = sourceUrl(clip.source, media);
  if (!url) return null;
  const from = frames(clip.start, fps);
  const length = clip.end - clip.start;
  const trim = frames(clip.in, fps);
  return (
    <Html5Audio
      src={url}
      loop={clip.loop}
      trimBefore={trim > 0 ? trim : undefined}
      volume={(f) => {
        const t = f / fps;
        const fade = Math.min(clip.fadeIn > 0 ? Math.min(1, t / clip.fadeIn) : 1, clip.fadeOut > 0 ? Math.min(1, Math.max(0, (length - t) / clip.fadeOut)) : 1);
        const ducked = duck && clip.role === "music" && voiceAt(from + f) ? DUCK : 1;
        return clip.volume * fade * ducked;
      }}
    />
  );
}

function Card({ card, accent, image }: { card: CompositionCard; accent: string; image: string | null }) {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  const { opacity, enter } = life(t, 0, card.end - card.start, 0.35, 0.25);
  const rise = interpolate(enter, [0, 1], [28, 0]);
  if (card.kind === "statement")
    return (
      <AbsoluteFill style={{ background: accent, opacity, fontFamily: FONT, color: "white", alignItems: "center", justifyContent: "center", padding: `0 ${SAFE_X}px` }}>
        {image && <Img src={image} maxRetries={0} style={{ width: 420, height: 420, objectFit: "contain", marginBottom: 60, transform: `scale(${interpolate(enter, [0, 1], [0.86, 1])})` }} />}
        <div style={{ fontSize: 96, fontWeight: 750, lineHeight: 1.05, letterSpacing: "-0.02em", textAlign: "center", textWrap: "balance", transform: `translateY(${rise}px)` }}>{card.title}</div>
        {card.subtitle && <div style={{ marginTop: 28, fontSize: 46, fontWeight: 450, lineHeight: 1.2, opacity: 0.88, textAlign: "center" }}>{card.subtitle}</div>}
      </AbsoluteFill>
    );
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
          {image && <Img src={image} maxRetries={0} style={{ width: 120, height: 120, objectFit: "cover", alignSelf: "center", marginLeft: 18, borderRadius: 16 }} />}
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
        {image ? (
          <Img src={image} maxRetries={0} style={{ flex: "none", width: 120, height: 120, objectFit: "contain" }} />
        ) : (
          <div style={{ flex: "none", width: 96, height: 96, borderRadius: 48, background: accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 0, height: 0, marginLeft: 8, borderTop: "20px solid transparent", borderBottom: "20px solid transparent", borderLeft: "30px solid white" }} />
          </div>
        )}
        <div>
          <div style={{ fontSize: 50, fontWeight: 700, color: "#17181b", lineHeight: 1.08 }}>{card.title}</div>
          {card.subtitle && <div style={{ marginTop: 6, fontSize: 38, color: "#6b6f76", lineHeight: 1.15 }}>{card.subtitle}</div>}
        </div>
      </div>
    </div>
  );
}

/** One caption page. With a transcript, each word lights up when it is spoken; without, words share the time evenly. */
function Caption({ cue, composition, words }: { cue: CaptionCue; composition: Composition; words: TranscriptWord[] }) {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  const length = cue.end - cue.start;
  // Pages cut rather than fade, so a caption is readable from its first frame.
  const enter = interpolate(t, [0, 0.1], [0.55, 1], { ...CLAMP, easing: outCubic });
  const tokens = cue.text.split(/\s+/).filter(Boolean);
  const absolute = cue.start + t;
  const timed = words.length === tokens.length ? words : null;
  const active = timed
    ? Math.max(0, timed.reduce((last, word, index) => (absolute >= word.start - 0.03 ? index : last), 0))
    : Math.min(tokens.length - 1, Math.floor((t / Math.max(length, 0.01)) * tokens.length));
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
        transform: `translateY(${interpolate(enter, [0.55, 1], [10, 0])}px)`,
        textShadow: "0 3px 16px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.45)",
      }}
    >
      {tokens.map((word, index) => (
        <span key={index} style={{ position: "relative", opacity: index === active ? 1 : 0.78 }}>
          {word}
          {index === active && <span style={{ position: "absolute", left: 2, right: 2, bottom: -10, height: 7, borderRadius: 4, background: composition.style.accent, boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />}
        </span>
      ))}
    </div>
  );
}

/** Honesty labels stay on every frame: an "AI avatar" tag and an optional disclaimer line. */
function Labels({ composition }: { composition: Composition }) {
  const { aiAvatar, disclaimer } = composition.labels;
  return (
    <>
      {aiAvatar && (
        <div style={{ position: "absolute", right: 48, top: 120, padding: "10px 20px", borderRadius: 999, background: "rgba(10,10,12,0.55)", color: "white", fontFamily: FONT, fontSize: 28, fontWeight: 600, letterSpacing: "0.04em" }}>AI avatar</div>
      )}
      {disclaimer && (
        <div style={{ position: "absolute", left: SAFE_X, right: SAFE_X, bottom: 70, textAlign: "center", color: "rgba(255,255,255,0.86)", fontFamily: FONT, fontSize: 26, lineHeight: 1.3, textShadow: "0 1px 6px rgba(0,0,0,0.6)" }}>{disclaimer}</div>
      )}
    </>
  );
}

export function Reel({ composition, media, onMediaError }: ReelProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  // Split-screen weight: eases in and out around every split overlay.
  const split = Math.max(
    0,
    ...composition.video.filter((clip) => clip.layer === 1 && clip.layout === "split" && clip.end > clip.start).map((clip) => life(t, clip.start, clip.end, 0.35, 0.35).opacity),
  );
  const voices = composition.audio.filter((clip) => clip.role === "voice");
  const voiceAt = (absoluteFrame: number) => voices.some((clip) => absoluteFrame >= frames(clip.start, fps) && absoluteFrame < frames(clip.end, fps));
  const words = composition.transcript?.words ?? [];
  const statements = composition.cards.filter((card) => card.kind === "statement");
  const imageOf = (card: CompositionCard) => (card.imageFileId ? (media.files[card.imageFileId]?.url ?? null) : null);
  return (
    <AbsoluteFill style={{ background: composition.style.background, fontFamily: FONT }}>
      {[0, 1].map((layer) =>
        spans(composition.video.filter((clip) => clip.layer === layer), fps).map(({ clip, from, duration }) => (
          <Sequence key={clip.id} from={from} durationInFrames={duration} layout="none" name={`Video ${clip.id}`}>
            <VideoLayerClip clip={clip} media={media} split={layer === 0 ? split : 0} onMediaError={onMediaError} />
          </Sequence>
        )),
      )}
      {spans(composition.audio, fps).map(({ clip, from, duration }) => (
        <Sequence key={clip.id} from={from} durationInFrames={duration} layout="none" name={`Audio ${clip.id}`}>
          <AudioLayerClip clip={clip} media={media} voiceAt={voiceAt} duck={composition.style.duckMusic} />
        </Sequence>
      ))}
      {spans(composition.cards, fps).map(({ clip, from, duration }) => (
        <Sequence key={clip.id} from={from} durationInFrames={duration} layout="none" name={`Card ${clip.id}`}>
          <Card card={clip} accent={composition.style.accent} image={imageOf(clip)} />
        </Sequence>
      ))}
      {spans(composition.captions, fps)
        // A full-screen statement carries its own words; captions never sit on top of it.
        .filter(({ clip }) => !statements.some((card) => clip.start < card.end && clip.end > card.start && clip.start >= card.start))
        .map(({ clip, from, duration }) => (
          <Sequence key={clip.id} from={from} durationInFrames={duration} layout="none" name={`Caption ${clip.id}`}>
            <Caption cue={clip} composition={composition} words={words.filter((word) => word.start >= clip.start - 0.05 && word.start < clip.end)} />
          </Sequence>
        ))}
      <Labels composition={composition} />
    </AbsoluteFill>
  );
}
