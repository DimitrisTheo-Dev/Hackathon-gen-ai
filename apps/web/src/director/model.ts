import { z } from 'zod';
import { directorActionSchema, directorAssetSchema, directorPlanSchema, idSchema, patchSchema, type Campaign, type ContentItem, type DirectorAction, type DirectorPlan, type StudioContext } from '@castroom/contracts';
import { contentPatch } from '../views/editor/model';

// One definition, shared with the engine and MCP: see packages/contracts.
export { directorActionSchema, directorPlanSchema };
export type { DirectorAction, DirectorPlan };
export type DirectorScope = 'item' | 'project';
export const directorEntrySchema = z.object({
  id: z.uuid(), at: z.iso.datetime(), itemId: idSchema, itemTitle: z.string().max(120),
  scope: z.enum(['item', 'project']), instruction: z.string().max(5000),
  sourceIds: z.array(idSchema).max(20), summary: z.string().max(2000),
  plan: directorPlanSchema.nullable(),
  // Optional so conversations saved before the engine was connected still load.
  mode: z.enum(['ai','basic','local']).optional(),
  assets: z.array(directorAssetSchema).max(20).optional(),
  suggestions: z.array(z.string().max(80)).max(4).optional(),
  results: z.record(z.string(), z.object({ state: z.enum(['saved','queued','review','failed','unknown','undone']), message: z.string().max(1000), revision: z.number().int().positive().optional(), before: patchSchema.optional(), reviewUrl: z.string().max(300).optional() }).strict()),
}).strict();
export type DirectorEntry = z.infer<typeof directorEntrySchema>;

/** Literal edits only. No rewriting, model activity or provider work is simulated. */
export function localDirectorPlan(instruction: string, campaign: Campaign, selected: ContentItem, context: StudioContext, scope: DirectorScope): DirectorPlan | null {
  const text=instruction.trim();
  const items=scope==='project'?campaign.items:[selected];
  if (!items.length || items.length>3) throw new Error('Choose up to three items for a single plan.');
  let patch: z.infer<typeof patchSchema> | null=null;
  const literal=text.match(/^set (script|title):\s*([\s\S]+)$/i);
  if(literal) patch=literal[1].toLowerCase()==='script'?{script:literal[2]}:{title:literal[2]};
  const caption=text.match(/^set (instagram|tiktok|youtube) caption:\s*([\s\S]+)$/i);
  if(caption) return directorPlanSchema.parse({summary:'Replace the channel caption. Reuse the video; schedule approval must be reviewed again.',actions:items.map(item=>{
    const platform=caption[1].toLowerCase();
    if(!item.variants.some(v=>v.platform===platform)) throw new Error(`This item has no ${platform} variant.`);
    return {kind:'revise',itemId:item.id,expectedRevision:item.revision,patch:{variants:item.variants.map(v=>v.platform===platform?{...v,caption:caption[2]}:v)}};
  })});
  const avatar=text.match(/^use avatar:\s*(.+)$/i);
  if(avatar){
    const match=context.avatars.find(a=>a.permission==='authorized'&&(a.id===avatar[1]||a.name.toLowerCase()===avatar[1].toLowerCase()));
    if(!match)throw new Error('Choose an authorized avatar from Details. No matching presenter is available.');
    if(items.some(i=>!match.languages.includes(i.language)))throw new Error('This avatar does not support the current script language.');
    patch={avatarId:match.id};
  }
  if(/^(enable|disable) captions$/i.test(text))return directorPlanSchema.parse({summary:'Update burned-in caption preferences. A new composition is required before review.',actions:items.map(item=>({kind:'revise',itemId:item.id,expectedRevision:item.revision,patch:{style:{...item.style,captions:/^enable/i.test(text)}}}))});
  if(patch)return directorPlanSchema.parse({summary:'Apply your exact wording to the selected scope. Save a new revision and invalidate any previous approval.',actions:items.map(item=>({kind:'revise',itemId:item.id,expectedRevision:item.revision,patch}))});
  if(/^regenerate( (this|selected) (video|scene))?$/i.test(text))return {summary:'Render the current saved revision only. Existing campaign items are unchanged.',actions:items.map(item=>({kind:'render',itemId:item.id,expectedRevision:item.revision}))};
  if(/^review schedule$/i.test(text))return {summary:'Prepare the exact campaign schedule for review. This does not approve, schedule or publish anything.',actions:[{kind:'review_schedule',campaignId:campaign.id,expectedRevision:campaign.revision}]};
  return null;
}

/** Defense in depth. Domain service remains the authority for every execution. */
export function validateDirectorPlan(plan: unknown,campaign: Campaign,selected: ContentItem,scope: DirectorScope,context: StudioContext): DirectorPlan {
  const parsed=directorPlanSchema.parse(plan);
  const seen=new Set<string>();
  for(const action of parsed.actions){
    if(action.kind==='review_schedule'){
      if(action.campaignId!==campaign.id||action.expectedRevision!==campaign.revision)throw new Error('The campaign has changed. Prepare a new plan.');
      continue;
    }
    // Checkout touches no content. The engine checks billing permission; payment happens on Stripe's page.
    if(action.kind==='checkout')continue;
    if(seen.has(action.itemId))throw new Error('A plan must have only one action per item.');seen.add(action.itemId);
    const item=campaign.items.find(i=>i.id===action.itemId);
    if(!item||item.workspaceId!==context.workspace.id||(scope==='item'&&item.id!==selected.id))throw new Error('This action is outside the selected scope.');
    if(item.revision!==action.expectedRevision)throw new Error('This item changed. Prepare a new plan against its latest version.');
    if(item.targets.some(t=>['accepted','published','unknown','cancel_requested'].includes(t.state)))throw new Error('A destination has already been submitted. Reconcile or cancel it before editing.');
    if(!context.principal.scopes.includes('content:edit'))throw new Error('Content editing access is required.');
    if(action.kind==='revise'&&action.patch.avatarId){
      const avatar=context.avatars.find(a=>a.id===action.patch.avatarId&&a.permission==='authorized');
      if(!avatar||!avatar.languages.includes(action.patch.language??item.language))throw new Error('The selected avatar or language is not authorized.');
    }
    if(action.kind==='render'&&(!context.capabilities.canRender||!context.principal.scopes.includes('render:write')))throw new Error('Rendering is unavailable in this workspace.');
  }
  return parsed;
}
export function changedFields(item: ContentItem, patch: z.infer<typeof patchSchema>, before?: z.infer<typeof patchSchema>) {
  return Object.entries(patch).map(([field,after])=>({field,before:JSON.stringify(before?.[field as keyof typeof before]??item[field as keyof ContentItem],null,2),after:typeof after==='string'?after:JSON.stringify(after,null,2)}));
}
export function restorePatch(before: ContentItem, after: ContentItem) { return contentPatch(after,before); }

/** Stable across reloads/devices. Replaying a recorded action retains its identity. */
export async function directorOperationKey(intent:string):Promise<string> {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('castroom-director-v1:'+intent)));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes.slice(0,16)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
/** Notes are append-only in Supabase. A late snapshot cannot regress a receipt. */
export function mergeDirectorEntry(old:DirectorEntry|undefined,next:DirectorEntry):DirectorEntry {
  if(!old)return next;
  const priority={failed:0,unknown:1,review:2,queued:2,saved:2,undone:3};
  const results={...old.results};
  for(const [key,result] of Object.entries(next.results))if(!results[key]||priority[result.state]>=priority[results[key].state])results[key]=result;
  return {...old,...next,plan:next.plan??old.plan,results};
}
