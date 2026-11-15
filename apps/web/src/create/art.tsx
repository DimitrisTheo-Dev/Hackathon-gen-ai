import type { ReactNode } from "react";

/**
 * Illustrations for the New project flow, in the sunlit art family (gold, amber, cream, sky). They label a choice
 * and never pretend to be a frame of the video. All are decorative: every card names its choice in text too.
 */

/** No face: a vertical frame of caption lines, one of them lit, as the captions-only video looks. */
export function NoFaceArt() {
  return (
    <svg className="np-art" viewBox="0 0 120 150" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="np-noface-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F6E7B0" />
          <stop offset="1" stopColor="#CFE0E6" />
        </linearGradient>
      </defs>
      <rect x="22" y="12" width="76" height="126" rx="12" fill="url(#np-noface-bg)" />
      <rect x="22" y="12" width="76" height="126" rx="12" fill="none" stroke="rgba(42,42,39,.12)" />
      <rect x="34" y="34" width="34" height="6" rx="3" fill="rgba(42,42,39,.35)" />
      <rect x="34" y="64" width="52" height="10" rx="5" fill="#2A2A27" />
      <rect x="34" y="80" width="40" height="10" rx="5" fill="#F6C404" />
      <rect x="34" y="96" width="46" height="10" rx="5" fill="#2A2A27" />
      <circle cx="84" cy="122" r="5" fill="rgba(42,42,39,.25)" />
      <circle cx="70" cy="122" r="5" fill="rgba(42,42,39,.15)" />
    </svg>
  );
}

/** A soft pattern of rings behind an AI presenter's photo. */
export function PatternFrame({ children }: { children: ReactNode }) {
  return (
    <span className="np-pattern">
      <svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <pattern id="np-dots" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.4" fill="rgba(42,42,39,.16)" />
          </pattern>
          <radialGradient id="np-glow" cx="50%" cy="45%" r="60%">
            <stop offset="0" stopColor="#F6C404" stopOpacity=".55" />
            <stop offset=".6" stopColor="#DDCB9F" stopOpacity=".35" />
            <stop offset="1" stopColor="#88B4C5" stopOpacity=".35" />
          </radialGradient>
        </defs>
        <rect width="200" height="200" fill="url(#np-glow)" />
        <rect width="200" height="200" fill="url(#np-dots)" />
        {[46, 70, 94].map((r) => (
          <circle key={r} cx="100" cy="92" r={r} fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="1.2" />
        ))}
      </svg>
      <span className="np-pattern-face">{children}</span>
    </span>
  );
}

/** Record myself: a camera frame around a person. */
export function CameraArt() {
  return (
    <svg className="np-art" viewBox="0 0 120 90" aria-hidden="true" focusable="false">
      <rect x="14" y="10" width="92" height="70" rx="14" fill="#F1F0EB" />
      <circle cx="60" cy="38" r="12" fill="#DDCB9F" />
      <path d="M36 74c3-14 13-21 24-21s21 7 24 21" fill="#EEA902" />
      {[
        "M22 26v-8h8",
        "M98 26v-8h-8",
        "M22 64v8h8",
        "M98 64v8h-8",
      ].map((d) => (
        <path key={d} d={d} fill="none" stroke="#2A2A27" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ))}
      <circle cx="60" cy="17" r="3.5" fill="#D23B32" />
    </svg>
  );
}

/** Record my voice only: a voice wave. */
export function VoiceArt() {
  const bars = [10, 18, 30, 22, 38, 26, 44, 30, 20, 34, 16, 24, 12];
  return (
    <svg className="np-art" viewBox="0 0 120 90" aria-hidden="true" focusable="false">
      <rect x="14" y="10" width="92" height="70" rx="14" fill="#F1F0EB" />
      {bars.map((height, index) => (
        <rect key={index} x={23 + index * 6} y={45 - height / 2} width="3.4" height={height} rx="1.7" fill={index === 6 ? "#EEA902" : "#2A2A27"} opacity={index === 6 ? 1 : 0.75} />
      ))}
    </svg>
  );
}
