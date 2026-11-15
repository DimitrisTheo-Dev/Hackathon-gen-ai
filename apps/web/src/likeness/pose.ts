/**
 * Head pose for the guided face scan, from MediaPipe FaceLandmarker's facial transformation matrix.
 *
 * The matrix maps the canonical face into camera space (x right in the unmirrored image, y up, the face
 * looking along +z towards the camera), stored column-major. Its third column is where the face points:
 *   yaw   > 0  the person turned to their own left (the right of the raw camera image)
 *   pitch > 0  the person looked up
 * The scan starts with the straight pose, which becomes the baseline, so a camera held low or high does
 * not count as looking up or down. Pure: no browser APIs, unit tested in tests/likeness.test.ts.
 */

export type PoseId = "center" | "left" | "right" | "up" | "down";

export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface PoseTarget {
  id: PoseId;
  /** What the person is asked to do; read out to screen readers while the chevrons show it. */
  prompt: { en: string; el: string };
}

export const POSES: Record<PoseId, PoseTarget> = {
  center: { id: "center", prompt: { en: "Look straight at the camera", el: "Κοιτάξτε ευθεία την κάμερα" } },
  left: { id: "left", prompt: { en: "Slowly turn your head left", el: "Γυρίστε αργά το κεφάλι αριστερά" } },
  right: { id: "right", prompt: { en: "Slowly turn your head right", el: "Γυρίστε αργά το κεφάλι δεξιά" } },
  up: { id: "up", prompt: { en: "Tilt your head up a little", el: "Σηκώστε λίγο το κεφάλι" } },
  down: { id: "down", prompt: { en: "Tilt your head down a little", el: "Χαμηλώστε λίγο το κεφάλι" } },
};

/** Degrees past the baseline that count as a turn or a tilt, and how close to it counts as straight. */
export const YAW_TURN = 22;
export const PITCH_TILT = 13;
export const STRAIGHT = 9;
/** How long a pose must be held before it is captured. */
export const HOLD_MS = 450;

const DEG = 180 / Math.PI;

/** Yaw, pitch and roll in degrees from a column-major 4x4 matrix (MediaPipe `Matrix.data`). */
export function poseFromMatrix(data: ArrayLike<number>): HeadPose {
  // r(row, col) for a column-major matrix.
  const r = (row: number, col: number) => data[col * 4 + row];
  const fx = r(0, 2);
  const fy = r(1, 2);
  const fz = r(2, 2);
  const yaw = Math.atan2(fx, fz) * DEG;
  const pitch = Math.asin(Math.max(-1, Math.min(1, fy))) * DEG;
  const roll = Math.atan2(r(1, 0), r(0, 0)) * DEG;
  return { yaw, pitch, roll };
}

/** Center first (it calibrates the baseline), then the four turns in a random order, so a replayed video fails. */
export function poseSequence(random: () => number = Math.random): PoseId[] {
  const turns: PoseId[] = ["left", "right", "up", "down"];
  for (let i = turns.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [turns[i], turns[j]] = [turns[j], turns[i]];
  }
  return ["center", ...turns];
}

/** Whether `pose` (relative to `baseline`) matches the target. The straight pose is judged absolutely. */
export function matchesPose(target: PoseId, pose: HeadPose, baseline: HeadPose | null): boolean {
  if (target === "center") return Math.abs(pose.yaw) < STRAIGHT && Math.abs(pose.pitch) < STRAIGHT * 2 && Math.abs(pose.roll) < 15;
  const base = baseline ?? { yaw: 0, pitch: 0, roll: 0 };
  const yaw = pose.yaw - base.yaw;
  const pitch = pose.pitch - base.pitch;
  switch (target) {
    case "left":
      return yaw >= YAW_TURN && Math.abs(pitch) < PITCH_TILT * 1.5;
    case "right":
      return yaw <= -YAW_TURN && Math.abs(pitch) < PITCH_TILT * 1.5;
    case "up":
      return pitch >= PITCH_TILT && Math.abs(yaw) < YAW_TURN;
    case "down":
      return pitch <= -PITCH_TILT && Math.abs(yaw) < YAW_TURN;
  }
}

/** 0..1, how far along the person is towards the target. */
export function poseProgress(target: PoseId, pose: HeadPose, baseline: HeadPose | null): number {
  const base = baseline ?? { yaw: 0, pitch: 0, roll: 0 };
  const yaw = pose.yaw - base.yaw;
  const pitch = pose.pitch - base.pitch;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  switch (target) {
    case "center":
      return clamp(1 - Math.max(Math.abs(pose.yaw), Math.abs(pose.pitch) / 2) / (STRAIGHT * 3));
    case "left":
      return clamp(yaw / YAW_TURN);
    case "right":
      return clamp(-yaw / YAW_TURN);
    case "up":
      return clamp(pitch / PITCH_TILT);
    case "down":
      return clamp(-pitch / PITCH_TILT);
  }
}

/** Tracks one target: true once the pose has been held for `holdMs` without a break. */
export function createHoldTimer(holdMs = HOLD_MS) {
  let since: number | null = null;
  return {
    update(matching: boolean, now: number): boolean {
      if (!matching) {
        since = null;
        return false;
      }
      if (since === null) since = now;
      return now - since >= holdMs;
    },
    /** 0..1 of the hold so far. */
    progress(now: number): number {
      return since === null ? 0 : Math.min(1, (now - since) / holdMs);
    },
    reset() {
      since = null;
    },
  };
}
