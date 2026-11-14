import type { FileKind, UploadTicket } from "@castroom/contracts";
import { FIXTURE_UPLOAD_PREFIX, registerFixtureUpload } from "../data/fixture-uploads";

/** Browser-side helpers for draft-file uploads: checksum, duration and the direct PUT to storage. */
export async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads the duration from an MP4/MOV `mvhd` box, without loading the video into a media element. */
export function mp4Duration(bytes: ArrayBuffer): number | null {
  const view = new DataView(bytes);
  const data = new Uint8Array(bytes);
  for (let i = 4; i < data.length - 32; i++) {
    if (data[i] !== 0x6d || data[i + 1] !== 0x76 || data[i + 2] !== 0x68 || data[i + 3] !== 0x64) continue;
    const version = data[i + 4];
    const timescale = version === 1 ? view.getUint32(i + 24) : view.getUint32(i + 16);
    const duration = version === 1 ? Number(view.getBigUint64(i + 28)) : view.getUint32(i + 20);
    if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 100) / 100;
  }
  return null;
}

/** Audio duration by decoding (works under the studio's content policy, which blocks blob: media). */
export async function audioDuration(bytes: ArrayBuffer): Promise<number | null> {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0));
    return Math.round(decoded.duration * 100) / 100;
  } catch {
    return null;
  } finally {
    void context.close();
  }
}

export function guessKind(file: File): FileKind {
  if (file.type.startsWith("audio/")) return "voice";
  if (file.type.startsWith("video/")) return "avatar_clip";
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/json" || file.name.endsWith(".json")) return "transcript";
  if (file.name.endsWith(".vtt") || file.name.endsWith(".srt")) return "captions";
  return "script";
}

/** The MIME type the server accepts for a file the browser could not type (common for .md, .srt, .m4a). */
export function mimeOf(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = { md: "text/markdown", txt: "text/plain", json: "application/json", vtt: "text/vtt", srt: "application/x-subrip", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  if (file.type && file.type !== "application/octet-stream") return file.type === "audio/x-m4a" ? "audio/mp4" : file.type;
  return byExt[ext] ?? "application/octet-stream";
}

/** PUTs the bytes exactly as the ticket says. Storage refuses any body whose SHA-256 differs from the declared one. */
export async function putToStorage(ticket: UploadTicket, file: Blob) {
  if (!ticket.upload) return;
  if (ticket.upload.url.startsWith(FIXTURE_UPLOAD_PREFIX)) {
    registerFixtureUpload(ticket.upload.url, file);
    return;
  }
  const response = await fetch(ticket.upload.url, { method: "PUT", headers: ticket.upload.headers, body: file, credentials: "omit", mode: "cors" });
  if (!response.ok) throw new Error(`The file could not be uploaded (${response.status}). Nothing was saved; try again.`);
}
