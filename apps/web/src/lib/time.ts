import { Temporal } from "@js-temporal/polyfill";
export function localInput(iso: string, timezone: string): string {
  return Temporal.Instant.from(iso)
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}
export function exactInstant(local: string, timezone: string): string {
  const value = Temporal.PlainDateTime.from(local);
  return value
    .toZonedDateTime(timezone, { disambiguation: "reject" })
    .toInstant()
    .toString();
}
