import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Eye, EyeOff, LoaderCircle, Plus, RefreshCw, Sparkles, Trash2, Undo2, UserRound, X } from "lucide-react";
import { beatsFromText, scriptFromBeats, SCRIPT_BEATS_MAX, SCRIPT_BRIEF_MAX, workingTitle, type Campaign, type LibraryTemplate, type Persona, type ScriptBeat, type StudioContext } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { sessionLikenessApi } from "../likeness/session";
import type { ReelMedia } from "../video/Reel";
import { FogArt, FogPresenter, LookFaces } from "./look/LookStep";
import { languageOf } from "./languages";
import { PreviewStep, usePreviewShown, useProduction } from "./PreviewStep";
import { RecordStep } from "./RecordStep";
import { copyKey, copyRequest, firstDraftRequest, placeDraft, ScriptCache, useWriteAhead } from "./predraft";
import { SettingsMenus } from "./SettingsMenus";
import { withSettings, type VideoSettings } from "./settings";
import {
  clearDraft,
  emptyDraft,
  loadDraft,
  loadLastFace,
  MAX_COPIES,
  presenterOf,
  previewComposition,
  recommendTemplate,
  records,
  saveDraft,
  savedComposition,
  saveLastFace,
  scriptKeyOf,
  spokenSeconds,
  STEP_LABELS,
  stepsFor,
  STILL_PRESENTER,
  STILL_STYLE,
  type Draft,
  type Face,
  type Making,
  type StepId,
  type Take,
} from "./model";
import "./new-project.css";

const PreviewPlayer = lazy(() => import("./PreviewPlayer"));

const QUICK_EDITS = ["Make it shorter", "Make the hook stronger", "More casual", "More expert"];
const BEAT_EDITS = [
  { label: "Shorter", instruction: "Make this line shorter and punchier, same meaning." },
  { label: "Simpler", instruction: "Say this line in simpler, everyday words." },
  { label: "Rewrite", instruction: "Rewrite this line a different way, same meaning." },
];
const MIN_BRIEF = 10;
const uuid = () => crypto.randomUUID();
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
/** The code a stock presenter lists for a language: the exact one, else its base ("en" for "en-US"), else a sibling. */
function avatarLanguage(languages: readonly string[], code: string): string | null {
  if (languages.includes(code)) return code;
  const base = code.split("-")[0];
  return languages.includes(base) ? base : (languages.find((entry) => entry.split("-")[0] === base) ?? null);
}
/** The picture for a persona: the chosen look's photo, else the straight-on still from its scan, else any look. */
function personaPhoto(persona: Persona | undefined, lookId: string | null = null) {
  if (!persona) return null;
  const look = lookId ? persona.looks.find((entry) => entry.id === lookId) : null;
  return look?.imageUrl ?? persona.consent?.photoUrl ?? persona.looks.find((entry) => entry.imageUrl)?.imageUrl ?? null;
}

/**
 * New project, full screen: describe → look → make → script → record (for a person's own take) → preview.
 * Each step is one decision with a sensible default, so Next, Next, Next always ends in a draft. Choices are kept
 * in this browser until the project exists; the project is created when the script step is passed.
 */
export function NewProject({
  client,
  context,
  initialBrief = "",
  initialSettings,
  initialTemplateId,
  onClose,
  onDone,
}: {
  client: StudioClient;
  context: StudioContext;
  initialBrief?: string;
  /** Settings already picked where the request was typed (the home composer); they win over a resumed draft's. */
  initialSettings?: Partial<VideoSettings>;
  /** A library format already picked where the request was typed. */
  initialTemplateId?: string;
  /** Called with the project when one was already created, so the studio can show it. */
  onClose: (campaign: Campaign | null) => void;
  onDone: (campaign: Campaign, openVideo: boolean) => void;
}) {
  const workspaceId = context.workspace.id;
  const [draft, setDraft] = useState<Draft>(() => {
    const saved = loadDraft(workspaceId);
    // A saved project keeps the settings it was made with; anything earlier takes what was just picked.
    // A format cloned from Templates (a format, no description yet) always starts a new draft, never an earlier one.
    const cloning = Boolean(initialTemplateId) && !initialBrief.trim();
    if (saved && !cloning && (!initialBrief.trim() || saved.brief.trim() === initialBrief.trim())) return saved.project ? saved : withSettings(saved, initialSettings, initialTemplateId);
    return withSettings(emptyDraft(context.brand.color, initialBrief), initialSettings, initialTemplateId);
  });
  const [step, setStep] = useState<StepId>("describe");
  const [templates, setTemplates] = useState<LibraryTemplate[] | null>(null);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [lastFace] = useState(() => loadLastFace(workspaceId));
  const [scriptBusy, setScriptBusy] = useState(false);
  const [scriptMode, setScriptMode] = useState<"ai" | "basic" | null>(null);
  const [reply, setReply] = useState("");
  const [scriptError, setScriptError] = useState("");
  const [undo, setUndo] = useState<ScriptBeat[][]>([]);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<"" | "saving" | "finishing">("");
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const [remoteTake, setRemoteTake] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const scriptRequest = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const styleSeen = useRef(false);
  // A draft restored with a script already had its layout chosen once; that choice stands.
  const firstPass = useRef(!draft.beats);
  // Every script asked for here, kept by the inputs it was written from (see predraft.ts).
  const scripts = useMemo(() => new ScriptCache((input) => client.draftScript(input)), [client]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const patch = useCallback((change: Partial<Draft> | ((current: Draft) => Partial<Draft>)) => setDraft((current) => ({ ...current, ...(typeof change === "function" ? change(current) : change) })), []);

  useEffect(() => saveDraft(workspaceId, draft), [workspaceId, draft]);

  const live = context.capabilities.mode === "live";
  const liveToken = useMemo(() => (live ? () => sessionLikenessApi().liveToken() : null), [live]);
  const loadPersonas = useCallback(() => {
    client.listPersonas().then(setPersonas, () => setPersonas([]));
  }, [client]);
  useEffect(() => {
    client.listLibraryTemplates().then(setTemplates, () => setTemplates([]));
    loadPersonas();
  }, [client, loadPersonas]);
  // Someone who made a persona or a look in another tab finds it here when they come back.
  useEffect(() => {
    const refresh = () => document.visibilityState === "visible" && step === "look" && loadPersonas();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [step, loadPersonas]);

  const presenter = presenterOf(draft);
  const mode = presenter?.mode ?? "none";
  // A take counts only while the person is recording; switching to the AI leaves an earlier take unused.
  const take = records(presenter) ? draft.take : null;
  const steps = stepsFor(presenter);
  const index = Math.max(0, steps.indexOf(step));
  const template = templates?.find((entry) => entry.id === draft.templateId) ?? null;
  const allPersonas = personas ?? [];
  const avatars = context.avatars.filter((avatar) => avatar.permission === "authorized");
  const facePersona = draft.face?.kind === "persona" ? allPersonas.find((entry) => entry.id === (draft.face as { personaId: string }).personaId) : undefined;
  const faceAvatar = draft.face?.kind === "avatar" ? avatars.find((entry) => entry.id === (draft.face as { avatarId: string }).avatarId) : undefined;
  const faceLookId = draft.face?.kind === "persona" ? draft.face.lookId : null;
  const faceName = facePersona?.name ?? faceAvatar?.name ?? null;
  const facePhoto = facePersona ? personaPhoto(facePersona, faceLookId) : (faceAvatar?.previewUrl ?? null);
  const hasFace = draft.face?.kind === "persona" || draft.face?.kind === "avatar";
  const recommended = useMemo(() => (templates?.length ? recommendTemplate(draft.brief, templates.filter((entry) => entry.family === (hasFace ? "face" : "no_face"))) : null), [templates, draft.brief, hasFace]);
  const briefOk = draft.brief.trim().length >= MIN_BRIEF;
  const beatsOk = Boolean(draft.beats?.some((beat) => beat.text.trim()));
  const key = scriptKeyOf(draft);
  const stale = Boolean(draft.beats && draft.scriptKey && draft.scriptKey !== key);
  // The layout the script is written for. On Look the first time through, it is the suggestion Continue will apply.
  const plannedTemplate = step === "look" && !styleSeen.current && firstPass.current && draft.templateId === null && recommended ? recommended : draft.templateId;

  /** The face offered first: the one used last time if it still exists, else the first ready persona or stock avatar. */
  function defaultFace(): Face {
    // A format already picked (cloned from Templates) decides whether there is a presenter at all.
    if (template?.family === "no_face") return { kind: "none" };
    if (template?.family === "face" && lastFace?.kind === "none") {
      const persona = allPersonas.find((entry) => entry.status === "ready");
      if (persona) return { kind: "persona", personaId: persona.id, lookId: null };
      if (avatars[0]) return { kind: "avatar", avatarId: avatars[0].id };
    }
    const usable = (face: Face | null) =>
      face && (face.kind === "none" || (face.kind === "persona" && allPersonas.some((entry) => entry.id === face.personaId && entry.status === "ready")) || (face.kind === "avatar" && avatars.some((entry) => entry.id === face.avatarId)));
    if (usable(lastFace)) return lastFace!;
    const persona = allPersonas.find((entry) => entry.status === "ready");
    if (persona) return { kind: "persona", personaId: persona.id, lookId: null };
    if (avatars[0]) return { kind: "avatar", avatarId: avatars[0].id };
    return { kind: "none" };
  }

  function canEnter(target: StepId) {
    switch (target) {
      case "describe":
        return true;
      case "look":
        return briefOk;
      case "make":
      case "script":
        return briefOk && Boolean(draft.face);
      case "record":
        return beatsOk && Boolean(draft.project);
      case "preview":
        return beatsOk && Boolean(draft.project) && (!records(presenter) || Boolean(draft.take));
    }
  }

  /* ───────── script ───────── */

  const requestScript = useCallback(
    async (change?: { instruction: string; beatId?: string | null }) => {
      const current = draftRef.current;
      const requestKey = scriptKeyOf(current);
      if (!change && scriptRequest.current?.key === requestKey) return scriptRequest.current.promise;
      setScriptError("");
      setScriptBusy(true);
      const run = (async () => {
        try {
          // A first draft is usually written already (see the write-ahead below), or joins the one being written.
          const result = change
            ? await client.draftScript({ ...firstDraftRequest(current), beats: current.beats, instruction: change.instruction, beatId: change.beatId ?? null, operationKey: uuid() })
            : await scripts.get(requestKey, () => firstDraftRequest(current));
          setScriptMode(result.mode);
          setReply(result.reply);
          if (change) {
            if (current.beats) setUndo((stack) => [...stack.slice(-9), current.beats!]);
            patch({ beats: result.beats, edited: true });
          } else {
            // A first draft never replaces lines the person has already started editing.
            patch((now) => (now.edited && now.beats ? {} : { beats: result.beats, title: now.title.trim() ? now.title : result.title, scriptKey: requestKey, edited: false }));
          }
        } catch (reason) {
          setScriptError(errorText(reason, "The script could not be written. Write it yourself, or try again."));
          if (!change && !draftRef.current.beats) patch({ beats: beatsFromText(current.brief), scriptKey: requestKey, title: draftRef.current.title || workingTitle(current.brief) });
        } finally {
          setScriptBusy(false);
          if (!change) scriptRequest.current = null;
        }
      })();
      if (!change) scriptRequest.current = { key: requestKey, promise: run };
      return run;
    },
    [client, patch, scripts],
  );

  function editBeat(id: string, change: Partial<ScriptBeat>) {
    patch((current) => ({ edited: true, beats: (current.beats ?? []).map((beat) => (beat.id === id ? { ...beat, ...change } : beat)) }));
  }
  function moveBeat(id: string, by: -1 | 1) {
    patch((current) => {
      const beats = [...(current.beats ?? [])];
      const at = beats.findIndex((beat) => beat.id === id);
      const to = at + by;
      if (at < 0 || to < 0 || to >= beats.length) return {};
      [beats[at], beats[to]] = [beats[to], beats[at]];
      return { beats, edited: true };
    });
  }
  function removeBeat(id: string) {
    patch((current) => {
      if (current.beats) setUndo((stack) => [...stack.slice(-9), current.beats!]);
      return { beats: (current.beats ?? []).filter((beat) => beat.id !== id), edited: true };
    });
  }
  function addBeat() {
    const id = `beat-${Date.now().toString(36)}`;
    patch((current) => ({ beats: [...(current.beats ?? []), { id, label: `Line ${(current.beats?.length ?? 0) + 1}`, text: "" }].slice(0, SCRIPT_BEATS_MAX), edited: true }));
    requestAnimationFrame(() => document.getElementById(`np-beat-${id}`)?.focus());
  }

  /* ───────── project ───────── */

  /** Language copies: each extra language becomes its own draft, translated when AI writing is connected. */
  async function copyScripts(current: Draft, title: string, beats: ScriptBeat[]) {
    const codes = current.copies.filter((code) => code !== current.language).slice(0, MAX_COPIES);
    return Promise.all(
      codes.map(async (code) => {
        const language = languageOf(code);
        try {
          // Usually translated already while the person read the script (see the write-ahead below).
          const result = await scripts.get(copyKey(current, code, beats), () => copyRequest(current, code, beats));
          const translated = result.mode === "ai";
          return { code, translated, title: `${(translated ? result.title : title).slice(0, 100)} · ${language.native}`.slice(0, 120), script: scriptFromBeats(result.beats) };
        } catch {
          return { code, translated: false, title: `${title.slice(0, 100)} · ${language.native}`.slice(0, 120), script: scriptFromBeats(beats) };
        }
      }),
    );
  }

  async function ensureProject(): Promise<boolean> {
    const current = draftRef.current;
    const beats = (current.beats ?? []).filter((beat) => beat.text.trim());
    const script = scriptFromBeats(beats);
    const title = (current.title.trim() || workingTitle(current.brief)).slice(0, 120);
    const chosen = presenterOf(current);
    const avatarId = chosen?.mode === "avatar" ? chosen.avatarId : null;
    // Stock presenters list base languages ("en"); this flow offers regional ones too ("en-US"). A video read by a
    // presenter is stored under the code the presenter lists, or the save is refused.
    const avatar = avatarId ? context.avatars.find((entry) => entry.id === avatarId) : undefined;
    const spoken = (code: string) => (avatar ? avatarLanguage(avatar.languages, code) : code);
    const mainLanguage = spoken(current.language);
    if (avatar && !mainLanguage) {
      setError(`${avatar.name} doesn’t speak ${languageOf(current.language).name}. Choose another language or presenter.`);
      return false;
    }
    const signature = JSON.stringify([title, script, avatarId, current.language, current.accent]);
    if (current.project?.saved === signature) return true;
    setBusy("saving");
    setError("");
    try {
      if (!current.project) {
        const copies = await copyScripts(current, title, beats);
        const campaign = await client.startCampaign({
          operationKey: uuid(),
          title,
          companyContext: {
            name: (context.brand.name.trim() || context.workspace.name.trim() || "My brand").slice(0, 120),
            description: current.brief.trim().slice(0, 1500),
            audience: context.brand.audience.slice(0, 500),
            tone: context.brand.tone.slice(0, 500),
            sourceText: "",
            sourceUrl: null,
            missingInformation: "",
          },
          items: [{ title, script }, ...copies.map((copy) => ({ title: copy.title, script: copy.script }))],
        });
        // Each video gets its language, the presenter and the brand colour.
        const languages = [current.language, ...copies.map((copy) => copy.code)];
        const saved = await Promise.all(
          campaign.items.map(async (item, position) => {
            const wanted = languages[position] ?? current.language;
            // A copy in a language the presenter cannot speak keeps its language and goes without the presenter.
            const speaks = spoken(wanted);
            const language = speaks ?? wanted;
            const change = {
              ...(item.language !== language ? { language } : {}),
              ...(avatarId && speaks ? { avatarId } : {}),
              ...(item.style.brandColor.toLowerCase() !== current.accent.toLowerCase() ? { style: { ...item.style, brandColor: current.accent } } : {}),
            };
            return Object.keys(change).length ? client.reviseContent({ contentId: item.id, expectedRevision: item.revision, operationKey: uuid(), patch: change }) : item;
          }),
        );
        const main = saved[0];
        if (draftRef.current.face) saveLastFace(workspaceId, draftRef.current.face);
        patch({ project: { campaignId: campaign.id, itemId: main.id, revision: main.revision, saved: signature, copies: copies.map((copy) => copy.code) }, scriptKey: current.scriptKey ?? key });
        if (copies.some((copy) => !copy.translated)) setReply("Your language copies were added as drafts with the original script, ready to translate in the studio.");
      } else {
        const project = current.project;
        const campaign = await client.getCampaign(project.campaignId);
        const item = campaign.items.find((entry) => entry.id === project.itemId);
        if (!item) throw new Error("This project’s video was removed. Close this window and start a new project.");
        const saved = await client.reviseContent({
          contentId: item.id,
          expectedRevision: item.revision,
          operationKey: uuid(),
          patch: { title, script, language: mainLanguage ?? current.language, avatarId, style: { ...item.style, brandColor: current.accent } },
        });
        patch({ project: { ...project, revision: saved.revision, saved: signature } });
      }
      return true;
    } catch (reason) {
      setError(errorText(reason, "The project could not be saved. Nothing was lost here; try again."));
      return false;
    } finally {
      setBusy("");
    }
  }

  /* ───────── navigation ───────── */

  async function next() {
    if (busy || recording) return;
    setError("");
    if (step === "describe") {
      if (!briefOk) {
        setError(`Describe the video in at least ${MIN_BRIEF} characters.`);
        document.getElementById("np-brief")?.focus();
        return;
      }
      if (!draft.face) patch({ face: defaultFace() });
    }
    if (step === "look") {
      // The suggested layout is preselected once, the first time through; after that the person's pick stands.
      if (plannedTemplate !== draft.templateId) patch({ templateId: plannedTemplate });
      styleSeen.current = true;
    }
    if (step === "script") {
      if (!beatsOk) {
        setError("Write at least one line, or let the AI draft it.");
        return;
      }
      if (!(await ensureProject())) return;
    }
    if (step === "preview") return finish(true);
    const following = stepsFor(presenterOf(draftRef.current))[index + 1];
    if (following) setStep(following);
  }
  function back() {
    if (busy || recording || index === 0) return;
    setError("");
    setStep(steps[index - 1]);
  }

  useEffect(() => {
    if (step === "script" && !scriptBusy && (!draft.beats || (!draft.edited && stale))) void requestScript();
    // Only on arriving at the script step.
  }, [step]);
  // Written ahead: from leaving Describe, and again whenever a setting, the layout or who speaks changes, so the script
  // is ready on arrival. Lines the person edited are never replaced; untouched lines written for earlier choices make way.
  const plannedKey = scriptKeyOf({ ...draft, templateId: plannedTemplate });
  const ahead = (step === "look" || step === "make") && briefOk && Boolean(draft.face) && templates !== null && !draft.edited;
  useEffect(() => {
    if (ahead && draft.beats && draft.scriptKey !== plannedKey) patch((now) => (now.edited ? {} : { beats: null }));
  }, [ahead, plannedKey]);
  useWriteAhead(scripts, ahead ? [{ key: plannedKey, request: () => firstDraftRequest(draft, plannedTemplate) }] : [], 350, (written, result) => {
    setScriptMode(result.mode);
    setReply(result.reply);
    patch((now) => placeDraft(now, written, result, scripts.ready(now.scriptKey ?? "")?.title ?? null));
  });
  // Language copies are translated ahead too, once the lines have rested a moment, so saving does not wait for them.
  const copyLines = (draft.beats ?? []).filter((beat) => beat.text.trim());
  const copyJobs =
    step === "script" && !draft.project && !scriptBusy && copyLines.length
      ? draft.copies
          .filter((code) => code !== draft.language)
          .slice(0, MAX_COPIES)
          .map((code) => ({ key: copyKey(draft, code, copyLines), request: () => copyRequest(draft, code, copyLines) }))
      : [];
  useWriteAhead(scripts, copyJobs, 3000);
  // Keep a face chosen once personas load, so the look step always has a selection.
  useEffect(() => {
    if (personas && !draft.face && step !== "describe") patch({ face: defaultFace() });
  }, [personas, step]);

  async function close() {
    if (busy || recording) return;
    const project = draftRef.current.project;
    if (!project) return onClose(null);
    try {
      const campaign = await client.getCampaign(project.campaignId);
      clearDraft(workspaceId);
      onClose(campaign);
    } catch {
      onClose(null);
    }
  }
  async function finish(openVideo: boolean) {
    const current = draftRef.current;
    if (!current.project || busy) return;
    setBusy("finishing");
    setError("");
    try {
      // The preview step usually saved this timeline already, to render it; saving it again would only add a version.
      if (openVideo && saveTimeline && composition && !timelineSaved) {
        const document = await client.getComposition(current.project.itemId);
        await client.saveComposition({ contentId: current.project.itemId, expectedRevision: document.revision, composition: savedComposition(composition), operationKey: uuid() });
      }
      const campaign = await client.getCampaign(current.project.campaignId);
      clearDraft(workspaceId);
      onDone(campaign, openVideo);
    } catch (reason) {
      setError(errorText(reason, "The video could not be opened. Your project is saved; try again."));
      setBusy("");
    }
  }

  // The flow has its own history entry, so the browser's Back button closes it (the draft is kept).
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("new")) {
      const url = new URL(location.href);
      url.searchParams.set("new", "1");
      history.pushState({ ...history.state, newProject: true }, "", url);
    }
    const pop = () => {
      if (!new URLSearchParams(location.search).has("new")) void closeRef.current();
    };
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("popstate", pop);
      if (new URLSearchParams(location.search).has("new")) {
        const url = new URL(location.href);
        url.searchParams.delete("new");
        history.replaceState(history.state, "", url);
      }
    };
  }, []);

  // Escape closes; ⌘/Ctrl + Enter moves on; Tab stays inside the window. Keys never reach the studio underneath.
  function keys(event: ReactKeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      void close();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void next();
    } else if (event.key === "Tab") {
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), video[controls], audio[controls], [tabindex]:not([tabindex="-1"])') ?? [])].filter((element) => element.offsetParent !== null || element === document.activeElement);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>(".np-step [data-autofocus]")?.focus({ preventScroll: true });
    dialog.current?.querySelector(".np-main")?.scrollTo({ top: 0 });
  }, [step]);
  useEffect(() => {
    if (step !== "preview" || !take || take.localUrl || !draft.project) return;
    client
      .listFiles(draft.project.campaignId)
      .then((files) => setRemoteTake(files.find((file) => file.id === take.fileId)?.url ?? null))
      .catch(() => setRemoteTake(null));
  }, [step, take, draft.project, client]);

  /* ───────── preview ───────── */

  const styleStill = template?.posterUrl ?? null;
  const previewBeats = draft.beats?.length ? draft.beats : briefOk ? beatsFromText(draft.brief) : [{ id: "beat-1", label: "", text: "Your script appears here." }];
  const takeUrl = take?.localUrl ?? remoteTake;
  const takeForPreview: Take | null = take && takeUrl ? take : null;
  const composition = useMemo(
    () => {
      try {
        return previewComposition({ title: draft.title || workingTitle(draft.brief || "New video"), beats: previewBeats, accent: draft.accent, presenter, language: draft.language, take: takeForPreview, stills: { presenter: Boolean(facePhoto), style: Boolean(styleStill) } });
      } catch {
        return null;
      }
    },
    // previewBeats and presenter are derived from the draft.
    [draft.title, draft.brief, draft.beats, draft.accent, draft.face, draft.making, draft.language, takeForPreview, facePhoto, styleStill],
  );
  const media = useMemo<ReelMedia>(() => {
    const files: ReelMedia["files"] = {};
    if (facePhoto) files[STILL_PRESENTER] = { url: facePhoto, mime: "image/jpeg" };
    if (styleStill) files[STILL_STYLE] = { url: styleStill, mime: "image/jpeg" };
    if (take && takeUrl) files[take.fileId] = { url: takeUrl, mime: take.mime };
    return { itemMedia: null, files };
  }, [facePhoto, styleStill, take, takeUrl]);
  // A person's own take, or no presenter at all, is saved as the starting timeline; an AI presenter's video is rendered later.
  const saveTimeline = mode === "camera" || mode === "voice" || mode === "none";
  // The last step makes the video and waits for it (PreviewStep.tsx); the rough preview can be hidden throughout.
  const { production, timelineSaved, retry } = useProduction({ client, context, project: draft.project, mode, composition, active: step === "preview" });
  const [showPreview, setShowPreview] = usePreviewShown();

  /* ───────── describe ───────── */

  const describe = (
    <>
      <header className="np-hero">
        <h1 id="np-title">What is this video about?</h1>
        <p className="np-lead">Say it the way you would explain it to a friend: the topic, who it is for, and what they should do after watching. Paste notes or facts too.</p>
      </header>
      <div className="np-compose">
        <label className="sr-only" htmlFor="np-brief">
          Describe the video
        </label>
        <textarea
          id="np-brief"
          data-autofocus
          value={draft.brief}
          maxLength={SCRIPT_BRIEF_MAX}
          rows={7}
          placeholder="Three signs you should book an eye check this year, for people who stare at screens all day. Friendly, no medical jargon. End with: book online in two minutes."
          onChange={(event) => patch({ brief: event.target.value })}
        />
        <span className="np-count" aria-hidden="true">
          {draft.brief.length.toLocaleString()} / {SCRIPT_BRIEF_MAX.toLocaleString()}
        </span>
      </div>
      <div className="np-selects">
        <SettingsMenus value={draft} onChange={patch} made={draft.project ? (draft.project.copies ?? []) : null} />
      </div>
    </>
  );

  /* ───────── look ───────── */

  const pickFace = (face: Face) => patch((current) => {
    const keepLayout = template && template.family === (face.kind === "none" ? "no_face" : "face");
    return { face, templateId: keepLayout ? current.templateId : null };
  });
  const layouts = (templates ?? []).filter((entry) => entry.family === (hasFace ? "face" : "no_face"));
  const look = (
    <>
      {/* Presenter or no face first, then the people and their looks (create/look/LookStep.tsx). */}
      <LookFaces personas={personas} avatars={avatars} face={draft.face} lastFace={lastFace} createHref="/studio/?view=personas&create=1" onPick={pickFace} />

      {layouts.length > 0 && (
        <section className="np-layouts" aria-label="Layout">
          <h2 className="np-group">Layout</h2>
          <div className="np-styles" role="radiogroup" aria-label="Layout">
            <button type="button" role="radio" aria-checked={draft.templateId === null} className="np-style" onClick={() => patch({ templateId: null })}>
              <span className="np-style-art np-style-plain" aria-hidden="true">
                {hasFace ? <UserRound size={26} /> : <FogArt name="noface" />}
              </span>
              <strong>{hasFace ? "Plain presenter" : "Plain captions"}</strong>
              <span>{hasFace ? "Full frame with bold captions." : "Big captions on the brand colour."}</span>
            </button>
            {layouts.map((entry) => (
              <StyleCard key={entry.id} template={entry} selected={draft.templateId === entry.id} recommended={recommended === entry.id} onSelect={() => patch({ templateId: entry.id })} />
            ))}
          </div>
        </section>
      )}
    </>
  );

  /* ───────── make ───────── */

  const makeChoice = (making: Making, art: ReactNode, title: string, detail: string, wide = false) => (
    <button type="button" role="radio" aria-checked={draft.making === making} className={`np-make${wide ? " np-make-ai" : ""}`} data-autofocus={draft.making === making ? "" : undefined} onClick={() => patch((current) => ({ making, take: current.take && ((making === "camera" && current.take.kind === "avatar_clip") || (making === "voice" && current.take.kind === "voice")) ? current.take : null }))}>
      <span className="np-make-art">{art}</span>
      <span className="np-make-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      <span className="np-make-check" aria-hidden="true">
        <Check size={14} strokeWidth={2.5} />
      </span>
    </button>
  );
  const make = (
    <>
      <h1 id="np-title">How should it be made?</h1>
      <p className="np-lead">{hasFace ? `${faceName ?? "Your presenter"} can present it for you, or you can record it yourself.` : "The AI can build it from captions and graphics, or you can record it yourself."}</p>
      <div role="radiogroup" aria-label="How it is made">
        {hasFace
          ? makeChoice("ai", <FogPresenter photo={facePhoto} />,`${faceName ?? "Your presenter"} presents it`, "An AI avatar reads your script. You see a rough preview first; the speaking video is made when you render.", true)
          : makeChoice("ai", <FogArt name="noface" />,"No face, made by AI", "Captions and graphics carry the video. Add music or a voice-over in the video studio.", true)}
        <div className="np-divider" role="separator">
          <span>Would you like to do something manually?</span>
        </div>
        <div className="np-make-grid">
          {makeChoice("camera", <FogArt name="camera" />,"Record myself", "Read from a teleprompter that follows your voice. Your video becomes the presenter.")}
          {makeChoice("voice", <FogArt name="voice" />,"Record my voice only", hasFace ? `Your voice over ${faceName ?? "the presenter"}’s picture and the captions.` : "Your voice over the captions and graphics.")}
        </div>
      </div>
    </>
  );

  /* ───────── script ───────── */

  const seconds = spokenSeconds(draft.beats);
  const aiOff = scriptMode === "basic";
  const script = (
    <>
      <div className="np-script-head">
        <label className="sr-only" htmlFor="np-title-input">
          Title
        </label>
        <input id="np-title-input" className="np-title-input" value={draft.title} maxLength={120} placeholder={workingTitle(draft.brief)} onChange={(event) => patch({ title: event.target.value })} />
        <span className="np-meter" data-state={seconds > draft.seconds * 1.15 ? "long" : seconds < draft.seconds * 0.6 ? "short" : "ok"} title="At about 2.5 words a second">
          ≈ {seconds}s of {draft.seconds}s
        </span>
      </div>
      <h1 id="np-title" className="sr-only">
        Script
      </h1>
      {stale && !scriptBusy && (
        <div className="np-note">
          <span>Your description, settings, layout or presenter changed since this script was written.</span>
          <button type="button" className="text-button" onClick={() => void requestScript({ instruction: "Rewrite the whole script for the updated brief, length and layout. Keep lines the person clearly wrote themselves when they still fit." })}>
            <RefreshCw size={13} aria-hidden="true" /> Rewrite for the changes
          </button>
        </div>
      )}
      {!draft.beats && (
        <div className="np-writing" role="status">
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Writing your script…
        </div>
      )}
      {draft.beats && (
        <ol className="np-beats" aria-busy={scriptBusy}>
          {draft.beats.map((beat, position) => (
            <li key={beat.id} className="np-beat">
              <div className="np-beat-top">
                <input className="np-beat-label" value={beat.label} maxLength={40} aria-label={`Name of line ${position + 1}`} onChange={(event) => editBeat(beat.id, { label: event.target.value })} />
                <div className="np-beat-tools">
                  {!aiOff &&
                    BEAT_EDITS.map((edit) => (
                      <button key={edit.label} type="button" className="np-chip" disabled={scriptBusy || !beat.text.trim()} onClick={() => void requestScript({ instruction: edit.instruction, beatId: beat.id })}>
                        {edit.label}
                      </button>
                    ))}
                  <button type="button" className="icon-button" aria-label={`Move line ${position + 1} up`} disabled={position === 0} onClick={() => moveBeat(beat.id, -1)}>
                    <ChevronUp size={14} />
                  </button>
                  <button type="button" className="icon-button" aria-label={`Move line ${position + 1} down`} disabled={position === draft.beats!.length - 1} onClick={() => moveBeat(beat.id, 1)}>
                    <ChevronDown size={14} />
                  </button>
                  <button type="button" className="icon-button" aria-label={`Delete line ${position + 1}`} onClick={() => removeBeat(beat.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <textarea
                id={`np-beat-${beat.id}`}
                className="np-beat-text"
                value={beat.text}
                maxLength={600}
                rows={Math.max(1, Math.ceil(beat.text.length / 52))}
                aria-label={`Line ${position + 1}: ${beat.label || "spoken words"}`}
                data-autofocus={position === 0 ? "" : undefined}
                onChange={(event) => editBeat(beat.id, { text: event.target.value })}
              />
            </li>
          ))}
        </ol>
      )}
      {draft.beats && draft.beats.length < SCRIPT_BEATS_MAX && (
        <button type="button" className="text-button np-add" onClick={addBeat}>
          <Plus size={14} aria-hidden="true" /> Add a line
        </button>
      )}
      <form
        className="np-ask"
        onSubmit={(event) => {
          event.preventDefault();
          const text = ask.trim();
          if (!text || scriptBusy || aiOff) return;
          setAsk("");
          void requestScript({ instruction: text });
        }}
      >
        <Sparkles size={15} aria-hidden="true" />
        <label className="sr-only" htmlFor="np-ask">
          Ask AI to change the script
        </label>
        <input id="np-ask" value={ask} maxLength={1000} disabled={aiOff} placeholder={aiOff ? "AI writing isn’t connected here. Edit any line directly." : "Ask AI to change anything, e.g. “make the hook a question”"} onChange={(event) => setAsk(event.target.value)} />
        <button className="button primary" disabled={!ask.trim() || scriptBusy || aiOff}>
          {scriptBusy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : "Change"}
        </button>
      </form>
      {!aiOff && (
        <div className="np-quick" aria-label="Quick changes">
          {QUICK_EDITS.map((instruction) => (
            <button key={instruction} type="button" className="np-chip" disabled={scriptBusy || !draft.beats} onClick={() => void requestScript({ instruction })}>
              {instruction}
            </button>
          ))}
        </div>
      )}
      {(reply || scriptError || undo.length > 0) && (
        <p className={`np-reply${scriptError ? " is-error" : ""}`} role="status">
          {scriptError || reply}
          {undo.length > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                const previous = undo[undo.length - 1];
                setUndo((stack) => stack.slice(0, -1));
                patch({ beats: previous, edited: true });
              }}
            >
              <Undo2 size={13} aria-hidden="true" /> Undo
            </button>
          )}
        </p>
      )}
    </>
  );

  /* ───────── record and preview ───────── */

  const record =
    draft.project && draft.beats && (mode === "voice" || mode === "camera") ? (
      <RecordStep
        client={client}
        mode={mode}
        beats={draft.beats.filter((beat) => beat.text.trim())}
        language={draft.language}
        target={{ campaignId: draft.project.campaignId, itemId: draft.project.itemId, name: mode === "camera" ? "Camera take" : "Voice take" }}
        liveToken={liveToken}
        take={draft.take}
        onTake={(take) => patch({ take })}
        onBusy={setRecording}
      />
    ) : null;

  const preview = <PreviewStep production={production} onRetry={retry} composition={composition} media={media} showPreview={showPreview} />;

  const content: Record<StepId, ReactNode> = { describe, look, make, script, record, preview };
  const sideStep = step === "look" || step === "make" || step === "script";
  const side = showPreview && sideStep && composition;
  const nextLabel = step === "describe" ? "Continue" : step === "look" ? "Continue" : step === "make" ? "Write the script" : step === "script" ? (records(presenter) ? "Record it" : "See the preview") : step === "record" ? "See the preview" : "Open in video studio";
  const nextDisabled = Boolean(busy) || recording || (step === "script" && (!beatsOk || (scriptBusy && !draft.beats))) || (step === "record" && !draft.take) || (step === "look" && !draft.face);

  return (
    <div className="np" role="dialog" aria-modal="true" aria-labelledby="np-title" ref={dialog} onKeyDown={keys}>
      <header className="np-top">
        <span className="np-kicker">New project</span>
        <ol className="np-rail" aria-label="Steps">
          {steps.map((entry, position) => (
            <li key={entry} data-state={position < index ? "done" : position === index ? "current" : "todo"}>
              <button type="button" aria-current={entry === step ? "step" : undefined} disabled={busy !== "" || recording || entry === step || !canEnter(entry)} onClick={() => setStep(entry)}>
                <span className="np-rail-dot" aria-hidden="true">
                  {position < index ? <Check size={11} strokeWidth={2.5} /> : position + 1}
                </span>
                <span className="np-rail-label">{STEP_LABELS[entry]}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="np-top-end">
          {((sideStep && composition) || (step === "preview" && production.state !== "ready")) && (
            <button type="button" className="button secondary np-preview-toggle" data-where={sideStep ? "side" : "step"} aria-label={showPreview ? "Hide preview" : "Show preview"} title={showPreview ? "Hide preview" : "Show preview"} onClick={() => setShowPreview(!showPreview)}>
              {showPreview ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
              <span className="np-preview-toggle-label">{showPreview ? "Hide preview" : "Show preview"}</span>
            </button>
          )}
          <button type="button" className="icon-button np-close" aria-label="Close new project" title="Close (Esc)" disabled={busy !== "" || recording} onClick={() => void close()}>
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="np-body" data-step={step}>
        <main className="np-main">
          <section className={`np-step np-step-${step}`} key={step}>
            {content[step]}
          </section>
          {/* The step's own actions sit right under its content, and stay in reach while a long step scrolls. */}
          <footer className={`np-foot np-foot-${step}`}>
            <button type="button" className="button secondary" disabled={index === 0 || busy !== "" || recording} onClick={back}>
              <ArrowLeft size={14} aria-hidden="true" /> Back
            </button>
            <p className={`np-foot-note${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
              {error || (busy === "saving" ? (!draft.project && draft.copies.length ? "Saving your project and its language copies…" : "Saving your project…") : busy === "finishing" ? "Opening the video studio…" : "")}
            </p>
            {step === "preview" && (
              <button type="button" className="button secondary" disabled={busy !== ""} onClick={() => void finish(false)}>
                Finish later
              </button>
            )}
            <button type="button" className="button primary" disabled={nextDisabled} onClick={() => void next()}>
              {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}
              {nextLabel}
              {step !== "preview" && <ArrowRight size={14} aria-hidden="true" />}
            </button>
          </footer>
        </main>
        {side && (
          <aside className="np-side" aria-label="Rough preview">
            <div className="np-side-frame">
              <Suspense fallback={<div className="np-player-loading" />}>
                <PreviewPlayer composition={composition} media={media} compact />
              </Suspense>
            </div>
            <p>Rough preview · updates as you choose</p>
          </aside>
        )}
      </div>
    </div>
  );
}

/** One layout: its poster, and its sample playing while it is hovered or focused. */
function StyleCard({ template, selected, recommended, onSelect }: { template: LibraryTemplate; selected: boolean; recommended: boolean; onSelect: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const play = () => {
    if (!template.videoUrl || !video.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    video.current.currentTime = 0;
    void video.current.play().catch(() => undefined);
  };
  const pause = () => video.current?.pause();
  return (
    <button type="button" role="radio" aria-checked={selected} className="np-style" onClick={onSelect} onMouseEnter={play} onMouseLeave={pause} onFocus={play} onBlur={pause}>
      <span className="np-style-art">
        {template.posterUrl && <img src={template.posterUrl} alt="" loading="lazy" />}
        {template.videoUrl && <video ref={video} src={template.videoUrl} muted loop playsInline preload="none" aria-hidden="true" />}
        {recommended && <span className="np-badge">Suggested</span>}
      </span>
      <strong>{template.name}</strong>
      <span>{template.summary}</span>
    </button>
  );
}
