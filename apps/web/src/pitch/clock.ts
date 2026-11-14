import { createContext, useContext, useSyncExternalStore } from "react";
import { TOTAL } from "./timeline";

/**
 * The playhead. One requestAnimationFrame loop advances it while playing; components subscribe with a
 * selector and re-render only when their selected value changes (a cue, a typed character, a caption chunk).
 */
export type Clock = ReturnType<typeof createClock>;

export function createClock(speed = 1) {
  let t = 0;
  let playing = false;
  let origin = 0;
  let frame = 0;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const tick = (now: number) => {
    t = Math.min(TOTAL, ((now - origin) / 1000) * speed);
    if (t >= TOTAL) {
      playing = false;
      frame = 0;
    } else frame = requestAnimationFrame(tick);
    notify();
  };

  return {
    get t() { return t; },
    get playing() { return playing; },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    play() {
      if (playing) return;
      if (t >= TOTAL) t = 0;
      playing = true;
      origin = performance.now() - (t * 1000) / speed;
      frame = requestAnimationFrame(tick);
      notify();
    },
    pause() {
      if (!playing) return;
      playing = false;
      cancelAnimationFrame(frame);
      frame = 0;
      notify();
    },
    seek(to: number) {
      t = Math.max(0, Math.min(TOTAL, to));
      origin = performance.now() - (t * 1000) / speed;
      notify();
    },
    dispose() {
      cancelAnimationFrame(frame);
      listeners.clear();
    },
  };
}

export const ClockContext = createContext<Clock | null>(null);

/** Subscribe to the playhead through a selector; return a primitive so unchanged frames do not re-render. */
export function useClock<T>(select: (t: number, playing: boolean) => T): T {
  const clock = useContext(ClockContext);
  if (!clock) throw new Error("useClock outside the pitch clock");
  return useSyncExternalStore(clock.subscribe, () => select(clock.t, clock.playing), () => select(0, false));
}
