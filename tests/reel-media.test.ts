import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedMediaUrl, fetchMedia, MediaRefused, mediaHosts, stageMedia } from "../workers/reel-render/src/media";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOSTS = mediaHosts({ SUPABASE_URL: "https://project.supabase.co", FACEFUL_R2_ACCOUNT_ID: ACCOUNT, MEDIA_HOST_ALLOWLIST: " cdn.example.com ,169.254.169.254, *.evil.example,, localhost" });

test("the worker fetches media from exact hosts only: the engine's Supabase project, its R2 account and the allowlist", () => {
  assert.deepEqual(HOSTS, ["project.supabase.co", `${ACCOUNT}.r2.cloudflarestorage.com`, "cdn.example.com"]);
  assert.deepEqual(mediaHosts({ SUPABASE_URL: "not a url", FACEFUL_R2_ACCOUNT_ID: "nope" }), []);
  for (const url of ["https://project.supabase.co/storage/v1/object/sign/media/a.mp4?token=x", `https://${ACCOUNT}.r2.cloudflarestorage.com/faceful-media/a.mp4?X-Amz-Signature=x`, "https://CDN.example.com/a.png"]) assert.ok(allowedMediaUrl(url, HOSTS), url);
  for (const url of [
    "https://attacker.supabase.co/functions/v1/redirect", // anyone can own a supabase.co project
    `https://other${ACCOUNT.slice(5)}.r2.cloudflarestorage.com/x.mp4`,
    "https://sub.cdn.example.com/a.png",
    "http://cdn.example.com/a.png",
    "https://cdn.example.com:8443/a.png",
    "https://user:pass@cdn.example.com/a.png",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/a.png",
    "not a url",
  ]) assert.equal(allowedMediaUrl(url, HOSTS), false, url);
});

/** A fake internet: each URL answers with a fixed response. */
function web(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual", "redirects are never followed blindly");
    asked.push(String(input));
    const route = routes[String(input)];
    return route ? route() : new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const file = (body: string, type = "video/mp4") => () => new Response(body, { headers: { "content-type": type } });

test("every redirect is checked like the first request", async () => {
  const { fetcher, asked } = web({
    "https://cdn.example.com/moved.mp4": redirect("https://project.supabase.co/a.mp4"),
    "https://project.supabase.co/a.mp4": file("video"),
    "https://cdn.example.com/metadata": redirect("http://169.254.169.254/latest/meta-data/iam/"),
    "https://cdn.example.com/private": redirect("https://10.0.0.5/admin"),
    "https://cdn.example.com/away": redirect("https://evil.example/a.mp4"),
    "https://cdn.example.com/loop": redirect("/loop"),
    "https://cdn.example.com/nowhere": () => new Response(null, { status: 302 }),
  });
  assert.equal(await (await fetchMedia("https://cdn.example.com/moved.mp4", HOSTS, fetcher)).text(), "video");
  for (const url of ["https://cdn.example.com/metadata", "https://cdn.example.com/private", "https://cdn.example.com/away", "https://cdn.example.com/loop", "https://cdn.example.com/nowhere"])
    await assert.rejects(fetchMedia(url, HOSTS, fetcher), MediaRefused, url);
  assert.ok(!asked.some((url) => /169\.254|10\.0\.0\.5|evil\.example/.test(url)), "the refused targets were never contacted");
  assert.equal(asked.filter((url) => url === "https://cdn.example.com/loop").length, 4, "three redirects at most");
  await assert.rejects(fetchMedia("https://cdn.example.com/missing.mp4", HOSTS, fetcher), /answered 404/);
});

test("staged media is served to the renderer from 127.0.0.1 only, once per URL, within a size limit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reel-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { fetcher, asked } = web({
    "https://project.supabase.co/item.mp4?token=a": file("avatar video"),
    "https://cdn.example.com/music": file("music", "audio/mpeg; charset=binary"),
    "https://cdn.example.com/huge.png": file("x".repeat(64), "image/png"),
  });
  const urls = ["https://project.supabase.co/item.mp4?token=a", "https://cdn.example.com/music", "https://project.supabase.co/item.mp4?token=a"];
  const staged = await stageMedia(urls, join(dir, "job"), HOSTS, { fetcher, maxBytes: 32 });
  t.after(() => staged.close());
  assert.equal(asked.length, 2, "each URL is downloaded once");
  const video = staged.url(urls[0]);
  assert.match(video, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/0\.mp4$/);
  const served = await fetch(video);
  assert.deepEqual([served.status, served.headers.get("content-type"), await served.text()], [200, "video/mp4", "avatar video"]);
  const music = staged.url(urls[1]);
  assert.match(music, /\/1\.mp3$/, "the copy keeps an extension the renderer understands");
  assert.equal(await (await fetch(music)).text(), "music");
  assert.equal((await fetch(video.replace(/[0-9a-f]{32}/, "0".repeat(32)))).status, 404, "only under the random path");
  assert.equal((await fetch(video, { method: "DELETE" })).status, 404);
  assert.throws(() => staged.url("https://cdn.example.com/never-staged.mp4"), /not staged/);
  assert.deepEqual((await readdir(join(dir, "job"))).sort(), ["0.mp4", "1.mp3"]);

  await assert.rejects(stageMedia(["https://cdn.example.com/huge.png"], join(dir, "big"), HOSTS, { fetcher, maxBytes: 32 }), /larger than 32 bytes/);
});
