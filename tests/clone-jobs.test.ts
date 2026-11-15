import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneJobSchema, cloneSourceSchema, parseCloneLink } from "../packages/contracts/src/index";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { MemoryStore } from "../packages/engine/src/store-memory";

/**
 * Clone a video: the link reader shared by studio and engine, the source lookup (oEmbed, TikTok short links) and
 * the `create_clone_job` operation. Real engine + in-memory store; tokens "user:<id>" stand in for Supabase sessions.
 * The platforms are stubbed: no test reaches YouTube, TikTok or Instagram.
 */
function engine() {
  const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const deps: HttpDeps = {
    store: new MemoryStore(),
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: "https://faceful.test" }),
    now: () => new Date("2026-11-15T12:00:00.000Z"),
    verifyAccessToken: async (token) => {
      const [kind, id] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: null };
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, redirect: init?.redirect });
      const target = new URL(url);
      const asked = target.searchParams.get("url") ?? "";
      if (target.origin === "https://www.youtube.com" && target.pathname === "/oembed") {
        if (asked.includes("AAAAAAAAAAA")) return new Response("Not Found", { status: 404 });
        if (asked.includes("BBBBBBBBBBB")) return new Response("Unauthorized", { status: 401 });
        return Response.json({ title: "  How to  measure blood pressure ", author_name: "Dr Example", author_url: "https://www.youtube.com/@drexample", thumbnail_url: "https://i.ytimg.com/vi/x/hqdefault.jpg", html: "<iframe>" });
      }
      if (url === "https://vm.tiktok.com/ZMabc123/") return new Response(null, { status: 301, headers: { location: "https://www.tiktok.com/@doc.maria/video/7300000000000000001?_r=1&_t=abc" } });
      if (url === "https://vm.tiktok.com/ZMnowhere/") return new Response(null, { status: 302, headers: { location: "https://www.tiktok.com/?_r=1" } });
      if (target.origin === "https://www.tiktok.com" && target.pathname === "/oembed")
        return Response.json({ title: "Three signs of dehydration", author_name: "Doc Maria", author_url: "https://www.tiktok.com/@doc.maria", thumbnail_url: "javascript:alert(1)", embed_product_id: "7300000000000000001" });
      throw new TypeError("fetch failed");
    }) as typeof fetch,
    planner: null,
  };
  const call = async (path: string, init: RequestInit & { user?: string } = {}) => {
    const { user = "u1", ...rest } = init;
    const headers = new Headers(rest.headers);
    if (user) headers.set("Authorization", `Bearer user:${user}`);
    const request = new Request(`https://faceful.test${path}`, { ...rest, headers });
    return (await handleEngineRequest(deps, request, new URL(request.url).pathname))!;
  };
  /** The message of an error answer. */
  const message = async (response: Response) => ((await response.json()) as { error: { message: string } }).error.message;
  const lookup = (url: string, user?: string) => call(`/v1/studio/clone/source?url=${encodeURIComponent(url)}`, { user });
  const start = (body: Record<string, unknown>, user?: string) =>
    call("/v1/studio/operations/create_clone_job", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, user });
  return { deps, calls, call, lookup, start, message };
}

test("clone links: YouTube, TikTok and Instagram addresses are read per platform, tracking stripped", () => {
  const ok = (raw: string) => {
    const result = parseCloneLink(raw);
    assert.ok(result.ok, `${raw}: ${result.ok ? "" : result.reason}`);
    return result.link;
  };
  assert.deepEqual(ok("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=12s&si=track"), {
    platform: "youtube", kind: "video", sourceId: "jNQXAC9IVRw", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    embedUrl: "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?rel=0&playsinline=1", orientation: "landscape",
  });
  assert.equal(ok("youtu.be/jNQXAC9IVRw?si=abc").url, "https://www.youtube.com/watch?v=jNQXAC9IVRw", "no scheme is fine");
  const short = ok("https://m.youtube.com/shorts/jNQXAC9IVRw?feature=share");
  assert.equal(short.kind, "short");
  assert.equal(short.orientation, "portrait");
  assert.equal(short.url, "https://www.youtube.com/shorts/jNQXAC9IVRw");

  const tiktok = ok("https://www.tiktok.com/@doc.maria/video/7300000000000000001?is_from_webapp=1&sender_device=pc");
  assert.equal(tiktok.url, "https://www.tiktok.com/@doc.maria/video/7300000000000000001");
  assert.equal(tiktok.embedUrl, "https://www.tiktok.com/player/v1/7300000000000000001?music_info=1&description=1&rel=0");
  assert.equal(ok("https://www.tiktok.com/embed/v2/7300000000000000001").url, "https://www.tiktok.com/@/video/7300000000000000001");
  const shortLink = ok("https://vm.tiktok.com/ZMabc123/");
  assert.equal(shortLink.kind, "short_link");
  assert.equal(shortLink.embedUrl, null, "a short link has no player until it is followed");

  const reel = ok("https://www.instagram.com/reel/C5Yy3Kqr0Qm/?igsh=abc");
  assert.deepEqual([reel.kind, reel.url, reel.embedUrl], ["reel", "https://www.instagram.com/reel/C5Yy3Kqr0Qm/", "https://www.instagram.com/reel/C5Yy3Kqr0Qm/embed/"]);
  assert.equal(ok("instagram.com/doc.maria/reel/C5Yy3Kqr0Qm").url, "https://www.instagram.com/reel/C5Yy3Kqr0Qm/", "share links that start with the account");
  assert.equal(ok("https://www.instagram.com/p/C5Yy3Kqr0Qm/").kind, "post");

  const refused = (raw: string, reason: RegExp) => {
    const result = parseCloneLink(raw);
    assert.equal(result.ok, false, raw);
    if (!result.ok) assert.match(result.reason, reason, raw);
  };
  refused("", /Paste a link/);
  refused("https://vimeo.com/123456", /YouTube, TikTok and Instagram/);
  refused("https://evil-youtube.com/watch?v=jNQXAC9IVRw", /YouTube, TikTok and Instagram/);
  refused("https://youtube.com.evil.test/watch?v=jNQXAC9IVRw", /YouTube, TikTok and Instagram/);
  refused("https://www.youtube.com:8443/watch?v=jNQXAC9IVRw", /video link/);
  refused("https://user:pass@www.youtube.com/watch?v=jNQXAC9IVRw", /video link/);
  refused("javascript:alert(1)", /video link/);
  refused("https://www.youtube.com/@drexample", /not a single video/);
  refused("https://www.youtube.com/watch?v=short", /does not point to a video/);
  refused("https://www.tiktok.com/@doc.maria", /TikTok profile/);
  refused("https://www.tiktok.com/@doc.maria/photo/7300000000000000001", /photo post/);
  refused("https://www.instagram.com/stories/doc.maria/3300000000/", /Stories/);
  refused("https://www.instagram.com/doc.maria/", /Instagram profile/);
});

test("clone source lookup: needs a session, asks oEmbed for details, follows TikTok short links, refuses missing videos", async () => {
  const { calls, lookup, message } = engine();
  assert.equal((await lookup("https://youtu.be/jNQXAC9IVRw", "")).status, 401, "the lookup is not public");

  const youtube = await lookup("https://www.youtube.com/shorts/jNQXAC9IVRw?feature=share");
  assert.equal(youtube.status, 200);
  const source = cloneSourceSchema.parse(await youtube.json());
  assert.deepEqual(
    { title: source.title, author: source.author, authorUrl: source.authorUrl, orientation: source.orientation },
    { title: "How to measure blood pressure", author: "Dr Example", authorUrl: "https://www.youtube.com/@drexample", orientation: "portrait" },
  );
  assert.equal(calls.at(-1)?.url, `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/shorts/jNQXAC9IVRw")}`, "oEmbed is asked about the canonical link only");

  const tiktok = cloneSourceSchema.parse(await (await lookup("https://vm.tiktok.com/ZMabc123/")).json());
  assert.equal(tiktok.sourceId, "7300000000000000001");
  assert.equal(tiktok.url, "https://www.tiktok.com/@doc.maria/video/7300000000000000001");
  assert.equal(tiktok.author, "Doc Maria");
  assert.equal(tiktok.thumbnailUrl, null, "only https links are passed on from oEmbed");
  assert.equal(calls.find((entry) => entry.url === "https://vm.tiktok.com/ZMabc123/")?.redirect, "manual", "the redirect is read, not followed");

  const nowhere = await lookup("https://vm.tiktok.com/ZMnowhere/");
  assert.equal(nowhere.status, 400);
  assert.match(await message(nowhere), /does not lead to a video/);

  const before = calls.length;
  const instagram = cloneSourceSchema.parse(await (await lookup("https://www.instagram.com/reel/C5Yy3Kqr0Qm/")).json());
  assert.equal(calls.length, before, "Instagram's oEmbed needs a Meta token, so it is not asked");
  assert.equal(instagram.title, null);
  assert.equal(instagram.embedUrl, "https://www.instagram.com/reel/C5Yy3Kqr0Qm/embed/");

  const missing = await lookup("https://www.youtube.com/watch?v=AAAAAAAAAAA");
  assert.equal(missing.status, 400);
  assert.match(await message(missing), /could not find this video/);
  const locked = await lookup("https://www.youtube.com/watch?v=BBBBBBBBBBB");
  assert.match(await message(locked), /does not allow it to be embedded/);
  const bad = await lookup("https://vimeo.com/123456");
  assert.equal(bad.status, 400);
});

test("create_clone_job: queues one job per operation key, stores the resolved source, and lists it", async () => {
  const { deps, start, call } = engine();
  const store = deps.store as MemoryStore;
  const operationKey = crypto.randomUUID();
  const body = {
    url: "https://www.tiktok.com/@doc.maria/video/7300000000000000001?is_from_webapp=1",
    brief: "Keep the hook and the quick cuts. Make it about drinking water in a heatwave, in Greek, for my practice.",
    clone: ["captions", "structure", "pacing"],
    operationKey,
  };
  assert.equal((await start(body, "")).status, 401);

  const first = await start(body);
  assert.equal(first.status, 200);
  const job = cloneJobSchema.parse(await first.json());
  assert.equal(job.state, "queued");
  assert.equal(job.resultUrl, null);
  assert.equal(job.projectId, null);
  assert.deepEqual(job.clone, ["structure", "pacing", "captions"], "stored in the studio's order");
  assert.equal(job.source.title, "Three signs of dehydration");
  assert.equal(job.source.url, "https://www.tiktok.com/@doc.maria/video/7300000000000000001");

  const replay = cloneJobSchema.parse(await (await start(body)).json());
  assert.equal(replay.id, job.id, "a retried request returns the same job");
  assert.equal(store.tables.get("clone_jobs")?.length, 1, "and writes no second row");
  const conflict = await start({ ...body, brief: "Something else entirely." });
  assert.equal(conflict.status, 409, "the same key with different content is refused");

  const row = store.tables.get("clone_jobs")![0];
  assert.equal(row.state, "queued");
  assert.equal(row.org_id, (store.tables.get("memberships") ?? []).find((m) => m.user_id === "u1")?.org_id);
  assert.ok((store.tables.get("audit_events") ?? []).some((event) => event.object_id === job.id && /Queued a clone job/.test(event.action)));

  // Another workspace sees none of it.
  const elsewhere = await call("/v1/studio/clone/jobs", { user: "u2" });
  assert.deepEqual(await elsewhere.json(), []);
  const list = (await (await call("/v1/studio/clone/jobs")).json()) as unknown[];
  assert.deepEqual(list.map((entry) => cloneJobSchema.parse(entry).id), [job.id]);
});

test("create_clone_job: refuses a bad link, an empty brief, nothing to clone or a missing video, and writes no job", async () => {
  const { deps, start, message } = engine();
  const store = deps.store as MemoryStore;
  const base = { url: "https://youtu.be/jNQXAC9IVRw", brief: "Same idea, my topic.", clone: ["pacing"] };
  for (const [change, pattern] of [
    [{ url: "https://vimeo.com/1" }, /YouTube, TikTok and Instagram/],
    [{ brief: "   " }, /brief/],
    [{ clone: [] }, /clone/],
    [{ clone: ["pacing", "pacing"] }, /clone/],
    [{ clone: ["faces"] }, /clone/],
  ] as const) {
    const response = await start({ ...base, ...change, operationKey: crypto.randomUUID() });
    assert.equal(response.status, 400, JSON.stringify(change));
    assert.match(await message(response), pattern);
  }
  const missing = await start({ ...base, url: "https://www.youtube.com/watch?v=AAAAAAAAAAA", operationKey: crypto.randomUUID() });
  assert.equal(missing.status, 400);
  assert.equal(store.tables.get("clone_jobs")?.length ?? 0, 0, "no job was written");
});

test("clone jobs: a finished job carries its project and a signed link to the video", async () => {
  const { deps, start, call } = engine();
  const store = deps.store as MemoryStore;
  const job = cloneJobSchema.parse(await (await start({ url: "https://youtu.be/jNQXAC9IVRw", brief: "My version.", clone: ["pacing"], operationKey: crypto.randomUUID() })).json());
  const row = store.tables.get("clone_jobs")![0];
  const asset = await store.insert("media_assets", { id: crypto.randomUUID(), org_id: row.org_id, item_id: crypto.randomUUID(), revision: 1, storage_path: `${row.org_id}/clone/${job.id}.mp4`, mime: "video/mp4", bytes: 10, sha256: "x", duration_seconds: 12, has_audio: true, origin: "worker_upload" });
  await store.media.put(asset.storage_path, new Uint8Array([1]), "video/mp4");
  const projectId = crypto.randomUUID();
  await store.update("clone_jobs", { id: job.id }, { state: "succeeded", media_asset_id: asset.id, project_id: projectId });
  const [done] = ((await (await call("/v1/studio/clone/jobs")).json()) as unknown[]).map((entry) => cloneJobSchema.parse(entry));
  assert.equal(done.state, "succeeded");
  assert.equal(done.projectId, projectId);
  assert.match(done.resultUrl ?? "", /^https:\/\/media\.test\/.+\/clone\/.+\.mp4\?ttl=\d+$/);
});
