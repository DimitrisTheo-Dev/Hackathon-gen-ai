import { localDirectorPlan, validateDirectorPlan, type DirectorEntry, type DirectorPlan, type DirectorScope } from './model';
import type { Campaign, ContentItem, DirectorTurnInput, DirectorTurnResult, StudioContext } from '@castroom/contracts';

export type DirectorTurn = (input: DirectorTurnInput) => Promise<DirectorTurnResult>;
export type DirectorOutcome = {
  /** "local": matched an exact instruction in the browser. Otherwise whatever the engine reported. */
  mode: 'local' | 'ai' | 'basic';
  summary: string;
  plan: DirectorPlan | null;
  created: Campaign | null;
  open: DirectorTurnResult['open'];
  assets: DirectorTurnResult['assets'];
  suggestions: string[];
};
/** Earlier turns give the director continuity. They are conversation, never authority. */
export function recentHistory(entries: DirectorEntry[], limit = 6): DirectorTurnInput['history'] {
  return entries.filter(entry=>entry.summary&&entry.summary!=='Preparing your request…').slice(-limit).map(entry=>({instruction:entry.instruction.slice(0,5000),summary:entry.summary.slice(0,1000)}));
}
/**
 * Exact instructions are planned instantly in the browser. Everything else goes to the shared engine,
 * which may save drafts or open existing content, and returns any change as a plan for review.
 */
export async function planDirection(instruction:string,campaign:Campaign,item:ContentItem,context:StudioContext,scope:DirectorScope,sourceIds:string[],turn:DirectorTurn,history:DirectorTurnInput['history'],operationKey:string):Promise<DirectorOutcome> {
  const local=localDirectorPlan(instruction,campaign,item,context,scope);
  if(local){const plan=validateDirectorPlan(local,campaign,item,scope,context);return {mode:'local',summary:plan.summary,plan,created:null,open:null,assets:[],suggestions:[]};}
  if(!context.capabilities.canPlanWithDirector)throw new Error('AI direction is not connected yet. You can apply exact script, title or caption edits here, or continue with your connected agent.');
  const result=await turn({campaignId:campaign.id,itemId:item.id,scope,instruction,sourceIds,history,operationKey});
  // The engine already authorised the plan; this re-check guards against a project that changed while it was drafted.
  const plan=result.plan?validateDirectorPlan(result.plan,campaign,item,scope,context):null;
  return {mode:result.mode,summary:result.summary,plan,created:result.created,open:result.open,assets:result.assets,suggestions:result.suggestions};
}
