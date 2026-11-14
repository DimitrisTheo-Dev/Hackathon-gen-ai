import { useCallback, useEffect, useRef, useState } from "react";
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

type View = "canvas" | "schedule" | "connect" | "brand";
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
    ["canvas", "schedule", "connect", "brand"].includes(
      new URLSearchParams(location.search).get("view") ?? "",
    )
      ? (new URLSearchParams(location.search).get("view") as View)
      : "canvas",
  );
  const [selected, setSelected] = useState<string | null>(
    new URLSearchParams(location.search).get("item"),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [manifest, setManifest] = useState<ScheduleManifest | null>(null);
  const [grant, setGrant] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [scheduleView, setScheduleView] = useState("agenda");
  const [showActivity, setShowActivity] = useState(false);
  const [creating, setCreating] = useState(false);
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
          list[0];
        setCampaign(currentCampaign ?? null);
        if (currentCampaign)
          setSelected((current) =>
            current && currentCampaign.items.some((i) => i.id === current)
              ? current
              : matchMedia("(max-width: 760px)").matches
                ? null
                : (currentCampaign.items[0]?.id ?? null),
          );
        else setView("connect");
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
    history.replaceState(null, "", url);
    document.title = `${view === "connect" ? "Connect your agent" : view === "schedule" ? "Schedule" : (campaign?.title ?? "Studio")} · Castroom`;
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
    setSidebar(false);
    setError("");
    setNotice("");
  }
  function select(
    next: ContentItem,
    event?: React.MouseEvent<HTMLButtonElement>,
  ) {
    if (event) itemButton.current = event.currentTarget;
    setSelected(next.id);
    setDrafts((prev) => ({
      ...prev,
      [next.id]: prev[next.id] ?? {
        baseRevision: next.revision,
        value: structuredClone(next),
      },
    }));
    if (matchMedia("(max-width: 760px)").matches)
      requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>("#item-title")?.focus(),
      );
  }
  function closeEditor() {
    setSelected(null);
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
    if (!item || !draft || !campaign) return;
    const id = item.id;
    await action(async () => {
      await client.reviseContent({
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
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await fetchCampaign(campaign.id);
      setNotice(
        fixture
          ? "Draft saved in this development browser."
          : "Saved. Your agent can read this revision.",
      );
      setManifest(null);
    });
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
  if (loading)
    return (
      <div className="loading-page">
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
          Castroom
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
  const matches =
    campaign?.items.filter((i) =>
      `${i.title} ${i.script}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
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
    <div className={`app-frame ${fixture ? "fixture-mode" : ""}`}>
      <a className="skip-link" href="#workspace-content">
        Skip to campaign
      </a>
      {fixture && (
        <div className="fixture-banner">
          <span>Development preview</span>Sample drafts saved in this browser.
          Rendering, agent connections, and publishing are unavailable.
          <a href="/docs/capabilities/">
            Integration status <ArrowUpRight size={12} />
          </a>
        </div>
      )}
      <div
        className={`studio-shell ${sidebar ? "nav-open" : ""} ${item && view === "canvas" ? "has-editor" : ""}`}
      >
        <aside className="sidebar">
          <a className="wordmark" href="/">
            <Mark />
            Castroom
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
          <search className="search-box">
            <Search size={15} />
            <label className="sr-only" htmlFor="campaign-search">
              Search content
            </label>
            <input
              id="campaign-search"
              type="search"
              placeholder="Search content…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setView("canvas");
              }}
            />
          </search>
          <nav aria-label="Studio">
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
                onClick={() =>
                  void action(async () => {
                    await fetchCampaign(c.id);
                    setSelected(null);
                    go("canvas");
                  })
                }
              >
                <span className="project-dot" />
                {c.title}
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
                {fixture ? "Development workspace" : context.workspace.name}
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
            {view === "connect" ? (
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
                      {fixture ? "Development fixture" : "Shared workspace"}
                    </div>
                    <h1>{campaign.title}</h1>
                    <p>
                      {campaign.companyContext
                        ? `Stories for ${campaign.companyContext.name}. Ready to shape.`
                        : campaign.brief.split(".")[0] + "."}
                    </p>
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
                    {campaign.items.length} content items
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
                                  item={i}
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
                                <h2>{i.title}</h2>
                                <span className="card-selection">
                                  {selected === i.id ? (
                                    <Check size={11} />
                                  ) : null}
                                </span>
                              </div>
                              <div className="card-state">
                                <span className={`state-dot ${i.status}`} />
                                {i.status.replaceAll("_", " ")}
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
                          onClick={() => setSearch("")}
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
                    {fixture ? "Local development transport" : "Live workspace"}
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
        </div>
        {item && draft && view === "canvas" && (
          <Editor
            key={item.id}
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
          />
        )}
      </div>
      {creating && (
        <CreateCampaign
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
              matchMedia("(max-width: 760px)").matches
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
    </div>
  );
}
