import { useLayoutEffect, type RefObject } from "react";

/**
 * Grows a textarea with its content up to `maxPx`, then lets it scroll.
 * Height is the one layout property with no transform equivalent; it is set once per edit, not animated.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxPx = 220) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxPx);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
  }, [ref, value, maxPx]);
}
