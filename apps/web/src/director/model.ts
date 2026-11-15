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
  if(caption) return directorPlanSchema.parse({summary:'I’ll replace the caption with your exact wording. The video is reused; the schedule needs a fresh review.',actions:items.map(item=>{
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
  const captions=text.match(/^(enable|disable|show|hide)( burned-in)? captions$/i);
  if(captions){const on=/^(enable|show)$/i.test(captions[1]);return directorPlanSchema.parse({summary:`I’ll turn burned-in captions ${on?'on':'off'}. The video needs a new composition before review.`,actions:items.map(item=>({kind:'revise',itemId:item.id,expectedRevision:item.revision,patch:{style:{...item.style,captions:on}}}))});}
  if(patch)return directorPlanSchema.parse({summary:`${patch.avatarId?'I’ll switch the presenter.':'I’ll use your exact wording.'} Applying saves a new version and resets any earlier approval.`,actions:items.map(item=>({kind:'revise',itemId:item.id,expectedRevision:item.revision,patch}))});
  if(/^regenerate( (this|selected) (video|scene))?$/i.test(text))return {summary:'I’ll render the current saved version only. Nothing else in the campaign changes.',actions:items.map(item=>({kind:'render',itemId:item.id,expectedRevision:item.revision}))};
  if(/^review schedule$/i.test(text))return {summary:'Here is the exact schedule to review. Opening it doesn’t approve, schedule or publish anything.',actions:[{kind:'review_schedule',campaignId:campaign.id,expectedRevision:campaign.revision}]};
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
const platformLabel:Record<string,string>={instagram:'Instagram',tiktok:'TikTok',youtube:'YouTube'};
const partLabel:Record<string,string>={title:'title',caption:'caption',visibility:'visibility',aiDisclosure:'AI disclosure',accountId:'account',captions:'Captions',captionPosition:'Caption position',brandColor:'Brand color'};
const positionLabel:Record<string,string>={bottom:'Lower third',center:'Center'};
function readable(value:unknown,key=''):string {
  if(value===null||value===undefined)return 'None';
  if(typeof value==='boolean')return value?'On':'Off';
  if(typeof value==='string')return value===''?'Empty':key==='captionPosition'?positionLabel[value]??value:value;
  return JSON.stringify(value,null,2);
}
type Change={field:string;before:string;after:string};
/**
 * What a proposal changes, as plain before/after text. Channel copy and style are broken down to
 * the parts that actually differ ("Instagram caption"), so a diff never shows a wall of JSON.
 */
export function changedFields(item: ContentItem, patch: z.infer<typeof patchSchema>, before?: z.infer<typeof patchSchema>): Change[] {
  return Object.entries(patch).flatMap(([field,after]):Change[]=>{
    const prior:unknown=before?.[field as keyof typeof before]??item[field as keyof ContentItem];
    if(field==='variants'&&Array.isArray(after)&&Array.isArray(prior)){
      const parts=(after as Array<Record<string,unknown>>).flatMap(next=>{
        const old=(prior as Array<Record<string,unknown>>).find(candidate=>candidate.platform===next.platform);
        return Object.keys(partLabel).filter(key=>key in next&&next[key]!==old?.[key]).map(key=>({field:`${platformLabel[String(next.platform)]??String(next.platform)} ${partLabel[key]}`,before:readable(old?.[key],key),after:readable(next[key],key)}));
      });
      if(parts.length)return parts;
    }
    if(field==='style'&&after&&prior&&typeof after==='object'&&typeof prior==='object'){
      const next=after as Record<string,unknown>,old=prior as Record<string,unknown>;
      const parts=Object.keys(next).filter(key=>next[key]!==old[key]).map(key=>({field:partLabel[key]??key,before:readable(old[key],key),after:readable(next[key],key)}));
      if(parts.length)return parts;
    }
    return [{field,before:readable(prior),after:readable(after)}];
  });
}
export function restorePatch(before: ContentItem, after: ContentItem) { return contentPatch(after,before); }

/** Stable across reloads/devices. Replaying a recorded action retains its identity. */
export async function directorOperationKey(intent:string):Promise<string> {
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('castroom-director-v1:'+intent)));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
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

/* ───────────── Home composer preferences ───────────── */
export type PromptPreferences = { format?: string; length?: string; language?: string; presenter?: string };
export const FORMAT_OPTIONS = [
  { value: 'reel', label: 'Reel', words: 'an Instagram Reel' },
  { value: 'short', label: 'Short', words: 'a YouTube Short' },
  { value: 'tiktok', label: 'TikTok', words: 'a TikTok' },
] as const;
export const LENGTH_OPTIONS = [
  { value: '15', label: '15s', words: '15 seconds' },
  { value: '30', label: '30s', words: '30 seconds' },
  { value: '60', label: '60s', words: '60 seconds' },
] as const;
export const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English', words: 'in English' },
  { value: 'el', label: 'Greek', words: 'in Greek' },
] as const;
/** Exact instructions are planned word for word, so preferences never change their meaning. */
const EXACT=/^(set\s+(script|title|instagram caption|tiktok caption|youtube caption)\s*:|use avatar\s*:|(enable|disable|show|hide)( burned-in)? captions$|regenerate\b|review schedule$|show (my )?(content|videos)$|list assets$|show (the )?previous version$|play (the )?(latest|selected))/i;
/**
 * What is actually sent: the person's words, followed by the preferences they picked as plain words
 * ("— an Instagram Reel, 15 seconds, in Greek"). The conversation shows exactly this text.
 */
export function withPreferences(text: string, prefs: PromptPreferences, presenterName = ''): string {
  const trimmed=text.trim();
  if(!trimmed||EXACT.test(trimmed))return trimmed;
  const parts=[
    FORMAT_OPTIONS.find(option=>option.value===prefs.format)?.words,
    LENGTH_OPTIONS.find(option=>option.value===prefs.length)?.words,
    LANGUAGE_OPTIONS.find(option=>option.value===prefs.language)?.words,
    prefs.presenter&&presenterName?`presented by ${presenterName}`:undefined,
  ].filter(Boolean);
  return parts.length?`${trimmed} — ${parts.join(', ')}`.slice(0,5000):trimmed;
}

/* ───────────── Hand-off to the person's own agent ───────────── */
/** True for a turn the director declined because no model writes here (basic mode or the local studio). */
export function writingDeclined(entry: Pick<DirectorEntry,'summary'|'plan'|'assets'|'mode'>): boolean {
  if(entry.plan||entry.assets?.length||entry.mode==='ai'||entry.mode==='local')return false;
  return /\b(isn[’']t|is not|not) connected\b/i.test(entry.summary)&&/\b(writ\w*|draft\w*|direction|rewrit\w*)\b/i.test(entry.summary);
}
/** True when a request asks for new videos rather than a change to the draft in view. */
export function requestsNewContent(text: string): boolean {
  const ask=text.trim();
  return /^(create|plan|generate|produce|start)\b/i.test(ask)
    ||/^(make|write|draft)\s+(a|an|one|two|three|\d+)\b[^.]*\b(videos?|reels?|shorts?|tiktoks?|campaign|scripts?)\b/i.test(ask)
    ||/^(a|an|one|two|three|\d+)\b[^.]*\b(videos?|reels?|shorts?|tiktoks?|campaign)\b/i.test(ask);
}
/** The request as a prompt the person can paste into their own agent, which works through Faceful's MCP tools. */
export function handoffPrompt(request: string, scope: { campaignTitle?: string; itemTitle?: string } = {}): string {
  const said=request.trim().replace(/\s+/g,' ');
  const ask=/[.!?…]$/.test(said)?said:`${said}.`;
  // A request for something new gets a new project; anything else is a revision of the draft in view.
  if(scope.campaignTitle&&scope.itemTitle&&!requestsNewContent(ask))
    return `In my Faceful project “${scope.campaignTitle}”, use the Faceful tools to revise the draft “${scope.itemTitle}”: ${ask}\nKeep it short enough for a 15-second presenter video and save it as a new version with revise_draft. Don’t render, schedule or publish anything. Tell me what changed.`;
  return `Using the Faceful tools, create a project for this request: ${ask}\nWrite 1–3 short presenter scripts (about 15 seconds each) and save them as drafts with create_project and create_draft. Don’t render, schedule or publish anything. Tell me what you created.`;
}
/** An agent connection that is live and has called Faceful within the last week. */
export function agentSeenRecently(connections: StudioContext['connections'], now = Date.now()): boolean {
  return connections.some(connection=>!connection.revokedAt&&Date.parse(connection.expiresAt)>now&&connection.lastSeenAt!==null&&now-Date.parse(connection.lastSeenAt)<7*24*3600*1000);
}
