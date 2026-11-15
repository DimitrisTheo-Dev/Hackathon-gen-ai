import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { likenessConsentStatement, personaSchema } from "../packages/contracts/src/index";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { MemoryFileStore } from "../packages/engine/src/r2";
import { MemoryStore } from "../packages/engine/src/store-memory";

/** Personas on the real engine, with an in-memory store and bucket. "user:<id>" stands in for a verified session. */
const BASE = "https://faceful.test";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (label: string) => new TextEncoder().encode(`${label}-${crypto.randomUUID()}`);

function engine() {
  const files = new MemoryFileStore();
  const store = new MemoryStore();
  const deps: HttpDeps = {
    store,
    files,
    // A consent asks for seven upload links, and these tests record several in a minute; the limit has its own tests.
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: BASE, RATE_LIMIT_COSTLY_PER_MINUTE: "1000" }),
    now: () => new Date("2026-11-15T12:00:00.000Z"),
    verifyAccessToken: async (token) => {
      const [kind, id, client] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: client ?? null };
    },
    fetch: async () => new Response("{}", { status: 500 }),
    planner: null,
  };
  const call = async (path: string, init: { as?: string; method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { "user-agent": "TestBrowser/1.0" };
    if (init.as) headers.authorization = `Bearer ${init.as}`;
    const method = init.method ?? "POST";
    const response = await handleEngineRequest(deps, new Request(`${BASE}${path}`, { method, headers, body: method === "POST" ? JSON.stringify(init.body ?? {}) : undefined }), path);
    return { status: response!.status, body: (await response!.json()) as any };
  };
  const op = (name: string, as: string, body: unknown) => call(`/v1/studio/operations/${name}`, { as, body });
  const list = async (as = "user:u1") => {
    const response = await call("/v1/studio/personas", { as, method: "GET" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as any[];
  };
  const create = async (as = "user:u1", name = "Dr. Maria") => {
    const response = await op("create_persona", as, { name, description: "Calm nutrition explainer", language: "el", operationKey: crypto.randomUUID() });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  /** Uploads a likeness recording the way the browser does. */
  const uploadRecording = async (as: string, type: string, bytes: Uint8Array) => {
    const ticket = await call("/v1/studio/likeness/upload-url", { as, body: { type, size: bytes.byteLength, sha256: sha(bytes) } });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    await files.put(ticket.body.key, bytes, type);
    return ticket.body.key as string;
  };
  /** Records a complete, passing face scan and consent, optionally for a persona. */
  const consent = async (as: string, personaId?: string, name = "Maria Papadopoulou") => {
    const stills: Record<string, string> = {};
    for (const pose of ["center", "left", "right", "up", "down"]) stills[pose] = await uploadRecording(as, "image/jpeg", bytesOf(pose));
    const response = await call("/v1/studio/likeness/consents", {
      as,
      body: {
        subjectName: name,
        language: "en",
        phrases: ["The quick brown fox.", "Bright morning sunshine.", likenessConsentStatement(name, "en")],
        transcript: "the quick brown fox bright morning sunshine i agree",
        scanVideoKey: await uploadRecording(as, "video/webm", bytesOf("scan")),
        speechVideoKey: await uploadRecording(as, "video/mp4", bytesOf("speech")),
        stills,
        report: { passed: true, checks: [{ id: "poses", label: "Five head angles", passed: true, required: true, value: 5 }] },
        ...(personaId ? { personaId } : {}),
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as { id: string; passed: boolean; personaId?: string | null };
  };
  /** Uploads a look photo through the persona link. */
  const uploadPhoto = async (as: string, personaId: string, bytes = bytesOf("photo"), type = "image/webp") => {
    const ticket = await op("persona_image_upload_url", as, { personaId, type, size: bytes.byteLength, sha256: sha(bytes) });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    await files.put(ticket.body.key, bytes, type);
    return ticket.body.key as string;
  };
  return { store, files, call, op, list, create, consent, uploadPhoto };
}

test("a new persona waits for a consent; only signed-in editors create one, agents may list without photos", async () => {
  const { op, list, create, store } = engine();
  assert.deepEqual(await list(), []);
  const persona = await create();
  assert.equal(personaSchema.safeParse(persona).success, true);
  assert.equal(persona.status, "needs_consent");
  assert.equal(persona.consent, null);
  assert.deepEqual(persona.looks, []);
  assert.equal(persona.language, "el");

  // An agent acting for the same account cannot create or change personas, whatever it was granted.
  const agent = await op("create_persona", "user:u1:claude-code", { name: "Bot made", operationKey: crypto.randomUUID() });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.error.code, "approval_required");
  const agentList = await list("user:u1:claude-code");
  assert.equal(agentList.length, 1);

  // Replaying the same operation key returns the first result instead of a second persona.
  const key = crypto.randomUUID();
  const first = await op("create_persona", "user:u1", { name: "Nikos", operationKey: key });
  const again = await op("create_persona", "user:u1", { name: "Nikos", operationKey: key });
  assert.equal(again.body.id, first.body.id);
  assert.equal((await list()).length, 2);

  // Another workspace sees none of them and cannot reach them by id.
  assert.deepEqual(await list("user:u2"), []);
  const foreign = await op("update_persona", "user:u2", { personaId: persona.id, name: "Taken" });
  assert.equal(foreign.status, 404);
  const audit = await store.select("audit_events", { action: "Created a persona" });
  assert.equal(audit.length, 2);
});

test("a consent recorded for a persona backs that persona only, and a second one does not replace a live one", async () => {
  const { list, create, consent, store } = engine();
  const persona = await create();
  const first = await consent("user:u1", persona.id);
  assert.equal(first.personaId, persona.id);
  const [ready] = await list();
  assert.equal(ready.status, "ready");
  assert.equal(ready.consent.id, first.id);
  assert.equal(ready.consent.subjectName, "Maria Papadopoulou");
  assert.equal(ready.consent.canWithdraw, true);
  assert.match(ready.consent.photoUrl, /^https:\/\/files\.test\/orgs\/[0-9a-f-]+\/likeness\/u1\/[0-9a-f-]+\.jpg\?ttl=900$/);
  // The manifest beside the recordings says which persona the consent was given for.
  const [row] = await store.select("likeness_consents", { id: first.id });
  assert.ok(row.manifest_key);

  // A persona with a live consent keeps it; the new consent is saved on its own.
  const second = await consent("user:u1", persona.id);
  assert.equal(second.personaId, null);
  assert.equal((await list())[0].consent.id, first.id);
  assert.equal((await store.select("likeness_consents", {})).length, 2);

  // Agents see the status but never a photo of the person.
  const [forAgent] = await list("user:u1:claude-code");
  assert.equal(forAgent.status, "ready");
  assert.equal(forAgent.consent.photoUrl, null);
  assert.equal(forAgent.consent.canWithdraw, false);
});

test("a consent cannot be attached to another workspace's persona", async () => {
  const { list, create, consent } = engine();
  const persona = await create("user:u1");
  // u2 records a consent naming u1's persona: the consent is u2's own and is kept, but it backs nothing.
  const result = await consent("user:u2", persona.id, "Someone Else");
  assert.equal(result.personaId, null);
  assert.equal((await list("user:u1"))[0].status, "needs_consent");
  // Malformed ids are ignored the same way.
  assert.equal((await consent("user:u1", "not-a-uuid")).personaId, null);
});

test("withdrawing a persona's consent deletes the recordings, marks the persona, and a new consent can take its place", async () => {
  const { op, list, create, consent, files } = engine();
  const persona = await create();
  const first = await consent("user:u1", persona.id);
  const stored = files.objects.size;
  assert.ok(stored >= 7);
  // Another member of a different workspace cannot withdraw it.
  assert.equal((await op("withdraw_persona_consent", "user:u2", { personaId: persona.id })).status, 404);
  const withdrawn = await op("withdraw_persona_consent", "user:u1", { personaId: persona.id });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.equal(files.objects.size, 0);
  const [after] = await list();
  assert.equal(after.status, "consent_withdrawn");
  assert.equal(after.consent.id, first.id);
  assert.ok(after.consent.revokedAt);
  assert.equal(after.consent.photoUrl, null);
  assert.equal(after.consent.canWithdraw, false);

  const second = await consent("user:u1", persona.id);
  assert.equal(second.personaId, persona.id);
  const [renewed] = await list();
  assert.equal(renewed.status, "ready");
  assert.equal(renewed.consent.id, second.id);
});

test("looks: add with a photo, replace and remove it, delete looks; photos must come from this persona's own link", async () => {
  const { op, list, create, uploadPhoto, files } = engine();
  const persona = await create();
  const other = await create("user:u1", "Nikos");

  const photo = await uploadPhoto("user:u1", persona.id);
  const added = await op("create_persona_look", "user:u1", { personaId: persona.id, name: "Studio, navy blazer", description: "Soft key light, plain grey backdrop", imageKey: photo, operationKey: crypto.randomUUID() });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.looks.length, 1);
  const look = added.body.looks[0];
  assert.equal(look.hasImage, true);
  assert.equal(look.imageUrl, `https://files.test/${photo}?ttl=900`);
  const plain = await op("create_persona_look", "user:u1", { personaId: persona.id, name: "Kitchen, apron", operationKey: crypto.randomUUID() });
  assert.deepEqual(plain.body.looks.map((l: any) => [l.name, l.position, l.hasImage]), [["Studio, navy blazer", 0, true], ["Kitchen, apron", 1, false]]);

  // A photo uploaded for another persona, a key that was never uploaded, and a photo already in use are refused.
  const foreignPhoto = await uploadPhoto("user:u1", other.id);
  const wrong = await op("create_persona_look", "user:u1", { personaId: persona.id, name: "Borrowed", imageKey: foreignPhoto, operationKey: crypto.randomUUID() });
  assert.equal(wrong.status, 400);
  const ticket = await op("persona_image_upload_url", "user:u1", { personaId: persona.id, type: "image/jpeg", size: 10, sha256: "a".repeat(64) });
  const missing = await op("create_persona_look", "user:u1", { personaId: persona.id, name: "Missing", imageKey: ticket.body.key, operationKey: crypto.randomUUID() });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /did not finish uploading/);
  const reused = await op("update_persona_look", "user:u1", { lookId: plain.body.looks[1].id, imageKey: photo });
  assert.equal(reused.status, 400);
  assert.match(reused.body.error.message, /already used/);

  // Replacing a photo deletes the old file; null removes it.
  const replacement = await uploadPhoto("user:u1", persona.id, bytesOf("second"), "image/png");
  const replaced = await op("update_persona_look", "user:u1", { lookId: look.id, name: "Studio, white shirt", imageKey: replacement });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.looks[0].name, "Studio, white shirt");
  assert.equal(files.objects.has(photo), false);
  assert.equal(files.objects.has(replacement), true);
  const cleared = await op("update_persona_look", "user:u1", { lookId: look.id, imageKey: null });
  assert.equal(cleared.body.looks[0].hasImage, false);
  assert.equal(files.objects.has(replacement), false);

  const photoForDelete = await uploadPhoto("user:u1", persona.id);
  await op("update_persona_look", "user:u1", { lookId: plain.body.looks[1].id, imageKey: photoForDelete });
  const deleted = await op("delete_persona_look", "user:u1", { lookId: plain.body.looks[1].id });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.looks.map((l: any) => l.id), [look.id]);
  assert.equal(files.objects.has(photoForDelete), false);

  // Agents cannot add looks.
  assert.equal((await op("create_persona_look", "user:u1:claude-code", { personaId: persona.id, name: "Bot", operationKey: crypto.randomUUID() })).status, 403);
  assert.equal((await list()).find((p) => p.id === persona.id).looks.length, 1);
});

test("deleting a persona deletes its looks and their photos, and keeps the person's consent", async () => {
  const { op, list, create, consent, uploadPhoto, files, store } = engine();
  const persona = await create();
  const given = await consent("user:u1", persona.id);
  const photo = await uploadPhoto("user:u1", persona.id);
  await op("create_persona_look", "user:u1", { personaId: persona.id, name: "Studio", imageKey: photo, operationKey: crypto.randomUUID() });
  const deleted = await op("delete_persona", "user:u1", { personaId: persona.id });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(await list(), []);
  assert.equal((await store.select("persona_looks", {})).length, 0);
  assert.equal(files.objects.has(photo), false);
  const [kept] = await store.select("likeness_consents", { id: given.id });
  assert.equal(kept.revoked_at, null);
  assert.ok(kept.scan_video_key && files.objects.has(kept.scan_video_key));
});

test("the migration keeps personas server-only and ties every consent and look to the persona's workspace", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261115130000_personas.sql", import.meta.url), "utf8");
  for (const table of ["personas", "persona_looks"]) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`));
  }
  assert.match(sql, /consent_id uuid unique,/);
  assert.match(sql, /foreign key \(consent_id, org_id\) references public\.likeness_consents\(id, org_id\) on delete set null \(consent_id\)/);
  assert.match(sql, /foreign key \(persona_id, org_id\) references public\.personas\(id, org_id\) on delete cascade/);
  assert.doesNotMatch(sql, /drop |grant /i);
});
