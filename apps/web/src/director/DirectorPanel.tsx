import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, Check, ChevronDown, CreditCard, FileText, Paperclip, PenLine, RotateCcw, SlidersHorizontal, Video } from 'lucide-react';
import type { Campaign, ContentItem, DirectorTurnResult, StudioContext } from '@castroom/contracts';
import { ApiError } from '../data/client';
import { Mark, Notice } from '../components/ui';
import { useAutoGrow } from '../lib/use-auto-grow';
import { changedFields, type DirectorAction, type DirectorEntry, type DirectorScope } from './model';
import { planDirection, recentHistory, type DirectorTurn } from './planner';

type Result=DirectorEntry['results'][string];
type OpenTarget=NonNullable<DirectorTurnResult['open']>;
type Props={instruction:string;setInstruction:(value:string)=>void;home?:boolean;focusOnMount?:boolean;onStart?:()=>void;onCreate?:()=>void;onShowContent?:()=>void;onInspect?:()=>void;onTurn:DirectorTurn;onCreated?:(campaign:Campaign,entry:DirectorEntry)=>void;onOpen?:(target:OpenTarget)=>void;onTemplates?:()=>void;onVersions?:()=>void;onBilling?:()=>void;/** Reports a real in-flight planning request, so the canvas can show it on the item. */onBusy?:(working:boolean)=>void;item:ContentItem;campaign:Campaign;context:StudioContext;entries:DirectorEntry[];syncError:string;onRecord:(entry:DirectorEntry)=>Promise<void>;onRetrySync:()=>Promise<void>;onExecute:(action:DirectorAction,key:string,reconcile?:boolean)=>Promise<Result>;onDetails:()=>void;busy:boolean;offline:boolean;dirty:boolean};
const PENDING='Preparing your request…';
const actionTitle:Record<DirectorAction['kind'],string>={revise:'Update draft',render:'Render saved video',review_schedule:'Review schedule',checkout:'Upgrade with Stripe test checkout'};
const actionLabel:Record<DirectorAction['kind'],string>={revise:'Apply changes',render:'Start render',review_schedule:'Open review',checkout:'Open Stripe test checkout'};
const actionIcon={revise:PenLine,render:Video,review_schedule:CalendarDays,checkout:CreditCard} as const;
const fieldLabel:Record<string,string>={script:'Script',title:'Title',avatarId:'Presenter',language:'Language',style:'Style',variants:'Channel copy',targets:'Posting times'};
const jobLabel=(stage:string,state:string)=>`${stage==='publish'?'Publishing':stage==='compose'?'Composing':'Render'} · ${state.replaceAll('_',' ')}`;
function Thinking({children}:{children:string}){return <p className="director-working" role="status"><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>{children}</p>;}

export function DirectorPanel({instruction,setInstruction,home=false,focusOnMount=false,onStart,onCreate,onShowContent,onInspect,onTurn,onCreated,onOpen,onTemplates,onVersions,onBilling,onBusy,item,campaign,context,entries,syncError,onRecord,onRetrySync,onExecute,onDetails,busy,offline,dirty}:Props){
  const [scope,setScope]=useState<DirectorScope>('item');
  const [sourceIds,setSourceIds]=useState<string[]>([]);
  const [attachments,setAttachments]=useState(false);
  const [exactEdit,setExactEdit]=useState(false);
  const [replacement,setReplacement]=useState(item.script);
  const [planning,setPlanning]=useState(false);
  const [running,setRunning]=useState('');
  const [error,setError]=useState('');
  const [away,setAway]=useState(false);
  const input=useRef<HTMLTextAreaElement>(null);
  const conversation=useRef<HTMLDivElement>(null);
  const pinned=useRef(true);
  // Turns older than this were loaded from history; only fresh turns animate in.
  const mountedAt=useRef(Date.now()-1500);
  const live=context.capabilities.mode==='live';
  useAutoGrow(input,instruction,home?220:168);
  useEffect(()=>{
    const el=conversation.current;if(!el)return;
    // Follow the conversation only while the person is at the end of it; never yank them down while they read.
    if(pinned.current)el.scrollTop=el.scrollHeight;else setAway(true);
  },[entries,planning,running]);
  useEffect(()=>{onBusy?.(planning);return()=>{if(planning)onBusy?.(false);};},[planning]);
  // A request that creates its own project moves the conversation there; keep the person in the composer.
  useEffect(()=>{
    if(!focusOnMount||matchMedia('(max-width: 1000px)').matches)return;
    // After the surrounding panel has opened: opening a dialog moves focus to its first control.
    const frame=requestAnimationFrame(()=>input.current?.focus({preventScroll:true}));
    return()=>cancelAnimationFrame(frame);
  },[]);
  const active=planning||busy||!!running;
  function toLatest(){const el=conversation.current;if(!el)return;pinned.current=true;setAway(false);el.scrollTo({top:el.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
  async function plan(text:string){
    if(active||offline||!text.trim())return;
    pinned.current=true;setAway(false);setPlanning(true);setError('');onStart?.();
    const entry:DirectorEntry={id:crypto.randomUUID(),at:new Date().toISOString(),itemId:item.id,itemTitle:item.title,scope,instruction:text.trim(),sourceIds,summary:'',plan:null,results:{}};
    await onRecord({...entry,summary:PENDING});
    if(/^(show (my )?(content|videos)|list assets)$/i.test(text.trim())){entry.summary=`${campaign.items.length} saved items in this project. No generation was requested.`;await onRecord(entry);onShowContent?.();setPlanning(false);setInstruction('');return;}
    if(/^show (the )?previous version$/i.test(text.trim())){
      if(live&&onVersions){entry.summary='Opened this item’s saved versions in Details. Restoring one saves it as a new version; nothing was replaced or generated.';await onRecord(entry);onVersions();}
      else{entry.summary='Previous video playback is not available from this service yet. Your saved conversation includes prior edits; no video was replaced or generated.';await onRecord(entry);}
      setPlanning(false);setInstruction('');return;
    }
    if(/^play (the )?(latest|selected)( version| video)?$/i.test(text.trim())){entry.summary=item.media?'Opened the saved video in Details. Use the player controls to play it; no new render was requested.':'This storyboard has no playable video yet. Nothing was generated.';await onRecord(entry);if(item.media)onInspect?.();setPlanning(false);setInstruction('');return;}
    try{
      // The entry id doubles as the operation key, so a repeated submission of this turn cannot create two projects.
      const outcome=await planDirection(text,campaign,item,context,scope,sourceIds,onTurn,recentHistory(entries),entry.id);
      entry.plan=outcome.plan;entry.summary=outcome.summary.slice(0,2000);entry.mode=outcome.mode;
      if(outcome.assets.length)entry.assets=outcome.assets;
      if(outcome.suggestions.length)entry.suggestions=outcome.suggestions;
      if(outcome.created){
        // The new project keeps the full turn; this project keeps a pointer to it.
        await onRecord({...entry,plan:null,assets:undefined,suggestions:undefined,summary:`Saved as a new project, “${outcome.created.title}”, and opened it. Nothing was rendered.`});
        setPlanning(false);setInstruction('');setExactEdit(false);
        onCreated?.(outcome.created,entry);return;
      }
      await onRecord(entry);
      if(outcome.open)onOpen?.(outcome.open);
    }
    catch(e){entry.summary=e instanceof Error?e.message:'A plan could not be prepared. Nothing changed.';await onRecord(entry);}
    setPlanning(false);setInstruction('');setExactEdit(false);
  }
  function submit(event:FormEvent){event.preventDefault();void plan(instruction);}
  function suggest(prompt:string){
    if(prompt==='Choose a template'&&onTemplates){onTemplates();return;}
    if(prompt==='Create with my own script'&&onCreate){onCreate();return;}
    if(prompt==='Show my content'||prompt==='Review schedule'){void plan(prompt);return;}
    if(prompt==='Choose an avatar'){onStart?.();onDetails();return;}
    if(prompt==='Find existing content'){setInstruction('Find ');input.current?.focus();return;}
    setInstruction(prompt==='Create a video'?'Create a 15-second video about ':prompt==='Plan a campaign'?'Plan three videos for next week about ':prompt);input.current?.focus();
  }
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
      else await onRecord({...entry,results:{...entry.results,[index]:{state:e instanceof ApiError&&e.code==='unknown_outcome'?'unknown':'failed',message,...(e instanceof ApiError&&e.reviewUrl?{reviewUrl:e.reviewUrl.slice(0,300)}:{})}}});
    }finally{setRunning('');}
  }
  const latest=entries.at(-1);
  const basicMode=live&&context.capabilities.canPlanWithDirector&&context.capabilities.directorMode==='basic';
  const jobs=campaign.jobs.filter(j=>j.itemId===item.id&&['queued','running','cancel_requested','failed'].includes(j.state)).slice(0,2);
  const starters=home?['Create a video',live&&onTemplates?'Choose a template':'Choose an avatar','Plan a campaign',live?'Find existing content':'Show my content']:['Rewrite the opening','Create a 15-second Instagram Reel','Change the avatar'];
  return <section className="director-panel" aria-label="AI Creative Director">
    <div ref={conversation} onScroll={()=>{const el=conversation.current;if(!el)return;pinned.current=el.scrollHeight-el.clientHeight-el.scrollTop<60;if(pinned.current)setAway(false);}} className="director-conversation" role="log" aria-label="Project conversation" aria-live="polite" aria-relevant="additions text">
      {(home||!entries.length)&&<div className="director-intro"><span className="director-symbol" aria-hidden="true"><Mark/></span><h3>{home?"What will we create today?":"What would make this better?"}</h3><p>{home?"Describe a video. Faceful drafts it, and you shape it together.":"Ask for a change. You review every proposal before anything is saved."}</p></div>}
      {!entries.length&&<details className="director-context"><summary>What Faceful is working with <ChevronDown size={13}/></summary><p>{campaign.companyContext?.name??context.brand.name} · {campaign.items.length} storyboards · {campaign.sources.length} sources</p><p>{context.brand.rules.join(' ')||'No brand rules supplied.'}</p><p>{context.avatars.filter(a=>a.permission==='authorized').length} authorized avatars · {context.channels.filter(c=>c.state==='connected').length} connected accounts · {campaign.timezone}</p></details>}
      {!context.capabilities.canPlanWithDirector&&<p className="director-availability">AI direction isn’t connected. Exact draft edits work here; creative rewriting and production need a connected service.</p>}
      {basicMode&&<p className="director-availability">AI writing isn’t connected to this workspace yet. Exact edits, templates, finding content, credits and schedule review work now.</p>}
      {entries.map(entry=>{
        const pending=entry.summary===PENDING;
        const fresh=Date.parse(entry.at)>mountedAt.current;
        return <article className={`director-turn ${fresh?'is-new':''}`} key={entry.id}>
        <div className="director-user"><p>{entry.instruction}</p></div>
        {(entry.scope==='project'||entry.itemId!==item.id||entry.sourceIds.length>0)&&<small className="director-user-meta">{entry.scope==='project'?'Whole project':entry.itemTitle}{entry.sourceIds.length>0&&` · ${entry.sourceIds.length} source${entry.sourceIds.length===1?'':'s'} attached`}</small>}
        <div className="director-response"><span className="director-response-label"><span className="director-avatar" aria-hidden="true"><Mark/></span>Creative Director{entry.mode==='basic'&&<em>basic mode</em>}</span>
          {pending&&planning&&entry.id===latest?.id?<Thinking>Preparing a plan…</Thinking>:<p>{entry.summary}</p>}
          {!pending&&!entry.plan&&!entry.assets?.length&&entry.id===latest?.id&&<button className="text-button director-revise" onClick={()=>{setInstruction(entry.instruction);input.current?.focus();}}><RotateCcw size={12}/>Revise request</button>}
          {!!entry.assets?.length&&<ul className="director-assets" aria-label="Matching content">{entry.assets.map(asset=><li key={asset.itemId}><button className="text-button" onClick={()=>onOpen?.({campaignId:asset.campaignId,itemId:asset.itemId,play:asset.hasVideo})}><span>{asset.title}</span><small>{asset.campaignTitle} · version {asset.revision} · {asset.hasVideo?'video saved':'no video yet'}</small></button></li>)}</ul>}
          {entry.plan?.actions.map((action,index)=>{
            const target=action.kind==='revise'||action.kind==='render'?campaign.items.find(i=>i.id===action.itemId):null;
            const result=entry.results[index];const inFlight=running===`${entry.id}:${index}`;
            const complete=result&&!['failed','unknown'].includes(result.state);
            const Icon=actionIcon[action.kind];
            return <div className={`director-plan ${complete?'is-done':''} ${result?.state==='failed'?'is-failed':''}`} key={index}>
              <div className="plan-head"><span className="plan-icon" aria-hidden="true"><Icon size={14}/></span><strong>{actionTitle[action.kind]}{target?` · ${target.title}`:''}</strong></div>
              {action.kind==='revise'&&target&&<details onToggle={event=>{if(event.currentTarget.open)event.currentTarget.closest('.director-plan')?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}><summary>Review changes <ChevronDown size={12}/></summary>{changedFields(target,action.patch,result?.before).map(change=><div className="director-diff" key={change.field}><small>{fieldLabel[change.field]??change.field}</small><del>{change.before}</del><ins>{change.after}</ins></div>)}</details>}
              {action.kind==='render'&&<small>Uses generation units. Completion will be shown by the job status.</small>}
              {action.kind==='review_schedule'&&<small>Opens exact-manifest review. Publishing needs separate authorization.</small>}
              {action.kind==='checkout'&&<small>Opens Stripe’s hosted test page. Card details are never entered in Faceful, and your plan changes only after Stripe confirms.</small>}
              {result&&<p className={`director-result ${result.state==='failed'?'is-error':''}`} role="status">{complete&&<Check size={13}/>} {result.message}</p>}
              {result?.state==='failed'&&result.reviewUrl?.includes('view=billing')&&onBilling&&<button className="text-button" onClick={onBilling}>Open billing</button>}
              {inFlight?<span className="director-working" role="status"><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>Awaiting confirmation…</span>:result?.state==='unknown'&&action.kind!=='revise'?<p className="director-sync">Outcome unknown. Check the canvas job status before requesting any more work.</p>:!complete?<button className="button primary" disabled={active||offline||dirty} onClick={()=>void execute(entry,index)}>{result?.state==='unknown'?'Check saved revision':result?.state==='failed'?'Retry action':actionLabel[action.kind]}</button>:result.state==='saved'&&result.before?<button className="text-button" disabled={active||offline||dirty} onClick={()=>void execute(entry,index,true)}><RotateCcw size={13}/>Undo this change</button>:null}
            </div>;
          })}
          {entry.id===latest?.id&&!!entry.suggestions?.length&&!planning&&<div className="director-suggestions director-followups" aria-label="Suggested next steps">{entry.suggestions.map(prompt=><button key={prompt} onClick={()=>suggest(prompt)}>{prompt}</button>)}</div>}
        </div>
      </article>;})}
      {planning&&latest?.summary!==PENDING&&<Thinking>Preparing a plan…</Thinking>}
      {jobs.map(job=><p className={`director-job is-${job.state}`} key={job.id} role="status">{job.state!=='failed'&&<span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>}{jobLabel(job.stage,job.state)}{job.error?` · ${job.error.message}`:''}</p>)}
      {error&&<Notice error>{error}</Notice>}
    </div>
    {away&&<button className="director-jump" onClick={toLatest}><ArrowDown size={13}/>Latest</button>}
    <div className="director-compose-area">
      {syncError&&<p className="director-sync" role="status">{syncError} <button className="text-button" onClick={()=>void onRetrySync()}>Retry sync</button></p>}
      {dirty&&<p className="director-sync">You have unsaved Details edits. <button className="text-button" onClick={onDetails}>Save or undo them first</button>.</p>}
      {offline&&<p className="director-sync" role="status">You’re offline. Your draft stays here.</p>}
      {exactEdit?<form className="director-exact-edit" onSubmit={e=>{e.preventDefault();void plan(`Set script: ${replacement}`);}}><label htmlFor="director-script">Your replacement script</label><textarea id="director-script" value={replacement} maxLength={5000} rows={4} onChange={e=>setReplacement(e.target.value)}/><div><button className="text-button" type="button" onClick={()=>setExactEdit(false)}>Cancel</button><button className="button primary" disabled={active||offline||!replacement.trim()}>Review script change</button></div></form>:<>
        {!entries.length&&<div className="director-suggestions">{starters.map(prompt=><button key={prompt} onClick={()=>suggest(prompt)}>{prompt}</button>)}</div>}
        <form className="director-composer" onSubmit={submit} aria-busy={planning}>
          <p className="director-context-line"><i aria-hidden="true"/>{scope==='project'?<>Project · <b>{campaign.title}</b></>:<>This draft · <b>{item.title}</b></>}</p>
          <label className="sr-only" htmlFor="director-instruction">Direction for your content</label>
          <textarea ref={input} id="director-instruction" value={instruction} onChange={e=>setInstruction(e.target.value)} maxLength={5000} rows={1} placeholder={home?"Describe your next video, campaign, or idea…":"Ask for a change or something new…"} enterKeyHint="send" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void plan(instruction);}}}/>
          <div className="director-composer-actions">
            <button className="icon-button" type="button" aria-label="Attach project sources" aria-expanded={attachments} title="Attach project sources" onClick={()=>setAttachments(!attachments)}><Paperclip size={16}/>{sourceIds.length>0&&<b className="attach-count">{sourceIds.length}</b>}</button>
            <label className="sr-only" htmlFor="director-scope">Action scope</label>
            <select id="director-scope" value={scope} onChange={e=>setScope(e.target.value as DirectorScope)}><option value="item">This draft</option><option value="project">Whole project ({campaign.items.length})</option></select>
            <button className="director-send" aria-label="Prepare action plan" title="Send (Enter)" disabled={active||offline||!instruction.trim()}><ArrowUp size={17}/></button>
          </div>
        </form>
        {attachments&&<div className="director-attachments">{campaign.sources.length?campaign.sources.map(source=><label key={source.id}><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={e=>setSourceIds(ids=>e.target.checked?[...ids,source.id]:ids.filter(id=>id!==source.id))}/>{source.title}</label>):<p>No project sources yet. Add approved source material through your campaign brief.</p>}<small>Uses existing project sources. File uploads aren’t connected yet.</small></div>}
        <div className="director-quick-actions">{home&&<button className="text-button" onClick={onCreate}><PenLine size={13}/>Create with my own script</button>}{!home&&<><button className="text-button" onClick={()=>{setReplacement(item.script);setExactEdit(true);}}><FileText size={13}/>Edit script</button><button className="text-button" onClick={onDetails}><SlidersHorizontal size={13}/>Avatar & settings</button></>}<small className="director-storage">{context.capabilities.mode==='fixture'?'Saved on this device · production services unavailable':'Private to you and this workspace'}</small></div>
      </>}
    </div>
  </section>;
}
