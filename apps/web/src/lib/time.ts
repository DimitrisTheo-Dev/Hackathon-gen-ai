/**
 * Wall-clock time ↔ exact instant for the schedule inputs, using the platform's own time zone
 * database (Intl). This replaces a ~75 kB date polyfill that used to ship in the studio chunk
 * for two small functions; the behaviour is unchanged and covered by tests/editor-time.test.ts.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formatters.set(timezone, format);
  }
  return format;
}
/** "YYYY-MM-DDTHH:mm" as shown on a clock in `timezone` at that instant. */
function wallClock(epochMs: number, timezone: string): string {
  const parts: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(new Date(epochMs))) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function asUtc(local: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new RangeError("Use a date and time such as 2026-11-16T09:00.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const value = Date.UTC(year, month - 1, day, hour, minute);
  // Reject impossible calendar values (month 13, 30 February) instead of letting them roll over.
  if (new Date(value).toISOString().slice(0, 16) !== local) throw new RangeError("That date does not exist.");
  return value;
}

export function localInput(iso: string, timezone: string): string {
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs)) throw new RangeError("Invalid instant.");
  return wallClock(epochMs, timezone);
}

/**
 * The single instant at which a clock in `timezone` shows `local`.
 * Throws when that wall time never happens (clocks skip forward) or happens twice (clocks fall back):
 * a schedule must name one exact moment, so the person is asked to choose a different time.
 */
export function exactInstant(local: string, timezone: string): string {
  const wanted = asUtc(local);
  // The zone's offset a day either side covers both sides of any daylight-saving change.
  const candidates = new Set<number>();
  for (const probe of [wanted - 86_400_000, wanted + 86_400_000]) {
    const offset = asUtc(wallClock(probe, timezone)) - probe;
    const instant = wanted - offset;
    if (wallClock(instant, timezone) === local) candidates.add(instant);
  }
  if (candidates.size !== 1) throw new RangeError(candidates.size ? "That time happens twice when the clocks change. Choose another time." : "That time is skipped when the clocks change. Choose another time.");
  return new Date([...candidates][0]).toISOString().replace(".000Z", "Z");
}
