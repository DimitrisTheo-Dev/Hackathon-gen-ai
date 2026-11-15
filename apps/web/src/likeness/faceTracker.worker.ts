/**
 * Face tracking worker for the likeness capture (see faceTracker.ts). MediaPipe FaceLandmarker and its WASM
 * runtime ship with the app, built by Vite, so the page loads no script from another origin; only the model
 * file (about 4 MB) comes from Google's model storage, fetched on first use.
 *
 * In:  { type: "init", maxFaces }, then { type: "frame", bitmap, ts } for each frame.
 * Out: { type: "ready" } or { type: "error", error }, then one { type: "result", ... } per frame.
 */
import { FaceLandmarker } from "@mediapipe/tasks-vision";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_module_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url";

const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}
const scope = self as unknown as WorkerScope;
const message = (error: unknown) => String((error as Error | undefined)?.message ?? error);

let landmarker: FaceLandmarker | null = null;
let ready: Promise<void> | null = null;

async function init(maxFaces: number) {
  // This is a module worker: MediaPipe imports the loader as an ES module, so it needs the "module" build.
  const fileset = { wasmLoaderPath, wasmBinaryPath };
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO" as const,
    numFaces: maxFaces,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

scope.onmessage = async (event) => {
  const data = event.data as { type: "init"; maxFaces: number } | { type: "frame"; bitmap: ImageBitmap; ts: number };
  if (data.type === "init") {
    ready = init(data.maxFaces);
    ready.then(
      () => scope.postMessage({ type: "ready" }),
      (error) => scope.postMessage({ type: "error", error: message(error) }),
    );
    return;
  }
  const { bitmap, ts } = data;
  try {
    await ready;
    const result = landmarker!.detectForVideo(bitmap, ts);
    const people = (result.faceLandmarks ?? []).map((landmarks, i) => {
      let minX = 1;
      let maxX = 0;
      let minY = 1;
      let maxY = 0;
      for (const point of landmarks) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      }
      const shapes: Record<string, number> = {};
      for (const category of result.faceBlendshapes?.[i]?.categories ?? []) shapes[category.categoryName] = category.score;
      const matrix = result.facialTransformationMatrixes?.[i]?.data;
      return { matrix: matrix ? Array.from(matrix) : null, shapes, size: maxX - minX, box: [minX, minY, maxX, maxY] };
    });
    const first = people[0];
    scope.postMessage({ type: "result", ts, faces: people.length, matrix: first?.matrix ?? null, shapes: first?.shapes ?? {}, size: first?.size ?? 0, box: first?.box ?? null, people });
  } catch (error) {
    scope.postMessage({ type: "result", ts, faces: 0, matrix: null, shapes: {}, size: 0, box: null, people: [], error: message(error) });
  } finally {
    bitmap.close();
  }
};
