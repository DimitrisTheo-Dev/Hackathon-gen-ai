import { useEffect, useMemo, useState } from 'react';
import type { Campaign, StudioContext } from '@castroom/contracts';
import { createDirectorStore } from './store';
import { mergeDirectorEntry, type DirectorEntry } from './model';
export function useDirectorHistory(context:StudioContext|null,campaign:Campaign|null) {
  const [all,setAll]=useState<Record<string,DirectorEntry[]>>({});
  const [errors,setErrors]=useState<Record<string,string>>({});
  const store=useMemo(()=>createDirectorStore(context?.capabilities.mode==='fixture'),[context?.capabilities.mode]);
  const key=context&&campaign?`${context.workspace.id}/${campaign.id}`:'';
  useEffect(()=>{
    if(!context||!campaign)return;
    let active=true;
    void store.load(context.workspace.id,campaign.id).then(entries=>{
      if(!active)return;
      setAll(prev=>({...prev,[key]:mergeEntries([...entries,...(prev[key]??[])])}));
      setErrors(prev=>({...prev,[key]:''}));
    }).catch(()=>{if(active)setErrors(prev=>({...prev,[key]:'Conversation sync is unavailable. Messages are kept in this tab; retry sync when access is restored.'}));});
    return ()=>{active=false};
  },[key,store]);
  async function record(entry:DirectorEntry){
    if(!context||!campaign)return;
    setAll(prev=>({...prev,[key]:mergeEntries([...(prev[key]??[]),entry])}));
    try{await store.save(context.workspace.id,campaign.id,entry);setErrors(prev=>({...prev,[key]:''}));}
    catch{setErrors(prev=>({...prev,[key]:'Conversation could not sync. Your messages remain in this tab.'}));}
  }
  async function retry(){for(const e of all[key]??[])await record(e);}
  /** Records a turn under another project — used when a request creates the project it belongs to. */
  async function recordFor(campaignId:string,entry:DirectorEntry){
    if(!context)return;
    const target=`${context.workspace.id}/${campaignId}`;
    setAll(prev=>({...prev,[target]:mergeEntries([...(prev[target]??[]),entry])}));
    try{await store.save(context.workspace.id,campaignId,entry);setErrors(prev=>({...prev,[target]:''}));}
    catch{setErrors(prev=>({...prev,[target]:'Conversation could not sync. Your messages remain in this tab.'}));}
  }
  return {entries:all[key]??[],error:errors[key]??'',record,retry,recordFor};
}

function mergeEntries(entries:DirectorEntry[]){const result=new Map<string,DirectorEntry>();for(const entry of entries)result.set(entry.id,mergeDirectorEntry(result.get(entry.id),entry));return [...result.values()].sort((a,b)=>a.at.localeCompare(b.at));}
