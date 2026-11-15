import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { PlayerRef } from "@remotion/player";
import { AudioLines, Captions, Clapperboard, Layers, Mic, Music, UserRound, type LucideIcon } from "lucide-react";
import type { Composition } from "@castroom/contracts";
import { durationInFrames, timeLabel, type Clip, type Track } from "./model";

export type Selection = { track: Track; id: string } | null;
type Row = { key: string; label: string; icon: LucideIcon; empty: string; track: Track; clips: Clip[]; className: string };

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
    { key: "main", label: "Main picture", icon: UserRound, empty: "No main picture", track: "video", clips: composition.video.filter((clip) => clip.layer === 0), className: "video main" },
    { key: "overlay", label: "Overlays", icon: Layers, empty: "No overlays · add from Files", track: "video", clips: composition.video.filter((clip) => clip.layer === 1), className: "video overlay" },
    { key: "voice", label: "Voice", icon: Mic, empty: "The main picture’s own sound", track: "audio", clips: composition.audio.filter((clip) => clip.role === "voice"), className: "audio voice" },
    { key: "music", label: "Music", icon: Music, empty: "No music", track: "audio", clips: composition.audio.filter((clip) => clip.role === "music"), className: "audio music" },
    { key: "sfx", label: "Sound effects", icon: AudioLines, empty: "No sound effects", track: "audio", clips: composition.audio.filter((clip) => clip.role === "sfx"), className: "audio sfx" },
    { key: "cards", label: "Cards", icon: Clapperboard, empty: "No cards", track: "cards", clips: composition.cards, className: "cards" },
    { key: "captions", label: "Captions", icon: Captions, empty: "No captions", track: "captions", clips: composition.captions, className: "captions" },
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
      {rows.map((row) => {
        const Icon = row.icon;
        const clips = row.clips.filter((clip) => clip.end > clip.start);
        return (
          <div className={`timeline-row ${clips.some((clip) => clip.id === selection?.id) ? "has-selection" : ""}`} key={row.key}>
            <span className="timeline-label" title={row.label}><Icon size={13} aria-hidden="true" /><span>{row.label}</span></span>
            <div className="timeline-lane" onPointerDown={seek}>
              {!clips.length && <span className="lane-empty">{row.empty}</span>}
              {clips.map((clip) => {
                const name = labelFor(row.track, clip);
                return (
                  <button
                    key={clip.id}
                    type="button"
                    className={`timeline-clip ${row.className} ${selection?.id === clip.id ? "selected" : ""}`}
                    style={{ left: pct(clip.start), width: `calc(${pct(clip.end - clip.start)} - 2px)` }}
                    aria-label={`${row.label}: ${name}, ${timeLabel(clip.start)} to ${timeLabel(clip.end)}`}
                    aria-pressed={selection?.id === clip.id}
                    title={name}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onSelect(row.track, clip)}
                  >
                    <span aria-hidden="true">{name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
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
