import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Circle, LoaderCircle, Mic, RotateCcw, Square, Video, X } from "lucide-react";
import { SPEECH_RATE_WPS, scriptFromBeats, type ScriptBeat } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { createReadAlongSync, normalizeWord } from "../likeness/sync";
import { createBrowserSpeechSource, createLiveSource, type TranscriptSource } from "../likeness/source";
import { languageOf } from "./languages";
import { timedWords, type Language, type Take } from "./model";
import { createTakeUploader, recordingFormat, type TakeUploader, type UploadProgress } from "./take-upload";

/**
 * The Record step: a teleprompter that follows the reader's voice while the take is recorded and uploaded.
 * The script scrolls with live transcription (Microsoft MAI-Transcribe through Humanlike's live socket), the
 * browser's own speech recognition when that is unavailable, or a steady reading pace when neither hears anything.
 */
type Phase = "setup" | "blocked" | "countdown" | "recording" | "saving" | "review";
type Follow = "live" | "browser" | "pace";
const FOLLOW_LABEL: Record<Follow, string> = { live: "Following your voice", browser: "Following your voice (browser)", pace: "Scrolling at reading pace" };
/** Seconds of speech with no word of the script recognised before the next way of following is tried. */
const SILENT_SWITCH_SECONDS = 7;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function RecordStep({
  client,
  mode,
  beats,
  language,
  target,
  liveToken,
  take,
  onTake,
  onBusy,
}: {
  client: StudioClient;
  mode: "voice" | "camera";
  beats: ScriptBeat[];
  language: Language;
  target: { campaignId: string; itemId: string; name: string };
  liveToken: (() => Promise<{ token: string; url: string }>) | null;
  take: Take | null;
  onTake: (take: Take) => void;
  onBusy: (busy: boolean) => void;
}) {
  const camera = mode === "camera";
  const script = useMemo(() => scriptFromBeats(beats), [beats]);
  const [phase, setPhase] = useState<Phase>(take ? "review" : "setup");
  const [problem, setProblem] = useState("");
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [position, setPosition] = useState(0);
  const [follow, setFollow] = useState<Follow>("pace");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const levelRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const run = useRef<{
    recorder: MediaRecorder;
    uploader: TakeUploader;
    source: TranscriptSource | null;
    startedAt: number;
    reached: Array<number | undefined>;
    lastHeard: number;
    follow: Follow;
    timer: number;
    cancelled: boolean;
  } | null>(null);
  const format = useMemo(() => recordingFormat(camera), [camera]);
  const sync = useMemo(() => createReadAlongSync(script), [script]);

  useEffect(() => onBusy(phase === "countdown" || phase === "recording" || phase === "saving"), [phase, onBusy]);

  // The camera and microphone stay open while this step is on screen, and close when it leaves.
  const openDevices = useCallback(async () => {
    if (streamRef.current) return streamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot record here. Try Chrome, Edge or Safari.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: camera ? { facingMode: "user", width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9 / 16 } } : false,
    });
    streamRef.current = stream;
    if (previewRef.current) previewRef.current.srcObject = stream;
    return stream;
  }, [camera]);

  useEffect(() => {
    if (phase !== "setup") return;
    let live = true;
    openDevices().catch((error: unknown) => {
      if (!live) return;
      setProblem(error instanceof DOMException && error.name === "NotAllowedError" ? `Allow ${camera ? "the camera and microphone" : "the microphone"} for this site, then try again.` : error instanceof Error ? error.message : "The microphone could not be opened.");
      setPhase("blocked");
    });
    return () => {
      live = false;
    };
  }, [phase, openDevices, camera]);

  useEffect(() => {
    if (previewRef.current && streamRef.current && previewRef.current.srcObject !== streamRef.current) previewRef.current.srcObject = streamRef.current;
  });

  // A level meter, drawn straight to a CSS variable so speaking never re-renders the page.
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream || !stream.getAudioTracks().length || (phase !== "setup" && phase !== "recording" && phase !== "countdown")) return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) sum += ((value - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
      levelRef.current?.style.setProperty("--level", level.toFixed(3));
      // Once every word is read there is nothing left to follow, so talking on after the script changes nothing.
      if (run.current && level > 0.12 && run.current.follow !== "pace" && sync.position < sync.words.length) {
        // Speaking with no word of the script recognised for a while: this way of following is not hearing, try the next.
        const now = performance.now();
        if (now - run.current.lastHeard > SILENT_SWITCH_SECONDS * 1000) switchFollow();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      void context.close();
    };
    // switchFollow reads refs only and the script (so `sync`) cannot change mid-take: the meter restarts only when the phase changes.
  }, [phase]);

  useEffect(
    () => () => {
      const current = run.current;
      if (current) {
        current.cancelled = true;
        current.source?.stop();
        if (current.recorder.state !== "inactive") current.recorder.stop();
        current.uploader.abort();
        clearInterval(current.timer);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  // Keep the next word a third of the way down the prompter, where the eyes rest near the lens.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const word = scroller?.querySelector<HTMLElement>(`[data-i="${Math.min(position, sync.words.length - 1)}"]`);
    if (!scroller || !word) return;
    const top = word.offsetTop - scroller.clientHeight * 0.32;
    scroller.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });

  function heard(text: string) {
    const current = run.current;
    if (!current || current.cancelled) return;
    const before = sync.position;
    const next = sync.update(text);
    if (next > before) {
      // Only words that move the prompter count as hearing the reader. Any text at all would let a recognizer that
      // hears noise, or the wrong language, hold the prompter on the first word for the whole take.
      current.lastHeard = performance.now();
      const at = (performance.now() - current.startedAt) / 1000;
      for (let index = before; index < next; index++) current.reached[index] ??= at;
    }
    setPosition(next);
  }

  function startSource(kind: Follow) {
    const current = run.current;
    if (!current) return;
    current.source?.stop();
    current.source = null;
    current.follow = kind;
    current.lastHeard = performance.now();
    setFollow(kind);
    const lang = languageOf(language).locale;
    const source = kind === "live" && liveToken ? createLiveSource({ getToken: liveToken, language, stream: streamRef.current ?? undefined }) : kind === "browser" ? createBrowserSpeechSource(lang) : null;
    if (!source) {
      if (kind !== "pace") return startSource(kind === "live" ? "browser" : "pace");
      return;
    }
    current.source = source;
    // Each new recognizer starts from an empty transcript; the sync keeps its place.
    source.start(heard, () => {
      if (run.current === current && current.follow === kind) startSource(kind === "live" ? "browser" : "pace");
    });
  }
  function switchFollow() {
    const current = run.current;
    if (!current) return;
    startSource(current.follow === "live" ? "browser" : "pace");
  }

  async function begin() {
    setProblem("");
    if (!format) {
      setProblem("This browser cannot record audio or video here. Try Chrome, Edge or Safari.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await openDevices();
    } catch {
      setPhase("blocked");
      return;
    }
    sync.reset(0);
    setPosition(0);
    setElapsed(0);
    setPhase("countdown");
    for (let n = 3; n > 0; n--) {
      setCount(n);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!streamRef.current) return;
    }
    const uploader = createTakeUploader(client, { campaignId: target.campaignId, itemId: target.itemId, kind: camera ? "avatar_clip" : "voice", mime: format.mime, name: target.name }, setProgress);
    const recorder = new MediaRecorder(stream, { mimeType: format.recorder, ...(camera ? { videoBitsPerSecond: 5_000_000 } : { audioBitsPerSecond: 128_000 }) });
    recorder.ondataavailable = (event) => uploader.push(event.data);
    const startedAt = performance.now();
    run.current = {
      recorder,
      uploader,
      source: null,
      startedAt,
      reached: [],
      lastHeard: startedAt,
      follow: "pace",
      timer: window.setInterval(() => {
        const seconds = (performance.now() - startedAt) / 1000;
        setElapsed(seconds);
        // At reading pace the prompter moves on its own; a recognizer that hears the reader overrides it.
        if (run.current?.follow === "pace") {
          const paced = Math.floor(seconds * SPEECH_RATE_WPS * 0.95);
          if (paced > sync.position) {
            sync.reset(Math.min(sync.words.length, paced));
            setPosition(sync.position);
          }
        }
      }, 200),
      cancelled: false,
    };
    setProgress({ phase: "streaming", fallback: false, recordedBytes: 0, sentBytes: 0 });
    recorder.start(1000);
    setPhase("recording");
    startSource(liveToken ? "live" : "browser");
  }

  async function stop() {
    const current = run.current;
    if (!current) return;
    clearInterval(current.timer);
    const duration = (performance.now() - current.startedAt) / 1000;
    const stopped = new Promise<void>((resolve) => current.recorder.addEventListener("stop", () => resolve(), { once: true }));
    if (current.recorder.state !== "inactive") current.recorder.stop();
    current.source?.stop();
    await stopped;
    setPhase("saving");
    try {
      const { file, blob } = await current.uploader.finish(duration);
      // Words a recognizer placed keep their times even if it later gave way to the reading pace; the rest are spread between them.
      const followed = current.reached.some((value) => value !== undefined);
      onTake({
        fileId: file.id,
        kind: camera ? "avatar_clip" : "voice",
        mime: file.mime,
        durationSeconds: file.durationSeconds ?? duration,
        words: followed ? timedWords(script, current.reached, duration) : null,
        localUrl: URL.createObjectURL(blob),
      });
      run.current = null;
      setPhase("review");
    } catch (error) {
      run.current = null;
      setProblem(error instanceof Error ? `${error.message} The recording was not saved; record it again.` : "The recording could not be saved. Record it again.");
      setPhase("setup");
    }
  }

  function cancel() {
    const current = run.current;
    if (!current) return;
    current.cancelled = true;
    clearInterval(current.timer);
    current.source?.stop();
    if (current.recorder.state !== "inactive") current.recorder.stop();
    current.uploader.abort();
    run.current = null;
    setPhase("setup");
  }

  let index = 0;
  const prompter = (
    <div className="np-prompter" ref={scrollerRef} aria-label="Script" data-follow={follow}>
      {beats.map((beat) => (
        <p key={beat.id}>
          {beat.text
            .split(/\s+/)
            .filter(Boolean)
            .map((word, wordIndex) => {
              if (!normalizeWord(word)) return <span key={wordIndex}>{word} </span>;
              const i = index++;
              return (
                <span key={wordIndex} data-i={i} data-state={i < position ? "read" : i === position && phase === "recording" ? "now" : undefined}>
                  {word}{" "}
                </span>
              );
            })}
        </p>
      ))}
    </div>
  );

  const recording = phase === "recording";
  return (
    <div className={`np-record np-record-${mode}`} data-phase={phase}>
      <div className="np-record-stage">
        {camera && phase !== "review" && <video ref={previewRef} className="np-camera" muted playsInline autoPlay aria-label="Camera preview" />}
        {!camera && phase !== "review" && (
          <div className="np-mic" ref={levelRef} aria-hidden="true">
            <Mic size={28} />
          </div>
        )}
        {phase !== "review" && prompter}
        {camera && phase !== "review" && <div className="np-level" ref={camera ? levelRef : undefined} aria-hidden="true" />}
        {phase === "countdown" && (
          <div className="np-countdown" role="status" aria-live="assertive">
            <span key={count}>{count}</span>
          </div>
        )}
        {phase === "review" && take && (
          <div className="np-review">
            {take.localUrl ? (
              camera ? <video src={take.localUrl} controls playsInline aria-label="Your recording" /> : <audio src={take.localUrl} controls aria-label="Your recording" />
            ) : (
              <p className="np-muted">Your take is saved to the project. Its playback is available in the preview.</p>
            )}
          </div>
        )}
      </div>

      <div className="np-record-bar">
        {phase === "setup" && (
          <>
            <button type="button" className="np-rec-button" onClick={() => void begin()} aria-label="Start recording">
              <Circle size={22} fill="currentColor" aria-hidden="true" />
            </button>
            <div className="np-record-copy">
              <strong>{camera ? "Record yourself on camera" : "Record your voice"}</strong>
              <span>Read at your own pace; the script follows your voice. A 3-second countdown starts first.</span>
            </div>
          </>
        )}
        {phase === "blocked" && (
          <div className="np-record-copy">
            <strong>{camera ? "The camera is not available" : "The microphone is not available"}</strong>
            <span>{problem}</span>
            <button type="button" className="button secondary" onClick={() => setPhase("setup")}>
              Try again
            </button>
          </div>
        )}
        {(phase === "recording" || phase === "countdown") && (
          <>
            <button type="button" className="np-rec-button np-rec-stop" onClick={() => void stop()} disabled={!recording} aria-label="Stop recording">
              <Square size={18} fill="currentColor" aria-hidden="true" />
            </button>
            <div className="np-record-copy">
              <strong className="np-timer">
                <span className="np-rec-dot" aria-hidden="true" />
                {clock(elapsed)}
              </strong>
              <span>
                {FOLLOW_LABEL[follow]}
                {progress && progress.sentBytes > 0 && !progress.fallback ? ` · ${megabytes(progress.sentBytes)} saved as you speak` : ""}
              </span>
            </div>
            <button type="button" className="icon-button" onClick={cancel} aria-label="Cancel this take" title="Cancel this take">
              <X size={16} />
            </button>
          </>
        )}
        {phase === "saving" && (
          <div className="np-record-copy" role="status">
            <strong>
              <LoaderCircle size={15} className="spin" aria-hidden="true" /> Saving your take…
            </strong>
            <span>{progress?.fallback ? `Uploading ${megabytes(progress.recordedBytes)} in one piece.` : "Sending the last part."}</span>
          </div>
        )}
        {phase === "review" && take && (
          <>
            <span className="np-saved">
              <Check size={15} aria-hidden="true" />
            </span>
            <div className="np-record-copy">
              <strong>Take saved · {clock(take.durationSeconds)}</strong>
              <span>{take.words ? "Captions are timed to how you read it." : "Captions are spread evenly across the take."} Use it, or record again.</span>
            </div>
            <button type="button" className="button secondary" onClick={() => setPhase("setup")}>
              <RotateCcw size={14} aria-hidden="true" />
              Record again
            </button>
          </>
        )}
        {problem && phase === "setup" && (
          <p className="np-error" role="alert">
            {problem}
          </p>
        )}
      </div>
      {phase === "setup" && (
        <p className="np-hint">
          {camera ? <Video size={13} aria-hidden="true" /> : <Mic size={13} aria-hidden="true" />}
          {camera ? "Hold the phone or laptop at eye level; the words sit near the camera so you can read and look at the lens." : "A quiet room works best; the take becomes the video’s voice."}
        </p>
      )}
    </div>
  );
}
