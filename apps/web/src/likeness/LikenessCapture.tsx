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
import { Camera, Check, Copy, Lightbulb, Mic, Pause, Play, RotateCcw, ShieldCheck, TriangleAlert, Volume1, X } from "lucide-react";
import { uploadLikenessFile, type LikenessApi } from "./api";
import { createPhraseTracker, evaluateLiveness, meanLuma, voicedMs, type FaceFrame, type LivenessReport } from "./checks";
import { createFaceTracker, type FaceReading, type FaceTracker } from "./faceTracker";
import { boxOnScreen, faceFit } from "./fit";
import { consentStatement, pickPhrases, type LikenessLanguage } from "./phrases";
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
  /** Shown on the last screen: a link back (href) or an action in the page it is embedded in (onClick). */
  doneAction?: { label: string; href?: string; onClick?: () => void };
  /** The persona this consent is recorded for, when the person came from the Personas tab. */
  personaId?: string;
  /** Rendered in place, inside the page that hosts it (the studio's Personas tab), instead of over the whole screen. */
  embedded?: boolean;
  /** A short line above the title saying what the scan is for, e.g. "Persona · Dr. Maria". */
  context?: string;
}

type Step = "intro" | "prime" | "loading" | "scan" | "speech" | "review" | "saving" | "done";
type Hint = "noFace" | "twoFaces" | "closer" | "back" | "center" | "dark" | null;
/** Mean brightness (0..1) of the camera picture below which the face is too dark to track well. */
const DARK = 0.2;
/** A new hint waits this long before it replaces the one shown, so the guide does not flicker. */
const HINT_SETTLE_MS = 350;
type Turn = Exclude<PoseId, "center">;
/** Spoken this long with no text back from live transcription: it is not hearing, so switch recognizers. */
const LIVE_DEAF_MS = 3000;

const COPY = {
  en: {
    title: "Scan your face",
    name: "Your full name",
    nameHint: "It goes into the consent you read aloud.",
    agree: "I consent to an avatar of my face and voice.",
    youWillSay: "You’ll read this aloud at the end:",
    continue: "Continue",
    phases: ["Consent", "Face scan", "Your looks"],
    phasesNoPersona: ["Consent", "Face scan", "Saved"],
    stepOf: (n: number, label: string) => `Step ${n} of 3: ${label}`,
    plan: [
      { title: "Agree", time: "30 sec", body: "Confirm your name and tick the box." },
      { title: "Turn and read", time: "about 1 min", body: "Turn your head slowly, then read three short lines aloud." },
      { title: "Check and save", time: "30 sec", body: "See the result before anything is saved." },
    ],
    privacyTitle: "What happens to your face data",
    privacy: [
      "Face tracking runs on this device. The recordings stay here until you press Save.",
      "While you read aloud, your voice is transcribed live so the words follow you.",
      "Saved: the two recordings, five stills and the transcript, in private storage for this workspace.",
      "Withdraw consent on the persona at any time and the recordings are deleted for good. A dated record that you withdrew is kept.",
    ],
    primeTitle: "Get ready",
    primeBody: "Faceful needs your camera and microphone for about a minute.",
    primeAsk: "Your browser will ask next. Choose Allow.",
    tips: ["Face a window or a soft light", "Find a quiet spot", "Hold the camera at eye level"],
    allowButton: "Allow camera and microphone",
    startScan: "Start the scan",
    back: "Back",
    opening: "Opening the camera…",
    hints: { noFace: "Looking for your face…", twoFaces: "Only one person in view, please", closer: "Move a little closer", back: "Move back a little", center: "Center your face in the oval", dark: "Find more light on your face" },
    angleOf: (n: number, total: number) => `${n} of ${total}`,
    scanned: "Scan done. Now read aloud.",
    readHint: "Read each line at a normal pace. The words light up as you go.",
    finish: "I’ve finished reading",
    fallback: "Browser speech",
    restart: "Start again from the top",
    noSpeech: "Speech not supported",
    passedTitle: "Looks good",
    passedBody: "Play it back if you like, then save. Nothing has left this device yet.",
    failedTitle: "Let’s try that once more",
    failedBody: "One check didn’t pass, so this capture can’t be saved. It only takes a minute.",
    remedies: {
      poses: "Hold each angle until the ring moves on.",
      one_face: "Make sure only you are in view.",
      smooth: "Turn your head slowly, without sudden jumps.",
      phrases: "Read every line aloud, clearly.",
      duration: "Read all three lines at a steady pace.",
    } as Record<string, string>,
    advisory: "Advisory",
    save: "Save consent",
    saving: (n: number) => `Saving privately… ${n}%`,
    retry: "Scan again",
    saveAgain: "Try saving again",
    doneTitle: "Consent saved",
    doneBody: "Your face scan and spoken consent are stored privately in this workspace.",
    doneNext: "Next, add a look: what you wear and where you are on camera.",
    close: "Close",
    doneClose: "Done",
    play: "Play",
    pause: "Pause",
    angles: { center: "Front", left: "Left", right: "Right", up: "Up", down: "Down" },
    problems: {
      denied: { title: "Camera access is off", body: "Allow the camera and microphone for this site. In most browsers that is the camera icon in the address bar. Then try again." },
      missing: { title: "No camera found", body: "Connect a camera and try again, or open the scan link on your phone." },
      busy: { title: "The camera is busy", body: "Another app or tab is using it. Close that, then try again." },
      unsupported: { title: "This browser can’t open the camera here", body: "Open the scan in the latest Chrome, Edge or Safari." },
      tracker: { title: "Face tracking couldn’t start", body: "Reload the page and try again. If it keeps happening, try the latest Chrome, Edge or Safari." },
    },
    tryAgain: "Try again",
    copyLink: "Copy link for your phone",
    copied: "Link copied",
  },
  el: {
    title: "Σάρωση προσώπου",
    name: "Ονοματεπώνυμο",
    nameHint: "Μπαίνει στη συναίνεση που θα διαβάσετε φωναχτά.",
    agree: "Συναινώ σε avatar του προσώπου και της φωνής μου.",
    youWillSay: "Στο τέλος θα διαβάσετε φωναχτά:",
    continue: "Συνέχεια",
    phases: ["Συναίνεση", "Σάρωση", "Εμφανίσεις"],
    phasesNoPersona: ["Συναίνεση", "Σάρωση", "Αποθήκευση"],
    stepOf: (n: number, label: string) => `Βήμα ${n} από 3: ${label}`,
    plan: [
      { title: "Συμφωνία", time: "30 δευτ.", body: "Επιβεβαιώστε το όνομά σας και τσεκάρετε το κουτί." },
      { title: "Στροφές και ανάγνωση", time: "περίπου 1 λεπτό", body: "Γυρίστε αργά το κεφάλι, μετά διαβάστε τρεις μικρές φράσεις." },
      { title: "Έλεγχος και αποθήκευση", time: "30 δευτ.", body: "Βλέπετε το αποτέλεσμα πριν αποθηκευτεί οτιδήποτε." },
    ],
    privacyTitle: "Τι γίνεται με τα δεδομένα του προσώπου σας",
    privacy: [
      "Η παρακολούθηση του προσώπου γίνεται σε αυτή τη συσκευή. Οι εγγραφές μένουν εδώ μέχρι να πατήσετε Αποθήκευση.",
      "Όσο διαβάζετε, η φωνή σας μεταγράφεται ζωντανά για να σας ακολουθούν οι λέξεις.",
      "Αποθηκεύονται: οι δύο εγγραφές, πέντε στιγμιότυπα και η μεταγραφή, ιδιωτικά για αυτόν τον χώρο εργασίας.",
      "Ανακαλέστε τη συναίνεση από την περσόνα όποτε θέλετε και οι εγγραφές διαγράφονται οριστικά. Μένει μια χρονολογημένη καταγραφή της ανάκλησης.",
    ],
    primeTitle: "Ετοιμαστείτε",
    primeBody: "Η Faceful χρειάζεται κάμερα και μικρόφωνο για περίπου ένα λεπτό.",
    primeAsk: "Ο browser θα σας ρωτήσει. Επιλέξτε Να επιτρέπεται.",
    tips: ["Κοιτάξτε προς ένα παράθυρο ή απαλό φως", "Βρείτε ένα ήσυχο σημείο", "Κρατήστε την κάμερα στο ύψος των ματιών"],
    allowButton: "Επιτρέψτε κάμερα και μικρόφωνο",
    startScan: "Έναρξη σάρωσης",
    back: "Πίσω",
    opening: "Ανοίγει η κάμερα…",
    hints: { noFace: "Αναζήτηση προσώπου…", twoFaces: "Μόνο ένα άτομο, παρακαλώ", closer: "Λίγο πιο κοντά", back: "Λίγο πιο πίσω", center: "Το πρόσωπο στο κέντρο", dark: "Χρειάζεται περισσότερο φως" },
    angleOf: (n: number, total: number) => `${n} από ${total}`,
    scanned: "Η σάρωση έγινε. Τώρα διαβάστε φωναχτά.",
    readHint: "Διαβάστε κάθε φράση με κανονικό ρυθμό. Οι λέξεις φωτίζονται καθώς προχωράτε.",
    finish: "Τελείωσα",
    fallback: "Αναγνώριση browser",
    restart: "Ξεκινήστε ξανά από την αρχή",
    noSpeech: "Δεν υποστηρίζεται ομιλία",
    passedTitle: "Όλα καλά",
    passedBody: "Δείτε την εγγραφή αν θέλετε και αποθηκεύστε. Τίποτα δεν έχει φύγει ακόμη από τη συσκευή.",
    failedTitle: "Ας το ξαναδοκιμάσουμε",
    failedBody: "Ένας έλεγχος δεν πέρασε, οπότε η εγγραφή δεν μπορεί να αποθηκευτεί. Παίρνει ένα λεπτό.",
    remedies: {
      poses: "Κρατήστε κάθε γωνία μέχρι να προχωρήσει ο δακτύλιος.",
      one_face: "Μόνο εσείς στο κάδρο.",
      smooth: "Γυρίστε το κεφάλι αργά, χωρίς απότομες κινήσεις.",
      phrases: "Διαβάστε καθαρά κάθε φράση.",
      duration: "Διαβάστε και τις τρεις φράσεις με σταθερό ρυθμό.",
    } as Record<string, string>,
    advisory: "Ενδεικτικό",
    save: "Αποθήκευση συναίνεσης",
    saving: (n: number) => `Ιδιωτική αποθήκευση… ${n}%`,
    retry: "Νέα σάρωση",
    saveAgain: "Δοκιμάστε ξανά την αποθήκευση",
    doneTitle: "Η συναίνεση αποθηκεύτηκε",
    doneBody: "Η σάρωση και η προφορική συναίνεση φυλάσσονται ιδιωτικά σε αυτόν τον χώρο εργασίας.",
    doneNext: "Στη συνέχεια, προσθέστε μια εμφάνιση: τι φοράτε και πού βρίσκεστε στην κάμερα.",
    close: "Κλείσιμο",
    doneClose: "Τέλος",
    play: "Αναπαραγωγή",
    pause: "Παύση",
    angles: { center: "Μπροστά", left: "Αριστερά", right: "Δεξιά", up: "Πάνω", down: "Κάτω" },
    problems: {
      denied: { title: "Η κάμερα είναι απενεργοποιημένη", body: "Επιτρέψτε κάμερα και μικρόφωνο για αυτόν τον ιστότοπο, συνήθως από το εικονίδιο κάμερας στη γραμμή διεύθυνσης. Μετά δοκιμάστε ξανά." },
      missing: { title: "Δεν βρέθηκε κάμερα", body: "Συνδέστε μια κάμερα και δοκιμάστε ξανά, ή ανοίξτε τον σύνδεσμο στο κινητό σας." },
      busy: { title: "Η κάμερα χρησιμοποιείται", body: "Κάποια άλλη εφαρμογή ή καρτέλα τη χρησιμοποιεί. Κλείστε την και δοκιμάστε ξανά." },
      unsupported: { title: "Αυτός ο browser δεν ανοίγει την κάμερα εδώ", body: "Ανοίξτε τη σάρωση στον πιο πρόσφατο Chrome, Edge ή Safari." },
      tracker: { title: "Η παρακολούθηση προσώπου δεν ξεκίνησε", body: "Ανανεώστε τη σελίδα και δοκιμάστε ξανά, ή δοκιμάστε τον πιο πρόσφατο Chrome, Edge ή Safari." },
    },
    tryAgain: "Δοκιμάστε ξανά",
    copyLink: "Αντιγραφή συνδέσμου για το κινητό",
    copied: "Αντιγράφηκε",
  },
} as const;

type Problem = keyof (typeof COPY)["en"]["problems"];
/** What went wrong opening the camera, from the browser's error name. */
function problemOf(failure: unknown): Problem {
  const name = (failure as Error)?.name;
  const message = (failure as Error)?.message ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "missing";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy";
  if (message.startsWith("Face tracking")) return "tracker";
  return "unsupported";
}

/** Whether the browser already lets this site use the camera and microphone (no prompt will appear). */
async function alreadyAllowed(): Promise<boolean> {
  try {
    const states = await Promise.all((["camera", "microphone"] as const).map((name) => navigator.permissions.query({ name: name as PermissionName })));
    return states.every((state) => state.state === "granted");
  } catch {
    return false;
  }
}

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

export default function LikenessCapture({ open, api, defaultName = "", onClose, onComplete, doneAction, personaId, embedded = false, context }: Props) {
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
  /** Why the camera did not open, shown as a calm card on the get-ready screen. */
  const [problem, setProblem] = useState<Problem | null>(null);
  /** Whether the camera and microphone are already allowed, so no browser prompt will follow. */
  const [allowed, setAllowed] = useState(false);
  const [copied, setCopied] = useState(false);
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
  /** The camera picture's brightness, sampled a few times a second while scanning. */
  const lightRef = useRef({ at: 0, dark: false });
  const lightCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The hint on screen, and the one waiting to replace it (HINT_SETTLE_MS). */
  const settleRef = useRef<{ shown: Hint; candidate: Hint; since: number }>({ shown: null, candidate: null, since: 0 });

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
      // No face in a dark picture: the useful advice is light, not position.
      if (video?.videoWidth && now - lightRef.current.at > 700) {
        const canvas = (lightCanvasRef.current ??= Object.assign(document.createElement("canvas"), { width: 16, height: 16 }));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, 16, 16);
          lightRef.current = { at: now, dark: meanLuma(ctx.getImageData(0, 0, 16, 16).data) < DARK };
        }
      }
      if (hint === "noFace" && lightRef.current.dark) hint = "dark";
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
      // What the person sees changes only once a new hint has held for a moment; the scan itself uses `hint`.
      const settle = settleRef.current;
      if (hint === settle.shown) settle.candidate = hint;
      else if (hint !== settle.candidate) {
        settle.candidate = hint;
        settle.since = now;
      } else if (now - settle.since >= HINT_SETTLE_MS) settle.shown = hint;
      // Accumulates over the whole scan and never goes back, even when a hold breaks.
      totalRef.current = Math.max(totalRef.current, (capturedRef.current.length + hold) / sequence.length);
      setScanView({
        target: sequence[indexRef.current],
        progress: face.pose ? poseProgress(sequence[indexRef.current], face.pose, baselineRef.current) : 0,
        hold,
        hint: settle.shown,
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
    settleRef.current = { shown: null, candidate: null, since: 0 };
    lightRef.current = { at: 0, dark: false };
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
    setProblem(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem("unsupported");
      return;
    }
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
      go("prime");
      setProblem(problemOf(failure));
    }
  }, [beginScan, go, releaseAll]);

  /** From the agreement to the get-ready screen, which says what the browser will ask before it asks. */
  const prepare = useCallback(() => {
    setProblem(null);
    void alreadyAllowed().then(setAllowed);
    go("prime");
  }, [go]);

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
        ...(personaId ? { personaId } : {}),
      });
      releaseAll();
      go("done");
      onComplete?.({ consentId: saved.id, passed: saved.passed, front, stills: { ...stillsRef.current } });
    } catch (failure) {
      setError((failure as Error).message);
      go("review");
    }
  }, [api, go, language, name, onComplete, personaId, phrases, releaseAll, report]);

  const close = useCallback(() => {
    releaseAll();
    onClose();
  }, [onClose, releaseAll]);

  if (!open || typeof document === "undefined") return null;

  const live = step === "loading" || step === "scan" || step === "speech";
  // Three phases the person can follow: agree, scan (turns, read-aloud, review, save), then what comes next.
  const phase = step === "intro" || step === "prime" ? 1 : step === "done" ? 3 : 2;
  const phases = personaId ? t.phases : t.phasesNoPersona;
  const boundaries = phrases.reduce<number[]>((ends, phrase) => [...ends, (ends[ends.length - 1] ?? 0) + tokenizeScript(phrase).length], []);
  const currentPhrase = boundaries.findIndex((end) => position < end);
  const scanning = step === "scan";
  const holding = scanning && !scanView.hint && scanView.hold > 0;
  const direction: Turn | null = scanning && !scanView.hint && scanView.target !== "center" ? scanView.target : null;
  const fullCamera = step === "scan" || step === "loading";
  const statement = consentStatement(name.trim() || "…", language);
  const scanLink = personaId ? `${location.origin}/face-scan?persona=${encodeURIComponent(personaId)}` : null;
  const failedChecks = report ? report.checks.filter((check) => !check.passed && check.required) : [];
  const problemCopy = problem ? t.problems[problem] : null;

  const tree = (
    <div className={embedded ? `lk-root embedded is-${step}` : `lk-root is-${step}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={t.title} lang={language}>
      <header className="lk-header">
        <div className="lk-header-group">
          <span className="lk-header-title">{context ?? t.title}</span>
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
        <ol className="lk-progress" aria-label={t.stepOf(phase, phases[phase - 1])}>
          {phases.map((label, index) => {
            const n = index + 1;
            return (
              <li key={label} className={n < phase ? "done" : n === phase ? "on" : undefined} aria-current={n === phase ? "step" : undefined}>
                <span className="lk-progress-dot" aria-hidden="true">{n < phase ? <Check size={11} strokeWidth={3} /> : n}</span>
                <span className="lk-progress-label">{label}</span>
              </li>
            );
          })}
        </ol>
      </header>

      <main className="lk-main">
        {/* Camera: mounted for the whole session so the stream and recorders keep running between steps.
            Full screen while scanning (fixed, behind the header), a small circle while speaking. */}
        <div className={live ? "lk-live" : "lk-live is-hidden"}>
          <div className={fullCamera ? "lk-camera full" : "lk-camera bubble"}>
            <video ref={videoRef} playsInline muted className="lk-video" />
            {fullCamera && (
              <div className="lk-oval-wrap">
                <div ref={ovalRef} className={holding ? "lk-oval holding" : "lk-oval"}>
                  {step === "scan" && <FaceOval progress={scanView.total} fitted={!scanView.hint} />}
                  {step === "loading" && !scanDone && (
                    <div className="lk-oval-center">
                      <span className="lk-spinner" />
                      <span className="sr-only" role="status">{t.opening}</span>
                    </div>
                  )}
                  {step === "loading" && scanDone && (
                    <>
                      <FaceOval progress={1} fitted />
                      <div className="lk-oval-center">
                        <span className="lk-badge lk-pop">
                          <Check size={28} strokeWidth={2.5} aria-hidden="true" />
                        </span>
                        <span className="sr-only" role="status">{t.scanned}</span>
                      </div>
                    </>
                  )}
                  {direction && (
                    <div key={direction} className={`lk-chevrons ${direction} lk-in`}>
                      <Chevrons direction={direction} holding={holding} />
                    </div>
                  )}
                </div>
                {scanning && (
                  <div className="lk-guide">
                    <span className="sr-only" aria-live="polite">
                      {scanView.hint ? t.hints[scanView.hint] : POSES[scanView.target].prompt[language]}
                    </span>
                    <p key={scanView.hint ?? scanView.target} className={scanView.hint && scanView.hint !== "noFace" ? "lk-hint attention lk-in" : "lk-hint lk-in"} aria-hidden="true">
                      {scanView.hint === "dark" && <Lightbulb size={15} aria-hidden="true" />}
                      {scanView.hint ? t.hints[scanView.hint] : POSES[scanView.target].prompt[language]}
                    </p>
                    <span className="lk-count" aria-hidden="true">{t.angleOf(Math.min(scanView.done.length + 1, 5), 5)}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {step === "speech" && (
            <div className="lk-speech">
              <p className="lk-read-hint">{t.readHint}</p>
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
            <ol className="lk-plan">
              {t.plan.map((item, index) => (
                <li key={item.title}>
                  <span className="lk-plan-n" aria-hidden="true">{index + 1}</span>
                  <span className="lk-plan-text">
                    <strong>{item.title}<small>{item.time}</small></strong>
                    <span>{item.body}</span>
                  </span>
                </li>
              ))}
            </ol>
            <div className="lk-field">
              <label htmlFor="lk-name">{t.name}</label>
              <input id="lk-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="name" className="lk-input" aria-describedby="lk-name-hint" />
              <small id="lk-name-hint">{t.nameHint}</small>
            </div>
            <label className="lk-check">
              <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
              <span className="lk-check-box" aria-hidden="true">
                <span />
              </span>
              <span className="lk-check-label">{t.agree}</span>
            </label>
            <figure className="lk-statement">
              <figcaption>{t.youWillSay}</figcaption>
              <blockquote lang={language}>“{statement}”</blockquote>
            </figure>
            <details className="lk-privacy">
              <summary><ShieldCheck size={16} aria-hidden="true" />{t.privacyTitle}</summary>
              <ul>
                {t.privacy.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </details>
            <div className="lk-cta">
              <button type="button" onClick={prepare} disabled={!agreed || name.trim().length < 2} className="lk-button primary">
                {t.continue}
              </button>
            </div>
          </div>
        )}

        {step === "prime" && (
          <div className="lk-prime lk-in">
            {problemCopy ? (
              <div className="lk-problem" role="alert">
                <span className="lk-problem-icon" aria-hidden="true"><TriangleAlert size={20} /></span>
                <h2 className="lk-heading">{problemCopy.title}</h2>
                <p>{problemCopy.body}</p>
              </div>
            ) : (
              <>
                <div className="lk-prime-art" aria-hidden="true">
                  <span><Camera size={22} /></span>
                  <span><Mic size={22} /></span>
                </div>
                <h2 className="lk-heading">{t.primeTitle}</h2>
                <p className="lk-lede">{t.primeBody}{allowed ? "" : ` ${t.primeAsk}`}</p>
                <ul className="lk-tips">
                  <li><Lightbulb size={16} aria-hidden="true" />{t.tips[0]}</li>
                  <li><Volume1 size={16} aria-hidden="true" />{t.tips[1]}</li>
                  <li><Camera size={16} aria-hidden="true" />{t.tips[2]}</li>
                </ul>
              </>
            )}
            <div className="lk-cta">
              <button type="button" onClick={() => void start()} className="lk-button primary">
                {problemCopy ? t.tryAgain : allowed ? t.startScan : t.allowButton}
              </button>
              {problem === "missing" && scanLink && (
                <button
                  type="button"
                  className="lk-button quiet"
                  onClick={() => {
                    void navigator.clipboard?.writeText(scanLink).then(() => {
                      setCopied(true);
                      later(2000, () => setCopied(false));
                    });
                  }}
                >
                  <Copy size={15} aria-hidden="true" />
                  {copied ? t.copied : t.copyLink}
                </button>
              )}
              <button type="button" onClick={() => { setProblem(null); go("intro"); }} className="lk-button quiet">
                {t.back}
              </button>
            </div>
          </div>
        )}

        {(step === "review" || step === "saving") && report && (
          <div className="lk-review lk-in">
            <h2 className="lk-heading">{report.passed ? t.passedTitle : t.failedTitle}</h2>
            <p className="lk-lede">{report.passed ? t.passedBody : t.failedBody}</p>
            {!report.passed && failedChecks.length > 0 && (
              <ul className="lk-remedies">
                {failedChecks.map((check) => <li key={check.id}>{t.remedies[check.id] ?? check.label}</li>)}
              </ul>
            )}

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

            {step === "saving" && (
              <div className="lk-save-bar" role="progressbar" aria-label={t.saving(Math.round(saveProgress * 100))} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(saveProgress * 100)}>
                <span style={{ transform: `scaleX(${Math.max(0.04, saveProgress)})` }} />
              </div>
            )}
            <div className="lk-actions">
              {report.passed && (
                <button type="button" onClick={() => void save()} disabled={step === "saving"} className="lk-button primary">
                  {step === "saving" ? t.saving(Math.round(saveProgress * 100)) : error ? t.saveAgain : t.save}
                </button>
              )}
              <button type="button" onClick={retry} disabled={step === "saving"} className={report.passed ? "lk-button quiet" : "lk-button primary"}>
                <RotateCcw size={15} aria-hidden="true" />
                {t.retry}
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="lk-done lk-in">
            <div className="lk-done-photo">
              <span className="lk-done-halo" aria-hidden="true" />
              <div>{stillUrls.center && <img src={stillUrls.center} alt="" />}</div>
              <span className="lk-done-check">
                <Check size={16} strokeWidth={3} aria-hidden="true" />
              </span>
            </div>
            <h2 className="lk-heading" role="status">{t.doneTitle}</h2>
            <p className="lk-lede">{t.doneBody}</p>
            {personaId && <p className="lk-next">{t.doneNext}</p>}
            <div className="lk-done-actions">
              {doneAction?.onClick ? (
                <button type="button" onClick={() => { releaseAll(); doneAction.onClick!(); }} className="lk-button primary">
                  {doneAction.label}
                </button>
              ) : doneAction?.href ? (
                <a href={doneAction.href} className="lk-button primary">
                  {doneAction.label}
                </a>
              ) : null}
              <button type="button" onClick={close} className={doneAction ? "lk-button quiet" : "lk-button primary"}>
                {doneAction ? t.doneClose : t.close}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
  return embedded ? tree : createPortal(tree, document.body);
}
