import { useState, type FormEvent } from "react";
import { Archive, ExternalLink, FilePlus2, LoaderCircle, Plus, Upload } from "lucide-react";
import { FILE_KINDS, FILE_MIMES, type DraftFile, type FileKind } from "@castroom/contracts";
import { timeLabel } from "./model";
import { audioDuration, guessKind, mimeOf, mp4Duration, sha256Hex } from "./upload";

export const KIND_LABELS: Record<FileKind, string> = {
  script: "Script",
  facts: "Facts and sources",
  voice: "Voice takes",
  transcript: "Word transcripts",
  avatar_clip: "Avatar clips",
  video: "Video",
  image: "Images and icons",
  music: "Music",
  sfx: "Sound effects",
  captions: "Captions",
  cut_list: "Cut lists",
  render: "Renders",
  other: "Other",
};
export type FileAction =
  | { kind: "audio"; role: "voice" | "music" | "sfx" }
  | { kind: "video"; layer: 0 | 1 }
  | { kind: "image"; target: "overlay" | "statement" }
  | { kind: "transcript" };

function size(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
function actionsFor(file: DraftFile): Array<{ label: string; action: FileAction }> {
  if (file.state !== "ready") return [];
  if (file.mime.startsWith("audio/")) {
    const preferred = file.kind === "music" ? "music" : file.kind === "sfx" ? "sfx" : "voice";
    const roles: Array<"voice" | "music" | "sfx"> = [preferred, ...(["voice", "music", "sfx"] as const).filter((role) => role !== preferred)];
    return roles.map((role) => ({ label: `Add as ${role === "sfx" ? "SFX" : role}`, action: { kind: "audio", role } }));
  }
  if (file.mime.startsWith("video/")) return [{ label: "Add as main picture", action: { kind: "video", layer: 0 } }, { label: "Add as overlay", action: { kind: "video", layer: 1 } }];
  if (file.mime.startsWith("image/")) return [{ label: "Add as overlay", action: { kind: "image", target: "overlay" } }, { label: "Add a statement card with it", action: { kind: "image", target: "statement" } }];
  if (file.mime === "application/json" && (file.kind === "transcript" || file.kind === "other")) return [{ label: "Use as transcript", action: { kind: "transcript" } }];
  return [];
}

export interface UploadRequest {
  file: File;
  kind: FileKind;
  name: string;
  mime: string;
  sha256: string;
  bytes: number;
  durationSeconds: number | null;
}

/** Every component of the reel as its own draft: upload media, write text drafts, add any of them to the timeline. */
export function FilesPanel({
  files,
  loading,
  canEdit,
  itemTitle,
  onUpload,
  onSaveText,
  onArchive,
  onUse,
  onRefresh,
}: {
  files: DraftFile[];
  loading: boolean;
  canEdit: boolean;
  itemTitle: string;
  onUpload: (request: UploadRequest) => Promise<void>;
  onSaveText: (input: { kind: FileKind; name: string; mime: "text/markdown" | "text/plain" | "application/json"; text: string }) => Promise<void>;
  onArchive: (file: DraftFile) => Promise<void>;
  onUse: (file: DraftFile, action: FileAction) => void;
  onRefresh: () => void;
}) {
  const [picked, setPicked] = useState<File | null>(null);
  const [kind, setKind] = useState<FileKind>("voice");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"upload" | "text" | null>(null);
  const [problem, setProblem] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [textKind, setTextKind] = useState<FileKind>("script");
  const [textName, setTextName] = useState("");
  const [textFormat, setTextFormat] = useState<"text/markdown" | "text/plain" | "application/json">("text/markdown");
  const [text, setText] = useState("");

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!picked || busy) return;
    const mime = mimeOf(picked);
    if (!FILE_MIMES[kind].includes(mime)) {
      setProblem(`${KIND_LABELS[kind]} cannot hold a ${mime} file. Pick another kind or file.`);
      return;
    }
    setBusy("upload");
    setProblem("");
    try {
      const bytes = await picked.arrayBuffer();
      const durationSeconds = mime.startsWith("video/") ? mp4Duration(bytes) : mime.startsWith("audio/") ? await audioDuration(bytes) : null;
      await onUpload({ file: picked, kind, name: name.trim() || picked.name.replace(/\.[^.]+$/, "").slice(0, 160), mime, sha256: await sha256Hex(bytes), bytes: bytes.byteLength, durationSeconds });
      setPicked(null);
      setName("");
      (event.target as HTMLFormElement).reset();
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : "The file could not be uploaded.");
    } finally {
      setBusy(null);
    }
  }
  async function saveText(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || !textName.trim() || busy) return;
    setBusy("text");
    setProblem("");
    try {
      await onSaveText({ kind: textKind, name: textName.trim(), mime: textFormat, text });
      setText("");
      setTextOpen(false);
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : "The draft could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  const groups = FILE_KINDS.map((entry) => ({ kind: entry, files: files.filter((file) => file.kind === entry) })).filter((group) => group.files.length);
  return (
    <div className="video-panel">
      <div className="video-panel-head">
        <p>Every part of the reel is kept as its own draft: script, facts, voice takes, avatar clips, music, sound effects, images, transcripts and renders. Agents add files here too.</p>
        <button className="text-button" onClick={onRefresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </div>
      {canEdit && (
        <>
          <form className="upload-form" onSubmit={(event) => void upload(event)}>
            <input
              type="file"
              aria-label="File to upload"
              accept="audio/*,video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp,.md,.txt,.json,.vtt,.srt"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setPicked(file);
                if (file) setKind(guessKind(file));
              }}
            />
            <select aria-label="Kind of draft" value={kind} onChange={(event) => setKind(event.target.value as FileKind)}>
              {FILE_KINDS.filter((entry) => entry !== "render").map((entry) => <option key={entry} value={entry}>{KIND_LABELS[entry]}</option>)}
            </select>
            <input aria-label="Draft name" placeholder="Name (optional)" value={name} maxLength={160} onChange={(event) => setName(event.target.value)} />
            <button className="button secondary" disabled={!picked || busy !== null}>{busy === "upload" ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />}{busy === "upload" ? "Uploading…" : "Upload"}</button>
          </form>
          <button className="text-button" onClick={() => setTextOpen(!textOpen)} aria-expanded={textOpen}><FilePlus2 size={13} />Write a text draft</button>
          {textOpen && (
            <form className="text-draft-form" onSubmit={(event) => void saveText(event)}>
              <div className="clip-fields">
                <select aria-label="Kind of text draft" value={textKind} onChange={(event) => setTextKind(event.target.value as FileKind)}>
                  {(["script", "facts", "captions", "cut_list", "transcript", "other"] as FileKind[]).map((entry) => <option key={entry} value={entry}>{KIND_LABELS[entry]}</option>)}
                </select>
                <select aria-label="Format" value={textFormat} onChange={(event) => setTextFormat(event.target.value as typeof textFormat)}>
                  <option value="text/markdown">Markdown</option>
                  <option value="text/plain">Plain text</option>
                  <option value="application/json">JSON</option>
                </select>
                <input aria-label="Text draft name" placeholder={`e.g. ${itemTitle} facts`} value={textName} maxLength={160} onChange={(event) => setTextName(event.target.value)} />
              </div>
              <textarea aria-label="Text" rows={8} value={text} maxLength={200_000} onChange={(event) => setText(event.target.value)} placeholder="Write the script, the facts with their sources, or paste a word transcript." />
              <button className="button secondary" disabled={!text.trim() || !textName.trim() || busy !== null}>{busy === "text" ? "Saving…" : "Save text draft"}</button>
            </form>
          )}
        </>
      )}
      {problem && <p className="field-error" role="alert">{problem}</p>}
      {!groups.length && !loading && <p className="video-empty-line">No draft files yet.</p>}
      {groups.map((group) => (
        <section key={group.kind} className="file-group">
          <h3>{KIND_LABELS[group.kind]}</h3>
          <ul className="file-list">
            {group.files.map((file) => (
              <li key={file.id} className="file-row">
                <div className="file-main">
                  <strong>{file.name}</strong>
                  <small>
                    v{file.version} · {size(file.bytes)}
                    {file.durationSeconds ? ` · ${timeLabel(file.durationSeconds)}` : ""} · {file.createdBy}
                    {file.state === "pending" ? " · upload not finished" : ""}
                    {file.state === "ready" && !file.url ? " · not playable in this tab" : ""}
                  </small>
                </div>
                <div className="file-actions">
                  {canEdit && actionsFor(file).map(({ label, action }) => (
                    <button key={label} className="text-button" onClick={() => onUse(file, action)} disabled={!file.url}><Plus size={12} />{label}</button>
                  ))}
                  {file.url && <a className="text-button" href={file.url} target="_blank" rel="noreferrer"><ExternalLink size={12} />Open</a>}
                  {canEdit && (
                    <button className="icon-button" aria-label={`Archive ${file.name}`} title="Archive" onClick={() => void onArchive(file)}><Archive size={14} /></button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
