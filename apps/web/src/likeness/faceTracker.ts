/**
 * MediaPipe FaceLandmarker for the likeness capture, run in a Web Worker (faceTracker.worker.ts) so face
 * tracking never blocks the page: the camera preview, the recorders and React keep the main thread. The
 * worker, MediaPipe and its WASM runtime are their own build chunks, so pages that never open the capture
 * never download them.
 *
 * Frames go over as downscaled ImageBitmaps, one at a time: the next frame is only sent once the previous
 * result is back, so a slow machine tracks fewer frames per second instead of queueing work. Up to two
 * faces are tracked by default, so a second person in view can be noticed.
 */
import { poseFromMatrix, type HeadPose } from "./pose";

/** Width of the frames tracked; landmarks are relative, so this only trades accuracy for speed. */
const TRACK_WIDTH = 480;

export interface FaceReading {
  faces: number;
  pose: HeadPose | null;
  blink: number | undefined;
  jaw: number | undefined;
  /** Face width as a share of the frame width, 0..1. */
  size: number;
  /** Landmark bounds [minX, minY, maxX, maxY], 0..1 of the unmirrored frame. */
  box: [number, number, number, number] | null;
  /** Every blendshape score (ARKit names; "Left" is the person's own left), 0..1. Empty without a face. */
  blendshapes: Record<string, number>;
  /** Every face found, in MediaPipe's order (not stable from frame to frame); the fields above are the first one. */
  people: FacePerson[];
}

export interface FacePerson {
  pose: HeadPose | null;
  size: number;
  box: [number, number, number, number];
  blendshapes: Record<string, number>;
}

interface RawPerson {
  matrix: number[] | null;
  shapes: Record<string, number>;
  size: number;
  box: [number, number, number, number];
}

interface RawResult {
  type: "result";
  ts: number;
  faces: number;
  matrix: number[] | null;
  shapes: Record<string, number>;
  size: number;
  box?: [number, number, number, number] | null;
  people?: RawPerson[];
}

function toReading(raw: RawResult): FaceReading {
  const { eyeBlinkLeft, eyeBlinkRight, jawOpen } = raw.shapes;
  return {
    faces: raw.faces,
    pose: raw.matrix ? poseFromMatrix(raw.matrix) : null,
    blink: eyeBlinkLeft === undefined && eyeBlinkRight === undefined ? undefined : Math.max(eyeBlinkLeft ?? 0, eyeBlinkRight ?? 0),
    jaw: jawOpen,
    size: raw.size,
    box: raw.box ?? null,
    blendshapes: raw.shapes,
    people: (raw.people ?? []).map((person) => ({ pose: person.matrix ? poseFromMatrix(person.matrix) : null, size: person.size, box: person.box, blendshapes: person.shapes })),
  };
}

export interface FaceTracker {
  /** Resolves once the model is loaded. */
  ready: Promise<void>;
  /** Start tracking `video`; `onReading` gets each result with the time it was taken (performance.now()). */
  start(video: HTMLVideoElement, onReading: (reading: FaceReading, ts: number) => void): void;
  stop(): void;
  dispose(): void;
}

/** `maxFaces`: how many faces MediaPipe looks for (each extra face found costs another landmark pass). */
export function createFaceTracker({ maxFaces = 2 }: { maxFaces?: number } = {}): FaceTracker {
  const worker = new Worker(new URL("./faceTracker.worker.ts", import.meta.url), { type: "module" });
  let running = false;
  let busy = false;
  let raf: number | null = null;
  let video: HTMLVideoElement | null = null;
  let handler: ((reading: FaceReading, ts: number) => void) | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    worker.addEventListener("message", (event) => {
      if (event.data?.type === "ready") resolve();
      if (event.data?.type === "error") reject(new Error(`Face tracking could not start: ${event.data.error}`));
    });
    worker.addEventListener("error", (event) => reject(new Error(`Face tracking could not start: ${event.message || "worker error"}`)));
  });
  ready.catch(() => {});
  worker.postMessage({ type: "init", maxFaces: Math.max(1, Math.min(6, Math.round(maxFaces))) });

  worker.addEventListener("message", (event) => {
    if (event.data?.type !== "result") return;
    busy = false;
    if (running) handler?.(toReading(event.data as RawResult), event.data.ts);
  });

  const pump = () => {
    if (!running) return;
    raf = requestAnimationFrame(pump);
    if (busy || !video || video.readyState < 2 || !video.videoWidth) return;
    busy = true;
    const height = Math.round((TRACK_WIDTH * video.videoHeight) / video.videoWidth);
    createImageBitmap(video, { resizeWidth: TRACK_WIDTH, resizeHeight: height, resizeQuality: "low" })
      .then((bitmap) => {
        if (!running) {
          bitmap.close();
          busy = false;
          return;
        }
        worker.postMessage({ type: "frame", bitmap, ts: performance.now() }, [bitmap]);
      })
      .catch(() => {
        busy = false;
      });
  };

  return {
    ready,
    start(element, onReading) {
      video = element;
      handler = onReading;
      if (running) return;
      running = true;
      raf = requestAnimationFrame(pump);
    },
    stop() {
      running = false;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    },
    dispose() {
      this.stop();
      worker.terminate();
    },
  };
}
