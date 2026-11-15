import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle, MessageCircle, Plus, Send, X } from "lucide-react";
import { Notice } from "../components/ui";
import { ApiError } from "../data/client";
import type { CampaignDraft, CampaignOverview, CampaignsApi, DmCampaign, DmConversation, DmMessage } from "./campaigns-api";
import { plural } from "./model";

/**
 * Settings → Comment to DM. A campaign listens for a keyword in comments on one Instagram account and answers the
 * commenter privately; when they write back, Gemini can carry the conversation and follow-ups go out on schedule.
 * "Try it" sends a test comment and reply through the real webhook pipeline with nothing sent to Instagram, and shows
 * what would have gone out. Every state shown here is the engine's.
 */

/** Follow-up delays, all inside the 24 hours Instagram allows after a person's message. */
const DELAYS = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 180, label: "3 hours" },
  { minutes: 360, label: "6 hours" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1380, label: "23 hours" },
];
const KIND_LABEL: Record<string, string> = {
  comment: "Comment",
  message: "Their message",
  opening: "Private reply",
  public_reply: "Public reply under the comment",
  ai: "AI answer",
  follow_up: "Follow-up",
  notice: "Notice",
};
const STATE_LABEL = { awaiting_reply: "Waiting for their reply", open: "Talking", stopped: "Asked to stop" } as const;

function failureText(failure: unknown, fallback: string) {
  if (!(failure instanceof ApiError) || !failure.message.trim()) return fallback;
  if (failure.code === "unauthenticated") return "Your sign-in ended. Sign in again to manage campaigns.";
  // A contract refusal names a field and a rule; the form checks those first, so this is a fallback only.
  if (failure.code === "validation_error" && failure.message.startsWith("The request does not match")) {
    const rule = failure.message.match(/\(([^)]*)\)/)?.[1];
    return rule ? `${fallback} (${rule})` : fallback;
  }
  return failure.message;
}
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });

function emptyDraft(accountId: string): CampaignDraft {
  return { accountId, name: "", enabled: true, keywords: [], openingMessage: "", linkUrl: "", publicReply: "", aiEnabled: true, aiInstructions: "", followUps: [] };
}
function draftFrom(campaign: DmCampaign): CampaignDraft {
  return {
    accountId: campaign.accountId,
    name: campaign.name,
    enabled: campaign.enabled,
    keywords: campaign.keywords,
    openingMessage: campaign.openingMessage,
    linkUrl: campaign.linkUrl ?? "",
    publicReply: campaign.publicReply ?? "",
    aiEnabled: campaign.aiEnabled,
    aiInstructions: campaign.aiInstructions ?? "",
    followUps: campaign.followUps,
  };
}
/** What is wrong with a draft, in words for the person, or null. The engine checks again. */
function problem(draft: CampaignDraft): string | null {
  if (!draft.name.trim()) return "Give the campaign a name.";
  if (!draft.keywords.length) return "Add at least one keyword.";
  if (draft.keywords.some((keyword) => keyword.length > 40)) return "Keep each keyword under 40 characters.";
  if (!draft.openingMessage.trim()) return "Write the message people get when they comment.";
  if (draft.linkUrl.trim() && !/^https:\/\/\S+$/.test(draft.linkUrl.trim())) return "The link must start with https://";
  if (draft.followUps.some((followUp) => !followUp.text.trim())) return "Write each follow-up, or remove the empty one.";
  return null;
}
const keywordsFrom = (text: string) => [...new Set(text.split(",").map((keyword) => keyword.trim()).filter(Boolean))].slice(0, 10);

function statusText(message: DmMessage) {
  switch (message.status) {
    case "simulated":
      return message.direction === "out" ? "Would be sent" : "Received";
    case "sent":
      return message.sentAt ? `Sent ${time(message.sentAt)}` : "Sent";
    case "scheduled":
      return message.sendAt ? `Scheduled for ${time(message.sendAt)}` : "Scheduled";
    case "received":
      return message.sentAt ? time(message.sentAt) : "Received";
    case "skipped":
      return `Skipped${message.error ? `: ${message.error}` : ""}`;
    case "failed":
      return `Not sent${message.error ? `: ${message.error}` : ""}`;
    case "cancelled":
      return `Cancelled${message.error ? `: ${message.error}` : ""}`;
    default:
      return message.status;
  }
}

function MessageLog({ messages, label }: { messages: DmMessage[]; label: string }) {
  if (!messages.length) return null;
  return (
    <ol className="campaign-log" aria-label={label}>
      {messages.map((message) => (
        <li key={message.id} data-direction={message.direction} data-status={message.status}>
          <span className="campaign-log-kind">{KIND_LABEL[message.kind] ?? message.kind}</span>
          {message.text && <p>{message.text}</p>}
          <span className="campaign-log-status">{statusText(message)}</span>
        </li>
      ))}
    </ol>
  );
}

type Panel = { kind: "edit"; id: string | null; draft: CampaignDraft; keywordsText: string } | { kind: "test" | "people" | "delete"; id: string } | null;

export function CampaignsSection({ api }: { api: CampaignsApi }) {
  const [overview, setOverview] = useState<CampaignOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testText, setTestText] = useState("");
  const [testConversation, setTestConversation] = useState<DmConversation | null>(null);
  const [testVia, setTestVia] = useState<"webhook" | "direct" | null>(null);
  const [people, setPeople] = useState<DmConversation[] | null>(null);
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const alive = useRef(true);
  const heading = useId();
  const formId = useId();

  const load = useCallback(async () => {
    try {
      const next = await api.overview();
      if (!alive.current) return;
      setOverview(next);
      setLoadFailed(false);
    } catch {
      if (alive.current) setLoadFailed(true);
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function run(label: string, fallback: string, work: () => Promise<string | void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const said = await work();
      if (!alive.current) return;
      if (said) setNotice(said);
      await load();
    } catch (failure) {
      if (alive.current) setError(failureText(failure, fallback));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const campaigns = overview?.campaigns ?? [];
  const messagingAccounts = overview?.accounts.filter((account) => account.canMessage) ?? [];
  const accountName = (id: string) => overview?.accounts.find((account) => account.id === id)?.displayName ?? "an account no longer connected";
  const canManage = Boolean(overview?.canManage);
  const working = busy !== null;

  function open(next: Panel) {
    setError("");
    setNotice("");
    setPanel(next);
    setTestText("");
    setTestConversation(null);
    setTestVia(null);
    setPeople(null);
    setOpenPerson(null);
    if (next?.kind === "test")
      void api
        .testState(next.id)
        .then((state) => alive.current && setTestConversation(state.conversation))
        .catch(() => undefined);
    if (next?.kind === "people")
      void api
        .conversations(next.id)
        .then((list) => alive.current && setPeople(list))
        .catch((failure) => alive.current && setError(failureText(failure, "Conversations couldn’t be loaded. Try again.")));
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (panel?.kind !== "edit") return;
    const draft = { ...panel.draft, keywords: keywordsFrom(panel.keywordsText) };
    const wrong = problem(draft);
    if (wrong) {
      setError(wrong);
      return;
    }
    const clean = { ...draft, name: draft.name.trim(), openingMessage: draft.openingMessage.trim(), linkUrl: draft.linkUrl.trim(), publicReply: draft.publicReply.trim(), aiInstructions: draft.aiInstructions.trim() };
    void run("saving", "The campaign couldn’t be saved. Nothing changed; try again.", async () => {
      if (panel.id) {
        const { accountId: _account, ...patch } = clean;
        await api.update(panel.id, patch);
      } else await api.create(clean);
      setPanel(null);
      return panel.id ? `Saved ${clean.name}.` : `Created ${clean.name}.${clean.enabled ? " It’s listening for comments now." : ""}`;
    });
  }
  const toggle = (campaign: DmCampaign) =>
    run(`toggle:${campaign.id}`, `${campaign.name} couldn’t be switched ${campaign.enabled ? "off" : "on"}. Nothing changed; try again.`, async () => {
      await api.update(campaign.id, { enabled: !campaign.enabled });
      return campaign.enabled ? `${campaign.name} is off. It no longer answers comments.` : `${campaign.name} is on. It’s listening for comments now.`;
    });
  const remove = (campaign: DmCampaign) =>
    run("deleting", `${campaign.name} couldn’t be deleted. Nothing changed; try again.`, async () => {
      const { cancelledMessages } = await api.remove(campaign.id);
      setPanel(null);
      return `Deleted ${campaign.name}.${cancelledMessages ? ` ${plural(cancelledMessages, "scheduled message was", "scheduled messages were")} cancelled.` : ""}`;
    });
  function sendTest(event: FormEvent, campaign: DmCampaign) {
    event.preventDefault();
    const text = testText.trim();
    if (!text || busy) return;
    const kind = testConversation ? "reply" : "comment";
    setBusy("testing");
    setError("");
    void api
      .test(campaign.id, { kind, text })
      .then((result) => {
        if (!alive.current) return;
        setTestConversation(result.conversation);
        setTestVia(result.via ?? null);
        setTestText("");
        if (kind === "comment" && !result.conversation) setError(`That comment has none of the keywords (${campaign.keywords.join(", ")}), so nothing would be sent.`);
      })
      .catch((failure) => alive.current && setError(failureText(failure, "The test couldn’t run. Try again.")))
      .finally(() => alive.current && setBusy(null));
  }
  const resetTest = (campaign: DmCampaign) => {
    if (busy) return;
    setBusy("testing");
    void api
      .test(campaign.id, { kind: "reset" })
      .then(() => alive.current && (setTestConversation(null), setTestVia(null)))
      .catch((failure) => alive.current && setError(failureText(failure, "The test couldn’t be reset. Try again.")))
      .finally(() => alive.current && setBusy(null));
  };
  const edit = panel?.kind === "edit" ? panel : null;
  const setDraft = (patch: Partial<CampaignDraft>) => edit && setPanel({ ...edit, draft: { ...edit.draft, ...patch } });

  return (
    <section className="channels campaigns" aria-labelledby={heading} aria-busy={working || !overview}>
      <header className="channels-head">
        <h2 id={heading}>Comment to DM</h2>
        <p>When someone comments a keyword, they get a private message. AI can answer their replies.</p>
      </header>
      {error && (
        <Notice error>
          {error}
          <button className="text-button" onClick={() => setError("")}>Dismiss</button>
        </Notice>
      )}
      <p className="channels-status" role="status" aria-live="polite">
        {notice && (
          <>
            <Check size={14} aria-hidden="true" />
            {notice}
          </>
        )}
      </p>

      {loadFailed ? (
        <p className="settings-empty" role="alert">
          Campaigns couldn’t be loaded.{" "}
          <button className="text-button" onClick={() => void load()}>Retry</button>
        </p>
      ) : !overview ? (
        <p className="settings-skeleton" role="status"><span className="sr-only">Loading campaigns…</span></p>
      ) : (
        <>
          <dl className="campaign-facts">
            <div>
              <dt>Instagram activity</dt>
              <dd>{overview.webhook.instagram ? "Comments and messages come in on their own for accounts connected directly." : "Not switched on for this deployment yet, so campaigns can’t hear comments. Try it still works."}</dd>
            </div>
            <div>
              <dt>AI answers</dt>
              <dd>{overview.ai ? "Gemini answers people who write back." : "Off: this deployment has no Gemini key, so replies wait for you."}</dd>
            </div>
          </dl>

          {campaigns.length === 0 ? (
            <p className="settings-empty">
              {messagingAccounts.length ? "No campaigns yet." : "Connect an Instagram account directly (in Add an account above) to start a campaign. Accounts reached through Buffer can only post."}
            </p>
          ) : (
            <ul className="settings-rows campaign-rows">
              {campaigns.map((campaign) => {
                const expanded = panel && panel.kind !== "edit" ? panel.id === campaign.id : edit?.id === campaign.id;
                return (
                  <li key={campaign.id} data-expanded={expanded || undefined}>
                    <span className="channel-icon" aria-hidden="true"><MessageCircle size={17} /></span>
                    <div className="settings-row-body">
                      <strong>{campaign.name}</strong>
                      <span>
                        {campaign.keywords.map((keyword) => `“${keyword}”`).join(", ")} · {accountName(campaign.accountId)} · {plural(campaign.people, "person", "people")} reached
                      </span>
                    </div>
                    <div className="settings-row-side">
                      {canManage ? (
                        <label className="campaign-switch">
                          <input type="checkbox" role="switch" checked={campaign.enabled} disabled={working} aria-label={`${campaign.name} listens for comments`} onChange={() => void toggle(campaign)} />
                          <span>{busy === `toggle:${campaign.id}` ? "…" : campaign.enabled ? "On" : "Off"}</span>
                        </label>
                      ) : (
                        <span className={`channel-chip ${campaign.enabled ? "connected" : "unavailable"}`}>{campaign.enabled ? "On" : "Off"}</span>
                      )}
                      {canManage && (
                        <button className="text-button" aria-expanded={panel?.kind === "test" && panel.id === campaign.id} disabled={working} onClick={() => open(panel?.kind === "test" && panel.id === campaign.id ? null : { kind: "test", id: campaign.id })}>
                          Try it
                        </button>
                      )}
                      <button className="text-button" aria-expanded={panel?.kind === "people" && panel.id === campaign.id} disabled={working} onClick={() => open(panel?.kind === "people" && panel.id === campaign.id ? null : { kind: "people", id: campaign.id })}>
                        Conversations
                      </button>
                      {canManage && (
                        <>
                          <button className="text-button" disabled={working} onClick={() => open({ kind: "edit", id: campaign.id, draft: draftFrom(campaign), keywordsText: campaign.keywords.join(", ") })}>Edit</button>
                          <button className="text-button" aria-expanded={panel?.kind === "delete" && panel.id === campaign.id} disabled={working} onClick={() => open({ kind: "delete", id: campaign.id })}>Delete</button>
                        </>
                      )}
                    </div>

                    {panel?.kind === "delete" && panel.id === campaign.id && (
                      <div className="channel-confirm campaign-panel" role="group" aria-label={`Delete ${campaign.name}`}>
                        <p>Delete {campaign.name}? It stops answering comments, and follow-ups not yet sent are cancelled. Conversations already started stay in their history.</p>
                        <div>
                          <button className="button secondary" disabled={working} onClick={() => setPanel(null)} autoFocus>Keep it</button>
                          <button className="button danger" disabled={working} onClick={() => void remove(campaign)}>{busy === "deleting" ? "Deleting…" : "Delete"}</button>
                        </div>
                      </div>
                    )}

                    {panel?.kind === "test" && panel.id === campaign.id && (
                      <div className="campaign-panel campaign-test">
                        <p className="ob-fine">
                          Nothing is sent to Instagram. {testVia === "webhook" ? "Your test arrived as a signed delivery at the address Instagram uses, and ran like a real one." : testVia === "direct" ? "This deployment can’t sign test deliveries yet, so the test was taken in directly." : "Comment as a follower would, then reply."}
                          {campaign.aiEnabled && !overview.ai && " AI answers are off here, so replies show as skipped."}
                        </p>
                        {testConversation && <MessageLog messages={testConversation.messages} label="Test conversation" />}
                        <form className="campaign-test-form" onSubmit={(event) => sendTest(event, campaign)}>
                          <input
                            aria-label={testConversation ? "Your reply, as the person" : "Your comment, as a follower"}
                            placeholder={testConversation ? "Reply as the person…" : `Comment, e.g. “${campaign.keywords[0] ?? ""} please”`}
                            value={testText}
                            maxLength={2000}
                            onChange={(event) => setTestText(event.target.value)}
                          />
                          <button className="button primary" disabled={working || !testText.trim()}>
                            {busy === "testing" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
                            {testConversation ? "Send reply" : "Send comment"}
                          </button>
                        </form>
                        {testConversation && (
                          <button className="text-button" disabled={working} onClick={() => resetTest(campaign)}>Start over</button>
                        )}
                      </div>
                    )}

                    {panel?.kind === "people" && panel.id === campaign.id && (
                      <div className="campaign-panel">
                        {!people ? (
                          <p className="settings-skeleton" role="status"><span className="sr-only">Loading conversations…</span></p>
                        ) : people.length === 0 ? (
                          <p className="settings-empty">Nobody yet. People appear here once the campaign messages them.</p>
                        ) : (
                          <ul className="campaign-people">
                            {people.map((person) => {
                              const last = person.messages.at(-1);
                              const showing = openPerson === person.id;
                              return (
                                <li key={person.id}>
                                  <button className="campaign-person" aria-expanded={showing} onClick={() => setOpenPerson(showing ? null : person.id)}>
                                    <strong>{person.contactName ? `@${person.contactName}` : "Someone"}</strong>
                                    <span>{STATE_LABEL[person.state]}{last ? ` · ${last.text.slice(0, 80) || statusText(last)}` : ""}</span>
                                  </button>
                                  {showing && <MessageLog messages={person.messages} label={`Conversation with ${person.contactName ?? "this person"}`} />}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {canManage && messagingAccounts.length > 0 && !edit && (
            <div>
              <button className="button secondary" disabled={working} onClick={() => open({ kind: "edit", id: null, draft: emptyDraft(messagingAccounts[0].id), keywordsText: "" })}>
                <Plus size={14} aria-hidden="true" /> New campaign
              </button>
            </div>
          )}

          {edit && canManage && (
            <form className="settings-form campaign-form" aria-label={edit.id ? `Edit ${edit.draft.name}` : "New campaign"} onSubmit={save}>
              {!edit.id && messagingAccounts.length > 1 && (
                <div className="ob-field">
                  <label htmlFor={`${formId}-account`}>Instagram account</label>
                  <select id={`${formId}-account`} value={edit.draft.accountId} onChange={(event) => setDraft({ accountId: event.target.value })}>
                    {messagingAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
                  </select>
                </div>
              )}
              <div className="ob-field">
                <label htmlFor={`${formId}-name`}>Name</label>
                <input id={`${formId}-name`} value={edit.draft.name} maxLength={80} placeholder="Free guide" onChange={(event) => setDraft({ name: event.target.value })} required />
              </div>
              <div className="ob-field">
                <label htmlFor={`${formId}-keywords`}>Keywords <span>Separate with commas. Whole words, any case or accents.</span></label>
                <input id={`${formId}-keywords`} value={edit.keywordsText} placeholder="guide, οδηγός" onChange={(event) => setPanel({ ...edit, keywordsText: event.target.value })} required />
              </div>
              <div className="ob-field">
                <label htmlFor={`${formId}-opening`}>Private message <span>Sent once, in answer to the comment.</span></label>
                <textarea id={`${formId}-opening`} rows={3} maxLength={1000} value={edit.draft.openingMessage} placeholder="Here’s the guide you asked for: {link}" onChange={(event) => setDraft({ openingMessage: event.target.value })} required />
              </div>
              <div className="ob-field">
                <label htmlFor={`${formId}-link`}>Link <span>Optional. Goes where you write {"{link}"}, or at the end of the private message.</span></label>
                <input id={`${formId}-link`} type="url" inputMode="url" value={edit.draft.linkUrl} placeholder="https://" onChange={(event) => setDraft({ linkUrl: event.target.value })} />
              </div>
              <div className="ob-field">
                <label htmlFor={`${formId}-public`}>Public reply <span>Optional. Posted under the comment.</span></label>
                <input id={`${formId}-public`} value={edit.draft.publicReply} maxLength={300} placeholder="Sent you a message 📩" onChange={(event) => setDraft({ publicReply: event.target.value })} />
              </div>
              <div className="campaign-toggle">
                <label htmlFor={`${formId}-ai`}>AI answers their replies{!overview.ai && " (needs a Gemini key on this deployment)"}</label>
                <input id={`${formId}-ai`} type="checkbox" role="switch" checked={edit.draft.aiEnabled} onChange={(event) => setDraft({ aiEnabled: event.target.checked })} />
              </div>
              {edit.draft.aiEnabled && (
                <div className="ob-field">
                  <label htmlFor={`${formId}-instructions`}>What the AI should do <span>Its goal, tone and what it may offer.</span></label>
                  <textarea id={`${formId}-instructions`} rows={3} maxLength={4000} value={edit.draft.aiInstructions} placeholder="Help people book a home visit. Answer briefly, in Greek or English." onChange={(event) => setDraft({ aiInstructions: event.target.value })} />
                </div>
              )}
              <fieldset className="campaign-followups">
                <legend>Follow-ups <span>Sent after their first reply. Instagram allows messages for 24 hours after someone writes.</span></legend>
                {edit.draft.followUps.map((followUp, index) => (
                  <div className="campaign-followup" key={index}>
                    <select aria-label={`Follow-up ${index + 1}: when`} value={followUp.delayMinutes} onChange={(event) => setDraft({ followUps: edit.draft.followUps.map((entry, at) => (at === index ? { ...entry, delayMinutes: Number(event.target.value) } : entry)) })}>
                      {DELAYS.map((delay) => <option key={delay.minutes} value={delay.minutes}>After {delay.label}</option>)}
                    </select>
                    <input aria-label={`Follow-up ${index + 1}: message`} value={followUp.text} maxLength={1000} placeholder="Did it help? Book here: {link}" onChange={(event) => setDraft({ followUps: edit.draft.followUps.map((entry, at) => (at === index ? { ...entry, text: event.target.value } : entry)) })} />
                    <button type="button" className="text-button" aria-label={`Remove follow-up ${index + 1}`} onClick={() => setDraft({ followUps: edit.draft.followUps.filter((_, at) => at !== index) })}><X size={14} aria-hidden="true" /></button>
                  </div>
                ))}
                {edit.draft.followUps.length < 3 && (
                  <button type="button" className="text-button" onClick={() => setDraft({ followUps: [...edit.draft.followUps, { delayMinutes: 60, text: "" }] })}>
                    <Plus size={13} aria-hidden="true" /> Add a follow-up
                  </button>
                )}
              </fieldset>
              <div className="campaign-toggle">
                <label htmlFor={`${formId}-enabled`}>Listen for comments once saved</label>
                <input id={`${formId}-enabled`} type="checkbox" role="switch" checked={edit.draft.enabled} onChange={(event) => setDraft({ enabled: event.target.checked })} />
              </div>
              <div>
                <button className="button primary" disabled={working}>
                  {busy === "saving" ? <><LoaderCircle size={14} className="spin" aria-hidden="true" /> Saving…</> : edit.id ? "Save" : "Create campaign"}
                </button>
                <button className="button secondary" type="button" disabled={working} onClick={() => setPanel(null)}>Cancel</button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
