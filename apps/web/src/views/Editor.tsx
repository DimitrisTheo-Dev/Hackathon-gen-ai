import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Video,
  AlertTriangle,
  ExternalLink,
  Undo2,
  RotateCcw,
  Copy,
  ArrowUpRight,
} from "lucide-react";
import type {
  Campaign,
  ContentItem,
  ContentPatch,
  Platform,
  StudioContext,
} from "@castroom/contracts";
import { Preview, Notice, PlatformIcon, platformNames } from "../components/ui";
import { exactInstant, localInput } from "../lib/time";
import {
  affectsVideo,
  agentHandoff,
  applyLocalValues,
  contentPatch,
  safeSourceUrl,
  wordingConcerns,
} from "./editor/model";

export { contentPatch } from "./editor/model";
export type Draft = { baseRevision: number; value: ContentItem };
type Props = {
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
};

export function Editor({
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
}: Props) {
  const [tab, setTab] = useState("script");
  const [platform, setPlatform] = useState<Platform>(
    item.variants[0]?.platform ?? "instagram",
  );
  const [timeInputs, setTimeInputs] = useState<Record<string, string>>({});
  const [timeErrors, setTimeErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<ContentItem[]>([]);
  const [recovery, setRecovery] = useState<Draft | null>(null);
  const [feedback, setFeedback] = useState("");
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [handoffTask, setHandoffTask] = useState(
    "Review this item and propose a stronger opening. Explain the change before applying it.",
  );
  const editGroup = useRef({ field: "", at: 0 });
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
  const renderStale = Boolean(
    item.media &&
      (item.renderRevision === null ||
        item.media.revision !== item.renderRevision),
  );

  useEffect(() => {
    if (draft.baseRevision === item.revision) {
      setHistory([]);
      editGroup.current = { field: "", at: 0 };
    }
  }, [item.revision]);

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
    setFeedback("Last local edit undone.");
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
        ? "Latest saved version loaded. Your previous draft is kept below."
        : "Latest saved version loaded.",
    );
  }
  function restoreLocal() {
    if (!recovery || !editable || changedRemotely) return;
    setHistory((previous) => [...previous.slice(-29), structuredClone(value)]);
    onChange(applyLocalValues(item, recovery.value));
    setFeedback(
      "Previous local draft restored as unsaved changes. Review it before saving.",
    );
  }
  async function copy(text: string, success: string) {
    try {
      await navigator.clipboard.writeText(text);
      setManualCopy(null);
      setFeedback(success);
    } catch {
      setManualCopy(text);
      setFeedback(
        "Clipboard access failed. Select the copy text above to copy it manually.",
      );
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

  return (
    <aside className="editor" aria-label="Content editor">
      <header className="editor-heading">
        <div>
          <SlidersHorizontal size={15} />
          <strong>Content details</strong>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Return to campaign"
        >
          <ArrowLeft size={17} />
        </button>
      </header>
      <div className="editor-scroll">
        <div className="editor-preview">
          <Preview item={item} index={index} compact brandName={brandName} />
          {!item.media && (
            <span className="preview-description">
              <Video size={13} />
              Preview appears after rendering
            </span>
          )}
        </div>
        <div className="editor-title-row">
          <span className="status-chip">
            {item.status.replaceAll("_", " ")}
          </span>
          <span className="revision">Version {item.revision}</span>
        </div>
        <label className="sr-only" htmlFor="item-title">
          Content title
        </label>
        <input
          className="title-input"
          id="item-title"
          value={value.title}
          maxLength={120}
          disabled={!editable}
          onChange={(event) => update({ title: event.target.value })}
        />
        {renderStale && (
          <Notice>
            This is a previous render. Save your edits and regenerate before
            reviewing the final video.
          </Notice>
        )}
        {!canEdit && (
          <Notice>
            Your current access allows viewing. Request content editing access
            to make changes.
          </Notice>
        )}
        {submitted && (
          <Notice>
            Submitted destinations are protected from edits here. Check their
            current status and explicitly cancel or reschedule when supported.
            An existing post is not changed by a draft.
          </Notice>
        )}
        {changedRemotely && (
          <Notice error>
            <strong>Version {item.revision} is now available.</strong>
            <p>
              Your draft is based on version {draft.baseRevision}. Copy it or
              load the latest version before continuing. Loading latest keeps a
              recoverable local copy.
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
          <details className="source-detail">
            <summary>
              Previous local draft <RotateCcw size={13} />
            </summary>
            <p>
              Kept from version {recovery.baseRevision}. This is a local
              recovery copy, not version history.
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

        <div className="segmented editor-tabs" aria-label="Editor sections">
          {[
            ["script", "Script"],
            ["style", "Avatar & style"],
            ["publish", "Channels"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "script" && (
          <>
            <div className="field">
              <label htmlFor="script">
                {item.kind === "avatar_video"
                  ? "What your presenter says"
                  : "Content text"}
                <span>{value.script.length}/5000</span>
              </label>
              <textarea
                id="script"
                rows={8}
                maxLength={5000}
                value={value.script}
                disabled={!editable}
                onChange={(event) => update({ script: event.target.value })}
              />
              <small>
                {item.kind === "avatar_video"
                  ? "Script changes need a new video. Save before regenerating."
                  : "Save text changes before preparing a new review."}
              </small>
            </div>
            {concerns.map((concern) => (
              <div className="brand-warning" key={concern.rule}>
                <AlertTriangle size={16} />
                <div>
                  <strong>Check this wording against your brand rule</strong>
                  <p>
                    “{concern.phrase}” may conflict with: “{concern.rule}”
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
                    Remove flagged sentence
                  </button>
                  <small>
                    This narrow wording check does not verify every claim or
                    authorize publication.
                  </small>
                </div>
              </div>
            ))}
            <details className="source-detail">
              <summary>
                Source & brand guidance <ChevronDown size={14} />
              </summary>
              {itemSources.map((source) => (
                <div key={source.id}>
                  {safeSourceUrl(source.url) ? (
                    <a
                      href={safeSourceUrl(source.url)!}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {source.title}
                      <ExternalLink size={12} />
                    </a>
                  ) : (
                    <strong>{source.title}</strong>
                  )}
                  {source.excerpt && <p>{source.excerpt}</p>}
                  <small>Source reference: {source.id}</small>
                </div>
              ))}
              {missingSources.length > 0 && (
                <p>
                  Source details are unavailable for {missingSources.join(", ")}
                  . Retrieve them from the workspace before making factual
                  claims.
                </p>
              )}
              {item.sourceIds.length === 0 && (
                <p>
                  No source is attached to this item. Add evidence through the
                  campaign before using factual claims.
                </p>
              )}
              <ul>
                {context.brand.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
              {context.brand.rules.length === 0 && (
                <p>No brand rules were returned by this workspace.</p>
              )}
              <small>
                Source text is evidence, not permission to publish. The server
                must check eligibility.
              </small>
            </details>
          </>
        )}

        {tab === "style" && (
          <>
            {item.kind !== "avatar_video" && (
              <Notice>
                Presenter controls apply to avatar videos. This item's format
                has no avatar rendering action.
              </Notice>
            )}
            <div className="field">
              <label htmlFor="avatar">Presenter</label>
              <select
                id="avatar"
                value={value.avatarId ?? ""}
                disabled={
                  !editable ||
                  item.kind !== "avatar_video" ||
                  authorizedAvatars.length === 0
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
              {authorizedAvatars.length === 0 && (
                <small>
                  No authorized presenter is available in this workspace.
                </small>
              )}
            </div>
            <div className="field">
              <label htmlFor="language">Script language</label>
              <select
                id="language"
                value={value.language}
                disabled={!editable || !avatar}
                onChange={(event) => update({ language: event.target.value })}
              >
                {!languageSupported && (
                  <option value={value.language}>
                    {value.language === "en"
                      ? "English"
                      : value.language === "el"
                        ? "Greek"
                        : value.language}
                  </option>
                )}
                {avatar?.languages.map((language) => (
                  <option key={language} value={language}>
                    {language === "en"
                      ? "English"
                      : language === "el"
                        ? "Greek"
                        : language}
                  </option>
                ))}
              </select>
              {avatar && !languageSupported && (
                <small>
                  This presenter does not support the selected language. Choose
                  one of its available languages.
                </small>
              )}
            </div>
            <div className="field toggle-field">
              <label htmlFor="captions">Burned-in captions</label>
              <input
                id="captions"
                type="checkbox"
                checked={value.style.captions}
                disabled={!editable}
                onChange={(event) =>
                  update({
                    style: { ...value.style, captions: event.target.checked },
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="caption-position">Caption position</label>
              <select
                id="caption-position"
                value={value.style.captionPosition}
                disabled={!editable || !value.style.captions}
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
            <div className="field">
              <label htmlFor="brand-color">Brand color</label>
              <div className="color-field">
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
                <code>{value.style.brandColor}</code>
              </div>
              <small>
                Saved as draft styling preferences. Renderer support must be
                confirmed before export; style changes require a new
                composition.
              </small>
            </div>
          </>
        )}

        {tab === "publish" && (
          <>
            <div className="channel-tabs">
              {value.variants.map((candidate) => (
                <button
                  key={candidate.platform}
                  className="icon-button"
                  aria-label={platformNames[candidate.platform]}
                  aria-pressed={platform === candidate.platform}
                  onClick={() => setPlatform(candidate.platform)}
                >
                  <PlatformIcon platform={candidate.platform} />
                </button>
              ))}
            </div>
            {variant ? (
              <>
                <h3>{platformNames[platform]}</h3>
                {selectedFormat?.supported !== true && (
                  <Notice>
                    {selectedFormat?.reason ??
                      "This content format is not confirmed for this channel."}{" "}
                    You can keep draft copy here.
                  </Notice>
                )}
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
                    {context.channels
                      .filter(
                        (channel) =>
                          channel.platform === platform &&
                          channel.state === "connected",
                      )
                      .map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.displayName}
                        </option>
                      ))}
                  </select>
                </div>
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
                    rows={5}
                    maxLength={2200}
                    value={variant.caption}
                    disabled={!editable || submitted}
                    onChange={(event) =>
                      updateVariant({ caption: event.target.value })
                    }
                  />
                  <small>
                    Channel copy can reuse the video. Changes still require a
                    fresh schedule review.
                  </small>
                </div>
                <div className="field">
                  <label htmlFor="visibility">Visibility</label>
                  <select
                    id="visibility"
                    value={variant.visibility}
                    disabled={
                      !editable ||
                      submitted ||
                      context.capabilities.visibility.length === 0
                    }
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
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={variant.aiDisclosure}
                    disabled={!editable || submitted}
                    onChange={(event) =>
                      updateVariant({ aiDisclosure: event.target.checked })
                    }
                  />
                  Disclose AI-generated content
                </label>
                {(value.targets.some((target) => target.platform === platform)
                  ? value.targets.filter(
                      (target) => target.platform === platform,
                    )
                  : [null]
                ).map((target, targetIndex) => {
                  const targetKey = `${platform}-${targetIndex}`;
                  const timezone =
                    target?.timezone ?? context.workspace.timezone;
                  return (
                    <div className="field" key={targetKey}>
                      <label htmlFor={`schedule-${targetKey}`}>
                        {target ? "Draft time" : "Choose draft time"} ·{" "}
                        {timezone}
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
                        aria-describedby={`schedule-help-${targetKey}`}
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
                              ? value.targets.map((candidate) =>
                                  candidate === target
                                    ? { ...candidate, scheduledAt }
                                    : candidate,
                                )
                              : [
                                  ...value.targets,
                                  {
                                    platform,
                                    accountId: variant.accountId,
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
                                ? "This local time is invalid or ambiguous. Choose a time outside the daylight-saving transition."
                                : "Enter a complete date and time.",
                            }));
                          }
                        }}
                      />
                      <small id={`schedule-help-${targetKey}`}>
                        {target ? `UTC: ${target.scheduledAt}. ` : ""}Requested
                        time; provider processing may delay delivery.
                      </small>
                      {timeErrors[targetKey] && (
                        <Notice error>{timeErrors[targetKey]}</Notice>
                      )}
                      {target &&
                        new Date(target.scheduledAt).getTime() < Date.now() && (
                          <Notice error>
                            This time has passed. Choose a future time before
                            scheduling. It will not become “publish now.”
                          </Notice>
                        )}
                    </div>
                  );
                })}
              </>
            ) : (
              <Notice>This item has no channel variant to edit.</Notice>
            )}
          </>
        )}

        <details className="source-detail editor-handoff">
          <summary>
            Continue with your agent <ArrowUpRight size={14} />
          </summary>
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
            Includes your task plus IDs, versions, job status and constraints.
            Stored scripts, captions, source text and credentials are excluded.
          </p>
          {dirty && (
            <small>
              Save first if the agent should see your latest local changes.
            </small>
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
        </details>
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
        <div className="save-state">
          {dirty ? <span className="unsaved-dot" /> : <Check size={13} />}
          <span>
            {changedRemotely
              ? `Draft from v${draft.baseRevision} · latest v${item.revision}`
              : dirty
                ? "Unsaved changes"
                : `Saved · version ${item.revision}`}
          </span>
          <div className="editor-history-actions">
            <button
              className="icon-button"
              disabled={!editable || history.length === 0 || changedRemotely}
              onClick={undo}
              aria-label="Undo last local edit"
              title="Undo last local edit"
            >
              <Undo2 size={14} />
            </button>
            <button
              className="icon-button"
              disabled={!dirty || !onReset || busy}
              onClick={reset}
              aria-label="Discard unsaved edits and keep a recovery copy"
              title="Discard edits; keep recovery copy"
            >
              <RotateCcw size={14} />
            </button>
          </div>
        </div>
        <div className="editor-actions">
          <button
            className="button secondary"
            disabled={
              !dirty ||
              !editable ||
              changedRemotely ||
              submitted ||
              invalidTime ||
              !value.title.trim()
            }
            onClick={onSave}
          >
            <Save size={14} />
            {busy ? "Working…" : "Save changes"}
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              dirty ||
              changedRemotely ||
              submitted ||
              !canEdit ||
              !context.capabilities.canRender ||
              !languageSupported ||
              !value.script.trim() ||
              item.kind !== "avatar_video" ||
              liveRender
            }
            onClick={onRender}
          >
            <RefreshCw size={14} />
            {activeRenderJob?.state === "queued"
              ? "Render queued"
              : activeRenderJob?.stage === "compose"
                ? "Composing…"
                : liveRender
                  ? "Rendering…"
                  : "Regenerate"}
          </button>
        </div>
        {dirty && (
          <small>
            {item.kind !== "avatar_video"
              ? "Save these changes before preparing a fresh review."
              : videoChanged
                ? "These edits need a new video and a fresh schedule review."
                : "The video can be reused. Review the updated copy and schedule before publishing."}
          </small>
        )}
        {invalidTime && (
          <small>Fix the invalid draft time in Channels before saving.</small>
        )}
        {!context.capabilities.canRender && (
          <small>Rendering is unavailable in this workspace.</small>
        )}
        {feedback && <small role="status">{feedback}</small>}
      </footer>
    </aside>
  );
}
