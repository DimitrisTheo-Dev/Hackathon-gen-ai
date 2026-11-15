import { useContext, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, CalendarDays, Check, ChevronDown, CreditCard, FileText, LayoutGrid, LayoutTemplate, Paperclip, PenLine, RotateCcw, Search, UserRound, Video } from 'lucide-react';
import type { Campaign, ContentItem, DirectorTurnResult, LibraryTemplate, StudioContext } from '@castroom/contracts';
import { ApiError } from '../data/client';
import { Mark, Notice } from '../components/ui';
import { useAutoGrow } from '../lib/use-auto-grow';
import { agentSeenRecently, changedFields, handoffPrompt, withPreferences, writingDeclined, type DirectorAction, type DirectorEntry, type DirectorScope, type PromptPreferences } from './model';
import { AgentHandoff } from './AgentHandoff';
import { PromptCycle, PromptTokens } from './HomeComposer';
import { FormatPill, FormatStrip, FormatsContext, formatBrief, homeFormats, withFormat } from './HomeFormats';
import { AttachmentPills, SourceTray, ViewLink } from './Sources';
import { Preview } from '../components/ui';
import { planDirection, recentHistory, type DirectorTurn } from './planner';

type Result=DirectorEntry['results'][string];
type OpenTarget=NonNullable<DirectorTurnResult['open']>;
type Props={instruction:string;setInstruction:(value:string)=>void;home?:boolean;focusOnMount?:boolean;onStart?:()=>void;onCreate?:()=>void;onShowContent?:()=>void;onInspect?:()=>void;onTurn:DirectorTurn;onCreated?:(campaign:Campaign,entry:DirectorEntry)=>void;onOpen?:(target:OpenTarget)=>void;onTemplates?:()=>void;onVersions?:()=>void;/** Opens Details on the presenter controls. */onPresenter?:()=>void;/** Switches the studio to Agents / Brand & sources in place; without it the links navigate. */onAgents?:()=>void;onSources?:()=>void;onBilling?:()=>void;/** Reports a real in-flight planning request, so the canvas can show it on the item. */onBusy?:(working:boolean)=>void;item:ContentItem;campaign:Campaign;context:StudioContext;entries:DirectorEntry[];syncError:string;onRecord:(entry:DirectorEntry)=>Promise<void>;onRetrySync:()=>Promise<void>;onExecute:(action:DirectorAction,key:string,reconcile?:boolean)=>Promise<Result>;onDetails:()=>void;busy:boolean;offline:boolean;dirty:boolean};
const PENDING='Preparing your request…';
const actionTitle:Record<DirectorAction['kind'],string>={revise:'Update draft',render:'Render saved video',review_schedule:'Review schedule',checkout:'Upgrade with Stripe test checkout'};
const actionLabel:Record<DirectorAction['kind'],string>={revise:'Apply changes',render:'Start render',review_schedule:'Open review',checkout:'Open Stripe test checkout'};
const actionIcon={revise:PenLine,render:Video,review_schedule:CalendarDays,checkout:CreditCard} as const;
const fieldLabel:Record<string,string>={script:'Script',title:'Title',avatarId:'Presenter',language:'Language',style:'Style',variants:'Channel copy',targets:'Posting times'};
const jobLabel=(stage:string,state:string)=>`${stage==='publish'?'Publishing':stage==='compose'?'Composing':'Render'} · ${state.replaceAll('_',' ')}`;
const starterIcon:Record<string,typeof Video>={'Create a video':Video,'Choose a template':LayoutTemplate,'Choose an avatar':UserRound,'Plan a campaign':CalendarDays,'Find existing content':Search,'Show my content':LayoutGrid};
const count=(n:number,word:string)=>`${n} ${word}${n===1?'':'s'}`;
function Thinking({children}:{children:string}){return <p className="director-working" role="status"><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>{children}</p>;}

export function DirectorPanel({instruction,setInstruction,home=false,focusOnMount=false,onStart,onCreate,onShowContent,onInspect,onTurn,onCreated,onOpen,onTemplates,onVersions,onPresenter,onAgents,onSources,onBilling,onBusy,item,campaign,context,entries,syncError,onRecord,onRetrySync,onExecute,onDetails,busy,offline,dirty}:Props){
  const [scope,setScope]=useState<DirectorScope>('item');
  const [format,setFormat]=useState<LibraryTemplate|null>(null);
  const {formats,onAll:onAllFormats}=useContext(FormatsContext);
  const [sourceIds,setSourceIds]=useState<string[]>([]);
  const [attachments,setAttachments]=useState(false);
  const [exactEdit,setExactEdit]=useState(false);
  const [replacement,setReplacement]=useState(item.script);
  const [planning,setPlanning]=useState(false);
  const [running,setRunning]=useState('');
  const [error,setError]=useState('');
  const [away,setAway]=useState(false);
  // The context chip: closed by default; a keyboard toggle opens it without animation.
  const [about,setAbout]=useState({open:false,instant:false});
  const [prefs,setPrefs]=useState<PromptPreferences>({});
  const trayFocus=useRef(false);
  const [trayInstant,setTrayInstant]=useState(false);
  const clip=useRef<HTMLButtonElement>(null);
  // Turns sent from the home composer ask for something new, even after the panel docks beside a draft.
  const fromHome=useRef(new Set<string>());
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
  useEffect(()=>{if(attachments&&trayFocus.current){trayFocus.current=false;document.querySelector<HTMLElement>('#director-sources .source-card, #director-sources a')?.focus({preventScroll:true});}},[attachments]);
  const active=planning||busy||!!running;
  function toLatest(){const el=conversation.current;if(!el)return;pinned.current=true;setAway(false);el.scrollTo({top:el.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}
  async function plan(text:string){
    if(active||offline||!text.trim())return;
    pinned.current=true;setAway(false);setPlanning(true);setError('');onStart?.();
    const entry:DirectorEntry={id:crypto.randomUUID(),at:new Date().toISOString(),itemId:item.id,itemTitle:item.title,scope,instruction:text.trim(),sourceIds,summary:'',plan:null,results:{}};
    if(home)fromHome.current.add(entry.id);
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
  const presenters=context.avatars.filter(a=>a.permission==='authorized');
  /** Home requests carry the picked preferences as plain words; docked requests are sent as typed. */
  const outgoing=(text:string)=>home?withPreferences(withFormat(text,format),prefs,presenters.find(a=>a.id===prefs.presenter)?.name):text;
  function pickFormat(next:LibraryTemplate){setFormat(next);setInstruction(formatBrief(next));requestAnimationFrame(()=>{const field=input.current;if(!field)return;field.focus();field.setSelectionRange(field.value.length,field.value.length);});}
  function submit(event:FormEvent){event.preventDefault();void plan(outgoing(instruction));}
  function suggest(prompt:string){
    if(prompt==='Choose a template'&&onTemplates){onTemplates();return;}
    if(prompt==='Create with my own script'&&onCreate){onCreate();return;}
    if(['Show my content','Review schedule','Hide burned-in captions','Show burned-in captions'].includes(prompt)){void plan(prompt);return;}
    if(prompt==='Choose an avatar'){onStart?.();(onPresenter??onDetails)();return;}
    if(prompt==='Find existing content'){setInstruction('Find ');input.current?.focus();return;}
    setInstruction(prompt==='Create a video'?'Create a 15-second video about ':prompt==='Plan a campaign'?'Plan three videos for next week about ':prompt==='Change the title'?'Set title: ':prompt==='Change the caption'&&captionOf?`Set ${captionOf} caption: `:prompt);input.current?.focus();
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
  // The channel an exact caption edit applies to: this draft's first one.
  const captionOf={instagram:'Instagram',tiktok:'TikTok',youtube:'YouTube'}[item.variants[0]?.platform??'']??'';
  const basicMode=live&&context.capabilities.canPlanWithDirector&&context.capabilities.directorMode==='basic';
  // One short, true line about what the chat can do here; the longer sentence is its description.
  const limit=!context.capabilities.canPlanWithDirector
    ?{short:'AI isn’t connected · exact edits only',homeShort:'AI writing isn’t connected here',home:'AI isn’t connected. Exact title, script and caption edits work; writing and production need a connected service.',detail:'Exact title, script and caption edits work here. Creative rewriting and production need a connected service.'}
    :basicMode?{short:'AI writing isn’t connected · exact edits work',homeShort:'AI writing isn’t connected yet',home:'AI writing isn’t connected yet. Templates, exact edits, finding content and schedule review work now.',detail:'Exact edits, templates, finding content, credits and schedule review work now.'}:null;
  const jobs=campaign.jobs.filter(j=>j.itemId===item.id&&['queued','running','cancel_requested','failed'].includes(j.state)).slice(0,2);
  // Offer only what works here: without a model, starters are exact edits rather than requests that would be declined.
  const starters=home?['Create a video',live&&onTemplates?'Choose a template':'Choose an avatar','Plan a campaign',live?'Find existing content':'Show my content']
    :limit?['Change the title',...(captionOf?['Change the caption']:[]),item.style.captions?'Hide burned-in captions':'Show burned-in captions']
    :['Rewrite the opening','Create a 15-second Instagram Reel','Change the avatar'];
  const brand=campaign.companyContext?.name??context.brand.name;
  const storage=context.capabilities.mode==='fixture'?{short:'Saved on this device',detail:'This conversation is saved on this device only.'}:{short:'Private to you',detail:'This conversation is private to you and this workspace.'};
  return <section className={`director-panel ${home?'is-home':'is-docked'}`} aria-label="AI Creative Director">
    <div ref={conversation} onScroll={()=>{const el=conversation.current;if(!el)return;pinned.current=el.scrollHeight-el.clientHeight-el.scrollTop<60;if(pinned.current)setAway(false);}} className="director-conversation" role="log" aria-label="Project conversation" aria-live="polite" aria-relevant="additions text">
      {(home||!entries.length)&&<div className="director-intro"><span className="director-symbol" aria-hidden="true"><Mark/></span><h3>{home?"What will we create today?":"What would make this better?"}</h3><p>{home?"Describe a video. Faceful drafts it, and you shape it together.":"Ask for a change. Nothing is saved until you approve it."}</p></div>}
      {!home&&!entries.length&&<div className="director-context" data-open={about.open} data-instant={about.instant||undefined}>
        <button type="button" className="director-context-chip" aria-expanded={about.open} aria-controls={about.open?'director-context-body':undefined} onClick={event=>setAbout({open:!about.open,instant:event.detail===0})}>
          <span>{brand} · {count(campaign.items.length,'draft')}{campaign.sources.length>0&&` · ${count(campaign.sources.length,'source')}`}</span><ChevronDown size={13} aria-hidden="true"/>
        </button>
        {about.open&&<div className="director-context-body" id="director-context-body">
          {context.brand.rules.length?<ul>{context.brand.rules.map(rule=><li key={rule}>{rule}</li>)}</ul>:<p>No brand rules supplied.</p>}
          {campaign.sources.length>0&&<p>From {campaign.sources.map(source=>source.title).join('; ')}</p>}
        </div>}
      </div>}
      {/* Create is a fresh start: the conversation lives beside the canvas, never on this screen. Sending from here docks
          the panel first (onStart), so a new turn always appears where its history is. */}
      {!home&&entries.map(entry=>{
        const pending=entry.summary===PENDING;
        const fresh=Date.parse(entry.at)>mountedAt.current;
        const actions=entry.plan?.actions??[];
        return <article className={`director-turn ${fresh?'is-new':''}`} key={entry.id}>
        <div className="director-user"><p>{entry.instruction}</p></div>
        {(entry.scope==='project'||entry.itemId!==item.id||entry.sourceIds.length>0)&&<small className="director-user-meta">{entry.scope==='project'?'Whole project':entry.itemTitle}{entry.sourceIds.length>0&&` · ${count(entry.sourceIds.length,'source')} attached`}</small>}
        <div className="director-response"><span className="director-response-label"><span className="director-avatar" aria-hidden="true"><Mark/></span>Creative Director{entry.mode==='basic'&&<em>basic mode</em>}</span>
          {pending&&planning&&entry.id===latest?.id?<Thinking>Preparing a plan…</Thinking>:<p>{entry.summary}</p>}
          {/* No model writes here: offer the person's own agent, with the request ready to paste. */}
          {!pending&&entry.id===latest?.id&&writingDeclined(entry)&&<AgentHandoff prompt={handoffPrompt(entry.instruction,entry.scope==='item'&&!home&&!fromHome.current.has(entry.id)?{campaignTitle:campaign.title,itemTitle:entry.itemTitle}:{})} connected={agentSeenRecently(context.connections)} onAgents={onAgents}/>}
          {!pending&&!entry.plan&&!entry.assets?.length&&entry.id===latest?.id&&<button className="text-button director-revise" onClick={()=>{setInstruction(entry.instruction);input.current?.focus();}}><RotateCcw size={12}/>Revise request</button>}
          {!!entry.assets?.length&&<ul className="director-assets" aria-label="Matching content">{entry.assets.map(asset=><li key={asset.itemId}><button className="text-button" onClick={()=>onOpen?.({campaignId:asset.campaignId,itemId:asset.itemId,play:asset.hasVideo})}><span>{asset.title}</span><small>{asset.campaignTitle} · version {asset.revision} · {asset.hasVideo?'video saved':'no video yet'}</small></button></li>)}</ul>}
          {actions.map((action,index)=>{
            const target=action.kind==='revise'||action.kind==='render'?campaign.items.find(i=>i.id===action.itemId):null;
            const result=entry.results[index];const inFlight=running===`${entry.id}:${index}`;
            const complete=result&&!['failed','unknown'].includes(result.state);
            const Icon=actionIcon[action.kind];
            return <div className={`director-plan ${complete?'is-done':''} ${result?.state==='failed'?'is-failed':''}`} key={index}>
              {/* The item is named only when it is not the one already in the panel heading. */}
              <div className="plan-head"><span className="plan-icon" aria-hidden="true"><Icon size={14}/></span><strong>{actionTitle[action.kind]}{target&&(actions.length>1||target.id!==item.id)?` · ${target.title}`:''}</strong></div>
              {/* A single proposal shows its diff straight away; once applied, or in a batch, it folds. */}
              {action.kind==='revise'&&target&&<details open={actions.length===1&&!complete} onToggle={event=>{if(event.currentTarget.open)event.currentTarget.closest('.director-plan')?.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}><summary>Review changes <ChevronDown size={12}/></summary>{changedFields(target,action.patch,result?.before).map(change=><div className="director-diff" key={change.field}><small>{fieldLabel[change.field]??change.field}</small><del>{change.before}</del><ins>{change.after}</ins></div>)}</details>}
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
      {!home&&jobs.map(job=><p className={`director-job is-${job.state}`} key={job.id} role="status">{job.state!=='failed'&&<span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>}{jobLabel(job.stage,job.state)}{job.error?` · ${job.error.message}`:''}</p>)}
      {error&&<Notice error>{error}</Notice>}
    </div>
    {away&&!home&&<button className="director-jump" onClick={toLatest}><ArrowDown size={13}/>Latest</button>}
    <div className="director-compose-area">
      {syncError&&<p className="director-sync" role="status">{syncError} <button className="text-button" onClick={()=>void onRetrySync()}>Retry sync</button></p>}
      {dirty&&<p className="director-sync">You have unsaved Details edits. <button className="text-button" onClick={onDetails}>Save or undo them first</button>.</p>}
      {offline&&<p className="director-sync" role="status">You’re offline. Your draft stays here.</p>}
      {exactEdit?<form className="director-exact-edit" onSubmit={e=>{e.preventDefault();void plan(`Set script: ${replacement}`);}}><label htmlFor="director-script">Your replacement script<span>{replacement.length.toLocaleString('en')} / 5,000</span></label><textarea id="director-script" value={replacement} maxLength={5000} rows={4} onChange={e=>setReplacement(e.target.value)}/><div><button className="text-button" type="button" onClick={()=>setExactEdit(false)}>Cancel</button><button className="button primary" disabled={active||offline||!replacement.trim()}>Review script change</button></div></form>:<>
        {!home&&!entries.length&&<div className="director-suggestions">{starters.map(prompt=><button key={prompt} onClick={()=>suggest(prompt)}>{prompt}</button>)}</div>}
        <form className="director-composer" onSubmit={submit} aria-busy={planning}>
          {home&&format&&<FormatPill format={format} onRemove={()=>{if(instruction===formatBrief(format))setInstruction('');setFormat(null);input.current?.focus();}}/>}
          <AttachmentPills sources={campaign.sources} selected={sourceIds} onRemove={id=>setSourceIds(ids=>ids.filter(other=>other!==id))}/>
          <div className="composer-field">
            <label className="sr-only" htmlFor="director-instruction">Direction for your content</label>
            <textarea ref={input} id="director-instruction" value={instruction} onChange={e=>setInstruction(e.target.value)} maxLength={5000} rows={1} placeholder={home?"Describe your next video, campaign, or idea…":"Ask for a change…"} enterKeyHint="send" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void plan(outgoing(instruction));}}}/>
            {home&&<PromptCycle active={!instruction}/>}
          </div>
          <div className="director-composer-actions">
            <button ref={clip} className="icon-button" type="button" aria-label="Attach project sources" aria-expanded={attachments} aria-controls={attachments?'director-sources':undefined} title="Attach project sources" onClick={e=>{trayFocus.current=!attachments&&e.detail===0;setTrayInstant(e.detail===0);setAttachments(!attachments);}}><Paperclip size={16}/>{sourceIds.length>0&&<b className="attach-count">{sourceIds.length}</b>}</button>
            {home&&<PromptTokens prefs={prefs} onChange={setPrefs} presenters={presenters}/>}
            {/* With one draft there is nothing to choose between, so the control is not shown; home starts something new. */}
            {!home&&campaign.items.length>1&&<><label className="sr-only" htmlFor="director-scope">Action scope</label>
            <select id="director-scope" value={scope} onChange={e=>setScope(e.target.value as DirectorScope)}><option value="item">This draft</option><option value="project">Whole project ({campaign.items.length})</option></select></>}
            {!home&&<button className="director-tool" type="button" onClick={()=>{setReplacement(item.script);setExactEdit(true);}}><FileText size={14} aria-hidden="true"/><span>Edit script</span></button>}
            <button className="director-send" data-busy={planning||undefined} aria-label="Prepare action plan" title="Send (Enter)" disabled={active||offline||!instruction.trim()}><span className="send-arrow" aria-hidden="true"><ArrowUp size={17}/></span><span className="send-spinner" aria-hidden="true"/></button>
          </div>
        </form>
        {attachments&&<SourceTray id="director-sources" sources={campaign.sources} selected={sourceIds} onToggle={id=>setSourceIds(ids=>ids.includes(id)?ids.filter(other=>other!==id):[...ids,id])} onClose={()=>{setAttachments(false);clip.current?.focus();}} onSources={onSources} instant={trayInstant}/>}
        {home?<>
          <div className="home-meta">
            {/* Where the conversation is kept is said once, in the docked panel; home keeps one line. */}
            {limit&&<p className="director-status" title={limit.detail}><i aria-hidden="true"/><span>{limit.homeShort}</span><span className="sr-only">. {limit.detail}</span><ViewLink view="connect" onOpen={onAgents} className="director-status-link">Use your own agent</ViewLink></p>}
          </div>
          {/* With the Director writing and the library loaded, Create starts from a real format; otherwise the plain starters. */}
          {live&&!limit&&formats&&formats.length>0?<>
            <FormatStrip formats={homeFormats(formats)} total={formats.length} selected={format?.id??null} onPick={pickFormat} onAll={onAllFormats}/>
            <div className="home-more">
              <button type="button" className="text-button" onClick={()=>suggest('Plan a campaign')}><CalendarDays size={14} aria-hidden="true"/>Plan a campaign</button>
              <button type="button" className="text-button" onClick={()=>suggest('Find existing content')}><Search size={14} aria-hidden="true"/>Find existing content</button>
              <button type="button" className="text-button" onClick={onCreate}><PenLine size={14} aria-hidden="true"/>Write my own script</button>
            </div>
          </>:<>
            <div className="director-suggestions home-chips">{starters.map((prompt,index)=>{const Icon=starterIcon[prompt];return <button key={prompt} style={{'--i':index} as CSSProperties} onClick={()=>suggest(prompt)}>{Icon&&<Icon size={15} aria-hidden="true"/>}<span>{prompt}</span></button>;})}</div>
            <div className="director-quick-actions"><button className="text-button" onClick={onCreate}><PenLine size={13} aria-hidden="true"/>Create with my own script</button></div>
          </>}
          {/* The way back to this project's drafts and its conversation. */}
          {campaign.items.length>0&&<button type="button" className="home-continue" onClick={onShowContent}>
            <span className="home-continue-thumbs" aria-hidden="true">{campaign.items.slice(0,3).map((other,index)=><span key={other.id}><Preview item={other} index={index} compact passive brandName={brand}/></span>)}</span>
            <span className="home-continue-text"><small>Pick up where you left off</small><strong>{campaign.title}</strong><span>{count(campaign.items.length,'draft')}</span></span>
            <ArrowRight size={16} aria-hidden="true"/>
          </button>}
        </>
          :<div className="director-foot">
            {limit&&<p className="director-status" title={limit.detail}><i aria-hidden="true"/>{limit.short}<span className="sr-only">. {limit.detail}</span><ViewLink view="connect" onOpen={onAgents} className="director-status-link">Use your own agent</ViewLink></p>}
            <small className="director-storage" title={storage.detail}>{storage.short}</small>
          </div>}
      </>}
    </div>
  </section>;
}
