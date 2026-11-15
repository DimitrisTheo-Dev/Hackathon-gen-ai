import { useEffect, useRef } from "react";
import { SCRIPT_BRIEF_MAX, type DraftScriptInput, type DraftScriptResult, type ScriptBeat } from "@castroom/contracts";
import { languageOf } from "./languages";
import { presenterOf, scriptKeyOf, type Draft } from "./model";

/**
 * Scripts written ahead. The New project flow asks for its first draft as soon as the description and its settings are
 * known, and for each language copy while the person reads the script, so neither keeps anyone waiting later. Every
 * result is kept under the exact inputs it was written from. A result whose inputs have since changed stays kept (in
 * case they change back) but is never shown in their place.
 */
export type ScriptRequest = Omit<DraftScriptInput, "operationKey">;
type Writer = (input: DraftScriptInput) => Promise<DraftScriptResult>;
type Entry = { promise: Promise<DraftScriptResult>; result: DraftScriptResult | null };

export class ScriptCache {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly write: Writer,
    private readonly limit = 12,
  ) {}

  /** The script for `key`: kept, already being written, or written now. A failed attempt is not kept, so asking again tries again. */
  get(key: string, request: () => ScriptRequest): Promise<DraftScriptResult> {
    const found = this.entries.get(key);
    if (found) {
      // Most recently asked for last, so the oldest is the one let go when the cache is full.
      this.entries.delete(key);
      this.entries.set(key, found);
      return found.promise;
    }
    const entry: Entry = { promise: Promise.resolve(null as never), result: null };
    entry.promise = this.write({ ...request(), operationKey: crypto.randomUUID() }).then(
      (result) => {
        entry.result = result;
        return result;
      },
      (reason: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw reason;
      },
    );
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return entry.promise;
  }

  /** The finished script for `key`, or null while it is still being written, after it failed, or if it was never asked for. */
  ready(key: string): DraftScriptResult | null {
    return this.entries.get(key)?.result ?? null;
  }
}

/** A first draft from the description and its settings. `templateId` is the layout it is written for. */
export function firstDraftRequest(draft: Draft, templateId: string | null = draft.templateId): ScriptRequest {
  return {
    brief: draft.brief.trim().slice(0, SCRIPT_BRIEF_MAX),
    language: draft.language,
    seconds: draft.seconds,
    platform: draft.platform,
    templateId,
    presenter: presenterOf(draft)?.mode ?? "persona",
    beats: null,
    instruction: null,
    beatId: null,
  };
}

/** One language copy: the finished lines translated, in the same order and at about the same length. */
export function copyRequest(draft: Draft, code: string, beats: ScriptBeat[]): ScriptRequest {
  const language = languageOf(code);
  return {
    ...firstDraftRequest(draft),
    language: code,
    beats,
    instruction: `Translate the whole script into natural spoken ${language.name} (${code}). Keep the meaning, the order of the lines and roughly the same length. Translate the title too.`,
  };
}
/** A copy is kept for exactly the lines and settings it was translated from. */
export const copyKey = (draft: Draft, code: string, beats: ScriptBeat[]) => JSON.stringify(["copy", scriptKeyOf(draft), code, beats.map((beat) => [beat.label, beat.text])]);

/**
 * What a finished first draft changes: nothing when the person has edited the lines or this draft is already in place.
 * A title that came with the earlier draft (`earlierTitle`) follows the new one; a title the person typed stays.
 */
export function placeDraft(now: Draft, key: string, result: DraftScriptResult, earlierTitle: string | null): Partial<Draft> {
  if ((now.edited && now.beats) || (now.beats && now.scriptKey === key)) return {};
  const autoTitle = !now.title.trim() || now.title === earlierTitle;
  return { beats: result.beats, title: autoTitle ? result.title : now.title, scriptKey: key, edited: false };
}

export type WriteAheadJob = { key: string; request: () => ScriptRequest };
/**
 * Asks for each job's script after `delay` milliseconds; a script already kept is handed over at once. Returns a stop
 * function: once stopped (the inputs changed), nothing more is asked for and results still on their way are kept in the
 * cache but no longer handed over. Failures are dropped here; the step that needs the script asks again, with its own
 * loading state and error, when the person gets there.
 */
export function writeAhead(cache: ScriptCache, jobs: WriteAheadJob[], delay: number, onReady?: (key: string, result: DraftScriptResult) => void): () => void {
  let current = true;
  const handOver = (key: string, result: DraftScriptResult) => {
    if (current) onReady?.(key, result);
  };
  for (const job of jobs) {
    const kept = cache.ready(job.key);
    if (kept) handOver(job.key, kept);
  }
  const timer = setTimeout(() => {
    for (const job of jobs) {
      if (cache.ready(job.key)) continue;
      cache.get(job.key, job.request).then(
        (result) => handOver(job.key, result),
        () => undefined,
      );
    }
  }, delay);
  return () => {
    current = false;
    clearTimeout(timer);
  };
}

/**
 * `writeAhead` for a component: it starts again only when the set of keys changes, so clicking through choices sends
 * one request for the choice the person settles on (after `delay`), not one per click.
 */
export function useWriteAhead(cache: ScriptCache, jobs: WriteAheadJob[], delay: number, onReady?: (key: string, result: DraftScriptResult) => void) {
  const latest = useRef({ jobs, onReady });
  latest.current = { jobs, onReady };
  const signature = jobs.map((job) => job.key).join("\n");
  useEffect(() => {
    if (!latest.current.jobs.length) return;
    return writeAhead(cache, latest.current.jobs, delay, (key, result) => latest.current.onReady?.(key, result));
  }, [cache, signature, delay]);
}
