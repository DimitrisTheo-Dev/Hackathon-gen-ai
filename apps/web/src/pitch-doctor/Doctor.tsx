import { useId, type ReactNode } from "react";

/**
 * The doctor: an original, featureless figure drawn here in SVG. Not a photograph and not a likeness of any
 * real person: a white coat, scrubs, a stethoscope and no face. He follows Eleni's construction exactly
 * (same 9:16 box, same three composited layers, same class names), so the breathing, the sway and the nod
 * come from the shared stylesheet unchanged.
 */
const VIEWBOX = "0 0 180 320";

type Scrub = "teal" | "blue" | "sage";
const SCRUBS: Record<Scrub, [string, string]> = {
  teal: ["#4a9a96", "#2f7274"],
  blue: ["#5b86b8", "#3b6190"],
  sage: ["#7fa08a", "#56775f"],
};

function usePaint(scrub: Scrub) {
  const id = useId().replace(/:/g, "");
  const [from, to] = SCRUBS[scrub];
  return {
    skin: `url(#${id}-skin)`,
    hair: `url(#${id}-hair)`,
    coat: `url(#${id}-coat)`,
    scrub: `url(#${id}-scrub)`,
    defs: (
      <defs>
        <linearGradient id={`${id}-skin`} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#efc7a4" />
          <stop offset="1" stopColor="#d9a17c" />
        </linearGradient>
        <linearGradient id={`${id}-hair`} x1="0.1" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#57524d" />
          <stop offset="1" stopColor="#2c2a28" />
        </linearGradient>
        <linearGradient id={`${id}-coat`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e4ebee" />
        </linearGradient>
        <linearGradient id={`${id}-scrub`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
    ),
  };
}
type Paint = ReturnType<typeof usePaint>;

/** Behind the body: the ears, which move with the head. */
const back = ({ skin }: Paint) => (
  <>
    <ellipse cx="59.5" cy="147" rx="5" ry="8" fill={skin} />
    <ellipse cx="120.5" cy="147" rx="5" ry="8" fill={skin} />
    <ellipse cx="60" cy="147" rx="2.1" ry="4.6" fill="#b97c58" fillOpacity=".28" />
    <ellipse cx="120" cy="147" rx="2.1" ry="4.6" fill="#b97c58" fillOpacity=".28" />
  </>
);

/** Scrubs with a V neck, the neck, a white coat open over them, a stethoscope around the neck. */
const body = ({ skin, coat, scrub }: Paint) => (
  <>
    <path fill={scrub} d="M-22 324C-20 258 16 224 54 214l18-6 18 24 18-24 18 6c38 10 74 44 76 110Z" />
    <path fill={skin} d="M73 166h34l1 42-18 24-18-24Z" />
    <path fill="#b07a57" fillOpacity=".34" d="M73 174c9 13 25 13 34 0v14c-10 9-24 9-34 0Z" />
    <path fill="none" stroke="#16323a" strokeOpacity=".34" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M72 208l18 24 18-24" />
    <path fill={coat} d="M-22 324C-20 258 16 224 54 214l12-4 17 61v53Z" />
    <path fill={coat} d="M202 324C200 258 164 224 126 214l-12-4-17 61v53Z" />
    <path fill="#cdd7dc" fillOpacity=".9" d="M66 210l17 61-13-11-11-33-3-14ZM114 210l-17 61 13-11 11-33 3-14Z" />
    <path fill="none" stroke="#8fa0a8" strokeOpacity=".45" strokeWidth="1.2" strokeLinecap="round" d="M30 268c7 17 9 36 9 56M150 268c-7 17-9 36-9 56" />
    <path fill="none" stroke="#9fb0b8" strokeOpacity=".7" strokeWidth="1.3" strokeLinecap="round" d="M119 282h25" />
    <path fill="none" stroke="#2f6f8f" strokeWidth="2.2" strokeLinecap="round" d="M127 282v-9" />
    <path fill="none" stroke="#2c3a43" strokeWidth="3.4" strokeLinecap="round" d="M71 199C62 216 61 242 68 258M109 199C118 216 119 234 113 247" />
    <path fill="none" stroke="#a9b4b9" strokeWidth="2.2" strokeLinecap="round" d="M113 247c-6 7-9 13-9 20M113 247c6 7 9 13 9 20" />
    <circle cx="104" cy="268.5" r="2.6" fill="#2c3a43" />
    <circle cx="122" cy="268.5" r="2.6" fill="#2c3a43" />
    <circle cx="69.5" cy="264.5" r="7" fill="#d4dbde" stroke="#8a969c" strokeWidth="1.2" />
    <circle cx="69.5" cy="264.5" r="3.4" fill="#f4f6f7" />
  </>
);

/** The head: no features, light from the upper left, short hair with a side parting. */
const head = ({ skin, hair }: Paint) => (
  <>
    <path fill={skin} d="M60 136C60 113 73 103 90 103s30 10 30 33v9c0 24-12 39-30 39s-30-15-30-39Z" />
    <path fill="#a8704d" fillOpacity=".16" d="M106 110c9 6 14 15 14 26v9c0 20-7 33-18 39c7-12 10-26 9-40c-1-12-2-24-5-34Z" />
    <path fill={hair} d="M57 142C53 110 68 92 91 92s39 18 32 49l-4-1c0-11-3-20-9-26c-13 5-29 5-41 0c-5 6-7 15-7 27Z" />
    <path fill="#ffffff" fillOpacity=".1" d="M66 111c5-9 14-14 27-15c-10 4-19 8-27 15Z" />
  </>
);

/** The presenter in his frame: three layers, so the body breathes, the head sways and nods while he speaks. */
export function Doctor({ speaking = false, className = "", scrub = "teal" }: { speaking?: boolean; className?: string; scrub?: Scrub }) {
  const paint = usePaint(scrub);
  const svg = (children: ReactNode, defs = false) => (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      {defs && paint.defs}
      {children}
    </svg>
  );
  return (
    <span className={`pe ${speaking ? "is-speaking" : ""} ${className}`} aria-hidden="true">
      <span className="pe-breath">
        <span className="pe-layer pe-sway"><span className="pe-nod">{svg(back(paint), true)}</span></span>
        <span className="pe-layer pe-body">{svg(body(paint))}</span>
        <span className="pe-layer pe-sway"><span className="pe-nod">{svg(head(paint))}</span></span>
      </span>
    </span>
  );
}

/** One flat drawing for the other draft cards, where the card's own sway moves the whole figure. */
export function DoctorStill({ scrub = "teal" }: { scrub?: Scrub }) {
  const paint = usePaint(scrub);
  return (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      {paint.defs}
      {back(paint)}
      {body(paint)}
      {head(paint)}
    </svg>
  );
}
