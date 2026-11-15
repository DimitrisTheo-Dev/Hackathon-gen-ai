import { Player } from "@remotion/player";
import { useMemo } from "react";
import { COMPOSITION_HEIGHT, COMPOSITION_WIDTH, type Composition } from "@castroom/contracts";
import { Reel, type ReelMedia, type ReelProps } from "../video/Reel";

/** The rough preview: the same Reel the video studio and the render workers draw, played from local choices. */
export default function PreviewPlayer({ composition, media, compact = false }: { composition: Composition; media: ReelMedia; compact?: boolean }) {
  const inputProps = useMemo<ReelProps>(() => ({ composition, media }), [composition, media]);
  return (
    <Player
      component={Reel}
      inputProps={inputProps}
      durationInFrames={Math.max(1, Math.round(composition.durationSeconds * composition.fps))}
      fps={composition.fps}
      compositionWidth={COMPOSITION_WIDTH}
      compositionHeight={COMPOSITION_HEIGHT}
      controls={!compact}
      clickToPlay
      loop
      autoPlay={compact}
      initiallyMuted={compact}
      spaceKeyToPlayOrPause={!compact}
      style={{ width: "100%", height: "100%" }}
      errorFallback={() => <div className="np-player-error">The preview could not draw this frame.</div>}
    />
  );
}
