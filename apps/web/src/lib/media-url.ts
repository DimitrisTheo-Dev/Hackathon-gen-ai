/**
 * Signed playback URLs for the same media can differ between reads. Swapping a <video> src
 * restarts playback, so the player keeps the first URL it was given for a media id and only
 * takes a new one when that URL has expired or failed to play.
 */
type Remembered = { url: string; expiresAt: number | null };
const remembered = new Map<string, Remembered>();

export function stableMedia(media: { id: string; url: string; expiresAt: string | null }, now = Date.now()): Remembered {
  const known = remembered.get(media.id);
  if (known && (known.expiresAt === null || known.expiresAt > now)) return known;
  const parsed = media.expiresAt ? Date.parse(media.expiresAt) : null;
  const next = { url: media.url, expiresAt: parsed !== null && Number.isFinite(parsed) ? parsed : null };
  remembered.set(media.id, next);
  return next;
}

/** Drop a URL that failed to play, so the next read can supply a fresh one. */
export function forgetMedia(id: string) {
  remembered.delete(id);
}
