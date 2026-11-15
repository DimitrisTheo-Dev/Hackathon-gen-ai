/**
 * Development uploads: the fixture transport has no storage service, so an uploaded file lives as an
 * object URL in this tab only. Kept apart from fixture.ts so production code can recognise a fixture
 * ticket without bundling the fixture itself. Nothing here leaves the browser.
 */
export const FIXTURE_UPLOAD_PREFIX = "fixture-upload:";
export const fixtureBlobs = new Map<string, string>();
export function registerFixtureUpload(url: string, blob: Blob) {
  if (!url.startsWith(FIXTURE_UPLOAD_PREFIX) || typeof URL.createObjectURL !== "function") return false;
  fixtureBlobs.set(url.slice(FIXTURE_UPLOAD_PREFIX.length), URL.createObjectURL(blob));
  return true;
}

/** Development recordings: each part of a take PUT to a fixture link is kept here until the take is finished. */
const fixtureParts = new Map<string, Map<number, Blob>>();
/** Fixture part links look like `fixture-upload:part:<fileId>:<partNumber>`. Returns the part's ETag. */
export function registerFixturePart(url: string, blob: Blob): string | null {
  const match = url.match(/^fixture-upload:part:([^:]+):(\d+)$/);
  if (!match) return null;
  const parts = fixtureParts.get(match[1]) ?? new Map<number, Blob>();
  parts.set(Number(match[2]), blob);
  fixtureParts.set(match[1], parts);
  return `"fixture-${match[2]}"`;
}
/** Joins a finished development take into one object URL. Returns its size, or null when a part is missing. */
export function joinFixtureParts(fileId: string, partNumbers: number[], mime: string): number | null {
  const parts = fixtureParts.get(fileId);
  if (!parts || partNumbers.some((number) => !parts.has(number)) || typeof URL.createObjectURL !== "function") return null;
  const blob = new Blob([...partNumbers].sort((a, b) => a - b).map((number) => parts.get(number)!), { type: mime });
  fixtureBlobs.set(fileId, URL.createObjectURL(blob));
  fixtureParts.delete(fileId);
  return blob.size;
}
export function dropFixtureParts(fileId: string) {
  fixtureParts.delete(fileId);
}
