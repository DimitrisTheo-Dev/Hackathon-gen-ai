import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Check, ChevronDown, FileText, LoaderCircle, Paperclip, RotateCcw, Sparkles } from 'lucide-react';
import type { Campaign, ContentItem, StudioContext } from '@castroom/contracts';
import { ApiError } from '../data/client';
import { Notice } from '../components/ui';
import { changedFields, type DirectorAction, type DirectorEntry, type DirectorScope } from './model';
import { planDirection } from './planner';

type Result=DirectorEntry['results'][string];
type Props={instruction:string;setInstruction:(value:string)=>void;home?:boolean;onStart?:()=>void;onCreate?:()=>void;onShowContent?:()=>void;onInspect?:()=>void;item:ContentItem;campaign:Campaign;context:StudioContext;entries:DirectorEntry[];syncError:string;onRecord:(entry:DirectorEntry)=>Promise<void>;onRetrySync:()=>Promise<void>;onExecute:(action:DirectorAction,key:string,reconcile?:boolean)=>Promise<Result>;onDetails:()=>void;busy:boolean;offline:boolean;dirty:boolean};
export function DirectorPanel({instruction,setInstruction,home=false,onStart,onCreate,onShowContent,onInspect,item,campaign,context,entries,syncError,onRecord,onRetrySync,onExecute,onDetails,busy,offline,dirty}:Props){
  const [scope,setScope]=useState<DirectorScope>('item');
  const [sourceIds,setSourceIds]=useState<string[]>([]);
  const [attachments,setAttachments]=useState(false);
  const [exactEdit,setExactEdit]=useState(false);
  const [replacement,setReplacement]=useState(item.script);
  const [planning,setPlanning]=useState(false);
  const [running,setRunning]=useState('');
  const [error,setError]=useState('');
  const input=useRef<HTMLTextAreaElement>(null);
  const conversation=useRef<HTMLDivElement>(null);
  const pinned=useRef(true);
  useEffect(()=>{if(pinned.current&&conversation.current)conversation.current.scrollTop=conversation.current.scrollHeight;},[entries,planning,running]);
  const active=planning||busy||!!running;
  async function plan(text:string){
    if(active||offline||!text.trim())return;
    pinned.current=true;setPlanning(true);setError('');onStart?.();
    const entry:DirectorEntry={id:crypto.randomUUID(),at:new Date().toISOString(),itemId:item.id,itemTitle:item.title,scope,instruction:text.trim(),sourceIds,summary:'',plan:null,results:{}};
    await onRecord({...entry,summary:'Preparing your request…'});
    if(/^(show (my )?(content|videos)|list assets)$/i.test(text.trim())){entry.summary=`${campaign.items.length} saved items in this project. No generation was requested.`;await onRecord(entry);onShowContent?.();setPlanning(false);setInstruction('');return;}
    if(/^show (the )?previous version$/i.test(text.trim())){entry.summary='Previous video playback is not available from this service yet. Your saved conversation includes prior edits; no video was replaced or generated.';await onRecord(entry);setPlanning(false);setInstruction('');return;}
    if(/^play (the )?(latest|selected)( version| video)?$/i.test(text.trim())){entry.summary=item.media?'Opened the saved video in Details. Use the player controls to play it; no new render was requested.':'This storyboard has no playable video yet. Nothing was generated.';await onRecord(entry);if(item.media)onInspect?.();setPlanning(false);setInstruction('');return;}
    try{entry.plan=await planDirection(text,campaign,item,context,scope,sourceIds);entry.summary=entry.plan.summary;}
    catch(e){entry.summary=e instanceof Error?e.message:'A plan could not be prepared. Nothing changed.';}
    await onRecord(entry);setPlanning(false);setInstruction('');setExactEdit(false);
  }
  function submit(event:FormEvent){event.preventDefault();void plan(instruction);}
  async function execute(entry:DirectorEntry,index:number,undo=false){
    if(active||offline||dirty)return;
    const action=entry.plan?.actions[index];if(!action)return;
    const previous=entry.results[index];
    const next=undo&&previous?.before&&previous.revision&&action.kind==='revise'?{kind:'revise' as const,itemId:action.itemId,expectedRevision:previous.revision,patch:previous.before}:action;
    setRunning(`${entry.id}:${index}`);setError('');
    try{
      const result=await onExecute(next,`${entry.id}:${index}:${undo?'undo':'apply'}`,previous?.state==='unknown');
      await onRecord({...entry,results:{...entry.results,[index]:undo?{...result,state:'undone',message:'Restored as a new saved revision.'}:result}});
    }catch(e){
      const message=e instanceof Error?e.message:'The action failed. Nothing was confirmed.';
      if(undo)setError(message);
      else await onRecord({...entry,results:{...entry.results,[index]:{state:e instanceof ApiError&&e.code==='unknown_outcome'?'unknown':'failed',message}}});
    }finally{setRunning('');}
  }
  return <section className="director-panel" aria-label="AI Creative Director">
    <div ref={conversation} onScroll={()=>{const el=conversation.current;if(el)pinned.current=el.scrollHeight-el.clientHeight-el.scrollTop<60;}} className="director-conversation" role="log" aria-label="Project conversation" aria-live="polite" aria-relevant="additions text">
      <div className="director-intro"><span className="director-symbol"><Sparkles size={18}/></span><h3>{home?"What will we create today?":"What would make this better?"}</h3><p>{home?"Describe your idea. Shape it with Faceful.":<>Give a direction. Review the plan.<br/>Keep control of every change.</>}</p></div>
      <details className="director-context"><summary>Working with your context <ChevronDown size={13}/></summary><p>{campaign.companyContext?.name??context.brand.name} · {campaign.items.length} storyboards · {campaign.sources.length} sources</p><p>{context.brand.rules.join(' ')||'No brand rules supplied.'}</p><p>{context.avatars.filter(a=>a.permission==='authorized').length} authorized avatars · {context.channels.filter(c=>c.state==='connected').length} connected accounts · {campaign.timezone}</p></details>
      {!context.capabilities.canPlanWithDirector&&<p className="director-availability">AI direction isn’t connected. Exact draft edits work here; creative rewriting and production need a connected service.</p>}
      {entries.map(entry=><article className="director-turn" key={entry.id}>
        <div className="director-user"><small>You · {entry.scope==='project'?'Whole project':entry.itemTitle}</small><p>{entry.instruction}</p>{entry.sourceIds.length>0&&<small>{entry.sourceIds.length} project sources attached</small>}</div>
        <div className="director-response"><span className="director-response-label"><Sparkles size={13}/>Creative Director</span><p>{entry.summary}</p>
          {!entry.plan&&<button className="text-button" onClick={()=>{setInstruction(entry.instruction);input.current?.focus();}}>Revise request</button>}
          {entry.plan?.actions.map((action,index)=>{
            const target=action.kind==='review_schedule'?null:campaign.items.find(i=>i.id===action.itemId);
            const result=entry.results[index];const inFlight=running===`${entry.id}:${index}`;
            const complete=result&&!['failed','unknown'].includes(result.state);
            return <div className="director-plan" key={index}>
              <strong>{action.kind==='revise'?'Update draft':action.kind==='render'?'Render saved video':'Review schedule'}{target?` · ${target.title}`:''}</strong>
              {action.kind==='revise'&&target&&<details><summary>Review changes <ChevronDown size={12}/></summary>{changedFields(target,action.patch,result?.before).map(change=><div className="director-diff" key={change.field}><small>{change.field}</small><del>{change.before}</del><ins>{change.after}</ins></div>)}</details>}
              {action.kind==='render'&&<small>Uses generation units. Completion will be shown by the job status.</small>}
              {action.kind==='review_schedule'&&<small>Opens exact-manifest review. Publishing needs separate authorization.</small>}
              {result&&<p className={`director-result ${result.state==='failed'?'is-error':''}`} role="status">{complete&&<Check size={13}/>} {result.message}</p>}
              {inFlight?<span className="director-working" role="status"><LoaderCircle size={14} className="spin"/>Awaiting confirmation…</span>:result?.state==='unknown'&&action.kind!=='revise'?<p className="director-sync">Outcome unknown. Check the canvas job status before requesting any more work.</p>:!complete?<button className="button primary" disabled={active||offline||dirty} onClick={()=>void execute(entry,index)}>{result?.state==='unknown'?'Check saved revision':result?.state==='failed'?'Retry action':action.kind==='revise'?'Apply changes':action.kind==='render'?'Start render':'Open review'}</button>:result.state==='saved'&&result.before?<button className="text-button" disabled={active||offline||dirty} onClick={()=>void execute(entry,index,true)}><RotateCcw size={13}/>Undo this change</button>:null}
            </div>;
          })}
        </div>
      </article>)}
      {planning&&<p className="director-working" role="status"><LoaderCircle size={14} className="spin"/>Preparing your plan…</p>}
      {campaign.jobs.filter(j=>j.itemId===item.id).map(job=><p className="director-job" key={job.id}>{job.stage} · {job.state}{job.error?` · ${job.error.message}`:''}</p>)}
      {error&&<Notice error>{error}</Notice>}
    </div>
    <div className="director-compose-area">
      {syncError&&<p className="director-sync" role="status">{syncError} <button className="text-button" onClick={()=>void onRetrySync()}>Retry sync</button></p>}
      {dirty&&<p className="director-sync">You have unsaved Details edits. <button className="text-button" onClick={onDetails}>Save or undo them first</button>.</p>}
      {offline&&<p className="director-sync" role="status">You’re offline. Your draft stays here.</p>}
      {exactEdit?<form className="director-exact-edit" onSubmit={e=>{e.preventDefault();void plan(`Set script: ${replacement}`);}}><label htmlFor="director-script">Your replacement script</label><textarea id="director-script" value={replacement} maxLength={5000} rows={4} onChange={e=>setReplacement(e.target.value)}/><div><button className="text-button" type="button" onClick={()=>setExactEdit(false)}>Cancel</button><button className="button primary" disabled={active||offline||!replacement.trim()}>Review script change</button></div></form>:<>
        {!entries.length&&<div className="director-suggestions">{(home?['Create a video','Choose an avatar','Plan a campaign','Show my content']:['Rewrite the opening','Create a 15-second Instagram Reel','Change the avatar']).map(prompt=><button key={prompt} onClick={()=>{if(prompt==='Show my content'){void plan(prompt);return;}if(prompt==='Choose an avatar'){onStart?.();onDetails();return;}setInstruction(prompt==='Create a video'?'Create a 15-second video about ':prompt==='Plan a campaign'?'Plan three videos for next week about ':prompt);input.current?.focus();}}>{prompt}</button>)}</div>}
        <div className="director-quick-actions">{home&&<button className="text-button" onClick={onCreate}>Create with my own script</button>}<button className="text-button" onClick={()=>{setReplacement(item.script);setExactEdit(true);}}><FileText size={13}/>Edit script</button><button className="text-button" onClick={onDetails}>Avatar & settings</button></div>
        <form className="director-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="director-instruction">Direction for your content</label>
          <textarea ref={input} id="director-instruction" value={instruction} onChange={e=>setInstruction(e.target.value)} maxLength={5000} rows={2} placeholder={home?"Describe your next video, campaign, or idea…":"What should we change?"} enterKeyHint="send" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void plan(instruction);}}}/>
          <div className="director-composer-actions"><button className="icon-button" type="button" aria-label="Attach project sources" aria-expanded={attachments} onClick={()=>setAttachments(!attachments)}><Paperclip size={17}/></button><label className="sr-only" htmlFor="director-scope">Action scope</label><select id="director-scope" value={scope} onChange={e=>setScope(e.target.value as DirectorScope)}><option value="item">This storyboard</option><option value="project">Whole project ({campaign.items.length})</option></select><button className="director-send" aria-label="Prepare action plan" disabled={active||offline||!instruction.trim()}><ArrowUp size={18}/></button></div>
        </form>
        {attachments&&<div className="director-attachments">{campaign.sources.length?campaign.sources.map(source=><label key={source.id}><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={e=>setSourceIds(ids=>e.target.checked?[...ids,source.id]:ids.filter(id=>id!==source.id))}/>{source.title}</label>):<p>No project sources yet. Add approved source material through your campaign brief.</p>}<small>Uses existing project sources. File uploads aren’t connected yet.</small></div>}
        <small className="director-storage">{context.capabilities.mode==='fixture'?'Saved on this device · production services unavailable':'Private to you and this workspace'}</small>
      </>}
    </div>
  </section>;
}
