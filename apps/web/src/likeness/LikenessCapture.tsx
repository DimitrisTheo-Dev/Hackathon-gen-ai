/**
 * "Scan my face": a full-screen capture that gives an avatar a person's likeness, with their recorded permission.
 * Standalone at /face-scan (FaceScanPage.tsx); it renders in a portal, so it can be mounted anywhere on a page
 * whose headers allow the camera and microphone.
 *
 *   1. intro    name, language, and the agreement checkbox
 *   2. scan     straight at the camera, then left, right, up and down in a random order; each angle is held
 *               briefly and saved as a still while the whole scan is recorded. Face tracking runs in a worker
 *               (faceTracker.ts); rounded chevrons show where to turn and a thin ring fills as angles are held
 *   3. speech   three phrases read aloud, teleprompter style, followed live by Humanlike's live transcription
 *               (browser speech recognition if that is unavailable): two random ones, which no prepared
 *               video can know, then the spoken consent with their name
 *   4. review   the stills, the liveness checks (checks.ts) and the recording
 *   5. save     recordings go straight to private R2 through one-file upload links, then the consent is saved
 *
 * Nothing leaves the browser before the person presses Save.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Pause, Play, RotateCcw, TriangleAlert, X } from "lucide-react";
import { uploadLikenessFile, type LikenessApi } from "./api";
import { createPhraseTracker, evaluateLiveness, voicedMs, type FaceFrame, type LivenessReport } from "./checks";
import { createFaceTracker, type FaceReading, type FaceTracker } from "./faceTracker";
import { boxOnScreen, faceFit } from "./fit";
import { pickPhrases, type LikenessLanguage } from "./phrases";
import { createHoldTimer, matchesPose, poseProgress, poseSequence, POSES, type HeadPose, type PoseId } from "./pose";
import { createBrowserSpeechSource, createLiveSource, probeLive, type LiveHealth, type TranscriptSource } from "./source";
import { createReadAlongSync, tokenizeScript, type ReadAlongSync } from "./sync";
import "./likeness.css";

export interface LikenessResult {
  consentId: string;
  passed: boolean;
  /** The straight-on still, ready to use as the avatar photo. */
  front: Blob;
  stills: Partial<Record<PoseId, Blob>>;
}

interface Props {
  open: boolean;
  api: LikenessApi;
  defaultName?: string;
  onClose(): void;
  onComplete?(result: LikenessResult): void;
  /** Shown on the last screen, e.g. a link back to the studio. */
  doneAction?: { label: string; href: string };
}

type Step = "intro" | "loading" | "scan" | "speech" | "review" | "saving" | "done";
type Hint = "noFace" | "twoFaces" | "closer" | "back" | "center" | null;
type Turn = Exclude<PoseId, "center">;
/** Spoken this long with no text back from live transcription: it is not hearing, so switch recognizers. */
const LIVE_DEAF_MS = 3000;

const COPY = {
  en: {
    title: "Scan your face",
    name: "Full name",
    agree: "I consent to an avatar of my face and voice.",
    start: "Start",
    stepOf: (n: number) => `Step ${n} of 3`,
    hints: { noFace: "No face", twoFaces: "One person only", closer: "Move closer", back: "Move back", center: "Center your face" },
    finish: "Done",
    fallback: "Browser speech",
    restart: "Start again from the top",
    noSpeech: "Speech not supported",
    passedTitle: "Ready",
    failedTitle: "Try again",
    advisory: "Advisory",
    save: "Save",
    retry: "Retry",
    doneTitle: "Saved",
    close: "Close",
    allow: "Allow camera and microphone",
    play: "Play",
    pause: "Pause",
    angles: { center: "Front", left: "Left", right: "Right", up: "Up", down: "Down" },
  },
  el: {
    title: "Σάρωση προσώπου",
    name: "Ονοματεπώνυμο",
    agree: "Συναινώ σε avatar του προσώπου και της φωνής μου.",
    start: "Έναρξη",
    stepOf: (n: number) => `Βήμα ${n} από 3`,
    hints: { noFace: "Δεν φαίνεται πρόσωπο", twoFaces: "Μόνο ένα άτομο", closer: "Πιο κοντά", back: "Πιο πίσω", center: "Στο κέντρο" },
    finish: "Τέλος",
    fallback: "Αναγνώριση browser",
    restart: "Ξεκινήστε ξανά από την αρχή",
    noSpeech: "Δεν υποστηρίζεται ομιλία",
    passedTitle: "Έτοιμο",
    failedTitle: "Ξανά",
    advisory: "Ενδεικτικό",
    save: "Αποθήκευση",
    retry: "Ξανά",
    doneTitle: "Αποθηκεύτηκε",
    close: "Κλείσιμο",
    allow: "Επιτρέψτε κάμερα και μικρόφωνο",
    play: "Αναπαραγωγή",
    pause: "Παύση",
    angles: { center: "Μπροστά", left: "Αριστερά", right: "Δεξιά", up: "Πάνω", down: "Κάτω" },
  },
} as const;

const CHECK_LABELS: Record<LikenessLanguage, Record<string, string>> = {
  en: { poses: "Angles", one_face: "One face", smooth: "Movement", blink: "Blink", phrases: "Phrases", lip_sync: "Lip sync", duration: "Length" },
  el: { poses: "Γωνίες", one_face: "Ένα πρόσωπο", smooth: "Κίνηση", blink: "Βλεφάρισμα", phrases: "Φράσεις", lip_sync: "Χείλη", duration: "Διάρκεια" },
};

// H.264 first: Macs and most PCs encode it in hardware, VP9 is software only and can stall the page.
// MP4 before WebM: it plays everywhere, and Chrome writes "WebM" H.264 as Matroska (video/x-matroska).
function pickMime(withAudio: boolean): string | undefined {
  const list = withAudio
    ? ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/webm;codecs=h264,opus", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/mp4;codecs=avc1.42E01F", "video/webm;codecs=h264", "video/mp4", "video/webm;codecs=vp8", "video/webm"];
  return list.find((type) => MediaRecorder.isTypeSupported(type));
}

function startRecorder(stream: MediaStream) {
  const mimeType = pickMime(stream.getAudioTracks().length > 0);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.start(1000);
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        const type = (recorder.mimeType || mimeType || "video/webm").split(";")[0];
        if (recorder.state === "inactive") return resolve(new Blob(chunks, { type }));
        recorder.onstop = () => resolve(new Blob(chunks, { type }));
        recorder.stop();
      }),
  };
}

const ROTATE: Record<Turn, number> = { right: 0, down: 90, left: 180, up: 270 };

/**
 * Where to turn, without words: two big, soft, curved chevrons that ripple towards the direction (mirrored
 * view, so "left" points to the screen's left). While the pose is held they light up and stop.
 */
function Chevrons({ direction, holding }: { direction: Turn; holding: boolean }) {
  return (
    <div className="lk-chevron-pair" style={{ transform: `rotate(${ROTATE[direction]}deg)` }} aria-hidden="true">
      {[0, 1].map((i) => (
        <svg key={i} viewBox="0 0 32 56" className={holding ? "lk-chevron holding" : "lk-chevron"} style={{ animationDelay: `${i * 180}ms` }}>
          <path d="M9 9 Q 27 28 9 47" fill="none" stroke="currentColor" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ))}
    </div>
  );
}

// The oval drawn from 12 o'clock, clockwise, in a viewBox with the oval's own aspect (100 x 130) so it scales
// uniformly. No vector-effect: non-scaling strokes ignore pathLength, which broke the progress into dashes.
const OVAL = "M50 1.5 A48.5 63.5 0 1 1 50 128.5 A48.5 63.5 0 1 1 50 1.5";

/** The face-shaped guide: a thin outline, and one progress line from the top that only grows. */
function FaceOval({ progress, fitted }: { progress: number; fitted: boolean }) {
  const value = Math.max(0, Math.min(1, progress));
  return (
    <svg viewBox="0 0 100 130" className="lk-oval-svg" aria-hidden="true">
      <path className={fitted ? "lk-oval-outline fitted" : "lk-oval-outline"} d={OVAL} fill="none" strokeWidth="0.8" />
      {value > 0 && <path className="lk-oval-progress" d={OVAL} fill="none" strokeWidth="1.6" strokeLinecap="round" pathLength={100} strokeDasharray={`${value * 100} 200`} />}
    </svg>
  );
}

/**
 * The recorded clip shown mirrored like the live camera. Native controls would be mirrored too, so it has one
 * play/pause button of its own.
 */
function MirroredClip({ src, labels }: { src: string; labels: { play: string; pause: string } }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };
  return (
    <button type="button" onClick={toggle} className={playing ? "lk-clip playing" : "lk-clip"} aria-label={playing ? labels.pause : labels.play}>
      <video ref={ref} src={src} playsInline onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <span className="lk-clip-control">
        <span>{playing ? <Pause size={18} fill="currentColor" aria-hidden="true" /> : <Play size={18} fill="currentColor" aria-hidden="true" />}</span>
      </span>
    </button>
  );
}

export default function LikenessCapture({ open, api, defaultName = "", onClose, onComplete, doneAction }: Props) {
  // Greek for a Greek browser, from the first paint; the toggle on the intro changes it.
  const [language, setLanguage] = useState<LikenessLanguage>(() => (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("el") ? "el" : "en"));
  const [name, setName] = useState(defaultName);
  const [agreed, setAgreed] = useState(false);
  const [step, setStep] = useState<Step>("intro");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanDone, setScanDone] = useState(false);
  const [scanView, setScanView] = useState<{ target: PoseId; progress: number; hold: number; hint: Hint; done: PoseId[]; total: number }>({ target: "center", progress: 0, hold: 0, hint: null, done: [], total: 0 });
  const [phrases, setPhrases] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const [report, setReport] = useState<LivenessReport | null>(null);
  const [stillUrls, setStillUrls] = useState<Partial<Record<PoseId, string>>>({});
  const [speechUrl, setSpeechUrl] = useState<string | null>(null);
  const [saveProgress, setSaveProgress] = useState(0);
  const [canFinish, setCanFinish] = useState(false);
  const t = COPY[language];

  const videoRef = useRef<HTMLVideoElement>(null);
  const ovalRef = useRef<HTMLDivElement>(null);
  const totalRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef<FaceTracker | null>(null);
  const stepRef = useRef<Step>("intro");
  const stepStartRef = useRef(0);
  const sequenceRef = useRef<PoseId[]>([]);
  const indexRef = useRef(0);
  const baselineRef = useRef<HeadPose | null>(null);
  const holdRef = useRef(createHoldTimer());
  const scanFramesRef = useRef<FaceFrame[]>([]);
  const speechFramesRef = useRef<FaceFrame[]>([]);
  const stillsRef = useRef<Partial<Record<PoseId, Blob>>>({});
  const capturedRef = useRef<PoseId[]>([]);
  const scanRecorderRef = useRef<ReturnType<typeof startRecorder> | null>(null);
  const speechRecorderRef = useRef<ReturnType<typeof startRecorder> | null>(null);
  const scanBlobRef = useRef<Blob | null>(null);
  const speechBlobRef = useRef<Blob | null>(null);
  const sourceRef = useRef<TranscriptSource | null>(null);
  const transcriptRef = useRef("");
  const syncRef = useRef<ReadAlongSync | null>(null);
  const heardRef = useRef<ReturnType<typeof createPhraseTracker> | null>(null);
  /** Whether live transcription can be used this time; asked once, while the person is still scanning. */
  const liveHealthRef = useRef<LiveHealth | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const speechStartRef = useRef(0);
  const finishingRef = useRef(false);
  const phrasesRef = useRef<string[]>([]);
  const urlsRef = useRef<string[]>([]);
  const timersRef = useRef<number[]>([]);
  const handleRef = useRef<(reading: FaceReading, ts: number) => void>(() => {});

  useEffect(() => {
    if (defaultName) setName((current) => current || defaultName);
  }, [defaultName]);

  const go = useCallback((next: Step) => {
    stepRef.current = next;
    stepStartRef.current = performance.now();
    setStep(next);
  }, []);

  const objectUrl = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urlsRef.current.push(url);
    return url;
  }, []);

  /** Timers die with the capture, so a closed or restarted capture never advances on a stale one. */
  const later = useCallback((ms: number, run: () => void) => {
    timersRef.current.push(window.setTimeout(run, ms));
  }, []);

  const releaseAll = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    trackerRef.current?.dispose();
    trackerRef.current = null;
    sourceRef.current?.stop();
    sourceRef.current = null;
    scanRecorderRef.current?.stop().catch(() => {});
    speechRecorderRef.current?.stop().catch(() => {});
    scanRecorderRef.current = speechRecorderRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) {
      releaseAll();
      go("intro");
      setError(null);
      setNotice(null);
      setReport(null);
    }
  }, [open, releaseAll, go]);
  useEffect(
    () => () => {
      releaseAll();
      urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [releaseAll],
  );

  const captureStill = useCallback(
    async (pose: PoseId) => {
      const video = videoRef.current;
      if (!video) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) return;
      stillsRef.current[pose] = blob;
      setStillUrls((urls) => ({ ...urls, [pose]: objectUrl(blob) }));
    },
    [objectUrl],
  );

  const finishSpeech = useCallback(async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    const speechMs = performance.now() - speechStartRef.current;
    trackerRef.current?.stop();
    const source = sourceRef.current;
    sourceRef.current = null;
    const finalText = source?.finish ? await source.finish() : (source?.stop(), transcriptRef.current);
    const transcript = (finalText || "").length >= transcriptRef.current.length ? finalText : transcriptRef.current;
    transcriptRef.current = transcript;
    heardRef.current?.update(transcript);
    speechBlobRef.current = (await speechRecorderRef.current?.stop()) ?? null;
    speechRecorderRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    if (stepRef.current !== "speech") return;
    if (speechBlobRef.current) setSpeechUrl(objectUrl(speechBlobRef.current));
    const evaluated = evaluateLiveness({
      posesCaptured: capturedRef.current,
      scanFrames: scanFramesRef.current,
      speechFrames: speechFramesRef.current,
      phrases: phrasesRef.current,
      transcript,
      speechMs,
      phraseCoverage: heardRef.current?.coverage(),
    });
    // Measured values, for tuning the thresholds on real captures. No transcript, name or image.
    console.info("[likeness] checks", evaluated.checks.map((check) => `${check.id}=${check.value}${check.passed ? "" : " (fail)"}`).join(" "), "phrases", heardRef.current?.coverage().map((share) => share.toFixed(2)).join("/"));
    setReport(evaluated);
    go("review");
  }, [go, objectUrl]);

  const startSpeech = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const chosen = pickPhrases(name, language);
    phrasesRef.current = chosen;
    setPhrases(chosen);
    const sync = createReadAlongSync(chosen.join(" "));
    syncRef.current = sync;
    const heard = createPhraseTracker(chosen);
    heardRef.current = heard;
    setPosition(0);
    setCanFinish(false);
    setNotice(null);
    setScanDone(false);
    transcriptRef.current = "";
    finishingRef.current = false;
    speechFramesRef.current = [];

    const ctx = new AudioContext();
    // Created after a timer, not a click; a suspended context would read silence and fail lip sync.
    void ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;

    speechRecorderRef.current = startRecorder(stream);
    speechStartRef.current = performance.now();
    go("speech");
    // A way out if the transcript never reaches the end (noise, an unsupported accent).
    later(12_000, () => setCanFinish(true));

    const onTranscript = (text: string) => {
      transcriptRef.current = text;
      heard.update(text);
      const next = sync.update(text);
      setPosition(next);
      if (next >= sync.words.length && !finishingRef.current) later(900, () => void finishSpeech());
    };
    const browserFallback = () => {
      const fallback = createBrowserSpeechSource(language === "el" ? "el-GR" : "en-US");
      if (!fallback) {
        setNotice(t.noSpeech);
        setCanFinish(true);
        return;
      }
      // The new recognizer only hears what is said from now on. If the person was already reading, those words
      // are gone and the phrases would come up short, so the read-along goes back to the first word and says so.
      const alreadyReading = voicedMs(speechFramesRef.current) >= 1000;
      if (alreadyReading) {
        transcriptRef.current = "";
        sync.reset();
        setPosition(0);
      }
      setNotice(alreadyReading ? `${t.fallback} · ${t.restart}` : t.fallback);
      sourceRef.current = fallback;
      fallback.start(onTranscript, (message) => {
        setNotice(message);
        setCanFinish(true);
      });
    };
    // Known before the first word that live transcription cannot be used: follow with the browser from the start.
    if (liveHealthRef.current === "dead") {
      browserFallback();
      return;
    }
    const live = createLiveSource({ getToken: () => api.liveToken(), language, stream: new MediaStream(stream.getAudioTracks()) });
    sourceRef.current = live;
    const toBrowser = () => {
      if (sourceRef.current !== live || finishingRef.current) return;
      liveHealthRef.current = "dead";
      live.stop();
      browserFallback();
    };
    live.start(onTranscript, toBrowser);
    // The live service reports a failure only when asked for the final text. If the person has clearly been
    // speaking and nothing has come back, do not leave them reading to a dead line.
    const watch = () => {
      if (sourceRef.current !== live || finishingRef.current) return;
      if (!transcriptRef.current && voicedMs(speechFramesRef.current) >= LIVE_DEAF_MS) return toBrowser();
      later(1000, watch);
    };
    later(1000, watch);
  }, [api, finishSpeech, go, language, later, name, t]);

  const finishScan = useCallback(async () => {
    scanBlobRef.current = (await scanRecorderRef.current?.stop()) ?? null;
    scanRecorderRef.current = null;
    startSpeech();
  }, [startSpeech]);

  // Called for every tracked frame (from the worker). Kept in a ref so the tracker always calls the latest one.
  handleRef.current = (face: FaceReading, now: number) => {
    const current = stepRef.current;
    if (current !== "scan" && current !== "speech") return;
    const frame: FaceFrame = { t: now - stepStartRef.current, faces: face.faces, yaw: face.pose?.yaw, pitch: face.pose?.pitch, blink: face.blink, jaw: face.jaw };

    if (current === "scan") {
      scanFramesRef.current.push(frame);
      const sequence = sequenceRef.current;
      const target = sequence[indexRef.current];
      if (!target) return;
      let hint: Hint = face.faces === 0 ? "noFace" : face.faces > 1 ? "twoFaces" : null;
      // Scan only once the face fills the oval.
      const video = videoRef.current;
      const oval = ovalRef.current;
      if (!hint && face.box && video?.videoWidth && oval) {
        const view = video.getBoundingClientRect();
        const guide = oval.getBoundingClientRect();
        const fit = faceFit(
          boxOnScreen(face.box, { w: video.videoWidth, h: video.videoHeight }, { w: view.width, h: view.height }),
          { x: guide.left - view.left, y: guide.top - view.top, w: guide.width, h: guide.height },
          target !== "center",
        );
        if (fit !== "ok") hint = fit;
      }
      const matching = !hint && !!face.pose && matchesPose(target, face.pose, baselineRef.current);
      if (holdRef.current.update(matching, now)) {
        if (target === "center") baselineRef.current = face.pose;
        capturedRef.current.push(target);
        void captureStill(target);
        indexRef.current += 1;
        holdRef.current.reset();
        if (indexRef.current >= sequence.length) {
          go("loading");
          setScanDone(true);
          totalRef.current = 1;
          setScanView((view) => ({ ...view, done: [...capturedRef.current], hold: 0, progress: 0, total: 1 }));
          later(900, () => void finishScan());
          return;
        }
      }
      const hold = holdRef.current.progress(now);
      // Accumulates over the whole scan and never goes back, even when a hold breaks.
      totalRef.current = Math.max(totalRef.current, (capturedRef.current.length + hold) / sequence.length);
      setScanView({
        target: sequence[indexRef.current],
        progress: face.pose ? poseProgress(sequence[indexRef.current], face.pose, baselineRef.current) : 0,
        hold,
        hint,
        done: [...capturedRef.current],
        total: totalRef.current,
      });
    } else {
      const analyser = analyserRef.current;
      if (analyser) {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        frame.audio = Math.sqrt(sum / samples.length);
      }
      speechFramesRef.current.push(frame);
    }
  };

  const beginScan = useCallback(() => {
    // A retry starts clean: nothing scheduled by the previous attempt may fire into this one.
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    sequenceRef.current = poseSequence();
    indexRef.current = 0;
    baselineRef.current = null;
    holdRef.current.reset();
    scanFramesRef.current = [];
    speechFramesRef.current = [];
    stillsRef.current = {};
    capturedRef.current = [];
    scanBlobRef.current = speechBlobRef.current = null;
    setStillUrls({});
    setSpeechUrl(null);
    setReport(null);
    setNotice(null);
    setScanDone(false);
    setError(null);
    totalRef.current = 0;
    setScanView({ target: "center", progress: 0, hold: 0, hint: null, done: [], total: 0 });
    const stream = streamRef.current!;
    scanRecorderRef.current = startRecorder(new MediaStream(stream.getVideoTracks()));
    go("scan");
    trackerRef.current?.start(videoRef.current!, (reading, ts) => handleRef.current(reading, ts));
    // While the person turns their head, find out whether live transcription is working, so the read-aloud
    // starts on a recognizer that hears the first word. Asked once; a retry reuses the answer.
    if (liveHealthRef.current === null) {
      liveHealthRef.current = "unknown";
      void probeLive(() => api.liveToken()).then((health) => {
        if (liveHealthRef.current === "unknown") liveHealthRef.current = health;
      });
    }
  }, [api, go]);

  const start = useCallback(async () => {
    setError(null);
    go("loading");
    try {
      const tracker = trackerRef.current ?? createFaceTracker();
      trackerRef.current = tracker;
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        }),
        tracker.ready,
      ]);
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      beginScan();
    } catch (failure) {
      releaseAll();
      go("intro");
      const denied = (failure as Error)?.name === "NotAllowedError";
      setError(denied ? t.allow : (failure as Error)?.message || "Camera unavailable");
    }
  }, [beginScan, go, releaseAll, t]);

  const retry = useCallback(() => {
    if (!streamRef.current || !trackerRef.current) {
      void start();
      return;
    }
    beginScan();
  }, [beginScan, start]);

  const save = useCallback(async () => {
    const scan = scanBlobRef.current;
    const speech = speechBlobRef.current;
    const front = stillsRef.current.center;
    if (!report?.passed || !scan || !speech || !front) return;
    go("saving");
    setError(null);
    setSaveProgress(0);
    try {
      const stills = Object.entries(stillsRef.current) as [PoseId, Blob][];
      const total = stills.length + 2;
      let done = 0;
      const tick = <T,>(upload: Promise<T>) =>
        upload.then((value) => {
          done += 1;
          setSaveProgress(done / total);
          return value;
        });
      const [scanVideoKey, speechVideoKey, ...stillKeys] = await Promise.all([tick(uploadLikenessFile(api, scan)), tick(uploadLikenessFile(api, speech)), ...stills.map(([, blob]) => tick(uploadLikenessFile(api, blob)))]);
      const saved = await api.saveConsent({
        subjectName: name,
        language,
        phrases,
        transcript: transcriptRef.current.slice(0, 5000),
        scanVideoKey,
        speechVideoKey,
        stills: Object.fromEntries(stills.map(([pose], i) => [pose, stillKeys[i]])),
        report,
      });
      releaseAll();
      go("done");
      onComplete?.({ consentId: saved.id, passed: saved.passed, front, stills: { ...stillsRef.current } });
    } catch (failure) {
      setError((failure as Error).message);
      go("review");
    }
  }, [api, go, language, name, onComplete, phrases, releaseAll, report]);

  const close = useCallback(() => {
    releaseAll();
    onClose();
  }, [onClose, releaseAll]);

  if (!open || typeof document === "undefined") return null;

  const live = step === "loading" || step === "scan" || step === "speech";
  const stepNumber = { intro: 0, loading: 1, scan: 1, speech: 2, review: 3, saving: 3, done: 3 }[step];
  const boundaries = phrases.reduce<number[]>((ends, phrase) => [...ends, (ends[ends.length - 1] ?? 0) + tokenizeScript(phrase).length], []);
  const currentPhrase = boundaries.findIndex((end) => position < end);
  const scanning = step === "scan";
  const holding = scanning && !scanView.hint && scanView.hold > 0;
  const direction: Turn | null = scanning && !scanView.hint && scanView.target !== "center" ? scanView.target : null;
  const fullCamera = step === "scan" || step === "loading";

  return createPortal(
    <div className="lk-root" role="dialog" aria-modal="true" aria-label={t.title} lang={language}>
      <header className="lk-header">
        <div className="lk-header-group">
          {step !== "intro" && <span className="lk-header-title">{t.title}</span>}
          {stepNumber > 0 && step !== "done" && (
            <div className="lk-steps" role="img" aria-label={t.stepOf(stepNumber)}>
              {[1, 2, 3].map((n) => (
                <span key={n} className={stepNumber >= n ? "on" : undefined} />
              ))}
            </div>
          )}
        </div>
        <div className="lk-header-group">
          {step === "intro" && (
            <div className="lk-lang" role="group" aria-label="Language">
              {(["en", "el"] as const).map((code) => (
                <button key={code} type="button" onClick={() => setLanguage(code)} className={language === code ? "on" : undefined} aria-pressed={language === code}>
                  {code === "en" ? "EN" : "ΕΛ"}
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={close} className="lk-icon-button" aria-label={t.close}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="lk-main">
        {/* Camera: mounted for the whole session so the stream and recorders keep running between steps.
            Full screen while scanning (fixed, behind the header), a small circle while speaking. */}
        <div className={live ? "lk-live" : "lk-live is-hidden"}>
          <div className={fullCamera ? "lk-camera full" : "lk-camera bubble"}>
            <video ref={videoRef} playsInline muted className="lk-video" />
            {fullCamera && (
              <div className="lk-oval-wrap">
                <div ref={ovalRef} className="lk-oval">
                  {step === "scan" && <FaceOval progress={scanView.total} fitted={!scanView.hint} />}
                  {step === "loading" && !scanDone && (
                    <div className="lk-oval-center">
                      <span className="lk-spinner" />
                    </div>
                  )}
                  {step === "loading" && scanDone && (
                    <>
                      <FaceOval progress={1} fitted />
                      <div className="lk-oval-center">
                        <span className="lk-badge lk-in">
                          <Check size={28} strokeWidth={2.5} aria-hidden="true" />
                        </span>
                      </div>
                    </>
                  )}
                  {direction && (
                    <div key={direction} className={`lk-chevrons ${direction} lk-in`}>
                      <Chevrons direction={direction} holding={holding} />
                    </div>
                  )}
                  {scanning && (
                    <div className="lk-hint-wrap">
                      <span className="sr-only" aria-live="polite">
                        {scanView.hint ? t.hints[scanView.hint] : POSES[scanView.target].prompt[language]}
                      </span>
                      {scanView.hint && (
                        <p key={scanView.hint} className="lk-hint lk-in">
                          {t.hints[scanView.hint]}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {step === "speech" && (
            <div className="lk-speech">
              <div className="lk-phrases">
                {phrases.map((phrase, i) => {
                  const first = boundaries[i - 1] ?? 0;
                  const words = tokenizeScript(phrase);
                  const finished = position >= boundaries[i];
                  const active = i === currentPhrase;
                  return (
                    <p key={i} className={finished ? "lk-phrase done" : active ? "lk-phrase active" : "lk-phrase"}>
                      {words.map((word, w) => (
                        <span key={w} className={active && first + w < position ? "said" : undefined}>
                          {word.text}{" "}
                        </span>
                      ))}
                    </p>
                  );
                })}
              </div>
              {notice && <p className="lk-notice">{notice}</p>}
              <div className="lk-finish-row">
                {canFinish && (
                  <button type="button" onClick={() => void finishSpeech()} className="lk-button ghost lk-in">
                    {t.finish}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {step === "intro" && (
          <div className="lk-intro lk-in">
            <h1 className="lk-title">{t.title}</h1>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder={t.name} aria-label={t.name} autoComplete="name" className="lk-input" />
            <label className="lk-check">
              <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
              <span className="lk-check-box" aria-hidden="true">
                <span />
              </span>
              <span className="lk-check-label">{t.agree}</span>
            </label>
            {error && (
              <p className="lk-error" role="alert">
                <TriangleAlert size={18} aria-hidden="true" />
                {error}
              </p>
            )}
            <button type="button" onClick={() => void start()} disabled={!agreed || name.trim().length < 2} className="lk-button primary">
              {t.start}
            </button>
          </div>
        )}

        {(step === "review" || step === "saving") && report && (
          <div className="lk-review lk-in">
            <h2 className="lk-heading">{report.passed ? t.passedTitle : t.failedTitle}</h2>

            <div className="lk-stills">
              {(["left", "up", "center", "down", "right"] as PoseId[]).map((pose) => (
                <div key={pose}>{stillUrls[pose] && <img src={stillUrls[pose]} alt={t.angles[pose]} />}</div>
              ))}
            </div>

            <div className="lk-review-grid">
              {speechUrl && <MirroredClip src={speechUrl} labels={t} />}
              <ul className="lk-checks">
                {report.checks.map((check) => (
                  <li key={check.id} className={check.passed ? "ok" : check.required ? "fail" : "advisory"}>
                    <span className="lk-dot">{check.passed ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : <X size={12} strokeWidth={3} aria-hidden="true" />}</span>
                    <span>{CHECK_LABELS[language][check.id] ?? check.label}</span>
                    {!check.passed && !check.required && <small>{t.advisory}</small>}
                  </li>
                ))}
              </ul>
            </div>

            {error && (
              <p className="lk-error" role="alert">
                <TriangleAlert size={18} aria-hidden="true" />
                {error}
              </p>
            )}

            <div className="lk-actions">
              <button type="button" onClick={() => void save()} disabled={!report.passed || step === "saving"} className="lk-button primary">
                {step === "saving" ? `${Math.round(saveProgress * 100)}%` : t.save}
              </button>
              <button type="button" onClick={retry} disabled={step === "saving"} className="lk-button quiet">
                <RotateCcw size={15} aria-hidden="true" />
                {t.retry}
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="lk-done lk-in">
            <div className="lk-done-photo">
              <div>{stillUrls.center && <img src={stillUrls.center} alt="" />}</div>
              <span>
                <Check size={16} strokeWidth={3} aria-hidden="true" />
              </span>
            </div>
            <h2 className="lk-heading">{t.doneTitle}</h2>
            <div className="lk-done-actions">
              {doneAction && (
                <a href={doneAction.href} className="lk-button primary">
                  {doneAction.label}
                </a>
              )}
              <button type="button" onClick={close} className={doneAction ? "lk-button quiet" : "lk-button primary"}>
                {t.close}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>,
    document.body,
  );
}
