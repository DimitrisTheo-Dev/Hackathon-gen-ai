import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, Check, LoaderCircle } from "lucide-react";
import { CLONE_BRIEF_MAX, parseCloneLink, type CloneJob, type CloneLink, type CloneSource, type CloneTrait, type StudioContext } from "@castroom/contracts";
import { ApiError, type StudioClient } from "../data/client";
import { Notice, PlatformIcon, dateLabel } from "../components/ui";
import "../clone.css";

/** What can be borrowed from the source, in the order the engine stores them. Defaults keep the format, not the sound. */
const TRAITS: Array<{ key: CloneTrait; label: string; hint: string; on: boolean }> = [
  { key: "structure", label: "Hook and structure", hint: "The opening line and the order of the beats.", on: true },
  { key: "pacing", label: "Pacing and cuts", hint: "How long each shot lasts and where it cuts.", on: true },
  { key: "transitions", label: "Transitions", hint: "How one shot moves into the next.", on: true },
  { key: "captions", label: "Caption style", hint: "Font, size, placement and how words appear.", on: true },
  { key: "graphics", label: "Graphics", hint: "Text cards, arrows, stickers and overlays.", on: true },
  { key: "sound", label: "Sound effects", hint: "The pops and whooshes that land on the cuts.", on: true },
  { key: "music", label: "Music", hint: "A track with the same mood and tempo, never the same song.", on: false },
  { key: "voice", label: "Voice delivery", hint: "Tone and pace of speech, in your own voice.", on: false },
  { key: "colours", label: "Colours", hint: "The colour grade. Off keeps your brand kit colours.", on: false },
];
const PLATFORM: Record<CloneLink["platform"], string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };
const STATE: Record<CloneJob["state"], string> = {
  queued: "Queued, waiting for a worker",
  running: "A worker is making it",
  succeeded: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};
const POLL_MS = 20_000;

type Lookup = { url: string; state: "loading" } | { url: string; state: "done"; source: CloneSource } | { url: string; state: "refused" | "unavailable"; message: string };

function errorText(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/**
 * Clone a video: paste a YouTube, TikTok or Instagram link, see the original in the platform's own player, say
 * what to keep and what to change, pick what to clone, and start a job. The job is queued in the engine
 * (`create_clone_job`); nothing is made, charged or published until a worker takes it, and the page says so.
 */
export function CloneVideo({ client, context }: { client: StudioClient; context: StudioContext }) {
  const ids = useId();
  const [linkText, setLinkText] = useState("");
  const [linkTouched, setLinkTouched] = useState(false);
  const [brief, setBrief] = useState("");
  const [traits, setTraits] = useState<Set<CloneTrait>>(() => new Set(TRAITS.filter((t) => t.on).map((t) => t.key)));
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [jobs, setJobs] = useState<CloneJob[] | null>(null);
  const [jobsError, setJobsError] = useState("");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState("");
  const [problems, setProblems] = useState<{ brief?: string; traits?: string }>({});
  const [announce, setAnnounce] = useState("");
  const linkRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const traitsRef = useRef<HTMLFieldSetElement>(null);
  // One key per distinct request: a retry after a dropped answer replays the same job instead of making a second.
  const operation = useRef<{ key: string; signature: string } | null>(null);
  const readOnly = context.workspace.role === "reviewer";

  const parsed = useMemo(() => (linkText.trim() ? parseCloneLink(linkText) : null), [linkText]);
  const link = parsed?.ok ? parsed.link : null;

  // Ask the engine what the link is: title and author from the platform, and where a short link leads.
  useEffect(() => {
    if (!link) return;
    const url = link.url;
    if (lookup?.url === url && lookup.state !== "loading") return;
    let live = true;
    setLookup({ url, state: "loading" });
    const timer = window.setTimeout(() => {
      client
        .lookupCloneSource(url)
        .then((source) => { if (live) setLookup({ url, state: "done", source }); })
        .catch((reason) => {
          if (!live) return;
          const refused = reason instanceof ApiError && reason.code === "validation_error";
          setLookup({ url, state: refused ? "refused" : "unavailable", message: errorText(reason, "The link could not be checked just now.") });
        });
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [client, link?.url]);
  const current = lookup && link && lookup.url === link.url ? lookup : null;
  const source = current?.state === "done" ? current.source : null;
  // The platform's player can show at once from the address; a TikTok short link waits for the engine, and a
  // link the platform says is missing or private shows no player at all.
  const embed = current?.state === "refused" ? null : (source ?? (link?.embedUrl ? { ...link, embedUrl: link.embedUrl } : null));
  const linkError = parsed && !parsed.ok ? (linkTouched ? parsed.reason : "") : current?.state === "refused" ? current.message : "";

  const loadJobs = useCallback(async () => {
    try {
      setJobs(await client.listCloneJobs());
      setJobsError("");
    } catch (reason) {
      setJobsError(errorText(reason, "Your clone jobs could not be loaded."));
    }
  }, [client]);
  useEffect(() => { void loadJobs(); }, [loadJobs]);
  // Waiting jobs are checked now and then, only while the page is in view.
  const waiting = !!jobs?.some((job) => job.state === "queued" || job.state === "running");
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadJobs(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [waiting, loadJobs]);

  function toggle(key: CloneTrait) {
    setTraits((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setProblems((previous) => ({ ...previous, traits: undefined }));
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (busy || readOnly) return;
    setStartError("");
    setLinkTouched(true);
    const chosen = TRAITS.map((t) => t.key).filter((key) => traits.has(key));
    const next = {
      brief: brief.trim() ? undefined : "Say what your version should be about.",
      traits: chosen.length ? undefined : "Pick at least one thing to clone.",
    };
    setProblems(next);
    if (!link || current?.state === "refused") return linkRef.current?.focus();
    if (next.brief) return briefRef.current?.focus();
    if (next.traits) return traitsRef.current?.querySelector("input")?.focus();
    const input = { url: source?.url ?? link.url, brief: brief.trim(), clone: chosen };
    const signature = JSON.stringify(input);
    if (operation.current?.signature !== signature) operation.current = { key: crypto.randomUUID(), signature };
    setBusy(true);
    try {
      const job = await client.createCloneJob({ ...input, operationKey: operation.current.key });
      operation.current = null;
      setJobs((list) => [job, ...(list ?? []).filter((entry) => entry.id !== job.id)]);
      setCurrentId(job.id);
      setAnnounce(`Job started. ${STATE[job.state]}.`);
    } catch (reason) {
      setStartError(errorText(reason, "The job could not be started."));
    } finally {
      setBusy(false);
    }
  }

  const shown = jobs?.find((job) => job.id === currentId) ?? null;
  const timezone = context.workspace.timezone;

  return (
    <div className="cv">
      <header className="cv-intro">
        <h1>Clone a video</h1>
        <p>Paste a link to a short video you like. Say what to keep and what to change, and Faceful queues a job to make your own version.</p>
      </header>

      <form className="cv-form" onSubmit={start} noValidate>
        <div className="cv-link">
          <label htmlFor={`${ids}-link`}>Video link</label>
          <input
            ref={linkRef}
            id={`${ids}-link`}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="https://www.youtube.com/shorts/…"
            value={linkText}
            aria-invalid={linkError ? true : undefined}
            aria-describedby={`${ids}-link-note`}
            onChange={(e) => setLinkText(e.target.value)}
            onBlur={() => setLinkTouched(true)}
            onPaste={() => setLinkTouched(true)}
          />
          <p id={`${ids}-link-note`} className={linkError ? "cv-error" : "cv-note"} role={linkError ? "alert" : undefined}>
            {linkError || "YouTube, YouTube Shorts, TikTok or Instagram Reels."}
          </p>
        </div>

        <section className={`cv-source ${embed || current ? "has-source" : ""}`} aria-labelledby={`${ids}-source`}>
          <h2 id={`${ids}-source`}>Original</h2>
          {embed ? (
            <SourcePlayer key={embed.embedUrl} source={embed} title={source?.title ?? null} />
          ) : (
            <div className="cv-frame is-empty">
              {current?.state === "loading" ? (
                <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Opening the link…</p>
              ) : (
                <p>The video shows here, in {link ? PLATFORM[link.platform] : "the platform"}'s own player.</p>
              )}
            </div>
          )}
          {embed && (
            <div className="cv-source-meta">
              {source?.title && <strong>{source.title}</strong>}
              <span>
                <PlatformIcon platform={embed.platform} />
                {source?.author ?? PLATFORM[embed.platform]}
                {current?.state === "loading" && <span className="cv-muted"> · checking…</span>}
              </span>
              {current?.state === "unavailable" && <span className="cv-muted">{PLATFORM[embed.platform]} did not share a title just now.</span>}
              <a href={embed.url} target="_blank" rel="noreferrer noopener">Open on {PLATFORM[embed.platform]}<ArrowUpRight size={13} aria-hidden="true" /></a>
            </div>
          )}
        </section>

        <div className="cv-brief">
          <label htmlFor={`${ids}-brief`}>What should your version be?</label>
          <p id={`${ids}-brief-note`} className="cv-note">What to keep and what to change: the topic, your brand, the language, the call to action.</p>
          <textarea
            ref={briefRef}
            id={`${ids}-brief`}
            rows={7}
            maxLength={CLONE_BRIEF_MAX}
            value={brief}
            placeholder="Keep the hook and the quick cuts. Make it about checking blood pressure at home, for my cardiology practice in Athens. Greek captions, my brand colours, and end with a call to book a visit."
            aria-invalid={problems.brief ? true : undefined}
            aria-describedby={`${ids}-brief-note${problems.brief ? ` ${ids}-brief-error` : ""}`}
            onChange={(e) => { setBrief(e.target.value); if (problems.brief) setProblems((p) => ({ ...p, brief: undefined })); }}
          />
          {problems.brief && <p id={`${ids}-brief-error`} className="cv-error" role="alert">{problems.brief}</p>}
          {brief.length > CLONE_BRIEF_MAX - 400 && <p className="cv-note cv-count">{CLONE_BRIEF_MAX - brief.length} characters left</p>}
        </div>

        <fieldset ref={traitsRef} className="cv-traits" aria-describedby={problems.traits ? `${ids}-traits-error` : undefined}>
          <legend>What to clone</legend>
          <div className="cv-tags">
            {TRAITS.map((trait) => {
              const on = traits.has(trait.key);
              return (
                <label key={trait.key} className="cv-trait" data-on={on || undefined} title={trait.hint}>
                  <input type="checkbox" checked={on} onChange={() => toggle(trait.key)} aria-labelledby={`${ids}-${trait.key}-label`} aria-describedby={`${ids}-${trait.key}`} />
                  <span className="cv-box" aria-hidden="true"><Check size={11} strokeWidth={3} /></span>
                  <span id={`${ids}-${trait.key}-label`}>{trait.label}</span>
                  <span id={`${ids}-${trait.key}`} className="sr-only">{trait.hint}</span>
                </label>
              );
            })}
          </div>
          {problems.traits ? (
            <p id={`${ids}-traits-error`} className="cv-error" role="alert">{problems.traits}</p>
          ) : (
            <p className="cv-note">Music is matched in mood and tempo, never copied. Voice delivery is tone and pace, spoken in your own voice.</p>
          )}
        </fieldset>

        <section className="cv-result" aria-labelledby={`${ids}-result`}>
          <h2 id={`${ids}-result`}>Your version</h2>
          {shown?.resultUrl ? (
            <video className="cv-frame" src={shown.resultUrl} controls playsInline preload="metadata" />
          ) : (
            <div className="cv-frame is-empty">
              {shown ? (
                <div className="cv-wait" role="status">
                  <strong>{STATE[shown.state]}</strong>
                  <span>{shown.state === "failed" ? shown.error ?? "The worker gave up on this job." : shown.state === "queued" ? "Nothing has been made yet. The video shows here when a worker has made it." : null}</span>
                </div>
              ) : (
                <p>Your video shows here once a worker has made it.</p>
              )}
            </div>
          )}
        </section>

        <div className="cv-start">
          {startError && <Notice error>{startError}</Notice>}
          {readOnly ? (
            <p className="cv-note">Reviewers can see clone jobs but not start them. Ask an editor of this workspace.</p>
          ) : (
            <div className="cv-start-row">
              <button className="button primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
                {busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
                {busy ? "Starting job…" : "Start job"}
              </button>
              <p className="cv-note">The job waits in a queue until a worker takes it. Nothing is published.</p>
            </div>
          )}
        </div>
      </form>
      <p className="sr-only" aria-live="polite">{announce}</p>

      {(jobsError || !!jobs?.length) && (
        <section className="cv-jobs" aria-labelledby={`${ids}-jobs`}>
          <h2 id={`${ids}-jobs`}>Jobs</h2>
          {jobsError && <Notice error>{jobsError}</Notice>}
          {!!jobs?.length && (
            <ul>
              {jobs.map((job) => (
                <li key={job.id} className="cv-job" data-current={job.id === currentId || undefined}>
                  <span className="cv-job-thumb" aria-hidden="true">
                    {job.source.thumbnailUrl ? <img src={job.source.thumbnailUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <PlatformIcon platform={job.source.platform} />}
                  </span>
                  <span className="cv-job-main">
                    <a href={job.source.url} target="_blank" rel="noreferrer noopener">
                      {job.source.title ?? `${PLATFORM[job.source.platform]} ${job.source.kind}`}
                      <span className="sr-only"> (opens {PLATFORM[job.source.platform]})</span>
                    </a>
                    <span className="cv-job-brief">{job.brief}</span>
                    <span className="cv-job-traits">{TRAITS.filter((t) => job.clone.includes(t.key)).map((t) => t.label).join(", ")}</span>
                  </span>
                  <span className="cv-job-state">
                    <strong data-state={job.state}>{STATE[job.state]}</strong>
                    <time dateTime={job.createdAt}>{dateLabel(job.createdAt, timezone)}</time>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The platform's own embed player: the video is streamed by YouTube, TikTok or Instagram, never fetched or
 * stored by Faceful. Instagram's embed reports its height by message; nothing else from the frame is read.
 */
function SourcePlayer({ source, title }: { source: Pick<CloneLink, "platform" | "embedUrl" | "orientation">; title: string | null }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (source.platform !== "instagram") return;
    const listener = (event: MessageEvent) => {
      if (event.origin !== "https://www.instagram.com" || event.source !== frame.current?.contentWindow) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        const measured = Number(data?.details?.height);
        if (data?.type === "MEASURE" && Number.isFinite(measured) && measured > 100) setHeight(Math.min(Math.round(measured), 1400));
      } catch {
        /* Not a message we read. */
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [source.platform]);
  return (
    <div className={`cv-frame cv-player is-${source.orientation} is-${source.platform}`} style={height ? { blockSize: height, aspectRatio: "auto" } : undefined}>
      <iframe
        ref={frame}
        src={source.embedUrl ?? undefined}
        title={`${PLATFORM[source.platform]} video${title ? `: ${title}` : ""}`}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
        loading="lazy"
      />
    </div>
  );
}
