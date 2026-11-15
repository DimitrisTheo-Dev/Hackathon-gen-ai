import { Composition, continueRender, delayRender, registerRoot } from "remotion";
// The exact component the studio previews, so the MP4 and the preview draw the same frames.
import { Reel, type ReelProps } from "../../../apps/web/src/video/Reel";
import inter from "../../../apps/web/public/fonts/InterVariable.woff2";

// The studio's typeface, loaded before the first frame so text never renders in a fallback font.
const fontHandle = delayRender("Loading Inter");
new FontFace("InterVariable", `url(${inter})`, { weight: "100 900" })
  .load()
  .then((font) => {
    document.fonts.add(font);
    continueRender(fontHandle);
  })
  .catch(() => continueRender(fontHandle));

const placeholder: ReelProps = {
  media: { itemMedia: null, files: {} },
  composition: {
    version: 2,
    fps: 25,
    durationSeconds: 1,
    video: [],
    audio: [],
    cards: [],
    captions: [],
    transcript: null,
    style: { accent: "#5F6C66", background: "#111214", captionPosition: "bottom", captionSize: "large", duckMusic: true },
    labels: { aiAvatar: true, disclaimer: "" },
  },
};

function Root() {
  return (
    <Composition
      id="Reel"
      component={Reel}
      width={1080}
      height={1920}
      fps={25}
      durationInFrames={25}
      defaultProps={placeholder}
      calculateMetadata={({ props }) => ({
        fps: props.composition.fps,
        durationInFrames: Math.max(1, Math.round(props.composition.durationSeconds * props.composition.fps)),
      })}
    />
  );
}

registerRoot(Root);
