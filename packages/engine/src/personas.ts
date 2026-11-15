import { z } from "zod";
import {
  PERSONA_LIMIT,
  PERSONA_LOOK_LIMIT,
  PERSONA_MAX_IMAGE_BYTES,
  createPersonaInputSchema,
  createPersonaLookInputSchema,
  likenessUploadTicketSchema,
  personaImageUploadInputSchema,
  personaLookRefInputSchema,
  personaRefInputSchema,
  personaSchema,
  updatePersonaInputSchema,
  updatePersonaLookInputSchema,
  type Persona,
  type PersonaStatus,
} from "../../contracts/src/index.js";
import { audit, idempotent, requireHuman, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import { UnconfiguredFileStore, type FileStore } from "./r2.js";
import { selectOne, type Row } from "./store.js";
import { parse } from "./studio.js";

/**
 * Personas: presenters a workspace can put in its videos (the studio's Personas tab). Each persona is made from
 * one person's face scan and spoken consent and can appear in several looks (outfit, hair, setting, with an
 * optional reference photo). Tables: supabase/migrations/20261115130000_personas.sql.
 *
 *   • Every persona needs its own, new consent. The person records it in the Personas tab (or at
 *     /face-scan?persona=<id> on their own device), and saveLikenessConsent links it here
 *     (linkPersonaConsent). A consent backs at most one persona.
 *   • A withdrawn consent stays linked as the record, and the persona reads as consent_withdrawn until the
 *     person records a new one for it.
 *   • Writes are for signed-in members who can edit content, never agents. Agents with campaign:read can list
 *     personas, but get no photo links.
 *   • Reference photos go from the browser straight to private R2 through a one-file link, like the scan.
 */
export const PERSONAS_TABLE = "personas";
export const PERSONA_LOOKS_TABLE = "persona_looks";
/** likeness.ts owns this table; named here so the two modules do not import each other. */
const CONSENTS_TABLE = "likeness_consents";
const UPLOAD_TTL_SECONDS = 10 * 60;
const PHOTO_TTL_SECONDS = 15 * 60;
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

/** Everything stored for one persona. No key under it can be reached from another workspace or persona. */
export const personaFolder = (orgId: string, personaId: string) => `orgs/${orgId}/personas/${personaId}/`;
const ownsImage = (folder: string, key: string) =>
  key.startsWith(folder) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/.test(key.slice(folder.length));
const isUuid = (value: string) => z.uuid().safeParse(value).success;

function filesOf(deps: EngineDeps): FileStore {
  return deps.files ?? new UnconfiguredFileStore();
}
function storage(deps: EngineDeps): FileStore {
  const files = filesOf(deps);
  if (!files.configured) throw new EngineError("provider_unavailable", "Private file storage isn’t connected on this deployment yet, so a photo can’t be saved. Add the FACEFUL_R2_* settings.");
  return files;
}
/** Persona changes are made by a signed-in member who can edit content. Returns their user id. */
function editor(ctx: Ctx, action: string): string {
  requireHuman(ctx, action);
  requireScope(ctx, "content:edit");
  return (ctx.principal as { userId: string }).userId;
}
async function findPersona(deps: EngineDeps, ctx: Ctx, personaId: string): Promise<Row> {
  const row = isUuid(personaId) ? await selectOne(deps.store, PERSONAS_TABLE, { id: personaId, org_id: ctx.org.id }) : null;
  if (!row) throw new EngineError("not_found", "This persona was not found in your workspace.");
  return row;
}
async function findLook(deps: EngineDeps, ctx: Ctx, lookId: string): Promise<Row> {
  const row = isUuid(lookId) ? await selectOne(deps.store, PERSONA_LOOKS_TABLE, { id: lookId, org_id: ctx.org.id }) : null;
  if (!row) throw new EngineError("not_found", "This look was not found in your workspace.");
  return row;
}
/** A signed link, or null when there is nothing to sign or storage cannot sign one. A list never fails over a photo. */
async function signed(files: FileStore, key: unknown): Promise<string | null> {
  if (typeof key !== "string" || !key || !files.configured) return null;
  try {
    return await files.downloadUrl(key, PHOTO_TTL_SECONDS);
  } catch {
    return null;
  }
}
const statusOf = (consent: Row | null): PersonaStatus => (!consent ? "needs_consent" : consent.revoked_at ? "consent_withdrawn" : "ready");

async function present(deps: EngineDeps, ctx: Ctx, persona: Row, consent: Row | null, looks: Row[]): Promise<Persona> {
  const files = filesOf(deps);
  // Photos of a person's face are for the people in the studio, not for agents.
  const photos = ctx.principal.kind === "human";
  const userId = photos ? (ctx.principal as { userId: string }).userId : null;
  const ordered = [...looks].sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
  return parse(personaSchema, {
    id: persona.id,
    name: persona.name,
    description: persona.description ?? "",
    language: persona.language,
    status: statusOf(consent),
    consent: consent
      ? {
          id: consent.id,
          subjectName: consent.subject_name,
          language: consent.language,
          createdAt: consent.created_at,
          revokedAt: consent.revoked_at ?? null,
          photoUrl: photos && !consent.revoked_at ? await signed(files, consent.stills?.center) : null,
          canWithdraw: !consent.revoked_at && photos && (consent.user_id === userId || ctx.role === "owner" || ctx.role === "admin"),
        }
      : null,
    looks: await Promise.all(
      ordered.map(async (look) => ({
        id: look.id,
        personaId: look.persona_id,
        name: look.name,
        description: look.description ?? "",
        hasImage: Boolean(look.image_key),
        imageUrl: photos ? await signed(files, look.image_key) : null,
        position: look.position,
        createdAt: look.created_at,
        updatedAt: look.updated_at,
      })),
    ),
    createdAt: persona.created_at,
    updatedAt: persona.updated_at,
  });
}
async function presentOne(deps: EngineDeps, ctx: Ctx, persona: Row): Promise<Persona> {
  const consent = persona.consent_id ? await selectOne(deps.store, CONSENTS_TABLE, { id: persona.consent_id, org_id: ctx.org.id }) : null;
  const looks = await deps.store.select(PERSONA_LOOKS_TABLE, { persona_id: persona.id, org_id: ctx.org.id }, { limit: PERSONA_LOOK_LIMIT });
  return present(deps, ctx, persona, consent, looks);
}

/** GET /v1/studio/personas: the workspace's personas, oldest first, with their consent and looks. */
export async function listPersonas(deps: EngineDeps, ctx: Ctx): Promise<Persona[]> {
  requireScope(ctx, "campaign:read");
  const personas = await deps.store.select(PERSONAS_TABLE, { org_id: ctx.org.id }, { order: ["created_at", "asc"], limit: PERSONA_LIMIT });
  if (!personas.length) return [];
  const consentIds = personas.map((persona) => persona.consent_id).filter((id): id is string => typeof id === "string");
  const [consents, looks] = await Promise.all([
    consentIds.length ? deps.store.select(CONSENTS_TABLE, { org_id: ctx.org.id, id: { in: consentIds } }) : Promise.resolve([]),
    deps.store.select(PERSONA_LOOKS_TABLE, { org_id: ctx.org.id, persona_id: { in: personas.map((persona) => persona.id) } }, { limit: PERSONA_LIMIT * PERSONA_LOOK_LIMIT }),
  ]);
  return Promise.all(
    personas.map((persona) =>
      present(
        deps,
        ctx,
        persona,
        consents.find((consent) => consent.id === persona.consent_id) ?? null,
        looks.filter((look) => look.persona_id === persona.id),
      ),
    ),
  );
}

/** create_persona: a new persona with no consent and no looks yet. */
export async function createPersona(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Persona> {
  const userId = editor(ctx, "Creating a persona");
  const input = parse(createPersonaInputSchema, raw);
  return idempotent(deps, ctx, "create_persona", input.operationKey, input, async () => {
    const existing = await deps.store.select(PERSONAS_TABLE, { org_id: ctx.org.id }, { limit: PERSONA_LIMIT });
    if (existing.length >= PERSONA_LIMIT) throw new EngineError("validation_error", `A workspace can have up to ${PERSONA_LIMIT} personas. Delete one to add another.`);
    const now = deps.now().toISOString();
    const row = await deps.store.insert(PERSONAS_TABLE, {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      name: input.name,
      description: input.description,
      language: input.language,
      consent_id: null,
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
    await audit(deps, ctx, { action: "Created a persona", objectId: row.id, outcome: "Waiting for a face scan and spoken consent" });
    return present(deps, ctx, row, null, []);
  });
}

/** update_persona: renames it or changes its description or language. Only the fields sent change. */
export async function updatePersona(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Persona> {
  editor(ctx, "Editing a persona");
  const input = parse(updatePersonaInputSchema, raw);
  const persona = await findPersona(deps, ctx, input.personaId);
  const patch: Row = { updated_at: deps.now().toISOString() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.language !== undefined) patch.language = input.language;
  const [row] = await deps.store.update(PERSONAS_TABLE, { id: persona.id, org_id: ctx.org.id }, patch);
  if (!row) throw new EngineError("not_found", "This persona was not found in your workspace.");
  await audit(deps, ctx, { action: "Edited a persona", objectId: persona.id, outcome: `Changed ${Object.keys(patch).filter((key) => key !== "updated_at").join(", ") || "nothing"}` });
  return presentOne(deps, ctx, row);
}

/**
 * delete_persona: deletes the persona, its looks and their photos. The consent is the person's own and stays;
 * they withdraw it themselves (withdraw_persona_consent, before deleting, or the likeness route).
 */
export async function deletePersona(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  editor(ctx, "Deleting a persona");
  const input = parse(personaRefInputSchema, raw);
  const persona = await findPersona(deps, ctx, input.personaId);
  const looks = await deps.store.select(PERSONA_LOOKS_TABLE, { persona_id: persona.id, org_id: ctx.org.id }, { limit: PERSONA_LOOK_LIMIT });
  const keys = looks.map((look) => look.image_key).filter((key): key is string => typeof key === "string" && key.length > 0);
  // A failed delete stops here with every row intact, so deleting again finishes the job.
  if (keys.length) {
    const files = storage(deps);
    await Promise.all(keys.map((key) => files.remove(key)));
  }
  await deps.store.remove(PERSONA_LOOKS_TABLE, { persona_id: persona.id, org_id: ctx.org.id });
  await deps.store.remove(PERSONAS_TABLE, { id: persona.id, org_id: ctx.org.id });
  await audit(deps, ctx, { action: "Deleted a persona", objectId: persona.id, outcome: `${looks.length} looks and ${keys.length} photos deleted; the consent was kept` });
  return { deleted: true as const };
}

/**
 * withdraw_persona_consent: which consent to withdraw for this persona. The withdrawal itself is
 * revokeLikenessConsent, so the same rule applies: the person who recorded it, or an owner or admin.
 */
export async function personaConsentToWithdraw(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<string> {
  requireHuman(ctx, "Withdrawing a consent");
  const input = parse(personaRefInputSchema, raw);
  const persona = await findPersona(deps, ctx, input.personaId);
  if (!persona.consent_id) throw new EngineError("validation_error", "This persona has no consent to withdraw.");
  return persona.consent_id;
}

/** persona_image_upload_url: a link that accepts one reference photo for one persona, and nothing else. */
export async function personaImageUploadUrl(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  editor(ctx, "Adding a photo to a persona");
  const input = parse(personaImageUploadInputSchema, raw);
  const persona = await findPersona(deps, ctx, input.personaId);
  const files = storage(deps);
  const key = `${personaFolder(ctx.org.id, persona.id)}${crypto.randomUUID()}.${EXTENSIONS[input.type]}`;
  const { url, headers } = await files.uploadUrl(key, { sha256Hex: input.sha256, contentType: input.type, expiresSeconds: UPLOAD_TTL_SECONDS });
  return parse(likenessUploadTicketSchema, { key, uploadUrl: url, headers, expiresAt: new Date(deps.now().getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString() });
}

/** Checks that a photo key came from this persona's upload link, finished uploading, and is not used by another look. */
async function claimImage(deps: EngineDeps, ctx: Ctx, personaId: string, key: string, lookId: string | null) {
  if (!ownsImage(personaFolder(ctx.org.id, personaId), key)) throw new EngineError("validation_error", "That photo does not belong to this persona. Upload it again.");
  const files = storage(deps);
  const object = await files.head(key);
  if (!object) throw new EngineError("validation_error", "The photo did not finish uploading. Try again.");
  if (object.bytes > PERSONA_MAX_IMAGE_BYTES) {
    await files.remove(key).catch(() => undefined);
    throw new EngineError("validation_error", "That photo is too large. Use one under 15 MB.");
  }
  const users = await deps.store.select(PERSONA_LOOKS_TABLE, { org_id: ctx.org.id, image_key: key }, { limit: 2 });
  if (users.some((look) => look.id !== lookId)) throw new EngineError("validation_error", "That photo is already used by another look. Upload it again.");
}

/** create_persona_look: adds a look at the end of the persona's list. */
export async function createPersonaLook(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Persona> {
  const userId = editor(ctx, "Adding a look to a persona");
  const input = parse(createPersonaLookInputSchema, raw);
  return idempotent(deps, ctx, "create_persona_look", input.operationKey, input, async () => {
    const persona = await findPersona(deps, ctx, input.personaId);
    const looks = await deps.store.select(PERSONA_LOOKS_TABLE, { persona_id: persona.id, org_id: ctx.org.id }, { limit: PERSONA_LOOK_LIMIT });
    if (looks.length >= PERSONA_LOOK_LIMIT) throw new EngineError("validation_error", `A persona can have up to ${PERSONA_LOOK_LIMIT} looks. Delete one to add another.`);
    if (input.imageKey) await claimImage(deps, ctx, persona.id, input.imageKey, null);
    const now = deps.now().toISOString();
    const look = await deps.store.insert(PERSONA_LOOKS_TABLE, {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      persona_id: persona.id,
      name: input.name,
      description: input.description,
      image_key: input.imageKey,
      position: looks.reduce((next, row) => Math.max(next, row.position + 1), 0),
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
    await deps.store.update(PERSONAS_TABLE, { id: persona.id, org_id: ctx.org.id }, { updated_at: now });
    await audit(deps, ctx, { action: "Added a look to a persona", objectId: look.id, outcome: input.imageKey ? "With a reference photo" : "Without a photo" });
    return presentOne(deps, ctx, { ...persona, updated_at: now });
  });
}

/** update_persona_look: changes its name, description or photo. Sending imageKey: null removes the photo. */
export async function updatePersonaLook(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Persona> {
  editor(ctx, "Editing a look");
  const input = parse(updatePersonaLookInputSchema, raw);
  const look = await findLook(deps, ctx, input.lookId);
  const replacing = input.imageKey !== undefined && input.imageKey !== look.image_key;
  if (replacing && input.imageKey) await claimImage(deps, ctx, look.persona_id, input.imageKey, look.id);
  const now = deps.now().toISOString();
  const patch: Row = { updated_at: now };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (replacing) patch.image_key = input.imageKey;
  // Compare-and-swap on the photo, so two edits at once cannot both think they replaced the same one.
  const [row] = await deps.store.update(PERSONA_LOOKS_TABLE, { id: look.id, org_id: ctx.org.id, image_key: look.image_key ?? null }, patch);
  if (!row) throw new EngineError("revision_conflict", "This look changed while you were editing it. Reload and try again.");
  // The old photo goes once nothing points at it. A failure leaves an unreferenced file, never a broken look.
  if (replacing && look.image_key)
    await storage(deps)
      .remove(look.image_key)
      .catch(() => console.error(JSON.stringify({ level: "error", event: "persona_photo_delete_failed", correlationId: ctx.correlationId })));
  const persona = await findPersona(deps, ctx, look.persona_id);
  await deps.store.update(PERSONAS_TABLE, { id: persona.id, org_id: ctx.org.id }, { updated_at: now });
  await audit(deps, ctx, { action: "Edited a look", objectId: look.id, outcome: `Changed ${Object.keys(patch).filter((key) => key !== "updated_at").join(", ") || "nothing"}` });
  return presentOne(deps, ctx, { ...persona, updated_at: now });
}

/** delete_persona_look: deletes the look and its photo. */
export async function deletePersonaLook(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Persona> {
  editor(ctx, "Deleting a look");
  const input = parse(personaLookRefInputSchema, raw);
  const look = await findLook(deps, ctx, input.lookId);
  // The photo first: a failure leaves the look in place, and deleting again finishes the job.
  if (look.image_key) await storage(deps).remove(look.image_key);
  await deps.store.remove(PERSONA_LOOKS_TABLE, { id: look.id, org_id: ctx.org.id });
  const now = deps.now().toISOString();
  const persona = await findPersona(deps, ctx, look.persona_id);
  await deps.store.update(PERSONAS_TABLE, { id: persona.id, org_id: ctx.org.id }, { updated_at: now });
  await audit(deps, ctx, { action: "Deleted a look", objectId: look.id, outcome: look.image_key ? "Its photo was deleted" : "It had no photo" });
  return presentOne(deps, ctx, { ...persona, updated_at: now });
}

/**
 * Called by saveLikenessConsent before it stores a consent recorded for a persona: the persona's current
 * consent id when the persona can take a new one (none yet, or the last one was withdrawn), otherwise
 * undefined. Never throws over the persona, so a consent the person just gave is never lost because of it.
 */
export async function personaAwaitingConsent(deps: EngineDeps, ctx: Ctx, personaId: string): Promise<{ id: string; current: string | null } | undefined> {
  if (!isUuid(personaId)) return undefined;
  const persona = await selectOne(deps.store, PERSONAS_TABLE, { id: personaId, org_id: ctx.org.id });
  if (!persona) return undefined;
  if (!persona.consent_id) return { id: persona.id, current: null };
  const consent = await selectOne(deps.store, CONSENTS_TABLE, { id: persona.consent_id, org_id: ctx.org.id });
  return !consent || consent.revoked_at ? { id: persona.id, current: persona.consent_id } : undefined;
}

/** Links a newly saved consent to the persona, unless another one got there first. Returns whether it did. */
export async function linkPersonaConsent(deps: EngineDeps, ctx: Ctx, target: { id: string; current: string | null }, consentId: string): Promise<boolean> {
  const [row] = await deps.store.update(PERSONAS_TABLE, { id: target.id, org_id: ctx.org.id, consent_id: target.current }, { consent_id: consentId, updated_at: deps.now().toISOString() });
  if (row) await audit(deps, ctx, { action: "Linked a consent to a persona", objectId: target.id, outcome: target.current ? "Replaced a withdrawn consent" : "The persona is ready to use" });
  return Boolean(row);
}
