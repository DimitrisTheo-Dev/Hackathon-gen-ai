import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  RefreshCw,
  Save,
  Video,
  AlertTriangle,
  ExternalLink,
  Undo2,
  RotateCcw,
  Copy,
  ArrowUpRight,
  X,
  MessageSquare,
  SlidersHorizontal,
} from "lucide-react";
import type {
  Campaign,
  ContentItem,
  Platform,
  StudioContext,
} from "@castroom/contracts";
import { Preview, Notice, PlatformIcon, dateLabel, platformNames } from "../components/ui";
import { SurfaceDialog } from "../components/SurfaceDialog";
import { exactInstant, localInput } from "../lib/time";
import {
  affectsVideo,
  agentHandoff,
  applyLocalValues,
  contentPatch,
  countLabel,
  renderBlockReason,
  safeSourceUrl,
  saveHint,
  wordingConcerns,
} from "./editor/model";
import { DetailSection } from "./editor/DetailSection";
import { OverflowMenu, type OverflowItem } from "./editor/OverflowMenu";

import { DirectorPanel } from '../director/DirectorPanel';
import type { DirectorAction, DirectorEntry } from '../director/model';
import type { ProjectStart } from '../create/settings';
import type { DirectorTurn } from '../director/planner';
import type { ContentVersion, DirectorTurnResult } from "@castroom/contracts";
import { failedRender, itemBadge } from "../lib/status";
import { ReviewPanel, useContentReview, type ReviewApi } from "../review/ReviewPanel";
import { reviewSummary } from "../review/vocabulary";
import "../editor.css";
// Version history is opened occasionally; it loads with its section.
const Versions = lazy(() => import("./Versions").then((module) => ({ default: module.Versions })));
export { contentPatch } from "./editor/model";
export type Draft = { baseRevision: number; value: ContentItem };
type SectionId = "guidance" | "review" | "presenter" | "channels" | "schedule" | "versions";
const languageName = (code: string) => (code === "en" ? "English" : code === "el" ? "Greek" : code);
type Props = {
  directorInstruction: string;
  onDirectorInstruction: (value: string) => void;
  home?: boolean;
  open?: boolean;
  onStart?: () => void;
  onCreate?: () => void;
  /** Opens the guided New project flow, with the request and settings from the home composer. */
  onNewProject?: (start: ProjectStart) => void;
  onShowContent?: () => void;
  /** Sends a conversational turn to the shared engine. */
  onDirectorTurn: DirectorTurn;
  onDirectorCreated?: (campaign: Campaign, entry: DirectorEntry) => void;
  onDirectorOpen?: (target: NonNullable<DirectorTurnResult["open"]>) => void;
  onTemplates?: () => void;
  onBilling?: () => void;
  /** Optional: switch the studio to Agents / Brand & sources in place. Without them those links navigate. */
  onAgents?: () => void;
  onSources?: () => void;
  focusDirector?: boolean;
  /** Open Details and start the saved video once, e.g. after "find … and play it". */
  playOnOpen?: boolean;
  onPlayed?: () => void;
  /** Present only when the workspace keeps server-side version history. */
  versions?: { load: (contentId: string) => Promise<ContentVersion[]>; restore: (revision: number) => Promise<ContentItem> };
  /** Content review of the saved script: claims, voice and captions, what is on screen, and a named approval. */
  reviews?: ReviewApi;
  campaign: Campaign;
  director: { entries: DirectorEntry[]; error: string; record: (entry:DirectorEntry)=>Promise<void>; retry:()=>Promise<void> };
  onDirectorAction: (action:DirectorAction,key:string,reconcile?:boolean)=>Promise<DirectorEntry['results'][string]>;
  /** The workspace's publishing-channels panel, shown at the top of Details → Channels. */
  channels?: ReactNode;
  /** True while the director is preparing a plan for this item. */
  onDirectorBusy?: (working: boolean) => void;
  item: ContentItem;
  index: number;
  context: StudioContext;
  draft: Draft;
  onChange: (value: ContentItem) => void;
  onSave: () => void;
  onRender: () => void;
  onClose: () => void;
  busy: boolean;
  sources?: Campaign["sources"];
  jobs?: Campaign["jobs"];
  onReset?: () => void;
  brandName?: string;
  error?: string;
  offline?: boolean;
};

export function Editor({
  campaign, director, onDirectorAction, directorInstruction, onDirectorInstruction, home=false, open=true, onStart, onCreate, onNewProject, onShowContent,
  onDirectorTurn, onDirectorCreated, onDirectorOpen, onDirectorBusy, channels, onTemplates, onBilling, onAgents, onSources, focusDirector=false, playOnOpen=false, onPlayed, versions, reviews,
  item,
  index,
  context,
  draft,
  onChange,
  onSave,
  onRender,
  onClose,
  busy,
  sources = [],
  jobs = [],
  onReset,
  brandName = context.brand.name,
  error,
  offline = false,
}: Props) {
  const [mode, setMode] = useState<"chat"|"details">("chat");
  // Details is one short list; each row opens in place and they open independently.
  const [sections, setSections] = useState<Partial<Record<SectionId, boolean>>>({});
  const [instantSection, setInstantSection] = useState<SectionId | "">("");
  const [platform, setPlatform] = useState<Platform>(
    item.variants[0]?.platform ?? "instagram",
  );
  const [timeInputs, setTimeInputs] = useState<Record<string, string>>({});
  const [timeErrors, setTimeErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<ContentItem[]>([]);
  const [recovery, setRecovery] = useState<Draft | null>(null);
  const [feedback, setFeedback] = useState("");
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  // The reason shown after someone presses Render while it is unavailable.
  const [renderWhy, setRenderWhy] = useState("");
  const [handoffTask, setHandoffTask] = useState(
    "Review this item and propose a stronger opening. Explain the change before applying it.",
  );
  const editGroup = useRef({ field: "", at: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef("");
  const value = draft.value;
  const patch = contentPatch(item, value);
  const dirty = Object.keys(patch).length > 0;
  const videoChanged = affectsVideo(patch);
  const changedRemotely = draft.baseRevision !== item.revision;
  const canEdit = context.principal.scopes.includes("content:edit");
  const protectedTargets = item.targets.filter((target) =>
    ["accepted", "published", "unknown", "cancel_requested"].includes(
      target.state,
    ),
  );
  const submitted = protectedTargets.length > 0;
  const editable = canEdit && !busy && !submitted;
  const variant = value.variants.find(
    (candidate) => candidate.platform === platform,
  );
  const authorizedAvatars = context.avatars.filter(
    (avatar) => avatar.permission === "authorized",
  );
  const avatar = authorizedAvatars.find(
    (candidate) => candidate.id === value.avatarId,
  );
  const languageSupported = Boolean(avatar?.languages.includes(value.language));
  const activeRenderJob = jobs.find(
    (job) =>
      job.itemId === item.id &&
      ["render", "compose"].includes(job.stage) &&
      ["queued", "running"].includes(job.state),
  );
  const liveRender = Boolean(activeRenderJob);
  const itemSources = sources.filter((source) =>
    item.sourceIds.includes(source.id),
  );
  const missingSources = item.sourceIds.filter(
    (id) => !itemSources.some((source) => source.id === id),
  );
  const concerns = wordingConcerns(value.script, context.brand.rules);
  const invalidTime = Object.values(timeErrors).some(Boolean);
  const selectedFormat = context.capabilities.formats.find(
    (format) => format.kind === value.kind && format.platform === platform,
  );
  const selectedAccount = context.channels.find(
    (channel) => channel.id === variant?.accountId,
  );
  const platformAccounts = context.channels.filter(
    (channel) => channel.platform === platform && channel.state === "connected",
  );
  const badge = itemBadge(item, jobs);
  const failure = failedRender(item, jobs);
  const renderStale = Boolean(
    item.media &&
      (item.renderRevision === null ||
        item.media.revision !== item.renderRevision),
  );
  const isVideo = item.kind === "avatar_video";
  // Every condition that used to disable the render button, now with the reason attached.
  const renderReason = renderBlockReason({
    kind: item.kind,
    canRender: context.capabilities.canRender,
    renderBlocker: context.capabilities.renderBlocker,
    canEdit,
    submitted,
    offline,
    changedRemotely,
    dirty,
    hasPresenter: Boolean(avatar),
    languageSupported,
    hasScript: Boolean(value.script.trim()),
  });
  const renderReady = isVideo && !renderReason && !busy && !liveRender;
  const titleMissing = dirty && !value.title.trim();
  const hint = invalidTime
    ? "Fix the posting time before saving."
    : titleMissing
      ? "Add a title before saving."
      : feedback ||
        (renderWhy && renderWhy === renderReason
          ? renderReason
          : saveHint({
              dirty: dirty && !changedRemotely,
              nextRevision: item.revision + 1,
              kind: item.kind,
              videoChanged,
              hasVideo: Boolean(item.media),
            }) ||
            // Nothing else to say: name the one thing between this draft and a video.
            (!dirty && isVideo && !liveRender ? renderReason : ""));
  const zones = [...new Set(value.targets.map((target) => target.timezone))];
  const sharedZone = zones.length <= 1 ? (zones[0] ?? context.workspace.timezone) : null;
  const times = [...new Set(value.targets.map((target) => target.scheduledAt))].sort();
  const scheduleValue = !times.length
    ? "Not set"
    : times.length > 1
      ? `${times.length} draft times`
      : `Draft · ${dateLabel(times[0], sharedZone ?? context.workspace.timezone)}`;
  const guidanceValue = context.brand.rules.length
    ? countLabel(context.brand.rules.length, "rule")
    : item.sourceIds.length
      ? countLabel(item.sourceIds.length, "source")
      : "None yet";
  const contentReview = useContentReview(reviews, item.id);
  const reviewValue = reviewSummary(contentReview.review, item);
  const presenterValue = !isVideo
    ? "Not used"
    : avatar
      ? avatar.name
      : value.avatarId
        ? "Unavailable"
        : authorizedAvatars.length
          ? "Not chosen"
          : "None available";

  useEffect(() => {
    if (!playOnOpen) return;
    setMode("details");
    const frame = requestAnimationFrame(() => {
      // Playback is a request: if the browser blocks it, the visible controls remain.
      void document.querySelector<HTMLVideoElement>(".editor-preview video")?.play().catch(() => undefined);
      onPlayed?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [playOnOpen]);
  useEffect(() => {
    if (draft.baseRevision === item.revision) {
      setHistory([]);
      editGroup.current = { field: "", at: 0 };
    }
  }, [item.revision]);
  // After a section or the handoff is opened from elsewhere, bring it into view once it exists.
  useEffect(() => {
    if (!pendingScroll.current) return;
    const target = document.getElementById(pendingScroll.current);
    pendingScroll.current = "";
    target?.scrollIntoView({ block: "nearest" });
    if (target instanceof HTMLTextAreaElement) target.focus({ preventScroll: true });
  });

  function toggleSection(id: SectionId, viaKeyboard: boolean) {
    setInstantSection(viaKeyboard ? id : "");
    setSections((previous) => ({ ...previous, [id]: !previous[id] }));
  }
  /** Opens Details on one section — used by the chat ("show versions", "choose a presenter"). */
  function reveal(id: SectionId) {
    onStart?.();
    setMode("details");
    setInstantSection(id);
    setSections((previous) => ({ ...previous, [id]: true }));
    pendingScroll.current = `detail-${id}-trigger`;
  }
  function update(
    next: Partial<ContentItem>,
    group = Object.keys(next).join(","),
  ) {
    if (!editable) return;
    const now = Date.now();
    if (editGroup.current.field !== group || now - editGroup.current.at > 800) {
      setHistory((previous) => [
        ...previous.slice(-29),
        structuredClone(value),
      ]);
    }
    editGroup.current = { field: group, at: now };
    setFeedback("");
    onChange({ ...value, ...next });
  }
  function updateVariant(next: Partial<ContentItem["variants"][number]>) {
    update(
      {
        variants: value.variants.map((candidate) =>
          candidate.platform === platform
            ? { ...candidate, ...next }
            : candidate,
        ),
      },
      `${platform}:${Object.keys(next).join(",")}`,
    );
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous || !editable || changedRemotely) return;
    setHistory((entries) => entries.slice(0, -1));
    setTimeInputs({});
    setTimeErrors({});
    editGroup.current = { field: "", at: 0 };
    onChange(applyLocalValues(item, previous));
    setFeedback("Last edit undone.");
  }
  function reset() {
    if (!onReset || busy) return;
    if (dirty) setRecovery(structuredClone(draft));
    setHistory([]);
    setTimeInputs({});
    setTimeErrors({});
    editGroup.current = { field: "", at: 0 };
    onReset();
    setFeedback(
      dirty
        ? "Latest saved version loaded. Your previous draft is kept above."
        : "Latest saved version loaded.",
    );
  }
  function restoreLocal() {
    if (!recovery || !editable || changedRemotely) return;
    setHistory((previous) => [...previous.slice(-29), structuredClone(value)]);
    onChange(applyLocalValues(item, recovery.value));
    setFeedback("Previous draft restored as unsaved changes.");
  }
  async function copy(text: string, success: string) {
    try {
      await navigator.clipboard.writeText(text);
      setManualCopy(null);
      setFeedback(success);
    } catch {
      setManualCopy(text);
      pendingScroll.current = "manual-copy";
      setFeedback("Clipboard access failed. Select the text to copy it.");
    }
  }
  function localDraftText(local: Draft) {
    return JSON.stringify(
      {
        contentId: item.id,
        basedOnRevision: local.baseRevision,
        title: local.value.title,
        script: local.value.script,
        avatarId: local.value.avatarId,
        language: local.value.language,
        style: local.value.style,
        variants: local.value.variants,
        targets: local.value.targets.map(
          ({ platform, accountId, scheduledAt, timezone }) => ({
            platform,
            accountId,
            scheduledAt,
            timezone,
          }),
        ),
      },
      null,
      2,
    );
  }
  const handoff = agentHandoff(item, context, jobs, handoffTask, dirty);
  const more: OverflowItem[] = [
    ...(editable && history.length > 0 && !changedRemotely
      ? [{ id: "undo", label: "Undo last edit", icon: <Undo2 size={15} aria-hidden="true" />, onSelect: undo }]
      : []),
    ...(dirty && onReset && !busy
      ? [{ id: "discard", label: "Discard edits", icon: <RotateCcw size={15} aria-hidden="true" />, onSelect: reset }]
      : []),
    {
      id: "handoff",
      label: "Continue with your agent",
      icon: <ArrowUpRight size={15} aria-hidden="true" />,
      onSelect: () => {
        setHandoffOpen(true);
        pendingScroll.current = "handoff-task";
      },
    },
  ];
  const section = (id: SectionId) => ({
    id: `detail-${id}`,
    open: Boolean(sections[id]),
    instant: instantSection === id,
    onToggle: (viaKeyboard: boolean) => toggleSection(id, viaKeyboard),
  });

  return (
    <SurfaceDialog title="Content editor" className={`editor ${home?"editor-home":""}`} editor inline={home} open={open} onClose={onClose}>
      {({ close, grip }) => <>
      {!home&&grip}
      <header className="editor-heading">
        <button className="editor-back text-button" data-surface-focus onClick={close} aria-label="Return to campaign"><ArrowLeft size={18} /><span>Campaign</span></button>
        {/* The selected item stays in view in both Chat and Details. */}
        <div className="director-selected">
          <div className="director-thumb"><Preview item={item} index={index} compact brandName={brandName}/></div>
          <div><strong title={item.title}>{item.title}</strong><small>Version {item.revision} · <span className={`status-word tone-${badge.tone}`}>{badge.label}</span></small></div>
        </div>
        {/* The panel is the AI chat. Details (script, presenter, channels, times, review, versions) is one quiet step away. */}
        <div className="editor-heading-actions">
          <button type="button" className="director-preview-switch editor-mode-button" onClick={onShowContent}>Preview</button>
          {mode==='chat'
            ? <button type="button" className="editor-mode-button" onClick={()=>{onStart?.();setMode('details');}}><SlidersHorizontal size={14} aria-hidden="true"/><span>Details</span></button>
            : <button type="button" className="editor-mode-button" onClick={()=>setMode('chat')}><MessageSquare size={14} aria-hidden="true"/><span>AI Chat</span></button>}
        </div>
      </header>
      {/* Kept mounted while Details is open so an in-flight plan, the scope and attachments are not lost. */}
      <div className="editor-chat" hidden={mode!=='chat'}>
        <DirectorPanel instruction={directorInstruction} setInstruction={onDirectorInstruction} home={home} onStart={onStart} onCreate={onCreate} onNewProject={onNewProject} onShowContent={onShowContent} onInspect={()=>{onStart?.();setMode('details');scroller.current?.scrollTo({top:0});}} onTurn={onDirectorTurn} onCreated={onDirectorCreated} onOpen={onDirectorOpen} onTemplates={onTemplates} onBilling={onBilling} onBusy={onDirectorBusy} onVersions={versions?()=>reveal('versions'):undefined} onPresenter={()=>reveal('presenter')} onAgents={onAgents} onSources={onSources} focusOnMount={focusDirector} item={item} campaign={campaign} context={context} entries={director.entries} syncError={director.error} onRecord={director.record} onRetrySync={director.retry} onExecute={onDirectorAction} onDetails={()=>setMode('details')} busy={busy} offline={offline} dirty={dirty}/>
      </div>
      <div className="editor-details" hidden={mode!=='details'}>
      <div className="editor-scroll" ref={scroller}>
        <div className={`editor-preview ${item.media ? "has-media" : "is-storyboard"}`}>
          <Preview item={item} index={index} compact brandName={brandName} />
        </div>
        <label className="sr-only" htmlFor="item-title">
          Title
        </label>
        <input
          className="title-input"
          id="item-title"
          value={value.title}
          maxLength={120}
          disabled={!editable}
          placeholder="Untitled draft"
          onChange={(event) => update({ title: event.target.value })}
        />
        {failure && (
          <Notice error>
            <strong>The last render did not finish.</strong>
            <p>{failure.error?.message ?? "The renderer reported a failure."} Credits held for it were returned.</p>
            {context.capabilities.canRetry && !dirty && (
              <button className="text-button" disabled={busy || offline} onClick={onRender}>Try the render again</button>
            )}
          </Notice>
        )}
        {renderStale && (
          <Notice>
            This video is from an earlier version. Save your edits and
            regenerate before reviewing it.
          </Notice>
        )}
        {!canEdit && (
          <Notice>
            You can view this draft. Ask for editing access to change it.
          </Notice>
        )}
        {submitted && (
          <Notice>
            A destination was already submitted, so this draft is locked here.
            Cancel or reschedule it from its status. An existing post is never
            changed by a draft.
          </Notice>
        )}
        {changedRemotely && (
          <Notice error>
            <strong>Version {item.revision} is now available.</strong>
            <p>
              Your draft is based on version {draft.baseRevision}. Copy it or
              load the latest version; loading keeps a recoverable copy.
            </p>
            <div className="editor-recovery-actions">
              <button
                className="button secondary"
                onClick={() =>
                  void copy(
                    localDraftText(draft),
                    "Your draft text and settings were copied.",
                  )
                }
              >
                <Copy size={13} />
                Copy my draft
              </button>
              <button
                className="button secondary"
                disabled={!onReset || busy}
                onClick={reset}
              >
                <RefreshCw size={13} />
                Load latest version
              </button>
            </div>
          </Notice>
        )}
        {recovery && (
          <details className="editor-recovery">
            <summary>
              <RotateCcw size={13} aria-hidden="true" />
              Previous draft kept
            </summary>
            <p>
              From version {recovery.baseRevision}. A local recovery copy, not
              version history.
            </p>
            <div className="editor-recovery-actions">
              <button
                className="button secondary"
                onClick={() =>
                  void copy(
                    localDraftText(recovery),
                    "Previous draft text and settings were copied.",
                  )
                }
              >
                <Copy size={13} />
                Copy previous draft
              </button>
              <button
                className="button secondary"
                disabled={!editable || changedRemotely || submitted}
                onClick={restoreLocal}
              >
                Restore as unsaved
              </button>
            </div>
          </details>
        )}

        <div className="field script-field">
          <label htmlFor="script">
            {isVideo ? "What your presenter says" : "Content text"}
          </label>
          <textarea
            id="script"
            rows={6}
            maxLength={5000}
            value={value.script}
            disabled={!editable}
            aria-describedby="script-count"
            onChange={(event) => update({ script: event.target.value })}
          />
          <span className="field-count" id="script-count">
            <span className="sr-only">Characters used: </span>
            {value.script.length.toLocaleString("en")} / 5,000
          </span>
        </div>
        {concerns.map((concern) => (
          <div className="brand-warning" key={concern.rule}>
            <AlertTriangle size={15} aria-hidden="true" />
            <div>
              <p>
                <strong>“{concern.phrase}”</strong> may conflict with your
                rule “{concern.rule}”
              </p>
              <button
                className="text-button"
                disabled={!editable}
                onClick={() =>
                  update({
                    script: value.script
                      .replace(concern.sentence, "")
                      .replace(/\n{3,}/g, "\n\n")
                      .trim(),
                  })
                }
              >
                Remove that sentence
              </button>
              <small>
                A narrow wording check. It doesn’t verify claims or authorize
                publishing.
              </small>
            </div>
          </div>
        ))}

        {(isVideo && !avatar) || !times.length || !value.variants.some((variant) => variant.accountId) ? (
          <p className="detail-key"><span className="detail-need" aria-hidden="true">Needed</span> marks what this video still needs before it can render or be scheduled. The other rows are optional.</p>
        ) : null}
        <div className="detail-list">
          <DetailSection {...section("guidance")} label="Guidance" value={guidanceValue}>
            {context.brand.rules.length > 0 ? (
              <ul className="guidance-rules">
                {context.brand.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            ) : (
              <p>No brand rules were returned by this workspace.</p>
            )}
            {itemSources.map((source) => (
              <p className="guidance-source" key={source.id}>
                {safeSourceUrl(source.url) ? (
                  <a
                    href={safeSourceUrl(source.url)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.title}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                ) : (
                  <strong>{source.title}</strong>
                )}
                {source.excerpt && <span>{source.excerpt}</span>}
              </p>
            ))}
            {missingSources.length > 0 && (
              <p>
                Details for {countLabel(missingSources.length, "source")}{" "}
                couldn’t be loaded. Retrieve them from the workspace before
                making factual claims.
              </p>
            )}
            {item.sourceIds.length === 0 && (
              <p>
                No source is attached. Add evidence through the campaign
                before using factual claims.
              </p>
            )}
            <small>
              Sources are evidence, not permission to publish. The server
              checks eligibility.
            </small>
          </DetailSection>

          {reviews && (
            <DetailSection
              {...section("review")}
              label="Review"
              value={
                <>
                  {reviewValue.tone !== "none" && <span className="cr-dot" data-tone={reviewValue.tone} aria-hidden="true" />}
                  <span className="cr-summary">{reviewValue.text}</span>
                </>
              }
            >
              <ReviewPanel
                item={item}
                script={value.script}
                dirty={dirty}
                editable={editable && !changedRemotely}
                offline={offline}
                context={context}
                products={context.products}
                state={contentReview}
                onScript={(next) => update({ script: next }, `review:${next}`)}
                onUndo={undo}
              />
            </DetailSection>
          )}

          <DetailSection {...section("presenter")} label="Presenter & style" value={presenterValue} need={isVideo && !avatar ? "Needed to render" : null}>
            {!isVideo && (
              <p>
                Presenter controls apply to avatar videos. This format has no
                avatar to render.
              </p>
            )}
            {authorizedAvatars.length > 0 || value.avatarId ? (
              <div className="field">
                <label htmlFor="avatar">Presenter</label>
                <select
                  id="avatar"
                  value={value.avatarId ?? ""}
                  disabled={
                    !editable || !isVideo || authorizedAvatars.length === 0
                  }
                  onChange={(event) =>
                    update({ avatarId: event.target.value || null })
                  }
                >
                  <option value="">Select an authorized avatar</option>
                  {value.avatarId && !avatar && (
                    <option value={value.avatarId} disabled>
                      Selected presenter unavailable
                    </option>
                  )}
                  {authorizedAvatars.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              isVideo && (
                <p>No authorized presenter is available in this workspace yet.</p>
              )
            )}
            {avatar ? (
              <div className="field">
                <label htmlFor="language">Script language</label>
                <select
                  id="language"
                  value={value.language}
                  disabled={!editable}
                  onChange={(event) => update({ language: event.target.value })}
                >
                  {!languageSupported && (
                    <option value={value.language}>
                      {languageName(value.language)}
                    </option>
                  )}
                  {avatar.languages.map((language) => (
                    <option key={language} value={language}>
                      {languageName(language)}
                    </option>
                  ))}
                </select>
                {!languageSupported && (
                  <small>
                    This presenter doesn’t support that language. Choose one
                    of theirs.
                  </small>
                )}
              </div>
            ) : (
              <dl className="detail-facts">
                <dt>Script language</dt>
                <dd>{languageName(value.language)}</dd>
              </dl>
            )}
            <div className="field toggle-field">
              <label htmlFor="captions">Burned-in captions</label>
              <input
                id="captions"
                type="checkbox"
                role="switch"
                checked={value.style.captions}
                disabled={!editable}
                onChange={(event) =>
                  update({
                    style: { ...value.style, captions: event.target.checked },
                  })
                }
              />
            </div>
            {value.style.captions && (
              <div className="field">
                <label htmlFor="caption-position">Caption position</label>
                <select
                  id="caption-position"
                  value={value.style.captionPosition}
                  disabled={!editable}
                  onChange={(event) =>
                    update({
                      style: {
                        ...value.style,
                        captionPosition: event.target.value as
                          | "bottom"
                          | "center",
                      },
                    })
                  }
                >
                  <option value="bottom">Lower third</option>
                  <option value="center">Center</option>
                </select>
              </div>
            )}
            <div className="field toggle-field">
              <label htmlFor="brand-color">Brand color</label>
              <div className="color-field">
                <code>{value.style.brandColor}</code>
                <input
                  id="brand-color"
                  type="color"
                  value={value.style.brandColor}
                  disabled={!editable}
                  onChange={(event) =>
                    update({
                      style: { ...value.style, brandColor: event.target.value },
                    })
                  }
                />
              </div>
            </div>
            <small>
              Style is saved with the draft. Changing it needs a new render,
              and the renderer confirms what it can apply.
            </small>
          </DetailSection>

          <DetailSection
            {...section("channels")}
            label="Channels"
            need={value.variants.some((variant) => variant.accountId) ? null : "Needed to schedule"}
            value={
              value.variants.length ? (
                <>
                  <span className="sr-only">
                    {countLabel(value.variants.length, "channel")}
                  </span>
                  {value.variants.map((candidate) => (
                    <PlatformIcon key={candidate.platform} platform={candidate.platform} />
                  ))}
                </>
              ) : (
                "None"
              )
            }
          >
            {/* Publishing accounts for this workspace, passed in by the studio (absent in local previews). */}
            {channels && <div className="channels-slot" data-slot="details-channels">{channels}</div>}
            {value.variants.length > 1 && (
              <div className="segmented channel-tabs" role="group" aria-label="Channel">
                {value.variants.map((candidate) => (
                  <button
                    key={candidate.platform}
                    aria-label={platformNames[candidate.platform]}
                    aria-pressed={platform === candidate.platform}
                    onClick={() => setPlatform(candidate.platform)}
                  >
                    <PlatformIcon platform={candidate.platform} />
                    <span aria-hidden="true">{platformNames[candidate.platform].split(" ")[0]}</span>
                  </button>
                ))}
              </div>
            )}
            {variant ? (
              <>
                {selectedFormat?.supported !== true && (
                  <p className="detail-note">
                    {selectedFormat?.reason ??
                      "This content format is not confirmed for this channel."}{" "}
                    You can keep draft copy here.
                  </p>
                )}
                {platformAccounts.length > 0 || variant.accountId ? (
                  <div className="field">
                    <label htmlFor="channel-account">Publishing account</label>
                    <select
                      id="channel-account"
                      value={variant.accountId ?? ""}
                      disabled={!editable || submitted}
                      onChange={(event) => {
                        const accountId = event.target.value || null;
                        update({
                          variants: value.variants.map((candidate) =>
                            candidate.platform === platform
                              ? { ...candidate, accountId }
                              : candidate,
                          ),
                          targets: value.targets.map((target) =>
                            target.platform === platform
                              ? { ...target, accountId }
                              : target,
                          ),
                        });
                      }}
                    >
                      <option value="">No account selected</option>
                      {variant.accountId &&
                        (!selectedAccount ||
                          selectedAccount.state !== "connected") && (
                          <option value={variant.accountId} disabled>
                            {selectedAccount?.displayName ?? "Selected account"} ·
                            reconnect required
                          </option>
                        )}
                      {platformAccounts.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <dl className="detail-facts">
                    <dt>Publishing account</dt>
                    <dd>Not connected</dd>
                  </dl>
                )}
                <div className="field">
                  <label htmlFor="channel-title">Title</label>
                  <input
                    id="channel-title"
                    maxLength={150}
                    value={variant.title}
                    disabled={!editable || submitted}
                    onChange={(event) =>
                      updateVariant({ title: event.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="channel-copy">Caption</label>
                  <textarea
                    id="channel-copy"
                    rows={4}
                    maxLength={2200}
                    value={variant.caption}
                    disabled={!editable || submitted}
                    onChange={(event) =>
                      updateVariant({ caption: event.target.value })
                    }
                  />
                </div>
                {context.capabilities.visibility.length > 0 && (
                  <div className="field">
                    <label htmlFor="visibility">Visibility</label>
                    <select
                      id="visibility"
                      value={variant.visibility}
                      disabled={!editable || submitted}
                      onChange={(event) =>
                        updateVariant({
                          visibility: event.target
                            .value as ContentItem["variants"][number]["visibility"],
                        })
                      }
                    >
                      {!context.capabilities.visibility.includes(
                        variant.visibility,
                      ) && (
                        <option value={variant.visibility}>
                          {variant.visibility} · not confirmed
                        </option>
                      )}
                      {context.capabilities.visibility.map((visibility) => (
                        <option key={visibility} value={visibility}>
                          {visibility}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="field toggle-field">
                  <label htmlFor="ai-disclosure">Disclose AI-generated content</label>
                  <input
                    id="ai-disclosure"
                    type="checkbox"
                    role="switch"
                    checked={variant.aiDisclosure}
                    disabled={!editable || submitted}
                    onChange={(event) =>
                      updateVariant({ aiDisclosure: event.target.checked })
                    }
                  />
                </div>
                <small>
                  Channel copy reuses the video. Changing it needs a fresh
                  schedule review.
                </small>
              </>
            ) : (
              <p>This item has no channel variant to edit.</p>
            )}
          </DetailSection>

          <DetailSection {...section("schedule")} label="Posting times" value={scheduleValue} need={times.length ? null : "Needed to schedule"}>
            {value.variants.length === 0 && (
              <p>This item has no channel to schedule.</p>
            )}
            {value.variants.flatMap((candidate) => {
              const channel = candidate.platform;
              const channelTargets = value.targets.filter(
                (target) => target.platform === channel,
              );
              return (channelTargets.length ? channelTargets : [null]).map(
                (target, targetIndex) => {
                  const targetKey = `${channel}-${targetIndex}`;
                  const timezone =
                    target?.timezone ?? context.workspace.timezone;
                  return (
                    <div className="field" key={targetKey}>
                      <label htmlFor={`schedule-${targetKey}`}>
                        {platformNames[channel]}
                        {(!sharedZone || !target) && <span>{timezone}</span>}
                      </label>
                      <input
                        id={`schedule-${targetKey}`}
                        type="datetime-local"
                        value={
                          timeInputs[targetKey] ??
                          (target
                            ? localInput(target.scheduledAt, timezone)
                            : "")
                        }
                        disabled={!editable || submitted}
                        aria-invalid={Boolean(timeErrors[targetKey])}
                        aria-describedby="schedule-help"
                        onChange={(event) => {
                          const localTime = event.target.value;
                          setTimeInputs((previous) => ({
                            ...previous,
                            [targetKey]: localTime,
                          }));
                          try {
                            const scheduledAt = exactInstant(
                              localTime,
                              timezone,
                            );
                            const targets = target
                              ? value.targets.map((existing) =>
                                  existing === target
                                    ? { ...existing, scheduledAt }
                                    : existing,
                                )
                              : [
                                  ...value.targets,
                                  {
                                    platform: channel,
                                    accountId: candidate.accountId,
                                    scheduledAt,
                                    timezone,
                                    state: "draft" as const,
                                    publishedAt: null,
                                    providerId: null,
                                    publishedUrl: null,
                                    error: null,
                                  },
                                ];
                            update({ targets }, targetKey);
                            setTimeErrors((previous) => ({
                              ...previous,
                              [targetKey]: "",
                            }));
                          } catch {
                            setTimeErrors((previous) => ({
                              ...previous,
                              [targetKey]: localTime
                                ? "That time is skipped or repeated when the clocks change. Choose another."
                                : "Enter a complete date and time.",
                            }));
                          }
                        }}
                      />
                      {target && editable && !submitted && (
                        <button
                          type="button"
                          className="text-button posting-remove"
                          aria-label={`Don’t post to ${platformNames[channel]}`}
                          onClick={() => {
                            update({ targets: value.targets.filter((existing) => existing !== target) }, targetKey);
                            setTimeInputs((previous) => ({ ...previous, [targetKey]: "" }));
                          }}
                        >
                          Don’t post here
                        </button>
                      )}
                      {timeErrors[targetKey] && (
                        <Notice error>{timeErrors[targetKey]}</Notice>
                      )}
                      {target &&
                        new Date(target.scheduledAt).getTime() < Date.now() && (
                          <Notice error>
                            This time has passed. Choose a future one; it will
                            not become “publish now.”
                          </Notice>
                        )}
                    </div>
                  );
                },
              );
            })}
            <small id="schedule-help">
              Draft times{sharedZone ? ` in ${sharedZone}` : ""}. Nothing posts
              until you approve the schedule, and a platform may deliver a
              little late.
            </small>
          </DetailSection>

          {versions && (
            <DetailSection {...section("versions")} label="Versions" value={`v${item.revision}`}>
              <Suspense fallback={<div className="view-skeleton" role="status" aria-label="Loading versions"><span className="skeleton skeleton-line" /><span className="skeleton skeleton-block" /></div>}><Versions
                item={item}
                timezone={campaign.timezone}
                load={versions.load}
                restore={versions.restore}
                blocked={dirty ? "Save or discard your unsaved edits before restoring a version." : offline ? "Reconnect to restore a version." : submitted ? "A destination has been submitted for this item, so it can’t be changed here." : !canEdit ? "Your access allows viewing only." : ""}
              /></Suspense>
            </DetailSection>
          )}
        </div>

        {handoffOpen && (
          <section className="editor-handoff" aria-labelledby="handoff-heading">
            <div className="editor-handoff-head">
              <h3 id="handoff-heading">Continue with your agent</h3>
              <button
                className="icon-button"
                aria-label="Close agent handoff"
                onClick={() => setHandoffOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="field">
              <label htmlFor="handoff-task">Task for your agent</label>
              <textarea
                id="handoff-task"
                rows={3}
                maxLength={600}
                value={handoffTask}
                onChange={(event) => setHandoffTask(event.target.value)}
              />
            </div>
            <p>
              Copies your task with IDs, versions and job status. Scripts,
              captions, sources and credentials are left out.
            </p>
            {dirty && (
              <p>Save first if the agent should see your latest edits.</p>
            )}
            <button
              className="button secondary"
              disabled={!handoffTask.trim()}
              onClick={() =>
                void copy(
                  handoff,
                  "Handoff copied. Paste it into your connected agent.",
                )
              }
            >
              <Copy size={13} />
              Copy handoff
            </button>
            <details>
              <summary>Inspect copied handoff</summary>
              <pre className="editor-handoff-code">{handoff}</pre>
            </details>
          </section>
        )}
        {manualCopy !== null && (
          <div className="field">
            <label htmlFor="manual-copy">Copy text manually</label>
            <textarea
              id="manual-copy"
              rows={5}
              readOnly
              value={manualCopy}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button className="text-button" onClick={() => setManualCopy(null)}>
              Hide copy text
            </button>
          </div>
        )}
      </div>
      <footer className="editor-footer">
        {error && <Notice error>{error}</Notice>}
        <div className="editor-status">
          <p className="save-state">
            {dirty ? <span className="unsaved-dot" /> : <Check size={13} aria-hidden="true" />}
            {changedRemotely ? (
              <span>Draft from v{draft.baseRevision} · latest v{item.revision}</span>
            ) : dirty ? (
              <span>Unsaved changes</span>
            ) : (
              <>
                <span aria-hidden="true">Saved · v{item.revision}</span>
                <span className="sr-only">Saved · version {item.revision}</span>
              </>
            )}
          </p>
          {offline ? (
            <p className="editor-hint editor-offline" role="status">You’re offline. Your unsaved draft stays here.</p>
          ) : (
            hint && <p className="editor-hint" role="status">{hint}</p>
          )}
        </div>
        <div className="editor-actions">
          <OverflowMenu label="More actions" items={more} />
          {isVideo && (
            <span className="editor-render" data-tip={renderReason && hint !== renderReason ? renderReason : undefined}>
              <button
                className={`button ${renderReady ? "primary" : "secondary"}`}
                disabled={busy || liveRender}
                aria-disabled={renderReason ? true : undefined}
                aria-describedby={renderReason ? "render-reason" : undefined}
                onClick={() => {
                  // Still a guard, not only a style: a blocked render explains itself and goes no further.
                  if (renderReason) {
                    setRenderWhy(renderReason);
                    return;
                  }
                  onRender();
                }}
              >
                {item.media ? <RefreshCw size={14} aria-hidden="true" /> : <Video size={14} aria-hidden="true" />}
                {activeRenderJob?.state === "queued"
                  ? "Render queued"
                  : activeRenderJob?.stage === "compose"
                    ? "Composing…"
                    : liveRender
                      ? "Rendering…"
                      : item.media
                        ? "Regenerate"
                        : "Render video"}
              </button>
              {renderReason && <span className="sr-only" id="render-reason">{renderReason}</span>}
            </span>
          )}
          <button
            className={`button ${renderReady ? "secondary" : "primary"}`}
            disabled={
              !dirty ||
              offline ||
              !editable ||
              changedRemotely ||
              submitted ||
              invalidTime ||
              !value.title.trim()
            }
            onClick={onSave}
          >
            <Save size={14} aria-hidden="true" />
            {busy ? "Working…" : "Save changes"}
          </button>
        </div>
      </footer>
      </div>
      </>}
    </SurfaceDialog>
  );
}
