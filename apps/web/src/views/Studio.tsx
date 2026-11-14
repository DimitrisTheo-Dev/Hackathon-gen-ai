import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Check,
  Circle,
  Clock3,
  FileText,
  Folder,
  Grid2X2,
  Layers,
  List,
  LoaderCircle,
  LogOut,
  Menu,
  PanelLeftClose,
  Plus,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Video,
  X,
} from "lucide-react";
import type {
  Campaign,
  ContentItem,
  ScheduleManifest,
  StudioContext,
} from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { ApiError } from "../data/client";
import {
  Mark,
  Modal,
  Notice,
  PlatformIcon,
  Preview,
  dateLabel,
  platformNames,
} from "../components/ui";
import { Editor, contentPatch, type Draft } from "./Editor";
import { Connect } from "./Connect";
import { Review, Grant } from "./Review";
import { CreateCampaign } from "./CreateCampaign";
import { operationKey } from "../lib/operation-key";
import { CommandPalette } from "../components/CommandPalette";

import { useDirectorHistory } from '../director/use-history';
import { validateDirectorPlan, restorePatch, directorOperationKey, type DirectorAction, type DirectorEntry } from '../director/model';
type View = "home" | "canvas" | "schedule" | "connect" | "brand";
export function Studio({
  client,
  onSignOut,
}: {
  client: StudioClient;
  onSignOut?: () => void;
}) {
  const [context, setContext] = useState<StudioContext | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [view, setView] = useState<View>(
    ["home", "canvas", "schedule", "connect", "brand"].includes(
      new URLSearchParams(location.search).get("view") ?? "",
    )
      ? (new URLSearchParams(location.search).get("view") as View)
      : new URLSearchParams(location.search).has("campaign") || new URLSearchParams(location.search).has("item") ? "canvas" : "home",
  );
  const [mobileChatOpen,setMobileChatOpen]=useState(false);
  const [selected, setSelected] = useState<string | null>(
    new URLSearchParams(location.search).get("item"),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [directorDrafts,setDirectorDrafts]=useState<Record<string,string>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [manifest, setManifest] = useState<ScheduleManifest | null>(null);
  const [grant, setGrant] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [scheduleView, setScheduleView] = useState("agenda");
  const [showActivity, setShowActivity] = useState(false);
  const [homeIdea,setHomeIdea]=useState("");
  const [homeReply,setHomeReply]=useState("");
  const [creating, setCreating] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("campaign");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [optimisticItems, setOptimisticItems] = useState<Record<string, ContentItem>>({});
  const director = useDirectorHistory(context,campaign);
  const previousEditorRect=useRef<{view:View;rect:DOMRect}|null>(null);
  useLayoutEffect(()=>{
    const el=document.querySelector<HTMLElement>('.editor');if(!el)return;
    const rect=el.getBoundingClientRect(),previous=previousEditorRect.current;
    previousEditorRect.current={view,rect};
    if(previous?.view==='home'&&view==='canvas'&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&!matchMedia('(max-width: 1000px)').matches){
      const dx=previous.rect.left-rect.left,dy=previous.rect.top-rect.top;
      if(Number.isFinite(dx)&&Number.isFinite(dy))el.animate([{transform:`translate(${dx}px,${dy}px)`,opacity:.65},{transform:'translate(0,0)',opacity:1}],{duration:360,easing:'cubic-bezier(.22,.8,.26,1)'});
    }
  },[view,loading]);
  const busyRef = useRef(false);
  const campaignRequest = useRef(0);
  const initialLocation = useRef(new URLSearchParams(location.search));
  const itemButton = useRef<HTMLButtonElement | null>(null);
  const fetchCampaign = useCallback(
    async (id: string) => {
      const request = ++campaignRequest.current;
      const next = await client.getCampaign(id);
      if (request === campaignRequest.current) {
        setCampaign(next);
        setCampaigns((list) => list.map((c) => (c.id === next.id ? next : c)));
      }
      return next;
    },
    [client],
  );
  const refreshContext = useCallback(async () => {
    setContext(await client.getContext());
  }, [client]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); setCommandOpen(open => !open);
      }
      if (event.key === "Escape") setSidebar(false);
    };
    const network = () => setOffline(!navigator.onLine);
    window.addEventListener("keydown", keys);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => { window.removeEventListener("keydown", keys); window.removeEventListener("online", network); window.removeEventListener("offline", network); };
  }, []);
  useEffect(() => {
    const back = () => {
      const params = new URLSearchParams(location.search);
      setSelected(params.get("item"));
    };
    window.addEventListener("popstate", back);
    document.documentElement.classList.add("studio-open");
    return () => { window.removeEventListener("popstate", back); document.documentElement.classList.remove("studio-open"); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([client.getContext(), client.listCampaigns()])
      .then(([ctx, list]) => {
        if (!active) return;
        setContext(ctx);
        setCampaigns(list);
        const requestedCampaign = initialLocation.current.get("campaign");
        const requestedItem = initialLocation.current.get("item");
        const currentCampaign =
          list.find((c) => c.id === requestedCampaign) ??
          list.find((c) => c.items.some((i) => i.id === requestedItem)) ??
          list.find(c=>c.jobs.some(j=>j.state==="running"||j.state==="queued")) ?? list[0];
        setCampaign(currentCampaign ?? null);
        if(!initialLocation.current.get('view')&&currentCampaign?.jobs.some(j=>j.state==='running'||j.state==='queued'))setView('canvas');
        if (currentCampaign)
          setSelected((current) =>
            current && currentCampaign.items.some((i) => i.id === current)
              ? current
              : view!=="home" && matchMedia("(max-width: 1000px)").matches
                ? null
                : (currentCampaign.items[0]?.id ?? null),
          );

      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      campaignRequest.current++;
    };
  }, [client]);
  useEffect(() => {
    if (!campaign || context?.capabilities.mode !== "live") return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !busyRef.current)
        void fetchCampaign(campaign.id).catch((e) =>
          setError(`Live updates paused: ${e.message}`),
        );
    }, 5000);
    return () => clearInterval(timer);
  }, [campaign?.id, context?.capabilities.mode, fetchCampaign]);
  useEffect(() => {
    if (loading) return;
    const url = new URL(location.href);
    url.searchParams.set("view", view);
    if (campaign) url.searchParams.set("campaign", campaign.id);
    else url.searchParams.delete("campaign");
    if (selected) url.searchParams.set("item", selected);
    else url.searchParams.delete("item");
    history.replaceState(history.state, "", url);
    document.title = `${view === "connect" ? "Connect your agent" : view === "schedule" ? "Schedule" : (campaign?.title ?? "Studio")} · Faceful`;
  }, [view, selected, campaign?.id, campaign?.title, loading]);
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (
        campaigns
          .flatMap((c) => c.items)
          .some(
            (i) =>
              drafts[i.id] &&
              Object.keys(contentPatch(i, drafts[i.id].value)).length,
          )
      ) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [campaigns, drafts]);
  const item = campaign?.items.find((i) => i.id === selected) ?? null;
  const draft = item
    ? (drafts[item.id] ?? {
        baseRevision: item.revision,
        value: structuredClone(item),
      })
    : null;
  const fixture = context?.capabilities.mode === "fixture";
  const unsaved = !!campaign?.items.some(
    (i) =>
      drafts[i.id] && Object.keys(contentPatch(i, drafts[i.id].value)).length,
  );
  function go(next: View) {
    setView(next);
    if(next==="home")setSelected(current=>current??campaign?.items[0]?.id??null);
    setSidebar(false);
    setError("");
    setNotice("");
  }
  function select(
    next: ContentItem,
    event?: React.MouseEvent<HTMLButtonElement>,
  ) {
    if (event) itemButton.current = event.currentTarget;
    if (!selected && matchMedia("(max-width: 1000px)").matches) {
      const url = new URL(location.href); url.searchParams.set("item", next.id);
      history.pushState({ ...history.state, castroomEditor: true }, "", url);
    }
    setSelected(next.id);
    setMobileChatOpen(true);
    setDrafts((prev) => ({
      ...prev,
      [next.id]: prev[next.id] ?? {
        baseRevision: next.revision,
        value: structuredClone(next),
      },
    }));
  }
  function closeEditor() {
    setMobileChatOpen(false);
    if (history.state?.castroomEditor) history.back();
    else setSelected(null);
    requestAnimationFrame(() => itemButton.current?.focus());
  }
  async function action(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setError(
        `${e instanceof Error ? e.message : "The operation failed."}${code === "revision_conflict" ? " Your local draft has been kept. Refresh the campaign to compare the latest version." : ""}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (!item || !draft || !campaign || busyRef.current || offline) return;
    const id = item.id;
    // Only the reversible preview is optimistic. Revisions, renders and receipts
    // remain server-owned. On rejection the card rolls back; the draft is kept.
    setOptimisticItems(previous => ({ ...previous, [id]: draft.value }));
    await action(async () => {
      const saved = await client.reviseContent({
        contentId: id,
        expectedRevision: draft.baseRevision,
        operationKey: await operationKey(
          context!.workspace.id,
          "revise-content",
          {
            id,
            revision: draft.baseRevision,
            patch: contentPatch(item, draft.value),
          },
        ),
        patch: contentPatch(item, draft.value),
      });
      const apply = (current: Campaign) => current.id === campaign.id ? { ...current, items: current.items.map(i => i.id === id ? saved : i) } : current;
      setCampaign(current => current ? apply(current) : current);
      setCampaigns(all => all.map(apply));
      setManifest(null);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await fetchCampaign(campaign.id);
      setNotice(
        fixture
          ? "Draft saved on this device."
          : "Saved. Your agent can read this revision.",
      );
      setManifest(null);
    });
    setOptimisticItems(previous => { const next = { ...previous }; delete next[id]; return next; });
  }
  async function executeDirector(planAction:DirectorAction, intentKey:string, reconcile=false):Promise<DirectorEntry['results'][string]> {
    if(!context||!campaign||busyRef.current||offline)throw new Error('Wait for the current action or reconnect before continuing.');
    const target=planAction.kind==='review_schedule'?campaign.items[0]:campaign.items.find(i=>i.id===planAction.itemId);
    if(!target)throw new Error('This storyboard is no longer available.');
    validateDirectorPlan({summary:'Reviewed instruction',actions:[reconcile&&planAction.kind==='revise'?{...planAction,expectedRevision:target.revision}:planAction]},campaign,target,'project',context);
    if(drafts[target.id]&&Object.keys(contentPatch(target,drafts[target.id].value)).length)throw new Error('This storyboard has unsaved edits. Save or undo them in Details first.');
    busyRef.current=true;setBusy(true);setError('');
    try {
      const key=await directorOperationKey(`${context.workspace.id}:${campaign.id}:${intentKey}`);
      if(planAction.kind==='revise'){
        setOptimisticItems(previous=>({...previous,[target.id]:{...target,...planAction.patch,targets:target.targets}}));
        const saved=await client.reviseContent({contentId:target.id,expectedRevision:planAction.expectedRevision,patch:planAction.patch,operationKey:key});
        const update=(current:Campaign)=>current.id===campaign.id?{...current,items:current.items.map(i=>i.id===saved.id?saved:i)}:current;
        setCampaign(current=>current?update(current):current);setCampaigns(all=>all.map(update));setManifest(null);
        setDrafts(previous=>{const next={...previous};delete next[target.id];return next;});
        try{await fetchCampaign(campaign.id);}catch{setNotice('Revision saved. Refresh to retrieve the latest campaign activity.');}
        return {state:'saved',message:`Saved version ${saved.revision}${context.capabilities.mode==='fixture'?' on this device':''}.`,revision:saved.revision,before:reconcile?undefined:restorePatch(target,saved)};
      }
      if(planAction.kind==='render'){
        const result=await client.renderContent({campaignId:campaign.id,itemIds:[target.id],expectedRevisions:{[target.id]:planAction.expectedRevision},operationKey:key});
        try{await fetchCampaign(campaign.id);}catch{setNotice('Request accepted. Refresh to reconcile job status.');}
        if(result.state==='blocked')throw new Error('The render was blocked. Check the current job and workspace capabilities.');
        return {state:'queued',message:`Render request ${result.state}. ${result.jobIds.length} job(s); watch their actual progress in the canvas.`};
      }
      const manifest=await client.prepareSchedule({campaignId:campaign.id,expectedRevision:planAction.expectedRevision,operationKey:key});
      setManifest(manifest);
      return {state:'review',message:'Review prepared. No publication has been submitted.'};
    } finally {
      setOptimisticItems(previous=>{const next={...previous};delete next[target.id];return next;});busyRef.current=false;setBusy(false);
    }
  }
  async function render() {
    if (!item || !campaign) return;
    await action(async () => {
      const result = await client.renderContent({
        campaignId: campaign.id,
        itemIds: [item.id],
        expectedRevisions: { [item.id]: item.revision },
        operationKey: await operationKey(
          context!.workspace.id,
          "render-content",
          { itemId: item.id, revision: item.revision },
        ),
      });
      setNotice(
        `Render request ${result.state}. Follow the actual job in Activity.`,
      );
      await fetchCampaign(campaign.id);
    });
  }
  async function prepare() {
    if (!campaign) return;
    await action(async () => {
      const next = await client.prepareSchedule({
        campaignId: campaign.id,
        expectedRevision: campaign.revision,
        operationKey: crypto.randomUUID(),
      });
      setManifest(next);
    });
  }
  function openCampaign(id: string, contentId?: string) {
    if (busyRef.current) return;
    const previous = campaign;
    const previousSelected = selected;
    const cached = campaigns.find(c => c.id === id);
    if (cached) setCampaign(cached);
    setSelected(contentId ?? null);
    setSearch(""); setStatusFilter("all"); go("canvas");
    void action(async () => {
      try { await fetchCampaign(id); }
      catch (error) { setCampaign(previous); setSelected(previousSelected); throw error; }
    });
  }
  if (loading)
    return (
      <div className="loading-page" role="status">
        <Mark />
        <p>Opening your studio…</p>
        <LoaderCircle className="spin" />
      </div>
    );
  if (!context)
    return (
      <div className="auth-page">
        <a className="wordmark" href="/">
          <Mark />
          Faceful
        </a>
        <main className="auth-card">
          <h1>We couldn’t open your workspace.</h1>
          <Notice error>
            {error || "No workspace is available for this session."}
          </Notice>
          <button className="button primary" onClick={() => location.reload()}>
            Try again
          </button>
          <a href="/docs/errors/">Troubleshooting</a>
        </main>
      </div>
    );
  const matches = (campaign?.items.filter((i) =>
    `${i.title} ${i.script}`.toLowerCase().includes(search.toLowerCase()) &&
    (statusFilter === "all" || (statusFilter === "attention" ? i.status === "failed" || i.renderRevision === null && !!i.media : i.status === statusFilter)),
  ) ?? []).sort((a, b) => sort === "recent" ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : sort === "title" ? a.title.localeCompare(b.title) : 0);
  const accepted =
    campaign?.items
      .flatMap((i) => i.targets)
      .filter((t) => ["accepted", "published"].includes(t.state)).length ?? 0;
  const published =
    campaign?.items
      .flatMap((i) => i.targets)
      .filter((t) => t.state === "published").length ?? 0;
  const finished =
    campaign?.items.filter(
      (i) => i.status === "ready" && i.media && i.renderRevision !== null,
    ).length ?? 0;
  const activeConnections = context.connections.filter(
    (c) => c.lastSeenAt && !c.revokedAt && new Date(c.expiresAt) > new Date(),
  );
  return (
    <div className="app-frame">
      <a className="skip-link" href="#workspace-content">
        Skip to campaign
      </a>
      <div
        className={`studio-shell ${view==="home"?"is-home":""} ${item && view === "canvas" ? "has-editor" : ""}`}
      >
        <aside className="sidebar">
          <a className="wordmark" href="/">
            <Mark />
            Faceful
          </a>
          <div className="workspace-switch">
            <span className="workspace-avatar">
              {context.workspace.name[0]}
            </span>
            <div>
              <strong>{context.workspace.name}</strong>
              <small>
                {context.workspace.type === "agency"
                  ? "Agency workspace"
                  : "Workspace"}
              </small>
            </div>
            <ChevronDown size={14} />
          </div>
          <button className="search-box" onClick={() => setCommandOpen(true)} aria-label="Search projects and content">
            <Search size={17} /><span>Search studio</span><kbd>⌘ K</kbd>
          </button>
          <nav aria-label="Studio"><button className={view==="home"?"active":""} onClick={()=>go("home")}><Plus size={17}/>Create</button>
            <button
              className={view === "canvas" ? "active" : ""}
              onClick={() => go("canvas")}
            >
              <Layers size={17} />
              Campaigns<span className="nav-count">{campaigns.length}</span>
            </button>
            <button
              className={view === "schedule" ? "active" : ""}
              onClick={() => go("schedule")}
            >
              <CalendarDays size={17} />
              Schedule
            </button>
            <button
              className={view === "brand" ? "active" : ""}
              onClick={() => go("brand")}
            >
              <FileText size={17} />
              Brand & sources
            </button>
          </nav>
          <div className="projects-heading">
            <span>Projects</span>
            <button
              className="icon-button"
              aria-label="Create a campaign"
              onClick={() => setCreating(true)}
            >
              <Plus size={15} />
            </button>
          </div>
          <nav className="project-list" aria-label="Projects">
            {campaigns.map((c) => (
              <button
                key={c.id}
                className={campaign?.id === c.id ? "current-project" : ""}
                onClick={() => openCampaign(c.id)}
                title={c.title}
              >
                <span className="project-dot" />
                <span className="project-name">{c.title}</span><small>{c.items.length}</small>
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              className={`agent-status ${view === "connect" ? "selected" : ""}`}
              onClick={() => go("connect")}
            >
              <span className="agent-icon">
                <Plug size={18} />
              </span>
              <span>
                <strong>
                  {activeConnections.length
                    ? "Agent connected"
                    : "Connect your agent"}
                </strong>
                <small>
                  {activeConnections.length
                    ? activeConnections.map((c) => c.displayName).join(", ")
                    : "Codex or Claude Code"}
                </small>
              </span>
              <ChevronRight size={15} />
            </button>
            <a
              href="/docs/"
              className="sidebar-help"
              target="_blank"
              rel="noreferrer"
            >
              Help & documentation <ArrowUpRight size={13} />
            </a>
            <div className="user-row">
              <span className="user-avatar">
                {fixture ? "D" : context.workspace.name[0]}
              </span>
              <span>
                {fixture ? "Personal studio" : context.workspace.name}
                <small>{context.workspace.role}</small>
              </span>
              {onSignOut && (
                <button
                  className="icon-button"
                  aria-label="Sign out"
                  onClick={onSignOut}
                >
                  <LogOut size={16} />
                </button>
              )}
            </div>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="breadcrumbs">
              <button
                className="icon-button mobile-menu"
                aria-label="Toggle navigation"
                aria-expanded={sidebar}
                onClick={() => setSidebar(!sidebar)}
              >
                <Menu size={18} />
              </button>
              <button className="mobile-project-switch" onClick={() => setSidebar(true)} aria-label="Switch project"><span>{campaign?.title ?? "Your projects"}</span><ChevronDown size={15}/></button>
              <Folder size={15} />
              <span>Projects</span>
              <ChevronRight size={13} />
              <strong>
                {view === "connect"
                  ? "Agent connections"
                  : view === "brand"
                    ? "Brand & sources"
                    : (campaign?.title ?? "Your campaigns")}
              </strong>
            </div>
            <div className="topbar-right">
              <button className="icon-button" onClick={() => setCommandOpen(true)} aria-label="Find projects or content"><Search size={18} /></button>
              <span className="timezone-label">
                <Clock3 size={13} />
                {context.workspace.timezone}
              </span>
              <a
                className="icon-button"
                href="/docs/"
                aria-label="Open documentation"
              >
                <ArrowUpRight size={17} />
              </a>
            </div>
          </header>
          <main
            id="workspace-content"
            tabIndex={-1}
            className={`workspace-main view-${view}`}
          >
            {offline && <div className="feedback"><Notice error>You’re offline. Unsaved edits stay open; reconnect before saving to the shared workspace.</Notice></div>}
            {(error || notice) && (
              <div className="feedback">
                {error && (
                  <Notice error>
                    {error}
                    <button
                      className="text-button"
                      onClick={() => setError("")}
                    >
                      Dismiss
                    </button>
                  </Notice>
                )}
                {notice && (
                  <div className="success-note" role="status">
                    <Check size={15} />
                    {notice}
                    <button
                      className="icon-button"
                      aria-label="Dismiss notification"
                      onClick={() => setNotice("")}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
              </div>
            )}
            {view === "home" && !campaign ? (<div className="empty-state studio-first"><h1>What will we create today?</h1><p>Describe your idea. Shape it with Faceful.</p><form className="home-idea-form" onSubmit={e=>{e.preventDefault();setHomeReply('AI production is not connected yet. Your idea is kept here. Add your own script to create an editable storyboard.');}}><label className="sr-only" htmlFor="home-idea">What would you like to create?</label><textarea id="home-idea" value={homeIdea} onChange={e=>setHomeIdea(e.target.value)} rows={4} maxLength={1500} placeholder="A 20-second introduction to our new idea…"/><button className="button primary" disabled={!homeIdea.trim()||offline}>Start creating</button></form>{homeReply&&<p role="status">{homeReply}</p>}<button className="text-button" onClick={()=>setCreating(true)}>Create with my own script</button><button className="text-button" onClick={()=>go("connect")}>Connect your agent</button></div>) : view === "home" ? null : view === "connect" ? (
              <Connect
                context={context}
                client={client}
                refresh={refreshContext}
                onContinue={() => go("canvas")}
                onCreateCampaign={() => setCreating(true)}
              />
            ) : view === "brand" ? (
              <div className="brand-view">
                <span className="section-kicker">Your shared context</span>
                <h1>{campaign?.companyContext?.name ?? context.brand.name}</h1>
                <p className="lead">
                  {campaign?.companyContext?.description ??
                    context.brand.description}
                </p>
                {campaign?.companyContext && (
                  <dl className="brief-summary">
                    <dt>Audience</dt>
                    <dd>
                      {campaign.companyContext.audience || "Not supplied"}
                    </dd>
                    <dt>Tone</dt>
                    <dd>
                      {campaign.companyContext.tone ||
                        "Follow workspace brand guidance"}
                    </dd>
                    <dt>Missing information</dt>
                    <dd>
                      {campaign.companyContext.missingInformation ||
                        "No additional gaps recorded"}
                    </dd>
                  </dl>
                )}
                <section>
                  <h2>Brand guidance</h2>
                  <ul className="rule-list">
                    {context.brand.rules.map((rule) => (
                      <li key={rule}>
                        <Check size={16} />
                        {rule}
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h2>Source material</h2>
                  {campaign?.sources.map((s) => (
                    <article className="source-card" key={s.id}>
                      <FileText size={22} />
                      <div>
                        <h3>{s.title}</h3>
                        <p>{s.excerpt}</p>
                        {s.url && (
                          <a href={s.url} target="_blank" rel="noreferrer">
                            Read original case study <ArrowUpRight size={13} />
                          </a>
                        )}
                        <small>
                          Retrieved{" "}
                          {dateLabel(s.retrievedAt, context.workspace.timezone)}{" "}
                          · {s.permittedAssetIds.length} permitted media assets
                        </small>
                      </div>
                    </article>
                  ))}
                </section>
                <Notice>
                  Source references do not grant media rights or publishing
                  permission.{" "}
                  {campaign?.id === "fixture-bewell-week" &&
                    "Quintessential is an unofficial demo agency; no endorsement is implied."}
                </Notice>
              </div>
            ) : !campaign ? (
              <div className="empty-state">
                <Layers size={36} />
                <h1>Your first campaign belongs here.</h1>
                <p>
                  Start with a company brief, or let your agent plan the
                  campaign.
                </p>
                <button
                  className="button primary"
                  onClick={() => setCreating(true)}
                >
                  Create a campaign
                </button>
                <button className="text-button" onClick={() => go("connect")}>
                  Connect your agent
                </button>
              </div>
            ) : (
              <>
                <div className="campaign-heading">
                  <div>
                    <div className="campaign-meta">
                      <span className="campaign-dot" />
                      Campaign <span>/</span>{" "}
                      {fixture ? "Local workspace" : "Shared workspace"}
                    </div>
                    <h1>{campaign.title}</h1>
                    <p>
                      {campaign.companyContext
                        ? `Stories for ${campaign.companyContext.name}. Ready to shape.`
                        : campaign.brief.split(".")[0] + "."}
                    </p>
                    <details className="mobile-campaign-brief"><summary>Read brief</summary><p>{campaign.brief}</p></details>
                  </div>
                  <div className="campaign-actions">
                    <button
                      className="button secondary new-campaign-button"
                      onClick={() => setCreating(true)}
                    >
                      <Plus size={14} />
                      New campaign
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      aria-label="Refresh campaign"
                      onClick={() =>
                        void action(async () => {
                          await fetchCampaign(campaign.id);
                          setNotice(
                            "Latest saved campaign loaded. Local unsaved drafts are preserved.",
                          );
                        })
                      }
                    >
                      <RefreshCw size={14} />
                      <span className="refresh-label">Refresh</span>
                    </button>
                    <button
                      className="button primary"
                      disabled={busy || unsaved}
                      onClick={() => void prepare()}
                    >
                      <CalendarDays size={15} />
                      Review schedule
                    </button>
                  </div>
                </div>
                {unsaved && (
                  <p className="draft-reminder">
                    Save your edits before reviewing the schedule.
                  </p>
                )}
                <div className="view-toolbar">
                  <div className="segmented">
                    <button
                      aria-pressed={view === "canvas"}
                      onClick={() => go("canvas")}
                    >
                      <Grid2X2 size={14} />
                      Canvas
                    </button>
                    <button
                      aria-pressed={view === "schedule"}
                      onClick={() => go("schedule")}
                    >
                      <CalendarDays size={14} />
                      Schedule
                    </button>
                  </div>
                  <span className="item-count">
                    {matches.length} {matches.length === 1 ? "item" : "items"}
                  </span>
                  <button
                    className="text-button activity-toggle"
                    onClick={() => setShowActivity(true)}
                  >
                    <Clock3 size={14} />
                    Activity
                  </button>
                </div>
                {view === "canvas" ? (
                  <div className="canvas">
                    <div className={`canvas-tools ${filtersOpen ? "filters-open" : ""}`}>
                      <label className="canvas-search"><Search size={16}/><input type="search" aria-label="Filter campaign content" value={search} onChange={e => setSearch(e.target.value)} placeholder="Find in this campaign" /></label>
                      <button className="icon-button mobile-filter-toggle" aria-label="Filter and sort content" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><Settings2 size={18}/></button>
                      <button className="icon-button mobile-activity" aria-label="Campaign activity" onClick={() => setShowActivity(true)}><Clock3 size={18}/></button>
                      <select aria-label="Filter by content status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">All content</option><option value="draft">Drafts</option><option value="ready">Ready</option><option value="attention">Needs attention</option></select>
                      <select aria-label="Sort content" value={sort} onChange={e => setSort(e.target.value)}><option value="campaign">Campaign order</option><option value="recent">Recently changed</option><option value="title">Title</option></select>
                    </div>
                    <div className="board-caption">
                      <span>
                        {campaign.companyContext?.name ?? context.brand.name} /
                        Campaign stories
                      </span>
                      <span>Portrait · 9:16</span>
                    </div>
                    <div className="content-grid">
                      {matches.map((i) => {
                        const index = campaign.items.indexOf(i);
                        const previewItem = optimisticItems[i.id] ?? i;
                        return (
                          <article
                            className={`content-card ${selected === i.id ? "selected" : ""}`}
                            key={i.id}
                          >
                            <button
                              className="content-select"
                              onClick={(e) => select(i, e)}
                              aria-pressed={selected === i.id}
                              aria-label={`Edit ${i.title}`}
                            >
                              <div className="card-preview">
                                <Preview
                                  item={previewItem}
                                  index={index}
                                  passive
                                  brandName={
                                    campaign.companyContext?.name ??
                                    context.brand.name
                                  }
                                />
                                {i.media && (
                                  <span className="has-video-badge">
                                    <Video size={13} />
                                    Video available
                                  </span>
                                )}
                              </div>
                              <div className="card-heading">
                                <h2>{previewItem.title}</h2>
                                <span className="card-selection">
                                  {selected === i.id ? (
                                    <Check size={11} />
                                  ) : null}
                                </span>
                              </div>
                              <div className="card-state">
                                <span className={`state-dot ${i.status}`} />
                                {optimisticItems[i.id] ? "Saving draft…" : i.status.replaceAll("_", " ")}
                                <span>v{i.revision}</span>
                              </div>
                            </button>
                            <div className="card-footer">
                              <div
                                className="platforms"
                                aria-label="Destinations"
                              >
                                {i.variants.map((v) => (
                                  <span
                                    key={v.platform}
                                    aria-label={platformNames[v.platform]}
                                  >
                                    <PlatformIcon platform={v.platform} />
                                  </span>
                                ))}
                              </div>
                              <span>
                                {i.targets[0]
                                  ? dateLabel(
                                      i.targets[0].scheduledAt,
                                      campaign.timezone,
                                    )
                                  : "No time set"}
                              </span>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    {matches.length === 0 && (
                      <div className="empty-state">
                        <Search size={30} />
                        <h2>No matching content</h2>
                        <p>Try a different title or phrase.</p>
                        <button
                          className="button secondary"
                          onClick={() => { setSearch(""); setStatusFilter("all"); }}
                        >
                          Clear search
                        </button>
                      </div>
                    )}
                    <div className="canvas-context">
                      <FileText size={16} />
                      <span>
                        {campaign.sources.length
                          ? `Based on ${campaign.sources.length} supplied source${campaign.sources.length === 1 ? "" : "s"}`
                          : "Add source evidence before publishing"}
                      </span>
                      <button
                        className="text-button"
                        onClick={() => go("brand")}
                      >
                        View source <ArrowUpRight size={12} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="schedule-view">
                    <div className="schedule-header">
                      <div>
                        <h2>Campaign schedule</h2>
                        <p>
                          All requested times in {campaign.timezone}. Draft
                          times are not accepted posts.
                        </p>
                      </div>
                      <div className="segmented">
                        <button
                          aria-pressed={scheduleView === "agenda"}
                          onClick={() => setScheduleView("agenda")}
                        >
                          <List size={14} />
                          Agenda
                        </button>
                        <button
                          aria-pressed={scheduleView === "calendar"}
                          onClick={() => setScheduleView("calendar")}
                        >
                          <CalendarDays size={14} />
                          Calendar
                        </button>
                      </div>
                    </div>
                    <div
                      className={
                        scheduleView === "calendar" ? "calendar-grid" : "agenda"
                      }
                    >
                      {campaign.items.map((i, index) => (
                        <section className="agenda-item" key={i.id}>
                          <div className="agenda-date">
                            <strong>
                              {i.targets[0]
                                ? new Intl.DateTimeFormat("en-GB", {
                                    timeZone: campaign.timezone,
                                    day: "numeric",
                                  }).format(new Date(i.targets[0].scheduledAt))
                                : "—"}
                            </strong>
                            <span>
                              {i.targets[0]
                                ? new Intl.DateTimeFormat("en-GB", {
                                    timeZone: campaign.timezone,
                                    weekday: "short",
                                  }).format(new Date(i.targets[0].scheduledAt))
                                : "Unscheduled"}
                            </span>
                          </div>
                          <div className="agenda-content">
                            <button
                              className="text-button agenda-title"
                              onClick={() => {
                                select(i);
                                go("canvas");
                              }}
                            >
                              {i.title}
                              <ChevronRight size={14} />
                            </button>
                            {i.targets.map((t, n) => (
                              <div
                                className="destination"
                                key={`${t.platform}-${n}`}
                              >
                                <PlatformIcon platform={t.platform} />
                                <div>
                                  <strong>
                                    {context.channels.find(
                                      (c) => c.id === t.accountId,
                                    )?.displayName ??
                                      `${platformNames[t.platform]} · account needed`}
                                  </strong>
                                  <small>
                                    {dateLabel(t.scheduledAt, t.timezone)} ·{" "}
                                    {
                                      i.variants.find(
                                        (v) => v.platform === t.platform,
                                      )?.visibility
                                    }
                                  </small>
                                  {t.error && (
                                    <span className="destination-error">
                                      {t.error}
                                    </span>
                                  )}
                                  {t.publishedUrl && (
                                    <a
                                      href={t.publishedUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Open published post
                                    </a>
                                  )}
                                </div>
                                <span className={`status-chip ${t.state}`}>
                                  {t.state.replaceAll("_", " ")}
                                </span>
                              </div>
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setGrant(true)}
                    >
                      <ShieldCheck size={15} />
                      Authorize a bounded campaign run
                    </button>
                  </div>
                )}
                <div className="run-summary">
                  <span>
                    <Video size={14} />
                    <strong>{finished}</strong> videos completed
                  </span>
                  <span>
                    <CalendarDays size={14} />
                    <strong>{accepted}</strong> destinations accepted
                  </span>
                  <span>
                    <Check size={14} />
                    <strong>{published}</strong> published
                  </span>
                  <span>
                    <strong>{campaign.humanInterventions}</strong>{" "}
                    {fixture ? "local edits" : "human interventions"}
                  </span>
                </div>
                <footer className="workspace-footer">
                  <span className="quiet-status">
                    <span />
                    {fixture ? "Saved on this device" : "Live workspace"}
                  </span>
                  <span>
                    {fixture
                      ? "No provider jobs have been run"
                      : "Background work continues when you leave"}
                  </span>
                </footer>
              </>
            )}
          </main>
          <nav className="mobile-dock" aria-label="Workspace shortcuts">
            <button onClick={() => setSidebar(true)}><Folder size={20}/><span>Projects</span></button>
            <button aria-current={view === "canvas" ? "page" : undefined} onClick={() => go("canvas")}><Grid2X2 size={20}/><span>Canvas</span></button>
            <button aria-current={view === "schedule" ? "page" : undefined} onClick={() => go("schedule")}><CalendarDays size={20}/><span>Schedule</span></button>
            <button onClick={() => {if(view==="home")setCreating(true);else {setSelected(current=>current??campaign?.items[0]?.id??null);setMobileChatOpen(true);}}}><Plus size={21}/><span>{view==="home"?"Create":"Chat"}</span></button>
          </nav>
        </div>
        {item && draft && (view === "canvas" || view === "home") && (
          <Editor
            home={view==="home"}
            open={view==="home" || !matchMedia("(max-width: 1000px)").matches || mobileChatOpen}
            onStart={()=>{setView("canvas");setMobileChatOpen(true);}}
            onShowContent={()=>{setView("canvas");setMobileChatOpen(false);}}
            onCreate={()=>setCreating(true)}
            key={item.id}
            campaign={campaign!}
            director={director}
            directorInstruction={directorDrafts[item.id]??""}
            onDirectorInstruction={value=>setDirectorDrafts(previous=>({...previous,[item.id]:value}))}
            onDirectorAction={executeDirector}
            item={item}
            index={campaign!.items.indexOf(item)}
            context={context}
            draft={draft}
            brandName={campaign!.companyContext?.name ?? context.brand.name}
            sources={campaign!.sources}
            jobs={campaign!.jobs}
            onReset={() =>
              setDrafts((prev) => ({
                ...prev,
                [item.id]: {
                  baseRevision: item.revision,
                  value: structuredClone(item),
                },
              }))
            }
            onChange={(value) =>
              setDrafts((prev) => ({
                ...prev,
                [item.id]: { baseRevision: draft.baseRevision, value },
              }))
            }
            onSave={() => void save()}
            onRender={() => void render()}
            onClose={closeEditor}
            busy={busy}
            error={error}
            offline={offline}
          />
        )}
      </div>
      {sidebar && <Modal title="Your projects" onClose={() => setSidebar(false)}>
        <p className="project-switch-workspace">{context.workspace.name} <span>· {context.workspace.role}</span></p>
        <nav className="mobile-project-list" aria-label="Projects">
          {campaigns.map(c => <button key={c.id} aria-current={campaign?.id === c.id ? "page" : undefined} onClick={() => openCampaign(c.id)}>
            <span className="project-thumbnail" aria-hidden="true"><Folder size={20}/></span><span><strong>{c.title}</strong><small>{c.items.length} content items</small></span>{campaign?.id === c.id && <Check size={17}/>}</button>)}
        </nav>
        <button className="button primary project-create" onClick={() => { setSidebar(false); setCreating(true); }}><Plus size={17}/>New campaign</button>
        <nav className="project-quick-links" aria-label="Workspace">
          <button onClick={() => go("brand")}><FileText size={18}/>Brand & sources<ChevronRight size={16}/></button>
          <button onClick={() => go("connect")}><Plug size={18}/>{activeConnections.length ? "Agent connections" : "Connect your agent"}<ChevronRight size={16}/></button>
          <button onClick={() => { setSidebar(false); setCommandOpen(true); }}><Search size={18}/>Search studio<ChevronRight size={16}/></button>
          <a href="/docs/">Help & documentation<ArrowUpRight size={16}/></a>
          {onSignOut && <button onClick={onSignOut}><LogOut size={18}/>Sign out</button>}
        </nav>
        {fixture && <p className="project-fixture-note">Local workspace. Drafts stay on this device; rendering and publishing require connected services.</p>}
      </Modal>}
      {creating && (
        <CreateCampaign
          initialBrief={homeIdea}
          context={context}
          client={client}
          onClose={() => setCreating(false)}
          onCreated={(next) => {
            campaignRequest.current++;
            setCampaigns((all) => [
              next,
              ...all.filter((c) => c.id !== next.id),
            ]);
            setCampaign(next);
            setSelected(
              matchMedia("(max-width: 1000px)").matches
                ? null
                : (next.items[0]?.id ?? null),
            );
            setSearch("");
            setCreating(false);
            go("canvas");
            setNotice(
              fixture
                ? "Your drafts are saved in this browser."
                : "Campaign created. Your agent can read these drafts.",
            );
          }}
        />
      )}
      {manifest && campaign && (
        <Review
          campaign={campaign}
          manifest={manifest}
          context={context}
          client={client}
          onClose={() => setManifest(null)}
          onRefresh={async () => {
            await fetchCampaign(campaign.id);
          }}
        />
      )}
      {grant && campaign && (
        <Grant
          campaign={campaign}
          context={context}
          client={client}
          onClose={() => setGrant(false)}
        />
      )}
      {showActivity && campaign && (
        <Modal title="Campaign activity" onClose={() => setShowActivity(false)}>
          <div className="activity-list">
            {campaign.activity.length === 0 ? (
              <p>No activity recorded.</p>
            ) : (
              campaign.activity.map((a) => (
                <article key={a.id}>
                  <span className="activity-dot" />
                  <div>
                    <strong>{a.actor}</strong>
                    <p>
                      {a.action.replaceAll("_", " ")} · {a.outcome}
                    </p>
                    <small>
                      {dateLabel(a.at, campaign.timezone)}
                      {a.revision ? ` · v${a.revision}` : ""}
                    </small>
                  </div>
                </article>
              ))
            )}
          </div>
          <h3>Background jobs</h3>
          {campaign.jobs.length === 0 ? (
            <p className="muted">No background jobs have been accepted.</p>
          ) : (
            campaign.jobs.map((j) => (
              <article className="job-row" key={j.id}>
                <div>
                  <strong>{j.stage}</strong>
                  <p>{j.state}</p>
                  {j.error && <p>{j.error.message}</p>}
                </div>
                {context.capabilities.canCancel &&
                  ["queued", "running"].includes(j.state) && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const result = await client.cancelJobs({
                            jobIds: [j.id],
                            operationKey: crypto.randomUUID(),
                          });
                          setNotice(
                            `Cancellation request ${result.state}. Check the job for its actual outcome.`,
                          );
                          await fetchCampaign(campaign.id);
                        })
                      }
                    >
                      Request cancellation
                    </button>
                  )}
              </article>
            ))
          )}
        </Modal>
      )}
      {commandOpen && <CommandPalette campaigns={campaigns} onClose={() => setCommandOpen(false)} onCampaign={id => openCampaign(id)} onItem={(campaignId, itemId) => openCampaign(campaignId, itemId)} onCreate={() => setCreating(true)} onConnect={() => go("connect")} onReview={campaign && !unsaved ? () => void prepare() : undefined} />}
    </div>
  );
}
