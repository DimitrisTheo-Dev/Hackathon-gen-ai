import { directorPlanSchema, localDirectorPlan, validateDirectorPlan, type DirectorScope } from './model';
import type { Campaign, ContentItem, StudioContext } from '@castroom/contracts';
import { supabase } from '../lib/supabase';
export async function planDirection(instruction:string,campaign:Campaign,item:ContentItem,context:StudioContext,scope:DirectorScope,sourceIds:string[]) {
  const local=localDirectorPlan(instruction,campaign,item,context,scope);
  if(local)return validateDirectorPlan(local,campaign,item,scope,context);
  if(!context.capabilities.canPlanWithDirector)throw new Error('AI direction is not connected yet. You can apply exact script, title or caption edits here, or continue with your connected agent.');
  const base=import.meta.env.VITE_CASTROOM_API_URL;
  if(!base||!supabase)throw new Error('The creative service is unavailable. Your content is unchanged.');
  const origin=new URL(base);if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash)throw new Error('The creative service address is not secure.');
  const {data}=await supabase.auth.getSession();
  if(!data.session)throw new Error('Sign in to continue.');
  const response=await fetch(`${base.replace(/\/$/,'')}/v1/studio/director/plan`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${data.session.access_token}`},credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000),body:JSON.stringify({campaignId:campaign.id,itemId:item.id,expectedRevision:item.revision,scope,instruction,sourceIds,operationKey:crypto.randomUUID()})});
  if(!response.ok)throw new Error('The creative service could not prepare a plan. Nothing was changed. Try again.');
  return validateDirectorPlan(directorPlanSchema.parse(await response.json()),campaign,item,scope,context);
}
