import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetMedia, stableMedia } from "../apps/web/src/lib/media-url";

const at = (iso: string) => Date.parse(iso);

test("the player keeps one signed URL per media id while it is valid, so polling never swaps the src", () => {
  const first = stableMedia({ id: "media-a", url: "https://cdn.test/a?sig=1", expiresAt: "2026-11-14T11:00:00.000Z" }, at("2026-11-14T10:00:00.000Z"));
  assert.equal(first.url, "https://cdn.test/a?sig=1");
  // A later poll returns a different signature for the same media: the remembered URL wins.
  const polled = stableMedia({ id: "media-a", url: "https://cdn.test/a?sig=2", expiresAt: "2026-11-14T11:05:00.000Z" }, at("2026-11-14T10:00:05.000Z"));
  assert.equal(polled.url, "https://cdn.test/a?sig=1");
  // A different media id is independent.
  assert.equal(stableMedia({ id: "media-b", url: "https://cdn.test/b?sig=9", expiresAt: null }, at("2026-11-14T10:00:05.000Z")).url, "https://cdn.test/b?sig=9");
});

test("a remembered URL is replaced once it has expired or after it failed to play", () => {
  stableMedia({ id: "media-c", url: "https://cdn.test/c?sig=1", expiresAt: "2026-11-14T11:00:00.000Z" }, at("2026-11-14T10:00:00.000Z"));
  const afterExpiry = stableMedia({ id: "media-c", url: "https://cdn.test/c?sig=2", expiresAt: "2026-11-14T12:00:00.000Z" }, at("2026-11-14T11:00:00.000Z"));
  assert.equal(afterExpiry.url, "https://cdn.test/c?sig=2");
  assert.equal(afterExpiry.expiresAt, at("2026-11-14T12:00:00.000Z"));
  forgetMedia("media-c");
  assert.equal(stableMedia({ id: "media-c", url: "https://cdn.test/c?sig=3", expiresAt: null }, at("2026-11-14T11:00:01.000Z")).url, "https://cdn.test/c?sig=3");
  // No expiry reported: the URL is kept until playback fails.
  assert.equal(stableMedia({ id: "media-c", url: "https://cdn.test/c?sig=4", expiresAt: null }, at("2027-01-01T00:00:00.000Z")).url, "https://cdn.test/c?sig=3");
});
