import { z } from 'zod';
import { supabase } from '../lib/supabase';
import { directorEntrySchema, mergeDirectorEntry, type DirectorEntry } from './model';
export interface DirectorStore { load(workspaceId: string,campaignId:string):Promise<DirectorEntry[]>; save(workspaceId:string,campaignId:string,entry:DirectorEntry):Promise<void> }
export function createDirectorStore(local: boolean): DirectorStore {
  const key=(w:string,c:string)=>`castroom:director:v1:${encodeURIComponent(w)}:${encodeURIComponent(c)}`;
  return {
    async load(workspaceId,campaignId) {
      if(local)return z.array(directorEntrySchema).parse(JSON.parse(localStorage.getItem(key(workspaceId,campaignId))??'[]'));
      if(!supabase)throw new Error('Sign in to save your conversation.');
      const {data:user,error:authError}=await supabase.auth.getUser();
      if(authError||!user.user)throw new Error('Sign in to save your conversation.');
      const {data,error}=await supabase.from('castroom_director_entries').select('body').eq('user_id',user.user.id).eq('workspace_id',workspaceId).eq('campaign_id',campaignId).order('created_at',{ascending:false}).limit(100);
      if(error)throw new Error('Conversation sync is unavailable. Your messages remain in this tab.');
      const entries=z.array(directorEntrySchema).parse(data.map(row=>row.body)).reverse();
      const merged=new Map<string,DirectorEntry>();for(const entry of entries)merged.set(entry.id,mergeDirectorEntry(merged.get(entry.id),entry));return [...merged.values()];
    },
    async save(workspaceId,campaignId,entry) {
      directorEntrySchema.parse(entry);
      if(local){const existing=await this.load(workspaceId,campaignId);localStorage.setItem(key(workspaceId,campaignId),JSON.stringify([...existing.filter(e=>e.id!==entry.id),mergeDirectorEntry(existing.find(e=>e.id===entry.id),entry)].slice(-100)));return;}
      if(!supabase)throw new Error('Sign in to save your conversation.');
      const {data:user,error:authError}=await supabase.auth.getUser();
      if(authError||!user.user)throw new Error('Sign in to save your conversation.');
      const {error}=await supabase.from('castroom_director_entries').insert({id:crypto.randomUUID(),entry_id:entry.id,user_id:user.user.id,workspace_id:workspaceId,campaign_id:campaignId,body:entry});
      if(error)throw new Error('Conversation sync is unavailable. Your messages remain in this tab.');
    }
  };
}
