import { useEffect, useState, type ReactNode } from "react";
import { forgetMedia, stableMedia } from "../lib/media-url";
import { SurfaceDialog } from "./SurfaceDialog";
import {
  X,
  Copy,
  Check,
  Video,
  Image,
  Type,
  Instagram,
  Youtube,
  Music2,
  CircleAlert,
} from "lucide-react";
import type { ContentItem, Platform } from "@castroom/contracts";

export const platformNames: Record<Platform, string> = {
  instagram: "Instagram Reels",
  tiktok: "TikTok",
  youtube: "YouTube Shorts",
};
export function PlatformIcon({ platform }: { platform: Platform }) {
  const Icon =
    platform === "instagram"
      ? Instagram
      : platform === "youtube"
        ? Youtube
        : Music2;
  return <Icon size={14} aria-hidden="true" />;
}
export function Mark() {
  return (
    <span className="castroom-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
export function CopyButton({
  value,
  label = "Copy",
  disabled = false,
}: {
  value: string;
  label?: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState("idle");
  return (
    <button
      className="button secondary"
      disabled={disabled}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? <Check size={15} /> : <Copy size={15} />}
      <span>
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Select and copy manually"
            : label}
      </span>
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  animateEntry = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  animateEntry?: boolean;
}) {
  return (
    <SurfaceDialog title={title} className={`modal ${wide ? "wide" : ""} ${animateEntry ? "" : "instant"}`} animateEntry={animateEntry} onClose={onClose}>
      {({ close, grip }) => <>
      {grip}
      <header className="modal-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          data-surface-focus
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={19} />
        </button>
      </header>
      <div className="modal-content">{children}</div>
      </>}
    </SurfaceDialog>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : undefined}
    >
      <CircleAlert size={16} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
export function dateLabel(instant: string, timezone: string, full = false) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: full ? "long" : "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(instant));
}
export function Preview({
  item,
  index = 0,
  compact = false,
  passive = false,
  brandName = "Faceful",
}: {
  item: ContentItem;
  index?: number;
  compact?: boolean;
  passive?: boolean;
  brandName?: string;
}) {
  // The src that failed to play. Compared by URL, so a fresh URL for the same media gets one more try.
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setFailed(null), [item.media?.id]);
  const media = item.media;
  // Polling returns a new signed URL on some reads; the player keeps one per media id so playback is never reset.
  let playable = media ? stableMedia(media) : null;
  if (media && playable && failed === playable.url && media.url !== playable.url) {
    // The remembered URL failed and the server has since issued a different one: try that.
    forgetMedia(media.id);
    playable = stableMedia(media);
  }
  const expired = playable?.expiresAt != null && playable.expiresAt <= Date.now();
  if (media && playable && !expired && failed !== playable.url)
    return (
      <div className="video-wrap">
        <video
          key={media.id}
          controls={!passive}
          tabIndex={passive ? -1 : undefined}
          playsInline
          preload="metadata"
          src={playable.url}
          onError={() => {
            forgetMedia(media.id);
            setFailed(playable.url);
          }}
          aria-label={`${item.title} video preview`}
        />
        {item.renderRevision === null && (
          <span className="stale-label">
            Previous render · regeneration needed
          </span>
        )}
      </div>
    );
  const Icon =
    item.kind === "image" ? Image : item.kind === "text" ? Type : Video;
  return (
    <div className={`poster poster-${index % 3} ${compact ? "compact" : ""}`}>
      <span className="poster-brand">
        {brandName} <span>stories</span>
      </span>
      <div className="poster-title">{item.title}</div>
      <div className="poster-bottom">
        <Icon size={15} />
        <span>
          {expired
            ? "Preview expired"
            : failed
              ? "Preview unavailable"
              : item.kind === "avatar_video"
                ? "No video yet"
                : "Draft preview"}
        </span>
      </div>
    </div>
  );
}
