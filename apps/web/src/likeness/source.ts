/**
 * Where the running transcript comes from. The read-along only needs "the whole transcript so far", so any
 * live speech-to-text works through the same interface: Humanlike's live transcription socket, or the
 * browser's own recognizer when that is unavailable.
 */
// `no-inline` matters: a small file would otherwise become a data: URL, which the page's script policy refuses.
import pcmWorkletUrl from "./pcm-worklet.js?url&no-inline";

export interface TranscriptSource {
  start(onTranscript: (text: string) => void, onError: (message: string) => void): void;
  stop(): void;
  /** Stops and resolves with the final text (the live socket sends a corrected final after stop). */
  finish?(): Promise<string>;
}

/**
 * Live transcription: streams the microphone to Humanlike's `/transcribe/live` socket as int16 PCM and gets
 * the whole text so far back as it is revised. `getToken` asks the engine for a single-use token and the
 * socket URL (signed-in people only), so no key ever reaches the browser. Pass `stream` to reuse a microphone
 * already open (a recording in progress); otherwise one is opened and closed with the source.
 */
export function createLiveSource(options: { getToken: () => Promise<{ token: string; url: string }>; language?: string; stream?: MediaStream }): TranscriptSource {
  let ws: WebSocket | null = null;
  let ctx: AudioContext | null = null;
  let ownStream: MediaStream | null = null;
  let latest = "";
  let stopped = false;
  let finalResolve: ((text: string) => void) | null = null;
  const finalText = new Promise<string>((resolve) => {
    finalResolve = resolve;
  });
  const pending: ArrayBuffer[] = [];

  const closeAudio = () => {
    ctx?.close().catch(() => {});
    ctx = null;
    ownStream?.getTracks().forEach((track) => track.stop());
    ownStream = null;
  };

  const source: TranscriptSource = {
    start(onTranscript, onError) {
      stopped = false;
      (async () => {
        const stream = options.stream ?? (ownStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }));
        const audio = (ctx = new AudioContext());
        await audio.audioWorklet.addModule(pcmWorkletUrl);
        const auth = await options.getToken();
        if (stopped) return;
        const language = (options.language || "auto").split("-")[0];
        const socket = (ws = new WebSocket(`${auth.url}?token=${encodeURIComponent(auth.token)}&rate=${audio.sampleRate}&language=${encodeURIComponent(language)}`));
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          for (const chunk of pending.splice(0)) socket.send(chunk);
        };
        socket.onmessage = (event) => {
          let message: { type?: string; text?: string; error?: string };
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (message.type === "partial" || message.type === "final") {
            latest = message.text ?? latest;
            onTranscript(latest);
            if (message.type === "final") finalResolve?.(latest);
          } else if (message.type === "error") {
            finalResolve?.(latest);
            if (!stopped) onError(message.error || "Live transcription failed");
          }
        };
        socket.onclose = () => finalResolve?.(latest);
        socket.onerror = () => {
          if (!stopped) onError("Live transcription disconnected");
        };
        const input = audio.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(audio, "pcm-int16");
        node.port.onmessage = (event) => {
          if (stopped) return;
          if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
          else if (pending.length < 200) pending.push(event.data);
        };
        // The graph must reach the destination to run; a silent gain keeps the microphone out of the speakers.
        const mute = audio.createGain();
        mute.gain.value = 0;
        input.connect(node).connect(mute).connect(audio.destination);
      })().catch((error) => {
        closeAudio();
        if (!stopped) onError(error?.name === "NotAllowedError" ? "Microphone permission was denied." : error?.message || "Live transcription is unavailable");
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      closeAudio();
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      else {
        ws?.close();
        finalResolve?.(latest);
      }
      // The final arrives within a second or two; never hang on it.
      setTimeout(() => {
        finalResolve?.(latest);
        ws?.close();
      }, 6000);
    },
    finish() {
      source.stop();
      return finalText;
    },
  };
  return source;
}

export type LiveHealth = "ok" | "dead" | "unknown";

/**
 * Asks the live service whether it can transcribe at all, before anyone is asked to read: half a second of
 * silence, then "stop". The service reports a provider failure only when asked for the final text, so
 * without this a dead service looks exactly like a person who has not started speaking, and their first
 * words are lost. "unknown" (no clear answer in time) is treated as worth trying.
 */
export async function probeLive(getToken: () => Promise<{ token: string; url: string }>, timeoutMs = 6000): Promise<LiveHealth> {
  let auth: { token: string; url: string };
  try {
    auth = await getToken();
  } catch {
    // Not connected on this deployment, or out of tokens for now: either way it cannot be used this time.
    return "dead";
  }
  return new Promise<LiveHealth>((resolve) => {
    const rate = 16000;
    const socket = new WebSocket(`${auth.url}?token=${encodeURIComponent(auth.token)}&rate=${rate}&language=auto`);
    let settled = false;
    const done = (health: LiveHealth) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(health);
    };
    const timer = setTimeout(() => done("unknown"), timeoutMs);
    socket.onopen = () => {
      socket.send(new Int16Array(rate / 2).buffer);
      socket.send(JSON.stringify({ type: "stop" }));
    };
    socket.onmessage = (event) => {
      let message: { type?: string };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "final") done("ok");
      else if (message.type === "error") done("dead");
    };
    socket.onerror = () => done("dead");
    socket.onclose = () => done("unknown");
  });
}

// The Web Speech API is not in TypeScript's DOM library; only what is used here is described.
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

/** Browser speech recognition (Chrome, Edge, Safari). Restarts itself when the browser ends a session. */
export function createBrowserSpeechSource(lang: string): TranscriptSource | null {
  const scope = typeof window === "undefined" ? undefined : (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor });
  const Ctor = scope?.SpeechRecognition ?? scope?.webkitSpeechRecognition;
  if (!Ctor) return null;
  let recognition: Recognition | null = null;
  let wanted = false;
  // The browser ends a session after a pause or about a minute, and the next one starts with empty results.
  // What earlier sessions heard is kept here, so the transcript only ever grows.
  let earlier = "";
  let latest = "";
  return {
    start(onTranscript, onError) {
      wanted = true;
      const open = () => {
        earlier = `${earlier} ${latest}`.trim();
        latest = "";
        const current = (recognition = new Ctor());
        current.lang = lang;
        current.continuous = true;
        current.interimResults = true;
        current.onresult = (event) => {
          let text = "";
          for (let i = 0; i < event.results.length; i++) text += `${event.results[i][0].transcript} `;
          latest = text.trim();
          onTranscript(`${earlier} ${latest}`.trim());
        };
        current.onerror = (event) => {
          if (event.error === "no-speech" || event.error === "aborted") return;
          wanted = false;
          onError(event.error === "not-allowed" ? "Microphone permission was denied." : `Speech recognition error: ${event.error}`);
        };
        current.onend = () => {
          if (wanted) open();
        };
        current.start();
      };
      open();
    },
    stop() {
      wanted = false;
      recognition?.stop();
      recognition = null;
    },
  };
}
