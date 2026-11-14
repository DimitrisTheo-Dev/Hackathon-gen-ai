import { useId, type ReactNode } from "react";

/**
 * Eleni: an original, featureless presenter drawn here in SVG — not a photograph, not a real person and
 * not anyone else's character. She refines the landing illustration's figure for full-screen use.
 *
 * She is drawn as three stacked layers (back hair, body, head) so each can move on its own composited
 * HTML layer: the body breathes, the head sways, and while she is speaking it adds a small nod.
 * The box is exactly 9:16, so percentage transform origins line up with the SVG coordinates.
 */
const VIEWBOX = "0 0 180 320";

export function Eleni({ speaking = false, className = "" }: { speaking?: boolean; className?: string }) {
  const id = useId().replace(/:/g, "");
  const skin = `url(#${id}-skin)`;
  const hair = `url(#${id}-hair)`;
  const jacket = `url(#${id}-jacket)`;
  const svg = (children: ReactNode, defs = false) => (
    <svg viewBox={VIEWBOX} preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      {defs && (
        <defs>
          <linearGradient id={`${id}-skin`} x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0" stopColor="#f2c9a6" />
            <stop offset="1" stopColor="#dfa680" />
          </linearGradient>
          <linearGradient id={`${id}-hair`} x1="0.1" y1="0" x2="0.7" y2="1">
            <stop offset="0" stopColor="#5e3a29" />
            <stop offset="0.55" stopColor="#43281d" />
            <stop offset="1" stopColor="#2f1c15" />
          </linearGradient>
          <linearGradient id={`${id}-jacket`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#617b8a" />
            <stop offset="1" stopColor="#3e5462" />
          </linearGradient>
        </defs>
      )}
      {children}
    </svg>
  );
  return (
    <span className={`pe ${speaking ? "is-speaking" : ""} ${className}`} aria-hidden="true">
      <span className="pe-breath">
        <span className="pe-layer pe-sway"><span className="pe-nod">{svg(
          <>
            {/* Long hair behind the shoulders. */}
            <path fill={hair} d="M47 152C41 106 63 87 90 87s49 19 43 64c0 36 11 62 7 92H40c-4-30 7-56 7-91Z" />
          </>,
          true,
        )}</span></span>
        <span className="pe-layer pe-body">{svg(
          <>
            {/* Cream top, a camel jacket open over it, the neck and a fine gold chain. */}
            <path fill="#f7f1e6" d="M-14 324C-12 262 20 226 56 216l16-5q18 15 36 0l16 5c36 10 68 46 70 108Z" />
            <path fill="#ece3d2" d="M72 211q18 15 36 0l3 1q-21 21-42 0Z" />
            <path fill={jacket} d="M-14 324C-12 262 20 226 56 216l11-3 16 57v54Z" />
            <path fill={jacket} d="M194 324C192 262 160 226 124 216l-11-3-16 57v54Z" />
            <path fill="#2c3e49" fillOpacity=".22" d="M67 213l16 57-10-4-12-46ZM113 213l-16 57 10-4 12-46Z" />
            <path fill="none" stroke="#2c3e49" strokeOpacity=".32" strokeWidth="1.1" strokeLinecap="round" d="M36 264c6 18 8 38 8 60M144 264c-6 18-8 38-8 60" />
            <path fill={skin} d="M75 164h30l1 42q-16 16-32 0Z" />
            <path fill="#c98d68" fillOpacity=".38" d="M75 170c8 13 22 13 30 0v15c-9 8-21 8-30 0Z" />
            <path fill="none" stroke="#e7b94a" strokeWidth="1.1" strokeLinecap="round" d="M76 212q14 13 28 0" />
            <circle cx="90" cy="219.4" r="2" fill="#f0c654" />
          </>,
        )}</span>
        <span className="pe-layer pe-sway"><span className="pe-nod">{svg(
          <>
            <path fill={skin} d="M61 135C61 112 74 103 90 103s29 9 29 32c0 27-13 46-29 46s-29-19-29-46Z" />
            {/* Light from the upper left: a soft shadow down the right of the face, a little warmth on the cheeks. */}
            <path fill="#b97c58" fillOpacity=".16" d="M104 110c9 6 15 15 15 26c0 20-8 35-19 43c7-13 10-27 9-41c-1-11-2-19-5-28Z" />
            <ellipse cx="74" cy="154" rx="6" ry="3.6" fill="#e7896f" fillOpacity=".12" />
            <ellipse cx="106" cy="154" rx="6" ry="3.6" fill="#e7896f" fillOpacity=".12" />
            {/* Side-swept fringe and two strands that fall in front of the shoulders. */}
            <path fill={hair} d="M122 149C126 115 110 95 90 95S53 116 58 153C61 132 74 117 98 112c14 2 21 16 24 37Z" />
            <path fill={hair} d="M59 138c-6 32-3 64-10 100l9 2c5-34 3-66 7-96Z" />
            <path fill={hair} d="M120 139c6 32 3 64 11 99l-9 3c-6-34-4-66-8-96Z" />
            <path fill="#f6d6b8" fillOpacity=".16" d="M64 132c3-17 15-27 31-29c-13 5-23 15-31 29Z" />
            <circle cx="61.5" cy="163" r="2.6" fill="#f0c654" />
            <circle cx="118.5" cy="163" r="2.6" fill="#f0c654" />
          </>,
        )}</span></span>
      </span>
    </span>
  );
}
