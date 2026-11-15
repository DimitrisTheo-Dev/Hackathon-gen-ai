import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { PlayerRef } from "@remotion/player";
import type { Composition } from "@castroom/contracts";
import { durationInFrames, timeLabel, type Clip, type Track } from "./model";

export type Selection = { track: Track; id: string } | null;
type Row = { key: string; label: string; track: Track | null; clips: Clip[]; className: string };

/** Clip lanes with a playhead and the transcript's words. Subscribes to the player itself, so playback never re-renders the inspector. */
export function Timeline({ composition, playerRef, selection, labelFor, onSelect }: { composition: Composition; playerRef: RefObject<PlayerRef | null>; selection: Selection; labelFor: (track: Track, clip: Clip) => string; onSelect: (track: Track, clip: Clip) => void }) {
  const [frame, setFrame] = useState(0);
  const total = durationInFrames(composition);
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
  const pct = (seconds: number) => `${(Math.min(Math.max(seconds, 0), composition.durationSeconds) / composition.durationSeconds) * 100}%`;
  const step = composition.durationSeconds > 90 ? 15 : composition.durationSeconds > 40 ? 10 : 5;
  const ticks = Array.from({ length: Math.floor(composition.durationSeconds / step) + 1 }, (_, index) => index * step);
  const rows: Row[] = [
    { key: "main", label: "Main picture", track: "video", clips: composition.video.filter((clip) => clip.layer === 0), className: "video main" },
    { key: "overlay", label: "Overlays", track: "video", clips: composition.video.filter((clip) => clip.layer === 1), className: "video overlay" },
    { key: "voice", label: "Voice", track: "audio", clips: composition.audio.filter((clip) => clip.role === "voice"), className: "audio voice" },
    { key: "music", label: "Music", track: "audio", clips: composition.audio.filter((clip) => clip.role === "music"), className: "audio music" },
    { key: "sfx", label: "SFX", track: "audio", clips: composition.audio.filter((clip) => clip.role === "sfx"), className: "audio sfx" },
    { key: "cards", label: "Cards", track: "cards", clips: composition.cards, className: "cards" },
    { key: "captions", label: "Captions", track: "captions", clips: composition.captions, className: "captions" },
  ];
  const words = composition.transcript?.words ?? [];
  return (
    <div className="video-timeline" aria-label="Timeline">
      <div className="timeline-row timeline-ruler">
        <span className="timeline-label">{timeLabel(frame / composition.fps)}</span>
        <div className="timeline-lane" onPointerDown={seek}>
          {ticks.map((second) => <span key={second} className="timeline-tick" style={{ left: pct(second) }}>{second}s</span>)}
        </div>
      </div>
      {rows.map((row) => (
        <div className="timeline-row" key={row.key}>
          <span className="timeline-label">{row.label}</span>
          <div className="timeline-lane" onPointerDown={seek}>
            {row.clips.filter((clip) => clip.end > clip.start).map((clip) => (
              <button
                key={clip.id}
                type="button"
                className={`timeline-clip ${row.className} ${selection?.id === clip.id ? "selected" : ""}`}
                style={{ left: pct(clip.start), width: `calc(${pct(clip.end - clip.start)} - 2px)` }}
                aria-label={`${row.label}: ${labelFor(row.track!, clip)}, ${timeLabel(clip.start)} to ${timeLabel(clip.end)}`}
                title={labelFor(row.track!, clip)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onSelect(row.track!, clip)}
              />
            ))}
          </div>
        </div>
      ))}
      {words.length > 0 && (
        <div className="timeline-row">
          <span className="timeline-label">Words</span>
          <div className="timeline-lane timeline-words" onPointerDown={seek} aria-hidden="true">
            {words.map((word, index) => <span key={index} className="timeline-word" style={{ left: pct(word.start), width: pct(Math.max(word.end - word.start, 0.04)) }} title={word.t} />)}
          </div>
        </div>
      )}
      <div className="timeline-playhead" style={{ left: `calc(var(--timeline-pad) + var(--timeline-label) + (100% - 2 * var(--timeline-pad) - var(--timeline-label)) * ${Math.min(1, frame / Math.max(1, total - 1))})` }} aria-hidden="true" />
    </div>
  );
}
