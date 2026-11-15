import { useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { HELLO, WordmarkContext } from "./marks";

// The logo sting. Each step adds one `at-<step>` class to the stage and CSS does the moving,
// so a step's look is whatever its class and all earlier ones say.
const STEPS = ["sky", "art", "logo", "speak", "exit", "url", "wink", "end"] as const;
type Step = (typeof STEPS)[number];
/** How long each step holds before the next one, in milliseconds. `speak` is the hold when the voice is off. */
const HOLD: Record<Step, number> = { sky: 900, art: 1900, logo: 1500, speak: 2600, exit: 1200, url: 650, wink: 950, end: 0 };
/** With the voice on, the line stays up at least this long and the next step waits for the voice to finish. */
const SPEAK_MIN = 1800;
const SPEAK_MAX = 7000;
const PAUSE_AFTER_VOICE = 350;

const SPOKEN_LINE = "Faceful. Made in an afternoon.";
const TAGLINE = "Made in an afternoon.";
/** Placeholder until the real address is decided. */
export const PLACEHOLDER_URL = "faceful.vercel.gr";

const PREFERRED_VOICES = ["Samantha", "Ava", "Allison", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Karen", "Daniel"];

/** Recorded takes of the line with Cartesia Sonic 3.6, in public/audio/logo-voice, from the highest voice to the lowest. */
const VOICES = [
  { id: "ca-kelsey", name: "Kelsey", note: "ball of energy" },
  { id: "ca-holly", name: "Holly", note: "joyful" },
  { id: "ca-madison", name: "Madison", note: "happy best friend" },
  { id: "ca-jillian", name: "Jillian", note: "happy spirit" },
  { id: "ca-melina", name: "Melina", note: "bright spirit" },
  { id: "ca-lori", name: "Lori", note: "cheerleader" },
  { id: "ca-pippa", name: "Pippa", note: "bright assistant" },
  { id: "ca-connie", name: "Connie", note: "cheery, candid" },
  { id: "browser", name: "Browser", note: "your device's own voice" },
] as const;
type VoiceId = (typeof VOICES)[number]["id"];
function recording(id: VoiceId) {
  return id === "browser" ? null : `/audio/logo-voice/${id}.mp3`;
}

/** Synthesised beds in public/audio/logo-music. Each is two files: `-a` starts with the film and `-b` with the
 * erase, so the music lands on the picture whatever the length of the voice. */
const MUSIC = [
  { id: "glow", name: "Glow", note: "warm pad that opens up" },
  { id: "kalimba", name: "Kalimba", note: "soft plucks, one per letter" },
  { id: "haze", name: "Haze", note: "lo-fi electric piano" },
  { id: "rise", name: "Rise", note: "air, voices and a chime" },
  { id: "none", name: "No music", note: "" },
] as const;
type MusicId = (typeof MUSIC)[number]["id"];

/** Browsers only let a page start sound inside a click. Starting a sound silently there keeps it allowed for later. */
function prime(audio: HTMLAudioElement) {
  audio.muted = true;
  audio.play().then(() => audio.pause(), () => {}).finally(() => { audio.muted = false; });
}

function browserUtterance() {
  const utterance = new SpeechSynthesisUtterance(SPOKEN_LINE);
  utterance.lang = "en-US";
  utterance.rate = 0.96;
  const chosen = pickVoice();
  if (chosen) utterance.voice = chosen;
  return utterance;
}

function canSpeak() {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}
function pickVoice() {
  const english = speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith("en"));
  for (const name of PREFERRED_VOICES) {
    const match = english.find((voice) => voice.name.includes(name));
    if (match) return match;
  }
  return english[0];
}

function FilmFace() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
      <g transform={HELLO.lean}>
        <rect className="lg-eye" {...HELLO.leftEye} fill="currentColor" />
        <rect className="lg-eye lg-eye-wink" {...HELLO.rightEye} fill="currentColor" />
        <path className="lg-smile" d={HELLO.smile} pathLength={1} stroke="currentColor" strokeWidth={HELLO.stroke} strokeLinecap="round" />
      </g>
    </svg>
  );
}

function FilmWord() {
  const { width, stroke, letters } = useContext(WordmarkContext);
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} 48`} fill="none" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        {letters.map((d, index) => <path key={index} className="lg-letter" style={{ "--i": index } as CSSProperties} d={d} />)}
      </g>
    </svg>
  );
}

export function LogoFilm() {
  // `step` is null before the first play: the stage then shows a still of the full logo.
  const [{ run, step }, setState] = useState<{ run: number; step: number | null }>({ run: 0, step: null });
  const [voice, setVoice] = useState(true);
  const [voiceId, setVoiceId] = useState<VoiceId>(VOICES[0].id);
  const [musicId, setMusicId] = useState<MusicId>(MUSIC[0].id);
  // The step effect reads these at the moment the line is due, so changing them never restarts a run.
  const voiceOn = useRef(voice);
  voiceOn.current = voice;
  const chosenVoice = useRef(voiceId);
  chosenVoice.current = voiceId;
  // One player for the film and one for previews, so a preview never steals the film's end-of-line event.
  const filmPlayer = useRef<HTMLAudioElement | null>(null);
  const previewPlayer = useRef<HTMLAudioElement | null>(null);
  const musicPlayers = useRef<HTMLAudioElement[]>([]);
  const word = useContext(WordmarkContext);
  const speechAvailable = canSpeak();
  const chosen = VOICES.find((item) => item.id === voiceId) ?? VOICES[0];

  function quietVoice() {
    filmPlayer.current?.pause();
    previewPlayer.current?.pause();
    if (canSpeak()) speechSynthesis.cancel();
  }
  function silence() {
    quietVoice();
    for (const audio of musicPlayers.current) audio.pause();
  }
  /** The two halves of a bed, loaded into their players. */
  function loadMusic(id: Exclude<MusicId, "none">) {
    return (["a", "b"] as const).map((part, index) => {
      const audio = (musicPlayers.current[index] ??= new Audio());
      const src = `/audio/logo-music/${id}-${part}.mp3`;
      if (!audio.src.endsWith(src)) audio.src = src;
      return audio;
    });
  }

  // Voices load late in some browsers; asking once up front makes them ready by the time we speak.
  useEffect(() => {
    if (canSpeak()) speechSynthesis.getVoices();
    return silence;
  }, []);
  useEffect(() => {
    if (!voice) quietVoice();
  }, [voice]);
  // Fetch the chosen music ahead of the click, so it starts together with the picture.
  useEffect(() => {
    if (musicId !== "none") loadMusic(musicId);
  }, [musicId]);
  // The second half of the music starts with the erase.
  useEffect(() => {
    const second = musicPlayers.current[1];
    if (step === null || STEPS[step] !== "exit" || musicId === "none" || !second) return;
    second.currentTime = 0;
    second.play().catch(() => {});
  }, [run, step]);

  useEffect(() => {
    if (step === null) return;
    const name = STEPS[step];
    if (name === "end") return;
    let finished = false;
    let timer = 0;
    const next = () => {
      if (finished) return;
      finished = true;
      setState((current) => (current.run === run && current.step === step ? { run, step: step + 1 } : current));
    };
    const src = recording(chosenVoice.current);
    if (name !== "speak" || !voiceOn.current || (!src && !canSpeak())) {
      timer = window.setTimeout(next, HOLD[name]);
      return () => { finished = true; clearTimeout(timer); };
    }
    const started = performance.now();
    const afterVoice = () => {
      if (finished) return;
      clearTimeout(timer);
      timer = window.setTimeout(next, Math.max(PAUSE_AFTER_VOICE, SPEAK_MIN - (performance.now() - started)));
    };
    timer = window.setTimeout(next, SPEAK_MAX);
    if (src) {
      const audio = (filmPlayer.current ??= new Audio());
      // A pause means a voice was picked mid-line and cut this one off, so the film moves on too.
      audio.onended = audio.onerror = audio.onpause = afterVoice;
      audio.muted = false;
      if (!audio.src.endsWith(src)) audio.src = src;
      audio.currentTime = 0;
      audio.play().catch(afterVoice);
      return () => {
        finished = true;
        clearTimeout(timer);
        audio.onended = audio.onerror = audio.onpause = null;
        audio.pause();
      };
    }
    const utterance = browserUtterance();
    utterance.onend = afterVoice;
    utterance.onerror = afterVoice;
    speechSynthesis.speak(utterance);
    return () => {
      finished = true;
      clearTimeout(timer);
      utterance.onend = null;
      utterance.onerror = null;
      speechSynthesis.cancel();
    };
  }, [run, step]);

  function play(music: MusicId = musicId) {
    silence();
    // The line and the second half of the music are due seconds after this click, so both are primed here.
    const src = recording(voiceId);
    if (voice && src) {
      const audio = (filmPlayer.current ??= new Audio());
      audio.src = src;
      prime(audio);
    } else if (voice && canSpeak()) {
      const unlock = new SpeechSynthesisUtterance(" ");
      unlock.volume = 0;
      speechSynthesis.speak(unlock);
    }
    if (music !== "none") {
      const [first, second] = loadMusic(music);
      first.currentTime = 0;
      first.play().catch(() => {});
      prime(second);
    }
    setState((current) => ({ run: current.run + 1, step: 0 }));
  }

  /** Music only makes sense against the picture, so picking one plays the film with it. */
  function chooseMusic(id: MusicId) {
    setMusicId(id);
    play(id);
  }

  /** Picking a voice turns the voice on and plays the line once, so takes can be compared without running the film. */
  function choose(id: VoiceId) {
    setVoiceId(id);
    setVoice(true);
    quietVoice();
    const src = recording(id);
    if (src) {
      const audio = (previewPlayer.current ??= new Audio());
      audio.src = src;
      audio.play().catch(() => {});
    } else if (canSpeak()) {
      speechSynthesis.speak(browserUtterance());
    }
  }

  const reached: readonly Step[] = step === null ? ["art", "logo", "speak"] : STEPS.slice(0, step + 1);
  const idle = step === null;
  const done = step !== null && STEPS[step] === "end";

  return (
    <div className="lg-film-block">
      {/* Remounting per run starts every play from a clean blue frame instead of rewinding the last one. */}
      <div key={run} className={`lg-film ${reached.map((name) => `at-${name}`).join(" ")}`} style={{ "--word-ratio": word.width / 48 } as CSSProperties} role="img" aria-label={`Faceful logo animation. Warm art drifts in like fog, the logo appears and a voice says ${SPOKEN_LINE} Then the face moves to the middle, erasing the word as it goes, and winks, and ${PLACEHOLDER_URL} appears at the bottom.`}>
        <div className="lg-film-sky" />
        <div className="lg-film-art" />
        <div className="lg-film-center">
          <div className="lg-film-lockup">
            <span className="lg-film-face"><FilmFace /></span>
            <span className="lg-film-clip"><span className="lg-film-word"><FilmWord /></span></span>
          </div>
        </div>
        <p className="lg-film-caption lg-film-line">{TAGLINE}</p>
        <p className="lg-film-caption lg-film-url">{PLACEHOLDER_URL}</p>
      </div>
      <div className="lg-film-controls">
        <button type="button" className="lg-button is-primary" onClick={() => play()}>
          {idle ? <Play size={16} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
          {idle ? "Play" : done ? "Replay" : "Restart"}
        </button>
        <button type="button" className="lg-button" aria-pressed={voice} onClick={() => setVoice((value) => !value)}>
          {voice ? <Volume2 size={16} aria-hidden="true" /> : <VolumeX size={16} aria-hidden="true" />}
          {voice ? "Voice on" : "Voice off"}
        </button>
        <p className="lg-film-note">
          {chosen.id === "browser" ? "Your browser's own text to speech, so it sounds different on each device." : `${chosen.name}, recorded with Cartesia.`} {PLACEHOLDER_URL} is a placeholder address.
        </p>
      </div>
      <p className="lg-chips-label">Music. Click one to play the animation with it.</p>
      <div className="lg-chips" role="group" aria-label="Music for the animation">
        {MUSIC.map((item) => (
          <button key={item.id} type="button" className="lg-chip" aria-pressed={item.id === musicId} onClick={() => chooseMusic(item.id)}>
            {item.name}{item.note && <small>{item.note}</small>}
          </button>
        ))}
      </div>
      <p className="lg-chips-label">Voice, from the highest to the lowest. Click one to hear the line.</p>
      <div className="lg-chips" role="group" aria-label="Voice for the line">
        {VOICES.map((item) => (
          <button key={item.id} type="button" className="lg-chip" aria-pressed={item.id === voiceId} disabled={item.id === "browser" && !speechAvailable} onClick={() => choose(item.id)}>
            {item.name}<small>{item.id === "browser" && !speechAvailable ? "not in this browser" : item.note}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
