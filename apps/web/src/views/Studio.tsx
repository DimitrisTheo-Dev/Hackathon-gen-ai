import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Check,
  CreditCard,
  Clock3,
  FileText,
  Folder,
  Grid2X2,
  LayoutTemplate,
  Layers,
  List,
  LogOut,
  Menu,
  PanelLeft,
  PenLine,
  Plus,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Video,
  X,
  Zap,
} from "lucide-react";
import type {
  Campaign,
  ContentItem,
  DirectorTurnResult,
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
import { operationKey } from "../lib/operation-key";
import { CommandPalette } from "../components/CommandPalette";
import { itemBadge, liveActivity, timeAgo } from "../lib/status";
import { useAutoGrow } from "../lib/use-auto-grow";
import "../studio.css";
import "../channels.css";

// Views a person opens occasionally load on demand, then stay cached. They are warmed when the browser is idle.
const loadConnect = () => import("./Connect");
const loadReview = () => import("./Review");
const loadCreate = () => import("./CreateCampaign");
const loadBilling = () => import("./Billing");
const loadTemplates = () => import("./Templates");
const Connect = lazy(() => loadConnect().then((m) => ({ default: m.Connect })));
const Review = lazy(() => loadReview().then((m) => ({ default: m.Review })));
const Grant = lazy(() => loadReview().then((m) => ({ default: m.Grant })));
const CreateCampaign = lazy(() => loadCreate().then((m) => ({ default: m.CreateCampaign })));
const Billing = lazy(() => loadBilling().then((m) => ({ default: m.Billing })));
const Templates = lazy(() => loadTemplates().then((m) => ({ default: m.Templates })));
const Channels = lazy(() => import("./Channels").then((m) => ({ default: m.Channels })));
const SIDEBAR_KEY = "faceful:sidebar";
function ViewSkeleton() {
  return <div className="view-skeleton" role="status" aria-label="Loading"><span className="skeleton skeleton-title" /><span className="skeleton skeleton-line" /><span className="skeleton skeleton-line short" /><span className="skeleton skeleton-block" /></div>;
}

import { useDirectorHistory } from '../director/use-history';
import { validateDirectorPlan, restorePatch, directorOperationKey, type DirectorAction, type DirectorEntry } from '../director/model';
type View = "home" | "canvas" | "schedule" | "connect" | "brand" | "billing";
const VIEWS = ["home", "canvas", "schedule", "connect", "brand", "billing"];
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
    VIEWS.includes(
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
  // First-run conversation, before any project exists to hold it.
  const [homeTurn,setHomeTurn]=useState<{text:string;suggestions:string[]}|null>(null);
  const [homeBusy,setHomeBusy]=useState(false);
  const homeAttempt=useRef<{text:string;key:string}|null>(null);
  const sampleKey=useRef(crypto.randomUUID());
  const [templatesOpen,setTemplatesOpen]=useState(false);
  const [focusDirector,setFocusDirector]=useState(false);
  const [playItem,setPlayItem]=useState<string|null>(null);
  const [errorBilling,setErrorBilling]=useState(false);
  const [loadFailure,setLoadFailure]=useState("");
  const [checkoutReturn,setCheckoutReturn]=useState<"success"|"cancelled"|null>(()=>{
    const value=new URLSearchParams(location.search).get("checkout");
    return value==="success"||value==="cancelled"?value:null;
  });
  const [creating, setCreating] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("campaign");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [optimisticItems, setOptimisticItems] = useState<Record<string, ContentItem>>({});
  // Sidebar width is a preference, remembered on this device only.
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(SIDEBAR_KEY) === "collapsed"; } catch { return false; } });
  // Which item the director is currently preparing a plan for (a real, in-flight request).
  const [draftingItem, setDraftingItem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const noticeHeld = useRef(false);
  const homeInput = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(homeInput, homeIdea, 240);
  const director = useDirectorHistory(context,campaign);
  const previousComposer=useRef<{view:View;rect:DOMRect}|null>(null);
  useEffect(()=>{
    // The home composer and the docked composer are one object: remember where it sat, then move the
    // panel so its composer starts there and reveal the rest of the panel around it (FLIP + clip).
    // A passive effect on purpose: the panel's own effect opens it first, and both run before the next paint.
    const panel=document.querySelector<HTMLElement>('.editor');
    const composer=view==='home'
      ? document.querySelector<HTMLElement>('.editor-home .director-composer, .home-idea-form')
      : panel?.querySelector<HTMLElement>('.director-composer')??null;
    const previous=previousComposer.current;
    if(composer)previousComposer.current={view,rect:composer.getBoundingClientRect()};
    if(!panel||!composer||previous?.view!=='home'||view!=='canvas')return;
    if(matchMedia('(prefers-reduced-motion: reduce)').matches||matchMedia('(max-width: 1000px)').matches)return;
    const to=composer.getBoundingClientRect(),box=panel.getBoundingClientRect(),from=previous.rect;
    if(!to.width||!box.width)return;
    const dx=from.left+from.width/2-(to.left+to.width/2),dy=from.top-to.top;
    if(!Number.isFinite(dx)||!Number.isFinite(dy)||(Math.abs(dx)<2&&Math.abs(dy)<2))return;
    const inset=`inset(${Math.max(0,to.top-box.top)}px ${Math.max(0,box.right-to.right)}px ${Math.max(0,box.bottom-to.bottom)}px ${Math.max(0,to.left-box.left)}px round 16px)`;
    panel.animate(
      [{transform:`translate(${dx}px,${dy}px)`,clipPath:inset},{transform:'translate(0,0)',clipPath:'inset(0px 0px 0px 0px round 0px)'}],
      {duration:440,easing:'cubic-bezier(.32,.72,0,1)'},
    );
  },[view,loading,campaign?.id]);
  // One-shot: the composer takes focus only on the mount that follows a create.
  useEffect(()=>{if(!focusDirector)return;const timer=window.setTimeout(()=>setFocusDirector(false),0);return()=>window.clearTimeout(timer);},[focusDirector,selected]);
  useEffect(() => { try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "open"); } catch { /* preference only */ } }, [collapsed]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    // Confirmations leave by themselves; errors stay until dismissed. Hover or focus holds a confirmation open.
    if (!notice) return;
    let shown = 0;
    const timer = window.setInterval(() => { if (!noticeHeld.current && (shown += 250) >= 7000) setNotice(""); }, 250);
    return () => window.clearInterval(timer);
  }, [notice]);
  useEffect(() => {
    const warm = () => { void loadCreate(); void loadReview(); void loadConnect(); void loadBilling(); void loadTemplates(); };
    const timer = window.setTimeout(warm, 2500);
    return () => window.clearTimeout(timer);
  }, []);
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
      .catch((e) => {
        if (!active) return;
        setError(e.message);
        setLoadFailure(e instanceof ApiError ? e.code : "unknown");
      })
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
    document.title = `${view === "connect" ? "Connect your agent" : view === "schedule" ? "Schedule" : view === "billing" ? "Billing" : (campaign?.title ?? "Studio")} · Faceful`;
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
    setErrorBilling(false);
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
    setErrorBilling(false);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      setErrorBilling(e instanceof ApiError && Boolean(e.reviewUrl?.includes("view=billing")));
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
    if(planAction.kind==='checkout'){
      // Runs only from an explicit click on the reviewed action. Payment happens on Stripe's hosted page.
      busyRef.current=true;setBusy(true);setError('');
      try{
        const checkout=await client.createCheckout({priceKey:planAction.priceKey,confirmationGranted:true,operationKey:await directorOperationKey(`${context.workspace.id}:checkout:${intentKey}`)});
        location.assign(checkout.checkoutUrl);
        return {state:'review',message:'Opening Stripe’s test checkout. Your plan changes only after Stripe confirms the payment.'};
      }finally{busyRef.current=false;setBusy(false);}
    }
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
  /** Makes a just-created project the current one and docks the conversation beside it. */
  function adoptCampaign(next: Campaign, message: string) {
    campaignRequest.current++;
    setCampaigns((all) => [next, ...all.filter((c) => c.id !== next.id)]);
    setCampaign(next);
    setSelected(next.items[0]?.id ?? null);
    setSearch(""); setStatusFilter("all");
    setCreating(false); setTemplatesOpen(false);
    go("canvas");
    setNotice(message);
  }
  function directorCreated(next: Campaign, entry: DirectorEntry) {
    const first = next.items[0];
    adoptCampaign(next, "Drafts saved. Nothing has been rendered or scheduled.");
    setFocusDirector(true);
    setMobileChatOpen(true);
    // The request becomes the first turn of the project it created.
    if (first) void director.recordFor(next.id, { ...entry, itemId: first.id, itemTitle: first.title.slice(0, 120) });
  }
  function directorOpen(target: NonNullable<DirectorTurnResult["open"]>) {
    setPlayItem(target.play ? target.itemId : null);
    setMobileChatOpen(true);
    openCampaign(target.campaignId, target.itemId ?? undefined);
  }
  async function submitHomeIdea() {
    const text = homeIdea.trim();
    if (!text || homeBusy || offline || !context) return;
    if (!context.capabilities.canPlanWithDirector) {
      setHomeReply('AI production is not connected yet. Your idea is kept here. Add your own script to create an editable storyboard.');
      return;
    }
    // One key per attempt: retrying after an interrupted response cannot create a second project.
    if (homeAttempt.current?.text !== text) homeAttempt.current = { text, key: crypto.randomUUID() };
    const key = homeAttempt.current.key;
    setHomeBusy(true); setHomeReply(""); setHomeTurn({ text, suggestions: [] });
    try {
      const result = await client.directorTurn({ campaignId: null, itemId: null, scope: "item", instruction: text, sourceIds: [], history: [], operationKey: key });
      homeAttempt.current = null;
      if (result.created) {
        setHomeIdea(""); setHomeTurn(null);
        directorCreated(result.created, { id: key, at: new Date().toISOString(), itemId: "pending", itemTitle: "", scope: "item", instruction: text, sourceIds: [], summary: result.summary.slice(0, 2000), plan: null, results: {}, mode: result.mode, ...(result.suggestions.length ? { suggestions: result.suggestions } : {}) });
        return;
      }
      setHomeReply(result.summary);
      setHomeTurn({ text, suggestions: result.suggestions });
    } catch (e) {
      setHomeReply(e instanceof Error ? e.message : "Your request could not be sent. Nothing was created.");
    } finally {
      setHomeBusy(false);
    }
  }
  function startSample() {
    void action(async () => {
      adoptCampaign(await client.createSampleProject({ operationKey: sampleKey.current }), "Sample project added. It is seeded demonstration content; nothing in it was rendered or published.");
    });
  }
  function homeSuggestion(prompt: string) {
    if (prompt === "Choose a template") setTemplatesOpen(true);
    else if (prompt === "Create with my own script") setCreating(true);
    else { setHomeIdea(prompt); document.getElementById("home-idea")?.focus(); }
  }
  function switchWorkspace(id: string) {
    if (!context || id === context.workspace.id) return;
    if (unsaved) { setError("Save or discard your edits before switching workspace."); return; }
    void action(async () => {
      const nextContext = await client.selectWorkspace(id);
      const list = await client.listCampaigns();
      campaignRequest.current++;
      setContext(nextContext); setCampaigns(list); setCampaign(list[0] ?? null);
      setSelected(list[0]?.items[0]?.id ?? null);
      setDrafts({}); setManifest(null); setView("home");
    });
  }
  async function restoreVersion(revision: number) {
    if (!item || !campaign || !context) throw new Error("Select an item first.");
    const saved = await client.restoreVersion({
      contentId: item.id,
      revision,
      expectedRevision: item.revision,
      operationKey: await operationKey(context.workspace.id, "restore-version", { id: item.id, revision, expected: item.revision }),
    });
    const apply = (current: Campaign) => current.id === campaign.id ? { ...current, items: current.items.map((i) => (i.id === saved.id ? saved : i)) } : current;
    setCampaign((current) => (current ? apply(current) : current));
    setCampaigns((all) => all.map(apply));
    setManifest(null);
    setDrafts((prev) => { const next = { ...prev }; delete next[saved.id]; return next; });
    void fetchCampaign(campaign.id).catch(() => undefined);
    return saved;
  }
  if (loading)
    return (
      <div className="app-frame studio-loading" role="status" aria-busy="true">
        <div className="studio-shell is-home">
          <aside className="sidebar" aria-hidden="true">
            <span className="wordmark"><Mark /><span>Faceful</span></span>
            <span className="skeleton skeleton-line" /><span className="skeleton skeleton-line short" /><span className="skeleton skeleton-line" /><span className="skeleton skeleton-line short" />
          </aside>
          <div className="workspace">
            <div className="topbar" aria-hidden="true"><span className="skeleton skeleton-line short" /></div>
            <div className="workspace-main studio-loading-main">
              <span className="skeleton skeleton-title" aria-hidden="true" />
              <span className="skeleton skeleton-composer" aria-hidden="true" />
              <p>Opening your studio…</p>
            </div>
          </div>
        </div>
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
          {loadFailure === "provider_unavailable" || loadFailure === "not_found" ? <>
            <h1>The studio service isn’t available yet.</h1>
            <p>You’re signed in, but this deployment’s studio service did not respond, so there is no workspace to open. Nothing was lost, and no sample content was substituted.</p>
          </> : loadFailure === "unauthenticated" ? <>
            <h1>Your session has ended.</h1>
            <p>Sign out and sign in again to reopen your workspace.</p>
          </> : <>
            <h1>We couldn’t open your workspace.</h1>
            <Notice error>
              {error || "No workspace is available for this session."}
            </Notice>
          </>}
          <button className="button primary" onClick={() => location.reload()}>
            Try again
          </button>
          <a className="button secondary" href="/docs/">View integration status</a>
          {onSignOut && <button className="text-button" onClick={onSignOut}>Sign out</button>}
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
  const credits = context.capabilities.renderUnitsRemaining;
  const inProject = Boolean(campaign) && (view === "canvas" || view === "schedule");
  return (
    <div className="app-frame">
      <a className="skip-link" href="#workspace-content">
        Skip to campaign
      </a>
      <div
        className={`studio-shell ${view==="home"?"is-home":""} ${item && view === "canvas" ? "has-editor" : ""} ${collapsed ? "sidebar-collapsed" : ""}`}
      >
        <aside className="sidebar" aria-label="Studio">
          <div className="sidebar-top">
            <a className="wordmark" href="/" aria-label="Faceful home">
              <Mark />
              <span>Faceful</span>
            </a>
            <button className="icon-button sidebar-toggle" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed((value) => !value)}>
              <PanelLeft size={16} />
            </button>
          </div>
          {context.workspaces.length > 1 && (
            <div className="workspace-switch">
              <span className="workspace-avatar">{context.workspace.name[0]}</span>
              <select className="workspace-select" aria-label="Switch workspace" value={context.workspace.id} disabled={busy} onChange={(event) => switchWorkspace(event.target.value)}>
                {context.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </select>
            </div>
          )}
          <button className="search-box" onClick={() => setCommandOpen(true)} aria-label="Search projects and content" title="Search">
            <Search size={16} /><span>Search</span><kbd>⌘K</kbd>
          </button>
          <nav aria-label="Studio" className="sidebar-nav">
            <button className={view==="home"?"active":""} aria-current={view==="home"?"page":undefined} title="Create" onClick={()=>go("home")}><Sparkles size={16}/><span>Create</span></button>
            <button className={view === "schedule" ? "active" : ""} aria-current={view==="schedule"?"page":undefined} title="Schedule" onClick={() => go("schedule")}><CalendarDays size={16} /><span>Schedule</span></button>
            <button className={view === "brand" ? "active" : ""} aria-current={view==="brand"?"page":undefined} title="Brand & sources" onClick={() => go("brand")}><FileText size={16} /><span>Brand & sources</span></button>
            {!fixture && <button className={view === "billing" ? "active" : ""} aria-current={view==="billing"?"page":undefined} title="Billing" onClick={() => go("billing")}><CreditCard size={16} /><span>Billing</span></button>}
          </nav>
          <div className="projects-heading">
            <span>Projects</span>
            <button className="icon-button" aria-label="Create a campaign" title="New project" onClick={() => setCreating(true)}><Plus size={14} /></button>
          </div>
          <nav className="project-list" aria-label="Projects">
            {campaigns.length === 0 && <p className="project-empty">Your projects will appear here.</p>}
            {campaigns.map((c) => {
              const working = c.jobs.some((job) => job.state === "queued" || job.state === "running");
              const current = campaign?.id === c.id;
              return (
                <button key={c.id} className={current ? "current-project" : ""} aria-current={current && inProject ? "page" : undefined} onClick={() => openCampaign(c.id)} title={c.title}>
                  <Grid2X2 size={14} className="project-icon" />
                  <span className="project-name">{c.title}</span>
                  {c.origin === "sample" && <span className="sample-chip">Sample</span>}
                  {working && <span className="live-dot" role="img" aria-label="Work in progress" />}
                  <small>{c.items.length}</small>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-bottom">
            <button className={`sidebar-row agent-status ${view === "connect" ? "selected" : ""}`} title="Agents" onClick={() => go("connect")}>
              <Plug size={16} />
              <span>Agents</span>
              <small>{activeConnections.length ? <>{activeConnections.length} connected<i className="live-dot is-steady" aria-hidden="true" /></> : "Connect"}</small>
            </button>
            {!fixture && (
              <button className={`sidebar-row credit-status ${view === "billing" ? "selected" : ""}`} title="Videos you can still render" onClick={() => go("billing")}>
                <Zap size={16} />
                <span>Credits</span>
                <small><b className="tick-number" key={credits}>{credits}</b> left</small>
              </button>
            )}
            <div className="user-row">
              <span className="user-avatar" aria-hidden="true">{fixture ? "D" : context.workspace.name[0]}</span>
              <span className="user-name" title={context.workspace.name}>
                {fixture ? "Personal studio" : context.workspace.name}
                <small>{context.workspace.role}</small>
              </span>
              {onSignOut && <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={onSignOut}><LogOut size={15} /></button>}
            </div>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="breadcrumbs">
              <button className="icon-button mobile-menu" aria-label="Toggle navigation" aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><Menu size={18} /></button>
              <button className="mobile-project-switch" onClick={() => setSidebar(true)} aria-label="Switch project"><span>{campaign?.title ?? "Your projects"}</span><ChevronDown size={15}/></button>
              <Folder size={14} />
              <span>Projects</span>
              <ChevronRight size={12} />
              <strong>
                {view === "connect" ? "Agent connections" : view === "brand" ? "Brand & sources" : view === "billing" ? "Billing" : view === "home" ? "Create" : (campaign?.title ?? "Your campaigns")}
              </strong>
            </div>
            {inProject && (
              <div className="segmented topbar-views" role="group" aria-label="Project view">
                <button aria-pressed={view === "canvas"} onClick={() => go("canvas")}><Grid2X2 size={14} />Canvas</button>
                <button aria-pressed={view === "schedule"} onClick={() => go("schedule")}><CalendarDays size={14} />Schedule</button>
              </div>
            )}
            <div className="topbar-right">
              <span className="timezone-label"><Clock3 size={13} />{context.workspace.timezone}</span>
              {inProject && <button className="icon-button activity-toggle" aria-label="Campaign activity" title="Activity" onClick={() => setShowActivity(true)}><Clock3 size={16} /></button>}
              <button className="icon-button" onClick={() => setCommandOpen(true)} aria-label="Find projects or content" title="Search (⌘K)"><Search size={16} /></button>
              <a className="icon-button" href="/docs/" aria-label="Open documentation" title="Documentation"><ArrowUpRight size={16} /></a>
            </div>
          </header>
          <main
            id="workspace-content"
            tabIndex={-1}
            className={`workspace-main view-${view}`}
          >
            {offline && <div className="feedback is-offline"><Notice error>You’re offline. Unsaved edits stay open; reconnect before saving to the shared workspace.</Notice></div>}
            {(error || notice) && (
              <div className="feedback">
                {error && (
                  <Notice error>
                    {error}
                    {errorBilling && <button className="text-button" onClick={() => go("billing")}>Open billing</button>}
                    <button className="text-button" onClick={() => setError("")}>Dismiss</button>
                  </Notice>
                )}
                {notice && (
                  <div className="success-note" role="status" onMouseEnter={() => { noticeHeld.current = true; }} onMouseLeave={() => { noticeHeld.current = false; }} onFocus={() => { noticeHeld.current = true; }} onBlur={() => { noticeHeld.current = false; }}>
                    <Check size={15} />
                    <span>{notice}</span>
                    <button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={14} /></button>
                  </div>
                )}
              </div>
            )}
            {view === "home" && !campaign ? (<div className="empty-state studio-first">
              <h1>What will we create today?</h1>
              <p>Describe a video. Faceful drafts it, and you shape it together.</p>
              <form className="home-idea-form" aria-busy={homeBusy} onSubmit={e=>{e.preventDefault();void submitHomeIdea();}}>
                <label className="sr-only" htmlFor="home-idea">What would you like to create?</label>
                <textarea ref={homeInput} id="home-idea" value={homeIdea} onChange={e=>setHomeIdea(e.target.value)} rows={3} maxLength={1500} placeholder="A 15-second Instagram Reel introducing our app, friendly and energetic…" enterKeyHint="send" disabled={homeBusy} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void submitHomeIdea();}}}/>
                <div className="home-idea-bar">
                  <small aria-hidden="true"><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</small>
                  <button className="button primary home-send" disabled={!homeIdea.trim()||offline||homeBusy}>{homeBusy?<><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>Drafting…</>:<>Start creating<ArrowUp size={15} aria-hidden="true"/></>}</button>
                </div>
              </form>
              <div className="home-turn" role="status">
                {homeTurn&&<p className="home-turn-request"><small>You</small>{homeTurn.text}</p>}
                {homeBusy&&<p className="home-turn-working"><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>Preparing your first drafts…</p>}
                {homeReply&&<p className="home-turn-reply">{homeReply}</p>}
              </div>
              {!!homeTurn?.suggestions.length&&!homeBusy&&<div className="director-suggestions home-suggestions" aria-label="Suggested next steps">{homeTurn.suggestions.filter(prompt=>prompt!=="Show my content").map(prompt=><button key={prompt} onClick={()=>homeSuggestion(prompt)}>{prompt}</button>)}</div>}
              <div className="home-starters" aria-label="Ways to start">
                <button disabled={homeBusy} onClick={()=>homeSuggestion("Create a 15-second avatar video about ")}><Video size={16} aria-hidden="true"/><span>Create avatar video</span></button>
                {!fixture&&!homeTurn?.suggestions.includes("Choose a template")&&<button disabled={busy||homeBusy} onClick={()=>setTemplatesOpen(true)}><LayoutTemplate size={16} aria-hidden="true"/><span>Choose a template</span></button>}
                <button disabled={homeBusy} onClick={()=>homeSuggestion("Plan three short videos for next week about ")}><CalendarDays size={16} aria-hidden="true"/><span>Plan a campaign</span></button>
                {!fixture&&<button disabled={busy||homeBusy} onClick={startSample}><Sparkles size={16} aria-hidden="true"/><span>Try the BeWell sample</span></button>}
              </div>
              <div className="home-actions" aria-label="Other ways to start">
                <button className="text-button" onClick={()=>setCreating(true)}><PenLine size={13} aria-hidden="true"/>Create with my own script</button>
                <button className="text-button" onClick={()=>go("connect")}><Plug size={13} aria-hidden="true"/>Connect your agent</button>
              </div>
            </div>) : view === "home" ? null : view === "billing" ? (
              <Suspense fallback={<ViewSkeleton />}><Billing
                client={client}
                context={context}
                checkoutReturn={checkoutReturn}
                onReturnHandled={() => {
                  setCheckoutReturn(null);
                  const url = new URL(location.href);
                  url.searchParams.delete("checkout");
                  history.replaceState(history.state, "", url);
                  void refreshContext().catch(() => undefined);
                }}
              /></Suspense>
            ) : view === "connect" ? (
              <Suspense fallback={<ViewSkeleton />}><Connect
                context={context}
                client={client}
                refresh={refreshContext}
                onContinue={() => go("canvas")}
                onCreateCampaign={() => setCreating(true)}
              /></Suspense>
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
            ) : !campaign && view === "schedule" && !fixture ? (
              // No project yet: channels can still be connected here, and Google returns to this view to finish connecting.
              <div className="schedule-view no-project">
                <div className="schedule-header">
                  <div>
                    <h1>Schedule</h1>
                    <p>Nothing is planned yet. Posts appear here once a campaign has times you approved.</p>
                  </div>
                  <button className="button secondary" onClick={() => go("home")}><Sparkles size={14} />Create a video</button>
                </div>
                <div className="channels-slot" data-slot="schedule-channels"><Suspense fallback={null}><Channels context={context} client={client} onChanged={refreshContext} /></Suspense></div>
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
                      {campaign.origin === "sample" && <span className="sample-chip" title="Seeded demonstration content. Nothing in it was rendered or published.">Sample</span>}
                      <span>{campaign.items.length} {campaign.items.length === 1 ? "draft" : "drafts"}</span>
                      <span aria-hidden="true">·</span>
                      <span>{fixture ? "Saved on this device" : "Shared workspace"}</span>
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
                    <button className="button secondary new-campaign-button" onClick={() => setCreating(true)}><Plus size={14} />New campaign</button>
                    <button
                      className="button secondary refresh-button"
                      disabled={busy}
                      aria-label="Refresh campaign"
                      title="Refresh"
                      onClick={() =>
                        void action(async () => {
                          await fetchCampaign(campaign.id);
                          setNotice("Latest saved campaign loaded. Local unsaved drafts are preserved.");
                        })
                      }
                    >
                      <RefreshCw size={14} />
                      <span className="refresh-label">Refresh</span>
                    </button>
                    <button className="button primary" disabled={busy || unsaved} onClick={() => void prepare()}><CalendarDays size={15} />Review schedule</button>
                  </div>
                </div>
                {unsaved && <p className="draft-reminder">Save your edits before reviewing the schedule.</p>}
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
                        {campaign.companyContext?.name ?? context.brand.name} · {matches.length} {matches.length === 1 ? "item" : "items"}
                      </span>
                      <span>Portrait · 9:16</span>
                    </div>
                    <div className="content-grid">
                      {matches.map((i, position) => {
                        const index = campaign.items.indexOf(i);
                        const previewItem = optimisticItems[i.id] ?? i;
                        const badge = itemBadge(i, campaign.jobs);
                        // Animated only for work that is really in flight: a sent request or a job the engine reports.
                        const live = liveActivity(i, campaign.jobs, { saving: Boolean(optimisticItems[i.id]), drafting: draftingItem === i.id });
                        const isSelected = selected === i.id;
                        return (
                          <article
                            className={`content-card ${isSelected ? "selected" : ""} ${live ? "is-live" : ""}`}
                            style={{ "--i": Math.min(position, 8) } as CSSProperties}
                            key={i.id}
                          >
                            {/* Sits on the card's top edge so it never covers the storyboard. */}
                            {live && <span className={`live-pill tone-${live.tone}`}><span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span>{live.label}</span>}
                            <button
                              className="content-select"
                              onClick={(e) => select(i, e)}
                              aria-pressed={isSelected}
                              aria-label={`Edit ${i.title}`}
                            >
                              <div className="card-preview">
                                <Preview
                                  item={previewItem}
                                  index={index}
                                  passive
                                  brandName={campaign.companyContext?.name ?? context.brand.name}
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
                                <span className="card-selection">{isSelected ? <Check size={11} /> : null}</span>
                              </div>
                              <div className="card-state">
                                <span className={`status-pill tone-${badge.tone}`}><i aria-hidden="true" />{optimisticItems[i.id] ? "Saving draft…" : badge.label}</span>
                                <span className="card-version">v{i.revision}</span>
                              </div>
                            </button>
                            <div className="card-footer">
                              <div className="platforms" aria-label="Destinations">
                                {i.variants.map((v) => (
                                  <span key={v.platform} aria-label={platformNames[v.platform]}>
                                    <PlatformIcon platform={v.platform} />
                                  </span>
                                ))}
                              </div>
                              <span>{i.targets[0] ? dateLabel(i.targets[0].scheduledAt, campaign.timezone) : "No time set"}</span>
                            </div>
                            {badge.tone === "failed"
                              ? <p className="card-activity is-failed"><TriangleAlert size={12} aria-hidden="true" />Render failed · open the draft to retry</p>
                              : isSelected && <p className="card-activity"><Check size={12} aria-hidden="true" />Saved v{i.revision} · {timeAgo(i.updatedAt, now)}</p>}
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
                                  {/* Accepted by YouTube and waiting for its publish time: the upload is real, so link to it. */}
                                  {t.platform === "youtube" && t.state === "accepted" && t.providerId && !t.publishedUrl && (
                                    <a
                                      href={`https://studio.youtube.com/video/${encodeURIComponent(t.providerId)}/edit`}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Open in YouTube Studio <ArrowUpRight size={12} />
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
                    {/* Publishing accounts: connect and list them where times are planned. Live workspaces only. */}
                    {!fixture && <div className="channels-slot" data-slot="schedule-channels"><Suspense fallback={null}><Channels context={context} client={client} onChanged={refreshContext} /></Suspense></div>}
                    <button
                      className="text-button"
                      onClick={() => setGrant(true)}
                    >
                      <ShieldCheck size={15} />
                      Authorize a bounded campaign run
                    </button>
                  </div>
                )}
                <footer className="workspace-footer">
                  <span className="quiet-status">
                    <span />
                    {fixture ? "Saved on this device" : "Live workspace"}
                  </span>
                  <div className="run-summary">
                    <span><Video size={13} /><strong>{finished}</strong> {finished === 1 ? "video" : "videos"} ready</span>
                    <span><CalendarDays size={13} /><strong>{accepted}</strong> scheduled</span>
                    <span><Check size={13} /><strong>{published}</strong> published</span>
                    <span><strong>{campaign.humanInterventions}</strong> {fixture ? "local edits" : "edits by people"}</span>
                  </div>
                </footer>
              </>
            )}
          </main>
          <nav className="mobile-dock" aria-label="Workspace shortcuts">
            <button aria-current={sidebar ? "page" : undefined} onClick={() => setSidebar(true)}><Folder size={20}/><span>Projects</span></button>
            <button aria-current={view === "canvas" ? "page" : undefined} onClick={() => go("canvas")}><Grid2X2 size={20}/><span>Canvas</span></button>
            <button aria-current={view === "schedule" ? "page" : undefined} onClick={() => go("schedule")}><CalendarDays size={20}/><span>Schedule</span></button>
            <button onClick={() => {if(view==="home")setCreating(true);else if(!campaign)go("home");else {setSelected(current=>current??campaign?.items[0]?.id??null);setMobileChatOpen(true);}}}>{view==="home"?<Plus size={21}/>:<Sparkles size={20}/>}<span>{view==="home"?"Create":"Chat"}</span></button>
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
            onDirectorTurn={client.directorTurn}
            onDirectorCreated={directorCreated}
            onDirectorOpen={directorOpen}
            onTemplates={fixture?undefined:()=>setTemplatesOpen(true)}
            onBilling={fixture?undefined:()=>go("billing")}
            focusDirector={focusDirector}
            playOnOpen={playItem===item.id}
            onPlayed={()=>setPlayItem(null)}
            versions={fixture?undefined:{load:client.listVersions,restore:restoreVersion}}
            channels={fixture?undefined:<Suspense fallback={null}><Channels context={context} client={client} onChanged={refreshContext} /></Suspense>}
            directorInstruction={directorDrafts[item.id]??""}
            onDirectorInstruction={value=>setDirectorDrafts(previous=>({...previous,[item.id]:value}))}
            onDirectorAction={executeDirector}
            onDirectorBusy={(working) => setDraftingItem(working ? item.id : null)}
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
            <span className="project-thumbnail" aria-hidden="true"><Folder size={20}/></span><span><strong>{c.title}</strong><small>{c.items.length} content items{c.origin === "sample" ? " · Sample" : ""}</small></span>{campaign?.id === c.id && <Check size={17}/>}</button>)}
        </nav>
        <button className="button primary project-create" onClick={() => { setSidebar(false); setCreating(true); }}><Plus size={17}/>New campaign</button>
        <nav className="project-quick-links" aria-label="Workspace">
          <button onClick={() => go("brand")}><FileText size={18}/>Brand & sources<ChevronRight size={16}/></button>
          {!fixture && <button onClick={() => go("billing")}><CreditCard size={18}/>Billing<ChevronRight size={16}/></button>}
          <button onClick={() => go("connect")}><Plug size={18}/>{activeConnections.length ? "Agent connections" : "Connect your agent"}<ChevronRight size={16}/></button>
          <button onClick={() => { setSidebar(false); setCommandOpen(true); }}><Search size={18}/>Search studio<ChevronRight size={16}/></button>
          <a href="/docs/">Help & documentation<ArrowUpRight size={16}/></a>
          {onSignOut && <button onClick={onSignOut}><LogOut size={18}/>Sign out</button>}
        </nav>
        {fixture && <p className="project-fixture-note">Local workspace. Drafts stay on this device; rendering and publishing require connected services.</p>}
      </Modal>}
      <Suspense fallback={null}>
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
      {templatesOpen && (
        <Templates
          client={client}
          onClose={() => setTemplatesOpen(false)}
          onCreated={(next) => adoptCampaign(next, "Drafts created from the template. Edit any line; nothing has been rendered.")}
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
      </Suspense>
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
