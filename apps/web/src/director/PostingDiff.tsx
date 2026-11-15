import { ArrowRight, Globe, Minus, Plus, UserRound } from 'lucide-react';
import type { Platform, StudioContext } from '@castroom/contracts';
import { PlatformIcon, dateLabel } from '../components/ui';
import type { PostingChange } from './model';

const platformName:Record<string,string>={instagram:'Instagram',tiktok:'TikTok',youtube:'YouTube'};
const stateName:Record<PostingChange['state'],string>={added:'New',removed:'Removed',moved:'Moved',account:'Account changes',same:'Unchanged'};

/** A proposal's posting times as one quiet line per post: channel, when, and what changes. */
export function PostingDiff({rows,channels}:{rows:PostingChange[];channels:StudioContext['channels']}){
  const zones=[...new Set(rows.map(row=>(row.after??row.before)!.timezone))];
  const one=zones.length===1;
  const when=(t:{scheduledAt:string;timezone:string})=>`${dateLabel(t.scheduledAt,t.timezone)}${one?'':` ${t.timezone.split('/').at(-1)?.replaceAll('_',' ')}`}`;
  const account=(id:string|null|undefined)=>id?channels.find(c=>c.id===id)?.displayName??'another account':'no account';
  return <div className="posting-diff">
    <ul>{rows.map((row,index)=>{
      const shown=(row.after??row.before)!;
      return <li key={index} data-state={row.state}>
        <span className="posting-platform" title={platformName[row.platform]??row.platform}><PlatformIcon platform={row.platform as Platform}/></span>
        <span className="sr-only">{platformName[row.platform]??row.platform}, {stateName[row.state]}: </span>
        <span className="posting-when">
          {row.state==='moved'&&<><s>{when(row.before!)}</s><ArrowRight size={11} aria-label="to"/></>}
          {row.state==='removed'?<s>{when(shown)}</s>:<time dateTime={shown.scheduledAt}>{when(shown)}</time>}
        </span>
        {row.state==='account'&&<small className="posting-account"><UserRound size={11} aria-hidden="true"/>{account(row.before?.accountId)} → {account(row.after?.accountId)}</small>}
        <span className="posting-mark" title={stateName[row.state]} aria-hidden="true">{row.state==='added'?<Plus size={12}/>:row.state==='removed'?<Minus size={12}/>:null}</span>
      </li>;
    })}</ul>
    {one&&<small className="posting-zone"><Globe size={11} aria-hidden="true"/>{zones[0]!.replaceAll('_',' ')}</small>}
  </div>;
}
