import {
  Activity as ActivityIcon,
  CalendarCheck,
  Clapperboard,
  CreditCard,
  FilePlus,
  Film,
  KeyRound,
  LayoutTemplate,
  ListChecks,
  PenLine,
  Plug,
  Send,
  ShieldCheck,
  Sparkles,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import type { Campaign } from "@castroom/contracts";
import { timeAgo } from "../lib/status";
import { dateLabel } from "./ui";

type Event = Campaign["activity"][number];
type Job = Campaign["jobs"][number];

/** One icon per kind of action, read from the engine's own wording. */
export function activityIcon(action: string): LucideIcon {
  const text = action.toLowerCase();
  if (text.includes("prepared a schedule")) return ListChecks;
  if (text.includes("approved the exact schedule")) return ShieldCheck;
  if (text.includes("scheduled approved")) return CalendarCheck;
  if (text.includes("uploaded") || text.includes("published")) return Send;
  if (text.includes("requested a video render")) return Clapperboard;
  if (text.includes("rendered video")) return Film;
  if (text.includes("channel")) return text.includes("disconnected") ? Unplug : Plug;
  if (text.includes("token")) return KeyRound;
  if (text.includes("stripe") || text.includes("subscription")) return CreditCard;
  if (text.includes("template")) return LayoutTemplate;
  if (text.includes("sample") || text.includes("drafted a project")) return Sparkles;
  if (text.includes("created drafts") || text.includes("added a draft")) return FilePlus;
  if (text.includes("saved") || text.includes("edited") || text.includes("changed") || text.includes("needs review") || text.includes("regeneration")) return PenLine;
  return ActivityIcon;
}

export type Actor = { name: string; initial: string; kind: "you" | "person" | "agent" | "system"; full: string };

/**
 * A short name for whoever acted. The engine records a member's email, "Connected agent for <email>",
 * "<agent name> (agent)", or a service name. The signed-in member reads as "You".
 */
export function actorOf(actor: string, memberEmail: string | null): Actor {
  const full = actor.trim();
  const me = memberEmail?.trim().toLowerCase() || null;
  const initialOf = (value: string) => (value.trim()[0] ?? "?").toUpperCase();
  const agentFor = /^connected agent for (.+)$/i.exec(full);
  if (agentFor) return { name: me && agentFor[1].trim().toLowerCase() === me ? "Your agent" : "An agent", initial: "A", kind: "agent", full };
  const named = /^(.+?)\s*\(agent\)$/i.exec(full);
  if (named) return { name: named[1], initial: initialOf(named[1]), kind: "agent", full };
  if (/^you(\s|·|$)/i.test(full) || (me && full.toLowerCase() === me)) return { name: "You", initial: initialOf(memberEmail ?? "You"), kind: "you", full };
  if (/^[^@\s]+@[^@\s]+$/.test(full)) {
    const first = full.split("@")[0].split(/[._+-]/)[0] || full.split("@")[0];
    const name = first.charAt(0).toUpperCase() + first.slice(1);
    return { name, initial: initialOf(name), kind: "person", full };
  }
  if (/^workspace member$/i.test(full)) return { name: "A member", initial: "M", kind: "person", full };
  return { name: full, initial: initialOf(full), kind: "system", full };
}

/** Splits "Edited the script; schedule needs review" into the action and its consequence. */
function splitAction(action: string) {
  const [head, ...rest] = action.split(/;\s+/);
  return { head, consequence: rest.join("; ") };
}

/** The outcome as quiet chips: zero-value parts ("0 ready") and a bare "Saved" say nothing, so they go. */
function outcomeChips(outcome: string) {
  if (/^saved\.?$/i.test(outcome.trim())) return [];
  return outcome.split(/\s+·\s+/).map((part) => part.trim()).filter((part) => part && !/^0\s/.test(part)).slice(0, 2);
}

type Group = { key: string; first: Event; latest: Event; count: number };

/** Newest first; consecutive identical entries (same actor, action, outcome and version) collapse into one. */
export function groupActivity(events: Event[]): Group[] {
  const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const groups: Group[] = [];
  for (const event of sorted) {
    const key = `${event.actor}\u0000${event.action}\u0000${event.outcome}\u0000${event.revision ?? ""}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.count += 1;
      last.first = event;
    } else groups.push({ key, first: event, latest: event, count: 1 });
  }
  return groups;
}

function relative(iso: string, now: number, timezone: string) {
  const age = now - Date.parse(iso);
  if (age > 6 * 86_400_000) return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short" }).format(new Date(iso));
  return timeAgo(iso, now);
}

/** A calm timeline of what happened in a project, read straight from the engine's record. */
export function ActivityTimeline({ events, timezone, memberEmail, now }: { events: Event[]; timezone: string; memberEmail: string | null; now: number }) {
  const groups = groupActivity(events);
  if (!groups.length) return <p className="timeline-empty">Nothing has happened in this project yet.</p>;
  return (
    <ol className="timeline">
      {groups.map(({ key, latest, first, count }) => {
        const Icon = activityIcon(latest.action);
        const who = actorOf(latest.actor, memberEmail);
        const { head, consequence } = splitAction(latest.action);
        const chips = [...(consequence ? [consequence.charAt(0).toUpperCase() + consequence.slice(1)] : []), ...outcomeChips(latest.outcome)];
        const exact = dateLabel(latest.at, timezone);
        const span = count > 1 ? `${exact} · first ${dateLabel(first.at, timezone)}` : exact;
        return (
          <li className="timeline-entry" key={`${key}-${latest.id}`}>
            <span className="timeline-icon" aria-hidden="true"><Icon size={14} /></span>
            <div className="timeline-body">
              <p className="timeline-action">
                {head}
                {count > 1 && <span className="timeline-count" aria-label={`${count} times`}>{count}×</span>}
              </p>
              <div className="timeline-meta">
                <span className="timeline-actor" title={who.full}>
                  <span className={`timeline-avatar is-${who.kind}`} aria-hidden="true">{who.initial}</span>
                  {who.name}
                </span>
                <time className="timeline-time" dateTime={latest.at} tabIndex={0} data-exact={span}>
                  {relative(latest.at, now, timezone)}
                  <span className="sr-only">, {span}</span>
                </time>
                {chips.map((chip) => <span className="timeline-chip" key={chip} title={latest.outcome}>{chip}</span>)}
                {latest.revision !== null && <span className="timeline-version" aria-label={`version ${latest.revision}`}>v{latest.revision}</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const JOB_STAGE: Record<Job["stage"], string> = { draft: "Drafting", brand_check: "Brand check", render: "Render", compose: "Compose", publish: "Publish" };
const JOB_STATE: Record<Job["state"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "queued" },
  running: { label: "Running", tone: "rendering" },
  succeeded: { label: "Done", tone: "ready" },
  failed: { label: "Failed", tone: "failed" },
  unknown: { label: "Unknown", tone: "failed" },
  cancel_requested: { label: "Cancelling", tone: "queued" },
  cancelled: { label: "Cancelled", tone: "draft" },
};

/** Background work the engine accepted, each with the state it reports. Rendered only when there is some. */
export function JobList({ jobs, items, canCancel, busy, onCancel }: { jobs: Job[]; items: Campaign["items"]; canCancel: boolean; busy: boolean; onCancel: (job: Job) => void }) {
  return (
    <ul className="job-list">
      {jobs.map((job) => {
        const state = JOB_STATE[job.state];
        const title = items.find((item) => item.id === job.itemId)?.title;
        return (
          <li className="job-entry" key={job.id}>
            <div className="job-body">
              <p><strong>{JOB_STAGE[job.stage]}</strong>{title && <span> · {title}</span>}</p>
              {job.error && <p className="job-error">{job.error.message}</p>}
            </div>
            <span className={`status-pill tone-${state.tone}`}><i aria-hidden="true" />{state.label}</span>
            {canCancel && (job.state === "queued" || job.state === "running") && (
              <button className="text-button job-cancel" disabled={busy} onClick={() => onCancel(job)}>Request cancellation</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
