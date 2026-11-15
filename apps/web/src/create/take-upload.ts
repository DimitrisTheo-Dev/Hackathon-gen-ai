import { TAKE_PART_BYTES, type DraftFile, type TAKE_MIMES, type TakeUpload } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { FIXTURE_UPLOAD_PREFIX, registerFixturePart } from "../data/fixture-uploads";
import { putToStorage, sha256Hex } from "../video/upload";

/**
 * Streams a recording to storage while it is being made. MediaRecorder hands over a chunk every second; chunks
 * are grouped into fixed 8 MB parts and each part is sent as soon as it is full, two at a time. When the person
 * stops, only the last part is left, so the take is stored a moment later.
 *
 * Any part that still fails after retries (a dropped connection, storage that hides the ETag header from the
 * browser) switches to the ordinary single upload of the whole take after it stops. Every byte stays in this tab
 * until the take is saved, so nothing is lost either way.
 */
export interface TakeTarget {
  campaignId: string;
  itemId: string;
  kind: "voice" | "avatar_clip";
  /** The base type the server accepts (no codecs parameter). */
  mime: TakeMime;
  name: string;
}
export interface UploadProgress {
  phase: "streaming" | "finishing" | "saved" | "failed";
  /** True once streaming was given up for a single upload at the end. */
  fallback: boolean;
  recordedBytes: number;
  sentBytes: number;
}
export interface TakeUploader {
  push(chunk: Blob): void;
  /** Uploads what is left, joins the parts and returns the saved draft file. */
  finish(durationSeconds: number): Promise<{ file: DraftFile; blob: Blob }>;
  /** Drops the recording: the parts already sent are deleted. */
  abort(): void;
}

type TakeMime = (typeof TAKE_MIMES)[number];
const PARALLEL = 2;
const RETRIES = 3;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTakeUploader(client: StudioClient, target: TakeTarget, onProgress: (progress: UploadProgress) => void): TakeUploader {
  const chunks: Blob[] = [];
  let buffer: Blob = new Blob([]);
  let nextPart = 1;
  let recordedBytes = 0;
  let sentBytes = 0;
  let fallback = false;
  let aborted = false;
  let phase: UploadProgress["phase"] = "streaming";
  const etags = new Map<number, string>();
  const queue: Array<{ partNumber: number; blob: Blob }> = [];
  const running = new Set<Promise<void>>();
  const emit = () => onProgress({ phase, fallback, recordedBytes, sentBytes });

  const started: Promise<TakeUpload | null> = client.startTake({ ...target, operationKey: crypto.randomUUID() }).catch(() => {
    fallback = true;
    emit();
    return null;
  });

  async function send(partNumber: number, blob: Blob) {
    const upload = await started;
    if (!upload || fallback || aborted) return;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const link = await client.takePartUrl({ fileId: upload.fileId, partNumber, bytes: blob.size });
        let etag: string | null;
        if (link.url.startsWith(FIXTURE_UPLOAD_PREFIX)) etag = registerFixturePart(link.url, blob);
        else {
          const response = await fetch(link.url, { method: "PUT", headers: link.headers, body: blob, credentials: "omit", mode: "cors" });
          if (!response.ok) throw new Error(`Part ${partNumber} was refused (${response.status}).`);
          // Readable only when the bucket's CORS rules expose ETag.
          etag = response.headers.get("ETag");
        }
        if (!etag) throw new Error("Storage did not return the part's receipt.");
        etags.set(partNumber, etag);
        sentBytes += blob.size;
        emit();
        return;
      } catch {
        if (aborted) return;
        await pause(400 * 2 ** attempt);
      }
    }
    fallback = true;
    emit();
  }

  function pump() {
    while (running.size < PARALLEL && queue.length) {
      const next = queue.shift()!;
      const task = send(next.partNumber, next.blob).finally(() => {
        running.delete(task);
        pump();
      });
      running.add(task);
    }
  }

  function cut(final: boolean) {
    while (!fallback && (buffer.size >= TAKE_PART_BYTES || (final && buffer.size > 0))) {
      const size = Math.min(TAKE_PART_BYTES, buffer.size);
      queue.push({ partNumber: nextPart++, blob: buffer.slice(0, size) });
      buffer = buffer.slice(size);
    }
    pump();
  }

  async function drain() {
    while (running.size || queue.length) {
      pump();
      await Promise.all(running);
    }
  }

  return {
    push(chunk) {
      if (aborted || !chunk.size) return;
      chunks.push(chunk);
      recordedBytes += chunk.size;
      if (!fallback) {
        buffer = new Blob([buffer, chunk]);
        cut(false);
      }
      emit();
    },
    async finish(durationSeconds) {
      phase = "finishing";
      emit();
      cut(true);
      await drain();
      const blob = new Blob(chunks, { type: target.mime });
      const sha256 = await sha256Hex(await blob.arrayBuffer());
      const upload = await started;
      const duration = Math.max(0.1, Math.round(durationSeconds * 100) / 100);
      try {
        if (upload && !fallback && etags.size === nextPart - 1 && etags.size > 0) {
          try {
            const parts = [...etags].map(([partNumber, etag]) => ({ partNumber, etag }));
            const file = await client.completeTake({ fileId: upload.fileId, parts, bytes: blob.size, sha256, durationSeconds: duration, operationKey: crypto.randomUUID() });
            phase = "saved";
            emit();
            return { file, blob };
          } catch {
            fallback = true;
          }
        }
        // The single upload of the whole take, the way any draft file is added.
        if (upload) void client.abortTake({ fileId: upload.fileId }).catch(() => undefined);
        fallback = true;
        emit();
        const ticket = await client.requestUpload({ campaignId: target.campaignId, itemId: target.itemId, kind: target.kind, name: target.name, mime: target.mime, bytes: blob.size, sha256, durationSeconds: duration, meta: { source: "recorded in the studio" }, operationKey: crypto.randomUUID() });
        await putToStorage(ticket, blob);
        const file = ticket.upload ? await client.completeUpload({ fileId: ticket.file.id, operationKey: crypto.randomUUID() }) : ticket.file;
        sentBytes = blob.size;
        phase = "saved";
        emit();
        return { file, blob };
      } catch (error) {
        phase = "failed";
        emit();
        throw error;
      }
    },
    abort() {
      aborted = true;
      queue.length = 0;
      void started.then((upload) => (upload ? client.abortTake({ fileId: upload.fileId }) : undefined)).catch(() => undefined);
    },
  };
}

/** The best recording format this browser offers, and the base type the server stores it as. */
export function recordingFormat(camera: boolean): { recorder: string; mime: TakeMime } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const options: Array<[string, TakeMime]> = camera
    ? [
        ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"],
        ["video/webm;codecs=vp9,opus", "video/webm"],
        ["video/webm;codecs=vp8,opus", "video/webm"],
        ["video/webm", "video/webm"],
        ["video/mp4", "video/mp4"],
      ]
    : [
        ["audio/webm;codecs=opus", "audio/webm"],
        ["audio/mp4", "audio/mp4"],
        ["audio/ogg;codecs=opus", "audio/ogg"],
      ];
  const found = options.find(([type]) => MediaRecorder.isTypeSupported(type));
  return found ? { recorder: found[0], mime: found[1] } : null;
}
