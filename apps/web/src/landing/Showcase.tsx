import { useEffect, useRef, useState, type RefObject } from "react";
import { Volume2, VolumeX } from "lucide-react";

/** `phase` is where in its 20 s loop each reel starts, so no two play in step. */
type Clip = { id: string; title: string; note: string; phase: number };

/** Dr Tanimanidis's reels, made in Faceful with his cloned face and voice. */
const doctorReels: readonly Clip[] = [
  { id: "tanimanidis-embryo", title: "From one cell to a baby", note: "Pregnancy, week by week", phase: 0 },
  { id: "tanimanidis-hpv-breast", title: "Five self-checks", note: "HPV and breast health", phase: 7 },
  { id: "tanimanidis-period-kids", title: "The period, for kids", note: "Explained to a 10-year-old", phase: 14 },
];

const faceTemplates: readonly Clip[] = [
  { id: "talking-tip", title: "Talking tip", note: "A quick practical tip", phase: 3 },
  { id: "window-explainer", title: "Window explainer", note: "A process, step by step", phase: 10 },
  { id: "myth-react", title: "Myth react", note: "One belief, taken apart", phase: 17 },
  { id: "hosted-list", title: "Hosted list", note: "3 signs that…", phase: 5 },
  { id: "faq-cards", title: "FAQ cards", note: "Questions before a visit", phase: 12 },
  { id: "patient-dialogue", title: "Patient dialogue", note: "A patient asks, you answer", phase: 1 },
];

const noFaceTemplates: readonly Clip[] = [
  { id: "kinetic-type", title: "Kinetic type", note: "One strong statement", phase: 8 },
  { id: "myth-fact", title: "Myth and fact", note: "Myths struck through", phase: 15 },
  { id: "explainer", title: "Explainer", note: "A moving diagram", phase: 2 },
  { id: "stat-story", title: "Stat story", note: "One number per beat", phase: 11 },
  { id: "chat-qa", title: "Chat Q&A", note: "A patient texts, you reply", phase: 6 },
];

/** Shared so only one reel plays with sound at a time. */
let unmuted: HTMLVideoElement | null = null;

/** Plays a muted looping video while it is on screen, from `phase` seconds in; pauses it off screen. */
export function useLoopInView(video: RefObject<HTMLVideoElement | null>, phase: number, onVolume?: (muted: boolean) => void) {
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sync = () => onVolume?.(element.muted);
    const seek = () => { if (element.duration > phase) element.currentTime = phase; };
    element.addEventListener("volumechange", sync);
    element.addEventListener("loadedmetadata", seek, { once: true });
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !still) void element.play().catch(() => undefined);
      else if (!entry.isIntersecting) element.pause();
    }, { threshold: 0.5 });
    observer.observe(element);
    return () => { observer.disconnect(); element.removeEventListener("volumechange", sync); element.removeEventListener("loadedmetadata", seek); };
  }, [video, phase, onVolume]);
}

/** A 9:16 reel that plays muted while on screen; tapping it turns its sound on. */
function Reel({ src, title, note, phase }: { src: string; title: string; note: string; phase: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  useLoopInView(video, phase, setMuted);
  function toggleSound() {
    const element = video.current;
    if (!element) return;
    if (element.muted) {
      if (unmuted && unmuted !== element) unmuted.muted = true;
      unmuted = element;
      element.muted = false;
      void element.play().catch(() => undefined);
    } else {
      element.muted = true;
    }
  }
  return <figure className="sc-reel">
    <button className="sc-frame" onClick={toggleSound} aria-label={`${muted ? "Play with sound" : "Mute"}: ${title}`}>
      <video ref={video} src={`/showcase/${src}.mp4`} poster={`/showcase/${src}.webp`} muted loop playsInline preload="none" aria-hidden="true" />
      <span className="sc-sound" aria-hidden="true">{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</span>
    </button>
    <figcaption><strong>{title}</strong><small>{note}</small></figcaption>
  </figure>;
}

export function Showcase() {
  return <section id="made" className="landing-section sc" aria-labelledby="made-heading">
    <div className="landing-section-heading">
      <h2 id="made-heading">Made with Faceful.</h2>
      <p>Real reels from a real doctor, and the templates every new video starts from.</p>
    </div>

    <div className="sc-doctor">
      <div className="sc-doctor-copy">
        <h3>Dr Panagiotis Tanimanidis</h3>
        <p>Obstetrician-gynecologist, Thessaloniki. His face and his voice, on the topics his patients ask about, in Greek.</p>
      </div>
      <div className="sc-row">{doctorReels.map((reel) => <Reel key={reel.id} src={reel.id} title={reel.title} note={reel.note} phase={reel.phase} />)}</div>
    </div>

    <div className="sc-templates">
      <h3>With your face</h3>
      <div className="sc-rail" tabIndex={0} aria-label="Templates with a presenter">{faceTemplates.map((t) => <Reel key={t.id} src={`template-${t.id}`} title={t.title} note={t.note} phase={t.phase} />)}</div>
      <h3>Without a face</h3>
      <div className="sc-rail" tabIndex={0} aria-label="Templates without a presenter">{noFaceTemplates.map((t) => <Reel key={t.id} src={`template-${t.id}`} title={t.title} note={t.note} phase={t.phase} />)}</div>
    </div>
  </section>;
}
