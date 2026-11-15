import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { stepSpring, shouldDismiss } from "../lib/sheet-motion";

export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const changed = () => setMatches(media.matches);
    changed(); media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, [query]);
  return matches;
}

let locks = 0;
let previousOverflow = "";
function lockPage() {
  if (locks++ === 0) {
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
  }
  return () => { if (--locks === 0) document.documentElement.style.overflow = previousOverflow; };
}

/**
 * Safari moves focus to the page as soon as a focused button becomes disabled, which is what a trigger does while
 * its action runs (Review schedule, for one). The place to return focus to is therefore the last element that held
 * it, not whatever holds focus at the moment a surface opens.
 */
let lastFocused: HTMLElement | null = null;
if (typeof document !== "undefined")
  document.addEventListener("focusin", (event) => { if (event.target instanceof HTMLElement && event.target !== document.body) lastFocused = event.target; }, true);
function returnTarget() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  return lastFocused?.isConnected ? lastFocused : null;
}

type Controls = { close: () => void; grip: ReactNode; mobile: boolean };
/** Native dialog provides focus containment, inert background and focus restoration.
 * Only the explicit handle owns dragging; content keeps native scrolling/selection/zoom.
 * Editor is a non-modal panel on desktop, the same DOM on mobile.
 * No role override: a <dialog> may only carry its own role (or alertdialog), so the docked editor is exposed as a
 * labelled non-modal dialog. Relabelling it "complementary" was invalid ARIA (Lighthouse, axe aria-allowed-role).
 */
export function SurfaceDialog({ title, className, editor = false, inline = false, open = true, animateEntry = true, onClose, children }: {
  title: string; className: string; editor?: boolean; onClose: () => void;
  animateEntry?: boolean; inline?: boolean; open?: boolean;
  children: (controls: Controls) => ReactNode;
}) {
  const mobile = useMedia(editor ? "(max-width: 1000px)" : "(max-width: 760px)");
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const ref = useRef<HTMLDialogElement>(null);
  const dismiss = useRef(onClose); dismiss.current = onClose;
  const id = useId();
  const motion = useRef({ position: 0, velocity: 0, target: 0, frame: 0, last: 0, closing: false });
  const pointer = useRef<{ id: number; startY: number; origin: number; points: { y: number; at: number }[]; moved: boolean } | null>(null);
  const ignoreClick = useRef(false);
  const historyEntry = useRef(false);
  const finished = useRef(false);
  const priorFocus = useRef<HTMLElement | null>(null);
  const insideFocus = useRef<HTMLElement | null>(null);

  function finish() {
    if (finished.current) return;
    finished.current = true;
    if (historyEntry.current && history.state?.castroomSheet === id) history.back();
    else dismiss.current();
  }
  function paint() {
    if (ref.current) ref.current.style.transform = `translate3d(0, ${motion.current.position}px, 0)`;
  }
  function settle(target: number, closing: boolean) {
    const state = motion.current;
    cancelAnimationFrame(state.frame);
    state.target = target; state.closing = closing; state.last = performance.now();
    if (reduced || !mobile) {
      state.position = 0; state.velocity = 0; paint();
      if (closing) finish();
      return;
    }
    const tick = (now: number) => {
      const next = stepSpring(state.position, state.velocity, state.target, Math.min((now - state.last) / 1000, .04));
      Object.assign(state, next); state.last = now; paint();
      if (Math.abs(state.position - state.target) < .5 && Math.abs(state.velocity) < 5) {
        state.position = state.target; state.velocity = 0; paint();
        if (state.closing) finish();
      } else state.frame = requestAnimationFrame(tick);
    };
    state.frame = requestAnimationFrame(tick);
  }
  function close() { settle((ref.current?.getBoundingClientRect().height ?? innerHeight) + 32, true); }

  // A layout effect: the surface is open in the same frame it mounts, so a panel never pops in one frame late.
  useLayoutEffect(() => {
    const dialog = ref.current!;
    finished.current = false;
    priorFocus.current = returnTarget();
    if (!open) { if(dialog.open)dialog.close(); return; }
    const modal = !inline && (!editor || mobile);
    if (dialog.open) dialog.close();
    if (modal) dialog.showModal(); else dialog.show();
    const unlock = modal ? lockPage() : () => {};
    if(insideFocus.current?.isConnected&&dialog.contains(insideFocus.current))insideFocus.current.focus({preventScroll:true});
    else if(inline){dialog.tabIndex=-1;dialog.focus({preventScroll:true});}
    insideFocus.current=null;
    if (modal && !dialog.contains(priorFocus.current)) dialog.querySelector<HTMLElement>("[data-surface-focus]")?.focus({ preventScroll: true });
    if (mobile && !editor && !inline) {
      history.pushState({ ...history.state, castroomSheet: id }, "", location.href);
      historyEntry.current = true;
    }
    const back = () => {
      if (historyEntry.current && history.state?.castroomSheet !== id) dismiss.current();
    };
    window.addEventListener("popstate", back);
    if (mobile && !inline && !reduced && animateEntry) {
      motion.current.position = Math.min(80, dialog.getBoundingClientRect().height * .12);
      paint(); settle(0, false);
    }
    return () => {
      cancelAnimationFrame(motion.current.frame);
      window.removeEventListener("popstate", back);
      if (historyEntry.current && history.state?.castroomSheet === id) {
        const next = { ...history.state }; delete next.castroomSheet;
        history.replaceState(next, "", location.href);
      }
      historyEntry.current = false;
      insideFocus.current=dialog.contains(document.activeElement)&&document.activeElement instanceof HTMLElement?document.activeElement:null;
      dialog.close(); unlock();
      if (modal && priorFocus.current?.isConnected) priorFocus.current.focus({ preventScroll: true });
      dialog.style.transform = "";
      motion.current.position = 0; motion.current.velocity = 0;
    };
  }, [mobile, editor, inline && mobile, open]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      // Pinch zoom must stay free: don't resize the layout to a magnified visual viewport.
      if (!ref.current || !viewport || viewport.scale !== 1) return;
      ref.current.style.setProperty("--surface-height", `${viewport.height}px`);
      ref.current.style.setProperty("--surface-top", `${viewport.offsetTop}px`);
    };
    update(); viewport?.addEventListener("resize", update); viewport?.addEventListener("scroll", update);
    return () => { viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update); };
  }, []);

  useEffect(() => {
    if (!reduced) return;
    const state = motion.current;
    cancelAnimationFrame(state.frame);
    state.position = 0; state.velocity = 0; paint();
    if (state.closing) finish();
  }, [reduced]);

  function down(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!mobile || !event.isPrimary || event.button !== 0 || pointer.current) return;
    cancelAnimationFrame(motion.current.frame);
    motion.current.closing = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { id: event.pointerId, startY: event.clientY, origin: motion.current.position, points: [{ y: event.clientY, at: event.timeStamp }], moved: false };
    ignoreClick.current = false;
  }
  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = pointer.current;
    if (!drag || drag.id !== event.pointerId) return;
    const delta = event.clientY - drag.startY;
    if (Math.abs(delta) > 6) drag.moved = true;
    const position = drag.origin + delta;
    motion.current.position = position < 0 ? position / (1 + Math.abs(position) / 24) : position;
    drag.points = [...drag.points.filter(p => event.timeStamp - p.at < 100), { y: event.clientY, at: event.timeStamp }];
    paint();
  }
  function up(event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = pointer.current;
    if (!drag || drag.id !== event.pointerId) return;
    pointer.current = null;
    ignoreClick.current = drag.moved || cancelled;
    const first = drag.points[0];
    motion.current.velocity = cancelled ? 0 : Math.max(-2500, Math.min(2500, (event.clientY - first.y) / Math.max(1, event.timeStamp - first.at) * 1000));
    const height = ref.current?.getBoundingClientRect().height ?? innerHeight;
    const closing = !cancelled && drag.moved && shouldDismiss(motion.current.position, motion.current.velocity, height);
    settle(closing ? height + 32 : 0, closing);
  }
  const grip = <button type="button" className="sheet-grip" aria-label={`Dismiss ${title}`} onPointerDown={down} onPointerMove={move} onPointerUp={e => up(e)} onPointerCancel={e => up(e, true)} onClick={() => { if (!ignoreClick.current) close(); ignoreClick.current = false; }}><span /></button>;

  return <dialog ref={ref} className={`surface-dialog ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); finish(); }} onClick={event => {
    if (event.target !== ref.current || editor) return;
    const rect = ref.current.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }}>{children({ close, grip, mobile })}</dialog>;
}
