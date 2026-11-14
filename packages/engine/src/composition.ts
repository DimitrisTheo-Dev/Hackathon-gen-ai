import {
  compositionDocumentSchema,
  draftComposition,
  saveCompositionInputSchema,
  type CompositionDocument,
} from "../../contracts/src/index.js";
import { audit, idempotent, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import { selectOne } from "./store.js";
import { getItem, loadItem, parse } from "./studio.js";

/**
 * Video compositions: the Remotion edit layer over a content item (captions, cards, b-roll, music).
 * Kept apart from the item's own revision on purpose: editing the composition never invalidates the
 * rendered presenter clip, an approval or a schedule. Preview only in this build; nothing here renders.
 */
const TABLE = "video_compositions";

export async function getComposition(deps: EngineDeps, ctx: Ctx, itemId: string): Promise<CompositionDocument> {
  requireScope(ctx, "campaign:read");
  // getItem applies the workspace filter, so an item from another workspace is simply not found.
  const item = await getItem(deps, ctx, itemId);
  const row = await selectOne(deps.store, TABLE, { org_id: ctx.org.id, item_id: item.id });
  const composition = row
    ? row.composition
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
    presenterMedia: item.media ? { url: item.media.url, expiresAt: item.media.expiresAt, durationSeconds: item.media.durationSeconds } : null,
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
    const existing = await selectOne(deps.store, TABLE, { org_id: ctx.org.id, item_id: item.id });
    const conflict = () => new EngineError("revision_conflict", "This video edit changed after you opened it. Reload the latest version before saving.");
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw conflict();
    const now = deps.now().toISOString();
    const revision = input.expectedRevision + 1;
    if (!existing) {
      try {
        await deps.store.insert(TABLE, {
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
      const updated = await deps.store.update(TABLE, { id: existing.id, org_id: ctx.org.id, revision: input.expectedRevision }, {
        revision,
        composition: input.composition,
        updated_by: ctx.actorId,
        updated_at: now,
      });
      if (!updated.length) throw conflict();
    }
    const { captions, cards, broll } = input.composition;
    await audit(deps, ctx, {
      projectId: item.project_id,
      action: "Saved the video edit",
      objectId: item.id,
      revision,
      outcome: `${captions.length} caption${captions.length === 1 ? "" : "s"}, ${cards.length} card${cards.length === 1 ? "" : "s"}, ${broll.length} b-roll clip${broll.length === 1 ? "" : "s"}`,
    });
    return getComposition(deps, ctx, item.id);
  });
}
