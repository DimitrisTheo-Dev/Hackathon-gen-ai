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
