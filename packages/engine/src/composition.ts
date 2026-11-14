import {
  compositionDocumentSchema,
  compositionSchema,
  draftComposition,
  referencedFileIds,
  saveCompositionInputSchema,
  type CompositionDocument,
} from "../../contracts/src/index.js";
import { audit, idempotent, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import { assertFilesReady, resolveFiles } from "./files.js";
import { selectOne } from "./store.js";
import { getItem, loadItem, parse } from "./studio.js";

/**
 * Reel timelines: the Remotion edit over a content item (video layers, audio, cards, captions,
 * transcript). Kept apart from the item's own revision on purpose: editing the timeline never
 * invalidates the rendered presenter clip, an approval or a schedule.
 */
export const COMPOSITIONS_TABLE = "video_compositions";

export async function getComposition(deps: EngineDeps, ctx: Ctx, itemId: string): Promise<CompositionDocument> {
  requireScope(ctx, "campaign:read");
  // getItem applies the workspace filter, so an item from another workspace is simply not found.
  const item = await getItem(deps, ctx, itemId);
  const row = await selectOne(deps.store, COMPOSITIONS_TABLE, { org_id: ctx.org.id, item_id: item.id });
  const stored = row ? compositionSchema.safeParse(row.composition) : null;
  // A saved timeline in an older shape is replaced by a fresh draft; its revision is kept so the next save still applies.
  const composition = stored?.success
    ? stored.data
    : draftComposition({
        title: item.title,
        script: item.script,
        brandColor: item.style.brandColor,
        captionPosition: item.style.captionPosition,
        mediaDurationSeconds: item.media?.durationSeconds ?? null,
      });
  return parse(compositionDocumentSchema, {
    itemId: item.id,
    campaignId: item.campaignId,
    itemRevision: item.revision,
    revision: row?.revision ?? 0,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    composition,
    itemMedia: item.media ? { url: item.media.url, mime: "video/mp4", expiresAt: item.media.expiresAt, durationSeconds: item.media.durationSeconds, name: `${item.title} (rendered presenter)` } : null,
    files: await resolveFiles(deps, ctx.org.id, item.campaignId, referencedFileIds(composition), deps.config.mediaUrlTtlSeconds),
  });
}

export async function saveComposition(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<CompositionDocument> {
  requireScope(ctx, "content:edit");
  // The saved result is read back, so a caller that cannot read the workspace is refused before anything is written.
  requireScope(ctx, "campaign:read");
  const input = parse(saveCompositionInputSchema, raw);
  return idempotent(deps, ctx, "save_composition", input.operationKey, input, async () => {
    const item = await loadItem(deps, ctx, input.contentId);
    if (item.kind !== "avatar_video") throw new EngineError("unsupported", "Only presenter videos can be edited in the video studio.");
    // Every file the timeline points at must be a ready draft of this same project.
    await assertFilesReady(deps, ctx, item.project_id, referencedFileIds(input.composition));
    const existing = await selectOne(deps.store, COMPOSITIONS_TABLE, { org_id: ctx.org.id, item_id: item.id });
    const conflict = () => new EngineError("revision_conflict", "This video edit changed after you opened it. Reload the latest version before saving.");
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw conflict();
    const now = deps.now().toISOString();
    const revision = input.expectedRevision + 1;
    if (!existing) {
      try {
        await deps.store.insert(COMPOSITIONS_TABLE, {
          id: crypto.randomUUID(),
          org_id: ctx.org.id,
          project_id: item.project_id,
          item_id: item.id,
          revision,
          composition: input.composition,
          updated_by: ctx.actorId,
          created_at: now,
          updated_at: now,
        });
      } catch (error) {
        // Two first saves raced; the unique (org_id, item_id) key picked the winner.
        if (error instanceof StoreConflict) throw conflict();
        throw error;
      }
    } else {
      // Compare-and-swap on the revision is the commit point: exactly one concurrent editor wins.
      const updated = await deps.store.update(COMPOSITIONS_TABLE, { id: existing.id, org_id: ctx.org.id, revision: input.expectedRevision }, {
        revision,
        composition: input.composition,
        updated_by: ctx.actorId,
        updated_at: now,
      });
      if (!updated.length) throw conflict();
    }
    const { video, audio, cards, captions } = input.composition;
    const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    await audit(deps, ctx, {
      projectId: item.project_id,
      action: "Saved the video edit",
      objectId: item.id,
      revision,
      outcome: `${count(video.length, "video clip")}, ${count(audio.length, "audio clip")}, ${count(cards.length, "card")}, ${count(captions.length, "caption")}`,
    });
    return getComposition(deps, ctx, item.id);
  });
}
