import { createContext, useContext, useId, type ReactElement, type ReactNode } from "react";

// Logo proposals for Faceful. Every mark is one SVG on a 48 unit grid that paints with
// `currentColor`, so the same file works on paper, on ink and on art.
export type MarkProps = { size?: number; compact?: boolean };
export type MarkComponent = (props: MarkProps) => ReactElement;
export type Concept = {
  id: string;
  number: string;
  name: string;
  idea: string;
  rationale: string;
  keeps: string;
  Mark: MarkComponent;
};

/** Below this pixel size a mark switches to its simplified drawing, where it has one. */
export const COMPACT_BELOW = 22;

function Svg({ size = 48, children }: { size?: number; children: ReactNode }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width={size} height={size} fill="none" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

// Masks and clips need document-unique ids because each mark is drawn many times on the page.
function useSvgId(name: string) {
  return `lg-${name}-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** The mark in use today, redrawn from public/favicon.svg. */
export function CurrentMark({ size }: MarkProps) {
  return (
    <Svg size={size}>
      <g fill="currentColor" transform="rotate(-9 24 24)">
        <rect x="12" y="15" width="6" height="23" rx="3" />
        <rect x="22" y="8" width="6" height="31" rx="3" />
        <rect x="32" y="18" width="6" height="16" rx="3" />
      </g>
    </Svg>
  );
}

/** Hello's geometry, shared with the animated version in LogoFilm so the two cannot drift apart. */
export const HELLO = {
  lean: "rotate(-8 24 24)",
  stroke: 6.6,
  leftEye: { x: 13.4, y: 8, width: 6.6, height: 15.5, rx: 3.3 },
  rightEye: { x: 28, y: 12, width: 6.6, height: 11.5, rx: 3.3 },
  smile: "M10.6 30.2c3.2 5.2 7.8 7.8 13.4 7.8s10.2-2.6 13.4-7.8",
};

/** 01. Two of the bars become eyes, the third bends into a smile. */
export function HelloMark({ size }: MarkProps) {
  return (
    <Svg size={size}>
      <g transform={HELLO.lean}>
        <rect {...HELLO.leftEye} fill="currentColor" />
        <rect {...HELLO.rightEye} fill="currentColor" />
        <path d={HELLO.smile} stroke="currentColor" strokeWidth={HELLO.stroke} strokeLinecap="round" />
      </g>
    </Svg>
  );
}

/** 02. A lowercase f. Hook as brow, dot as eye, crossbar as mouth. */
export function ProfileMark({ size }: MarkProps) {
  return (
    <Svg size={size}>
      <path d="M21 41V18.5A9.5 9.5 0 0 1 30.5 9H34" stroke="currentColor" strokeWidth="6.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 29.8h19.5" stroke="currentColor" strokeWidth="6.6" strokeLinecap="round" />
      <circle cx="32.6" cy="19.7" r="3.5" fill="currentColor" />
    </Svg>
  );
}

/** 03. A 9:16 frame with a presenter and a caption bar. The caption drops out when compact. */
export function TakeMark({ size, compact }: MarkProps) {
  const mask = useSvgId("take");
  return (
    <Svg size={size}>
      <g transform="rotate(-8 24 24)">
        <mask id={mask} maskUnits="userSpaceOnUse" x="-8" y="-8" width="64" height="64">
          <rect x="-8" y="-8" width="64" height="64" fill="#fff" />
          {compact ? (
            <g>
              <circle cx="19" cy="19.5" r="3.1" fill="#000" />
              <circle cx="29" cy="19.5" r="3.1" fill="#000" />
              <path d="M17.6 27.4c1.6 2.9 3.7 4.2 6.4 4.2s4.8-1.3 6.4-4.2" stroke="#000" strokeWidth="3.6" strokeLinecap="round" />
            </g>
          ) : (
            <g>
              <circle cx="19.3" cy="16.6" r="2.5" fill="#000" />
              <circle cx="28.7" cy="16.6" r="2.5" fill="#000" />
              <path d="M18.4 22.8c1.4 2.4 3.2 3.5 5.6 3.5s4.2-1.1 5.6-3.5" stroke="#000" strokeWidth="2.9" strokeLinecap="round" />
              <rect x="17.2" y="33.6" width="13.6" height="3.8" rx="1.9" fill="#000" />
            </g>
          )}
        </mask>
        <rect x="12" y="4.5" width="24" height="39" rx="7.5" fill="currentColor" mask={`url(#${mask})`} />
      </g>
    </Svg>
  );
}

/** 04. One face, half solid and half outline, with a single smile through both. */
export function DuetMark({ size, compact }: MarkProps) {
  const left = useSvgId("duet-l");
  const right = useSvgId("duet-r");
  const mask = useSvgId("duet-m");
  const ring = compact ? 4.4 : 3.6;
  const face = (color: string) => (
    <g>
      <rect x="14.6" y="12.8" width="5.2" height="10" rx="2.6" fill={color} />
      <rect x="28.2" y="12.8" width="5.2" height="10" rx="2.6" fill={color} />
      <path d="M14.8 28c2.1 3.9 5.2 5.9 9.2 5.9s7.1-2 9.2-5.9" stroke={color} strokeWidth={compact ? 5.2 : 4.6} strokeLinecap="round" />
    </g>
  );
  return (
    <Svg size={size}>
      <g transform="rotate(-8 24 24)">
        <clipPath id={left}><rect x="-8" y="-8" width="32.1" height="64" /></clipPath>
        <clipPath id={right}><rect x="23.9" y="-8" width="32.1" height="64" /></clipPath>
        <mask id={mask} maskUnits="userSpaceOnUse" x="-8" y="-8" width="64" height="64">
          <rect x="-8" y="-8" width="64" height="64" fill="#fff" />
          {face("#000")}
        </mask>
        <g clipPath={`url(#${left})`}>
          <circle cx="24" cy="24" r="19.5" fill="currentColor" mask={`url(#${mask})`} />
        </g>
        <g clipPath={`url(#${right})`}>
          <circle cx="24" cy="24" r={19.5 - ring / 2} stroke="currentColor" strokeWidth={ring} />
          {face("currentColor")}
        </g>
      </g>
    </Svg>
  );
}

// The wordmark is drawn, not typed: one round stroke per letter on the same 48 unit height as the
// marks, with the same round ends. No font file is involved, so it looks the same on every device.
// Each alternative is the same seven letters built from a few measurements.
type WordSpec = {
  /** Stroke width. The face's is 6.6. */
  stroke: number;
  /** Top of the small letters. They sit on a baseline at 38, so this also sets how big the bowls are. */
  xTop: number;
  /** Top of the f and the l. */
  ascender: number;
  /** White space between two upright strokes. Round and open sides sit closer. */
  space: number;
  /** Degrees the bar of the e rises to the right. */
  eTilt?: number;
  /** The l ends in a small curl instead of a straight foot. */
  lCurl?: boolean;
};
type Side = "stem" | "round" | "open";
const BASELINE = 38;
/** Share of `space` each kind of letter side keeps clear. */
const SIDE_SPACE: Record<Side, number> = { stem: 0.55, round: 0.35, open: 0.05 };

function drawWord({ stroke, xTop, ascender, space, eTilt = 0, lCurl = false }: WordSpec) {
  const r = (BASELINE - xTop) / 2;
  const cy = BASELINE - r;
  const n = (value: number) => Math.round(value * 100) / 100;
  /** A point on the bowl whose left edge is at `x`, by clock angle: 0 is right, 90 is down. */
  const onBowl = (x: number, degrees: number) => {
    const angle = (degrees * Math.PI) / 180;
    return `${n(x + r + r * Math.cos(angle))} ${n(cy + r * Math.sin(angle))}`;
  };
  const longWayRound = `A${n(r)} ${n(r)} 0 1 0 `;
  const hook = r * 0.78;
  const curl = r * 0.55;
  /** How far round the e stops short of its bar, so a heavier stroke still leaves the same opening. */
  const eOpening = (2 * Math.asin((stroke + 2.6) / (2 * r)) * 180) / Math.PI;
  // Each letter is drawn from its left edge and reports its right edge and what its two sides are.
  const glyphs: Record<string, { sides: [Side, Side]; draw: (x: number) => [string, number] }> = {
    f: { sides: ["open", "open"], draw: (x) => {
      const stem = x + r * 0.6;
      return [`M${n(stem)} ${BASELINE}V${n(ascender + hook)}a${n(hook)} ${n(hook)} 0 0 1 ${n(hook)}-${n(hook)}h${n(r * 0.18)}M${n(x)} ${xTop}h${n(r * 1.3)}`, stem + hook + r * 0.18];
    } },
    a: { sides: ["round", "stem"], draw: (x) => [`M${onBowl(x, 0)}${longWayRound}${onBowl(x, 180)}${longWayRound}${onBowl(x, 0)}M${n(x + 2 * r)} ${xTop}V${BASELINE}`, x + 2 * r] },
    c: { sides: ["round", "open"], draw: (x) => [`M${onBowl(x, -44)}${longWayRound}${onBowl(x, 44)}`, x + r + r * Math.cos((44 * Math.PI) / 180)] },
    e: { sides: ["round", "round"], draw: (x) => [`M${onBowl(x, 180 - eTilt)}L${onBowl(x, -eTilt)}${longWayRound}${onBowl(x, eOpening - eTilt)}`, x + 2 * r] },
    u: { sides: ["stem", "stem"], draw: (x) => [`M${n(x)} ${xTop}V${n(cy)}a${n(r)} ${n(r)} 0 0 0 ${n(2 * r)} 0M${n(x + 2 * r)} ${xTop}V${BASELINE}`, x + 2 * r] },
    l: lCurl
      ? { sides: ["stem", "open"], draw: (x) => [`M${n(x)} ${ascender}V${n(BASELINE - curl)}a${n(curl)} ${n(curl)} 0 0 0 ${n(curl)} ${n(curl)}`, x + curl] }
      : { sides: ["stem", "stem"], draw: (x) => [`M${n(x)} ${ascender}V${BASELINE}`, x] },
  };
  let x = stroke / 2;
  let before: Side | undefined;
  const letters = [..."faceful"].map((letter) => {
    const { sides, draw } = glyphs[letter];
    if (before) x += stroke + space * (SIDE_SPACE[before] + SIDE_SPACE[sides[0]]);
    const [d, right] = draw(x);
    x = right;
    before = sides[1];
    return d;
  });
  return { stroke, letters, width: n(x + stroke / 2) };
}

export type Wordmark = ReturnType<typeof drawWord> & { id: string; name: string; idea: string };

export const wordmarks: Wordmark[] = [
  { id: "soft", name: "Soft", idea: "The calm one. Plain round letters with air between them and nothing that asks for attention.", ...drawWord({ stroke: 5.4, xTop: 22, ascender: 11, space: 3.4 }) },
  { id: "smile", name: "Smile", idea: "A little heavier, and two letters join in: the e tilts up like the smile and the l ends in a small curl.", ...drawWord({ stroke: 6, xTop: 21.2, ascender: 12, space: 3, eTilt: 16, lCurl: true }) },
  { id: "plump", name: "Plump", idea: "The cheerful one. Thick, close letters with big bowls, as heavy as the face next to them.", ...drawWord({ stroke: 7.4, xTop: 20, ascender: 12.5, space: 3 }) },
];
/** The wordmark this page argues for, and the one drawn when nothing else is chosen. */
export const WORD_PICK = "smile";
export const WordmarkContext = createContext<Wordmark>(wordmarks.find((word) => word.id === WORD_PICK) ?? wordmarks[0]);

/** Draws `word`, or the wordmark chosen on the page when none is given. */
export function RoundWordmark({ height = 48, word }: { height?: number; word?: Wordmark }) {
  const chosen = useContext(WordmarkContext);
  const { width, stroke, letters } = word ?? chosen;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} 48`} width={(height * width) / 48} height={height} fill="none" role="img" aria-label="faceful">
      <g stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        {letters.map((d, index) => <path key={index} d={d} />)}
      </g>
    </svg>
  );
}

export const concepts: Concept[] = [
  {
    id: "hello",
    number: "01",
    name: "Hello",
    idea: "The bars learn to smile.",
    rationale: "Two of today's bars become eyes and the third bends into a smile. The old sound meter turns into a face without changing its handwriting: same rounded ends, same lean, same weight.",
    keeps: "Keeps the most of what exists and stays the clearest of the four at 16 pixels.",
    Mark: HelloMark,
  },
  {
    id: "profile",
    number: "02",
    name: "Profile",
    idea: "A lowercase f that looks back at you.",
    rationale: "The first letter of the name with one extra dot. The hook becomes a brow, the dot an eye and the crossbar a mouth: a face in profile, looking toward the word that follows it.",
    keeps: "It still reads as a plain letter if nobody spots the face. Next to the wordmark the f appears twice, so it is strongest alone, as an icon.",
    Mark: ProfileMark,
  },
  {
    id: "take",
    number: "03",
    name: "Take",
    idea: "A presenter in a portrait frame, captions on.",
    rationale: "The most literal of the four. A 9:16 frame with a face in it and a caption bar underneath, which is exactly what the studio produces. It leans like a card being dealt.",
    keeps: "Below 22 pixels the caption bar drops out and the face grows to fill the frame.",
    Mark: TakeMark,
  },
  {
    id: "duet",
    number: "04",
    name: "Duet",
    idea: "Half person, half agent, one smile.",
    rationale: "A single face split along the lean. One half is solid, the other is outline, and the smile runs through both. It is the product promise in one shape: you and your agent working on the same thing.",
    keeps: "The richest story of the four, and the one that asks the most of small sizes.",
    Mark: DuetMark,
  },
];
