import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby={id}
      onClose={onClose}
    >
      <header className="modal-header">
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          autoFocus
          aria-label="Close dialog"
          onClick={() => ref.current?.close()}
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
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
  brandName = "Castroom",
}: {
  item: ContentItem;
  index?: number;
  compact?: boolean;
  passive?: boolean;
  brandName?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.media?.url]);
  const expired =
    item.media?.expiresAt &&
    new Date(item.media.expiresAt).getTime() <= Date.now();
  if (item.media && !expired && !failed)
    return (
      <div className="video-wrap">
        <video
          key={item.media.id}
          controls={!passive}
          tabIndex={passive ? -1 : undefined}
          playsInline
          preload="metadata"
          src={item.media.url}
          onError={() => setFailed(true)}
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
      <div className="poster-art" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="poster-title">{item.title}</div>
      <div className="poster-bottom">
        <Icon size={15} />
        <span>
          {expired
            ? "Preview expired"
            : failed
              ? "Preview unavailable"
              : item.kind === "avatar_video"
                ? "Storyboard · no video yet"
                : "Draft preview"}
        </span>
      </div>
    </div>
  );
}
