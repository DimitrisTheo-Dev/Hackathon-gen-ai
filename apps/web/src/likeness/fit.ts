/**
 * Whether the face sits in the on-screen oval, close enough to scan. The camera fills the screen
 * (object-fit: cover, mirrored), so the landmark box is mapped to screen pixels the same way before it is
 * compared with the oval. A turned head looks narrower and off center, so turns get looser limits. Pure.
 */

export type Fit = "ok" | "closer" | "back" | "center";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The landmark box [minX, minY, maxX, maxY] (0..1 of the raw frame) in the mirrored, cover-fitted view. */
export function boxOnScreen(box: [number, number, number, number], video: { w: number; h: number }, view: { w: number; h: number }): Rect {
  const scale = Math.max(view.w / video.w, view.h / video.h);
  const offsetX = (view.w - video.w * scale) / 2;
  const offsetY = (view.h - video.h * scale) / 2;
  const left = view.w - (box[2] * video.w * scale + offsetX);
  const right = view.w - (box[0] * video.w * scale + offsetX);
  return { x: left, y: box[1] * video.h * scale + offsetY, w: right - left, h: (box[3] - box[1]) * video.h * scale };
}

/** Face landmarks span cheek to cheek, a bit narrower than the head the oval is drawn for. */
export const FIT_MIN = 0.62;
export const FIT_MIN_TURNED = 0.42;
export const FIT_MAX = 1.08;

export function faceFit(face: Rect, oval: Rect, turned: boolean): Fit {
  const ratio = face.w / oval.w;
  if (ratio > FIT_MAX) return "back";
  if (ratio < (turned ? FIT_MIN_TURNED : FIT_MIN)) return "closer";
  const dx = Math.abs(face.x + face.w / 2 - (oval.x + oval.w / 2)) / oval.w;
  const dy = Math.abs(face.y + face.h / 2 - (oval.y + oval.h / 2)) / oval.h;
  return dx > (turned ? 0.3 : 0.16) || dy > (turned ? 0.25 : 0.14) ? "center" : "ok";
}
