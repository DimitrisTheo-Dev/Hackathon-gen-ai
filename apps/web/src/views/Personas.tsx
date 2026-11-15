import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, CircleAlert, ImagePlus, LoaderCircle, PenLine, Plus, RotateCcw, ScanFace, Shirt, ShieldCheck, Trash2 } from "lucide-react";
import { PERSONA_LOOK_LIMIT, type Persona, type PersonaLook, type PersonaStatus } from "@castroom/contracts";
import type { StudioClient } from "../data/client";
import { CopyButton, Modal, Notice } from "../components/ui";
import { sessionLikenessApi, sessionName } from "../likeness/session";
import "../personas.css";

// The capture and its on-device face tracker load only when someone starts a scan.
const LikenessCapture = lazy(() => import("../likeness/LikenessCapture"));

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "el", name: "Greek (Ελληνικά)" },
] as const;
type Language = (typeof LANGUAGES)[number]["code"];
const STATUS: Record<PersonaStatus, string> = { needs_consent: "Needs consent", ready: "Ready", consent_withdrawn: "Consent withdrawn" };
const PHOTO_TYPES = "image/jpeg,image/png,image/webp";
const dateOf = (instant: string) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(instant));
const looksLabel = (n: number) => (n === 0 ? "No looks yet" : n === 1 ? "1 look" : `${n} looks`);
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const initialOf = (name: string) => (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();
/** The face a persona card shows: the straight-on still from the scan, else the first look with a photo. */
const portraitOf = (persona: Persona) => persona.consent?.photoUrl ?? persona.looks.find((look) => look.imageUrl)?.imageUrl ?? null;
const scanLink = (personaId: string) => `/face-scan?persona=${encodeURIComponent(personaId)}`;
/** The three steps from a name to a usable presenter, with honest time estimates (the scan's own plan). */
const JOURNEY = [
  { title: "Consent", time: "30 sec", body: "The person confirms their name and agrees." },
  { title: "Face scan", time: "about 1 min", body: "They turn their head and read three short lines aloud." },
  { title: "Your looks", time: "anytime", body: "Outfits and settings for the videos." },
] as const;

/** The journey as a quiet numbered row; `done` steps get a tick, the `current` one is in ink. */
function Journey({ done, current }: { done: number; current: number }) {
  return (
    <ol className="pa-journey">
      {JOURNEY.map((step, index) => (
        <li key={step.title} className={index < done ? "done" : index === current ? "on" : undefined} aria-current={index === current ? "step" : undefined}>
          <span className="pa-journey-dot" aria-hidden="true">{index < done ? <Check size={11} strokeWidth={3} /> : index + 1}</span>
          <span className="pa-journey-text">
            <strong>{step.title}<small>{step.time}</small></strong>
            <span>{step.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Personas: presenters for the workspace's videos (packages/engine/src/personas.ts). Each one is made from a face
 * scan with spoken consent, recorded by the person themself, and can appear in several looks. The scan runs right
 * here in the tab; someone recording on their own device uses the /face-scan?persona=<id> link instead.
 */
export function Personas({ client, role }: { client: StudioClient; role: string }) {
  const canEdit = role === "owner" || role === "admin" || role === "editor";
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  // Coming back from a face scan lands on the persona it was for.
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(location.search).get("persona"));
  const [scanFor, setScanFor] = useState<Persona | null>(null);
  /** Set when the scan finished and the person chose to add a look next. */
  const [lookFirst, setLookFirst] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const reloads = useRef(0);
  const load = useCallback(() => {
    let active = true;
    client
      .listPersonas()
      .then((list) => { if (active) { setPersonas(list); setError(""); } })
      .catch((reason) => { if (active) setError(messageOf(reason, "The personas could not be loaded.")); })
      .finally(() => { if (active) setRetrying(false); });
    return () => { active = false; };
  }, [client]);
  useEffect(() => load(), [load]);
  // Photo links are short-lived; one that stops loading fetches fresh links, a few times per visit at most.
  const refresh = useCallback(() => {
    if (reloads.current < 3) { reloads.current += 1; load(); }
  }, [load]);
  const replace = (persona: Persona) => setPersonas((list) => (list ? (list.some((p) => p.id === persona.id) ? list.map((p) => (p.id === persona.id ? persona : p)) : [...list, persona]) : [persona]));
  const close = () => {
    setOpenId(null);
    const url = new URL(location.href);
    if (url.searchParams.has("persona")) { url.searchParams.delete("persona"); history.replaceState(history.state, "", url); }
  };
  const open = personas?.find((persona) => persona.id === openId) ?? null;

  if (scanFor) {
    // Back to the persona, with its consent fresh from the engine; after a saved scan, straight to its first look.
    const exit = (toLooks: boolean) => {
      setLookFirst(toLooks);
      setOpenId(scanFor.id);
      setScanFor(null);
      load();
    };
    return <PersonaScan persona={scanFor} onExit={() => exit(false)} onLooks={() => exit(true)} />;
  }

  return (
    <div className="pa">
      <header className="pa-intro">
        <div>
          <h1>Personas</h1>
          <p>Real people as the presenters of your videos, each made from their own face scan and spoken consent.</p>
        </div>
        {canEdit && !!personas?.length && <button className="button primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />New persona</button>}
      </header>
      {error && personas === null && (
        <div className="pa-failed" role="alert">
          <span className="pa-failed-icon" aria-hidden="true"><CircleAlert size={16} /></span>
          <p><strong>Couldn’t load the personas</strong><span>{error}</span></p>
          <button className="button secondary" disabled={retrying} onClick={() => { setRetrying(true); load(); }}>
            {retrying ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {error && personas !== null && <Notice error>{error}</Notice>}
      {personas === null && !error && <><p className="sr-only" role="status">Loading personas…</p><PersonaGridSkeleton /></>}
      {personas?.length === 0 && (
        <section className="pa-empty" aria-labelledby="pa-empty-title">
          <div className="pa-empty-art" aria-hidden="true">
            <span className="pa-empty-oval"><ScanFace size={30} strokeWidth={1.75} /></span>
          </div>
          <div className="pa-empty-body">
            <h2 id="pa-empty-title">Put a real face on your videos</h2>
            <p>No personas yet. One short face scan with spoken consent turns you, or a teammate, into a presenter you can use in any video.</p>
            <Journey done={0} current={-1} />
            {canEdit ? (
              <div className="pa-empty-actions">
                <button className="button primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />Create a persona</button>
                <span className="pa-empty-note"><ShieldCheck size={14} aria-hidden="true" />Private to this workspace. Consent can be withdrawn anytime.</span>
              </div>
            ) : (
              <p className="pa-note">An owner, admin or editor can create one.</p>
            )}
          </div>
        </section>
      )}
      {!!personas?.length && (
        <ul className="pa-grid">
          {personas.map((persona) => {
            const portrait = portraitOf(persona);
            return (
              <li key={persona.id}>
                <button className="pa-card" onClick={() => { setLookFirst(false); setOpenId(persona.id); }}>
                  <span className={portrait ? "pa-portrait" : "pa-portrait art"}>
                    {portrait ? <img src={portrait} alt="" loading="lazy" decoding="async" onError={refresh} /> : <span className="pa-initial" aria-hidden="true">{initialOf(persona.name)}</span>}
                  </span>
                  <span className="pa-card-text">
                    <strong>{persona.name}</strong>
                    <span className={`pa-status ${persona.status}`}>{STATUS[persona.status]}</span>
                    <small>{persona.status === "ready" ? looksLabel(persona.looks.length) : persona.status === "needs_consent" ? "Next: face scan, about 2 min" : "Needs a new consent"}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <NewPersona client={client} onClose={() => setCreating(false)} onCreated={(persona) => { replace(persona); setCreating(false); setOpenId(persona.id); }} />}
      {open && (
        <PersonaDetail
          key={open.id}
          client={client}
          persona={open}
          canEdit={canEdit}
          onChange={replace}
          onReload={load}
          onRecord={() => setScanFor(open)}
          lookFirst={lookFirst}
          onDeleted={() => { setPersonas((list) => list?.filter((p) => p.id !== open.id) ?? null); close(); }}
          onClose={close}
          onExpired={refresh}
        />
      )}
    </div>
  );
}

/** The face scan for one persona, in place of the persona list. Leaving it, or finishing, returns to the persona. */
function PersonaScan({ persona, onExit, onLooks }: { persona: Persona; onExit: () => void; onLooks: () => void }) {
  const api = useMemo(() => sessionLikenessApi(), []);
  const [name, setName] = useState("");
  useEffect(() => {
    let active = true;
    void sessionName().then((value) => { if (active) setName(value); });
    return () => { active = false; };
  }, []);
  return (
    <div className="pa pa-scan">
      <Suspense fallback={<p className="pa-loading" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Opening the face scan…</p>}>
        <LikenessCapture
          open
          embedded
          api={api}
          defaultName={name}
          personaId={persona.id}
          context={`Persona · ${persona.name}`}
          onClose={onExit}
          doneAction={{ label: "Add a look", onClick: onLooks }}
        />
      </Suspense>
    </div>
  );
}

function NewPersona({ client, onClose, onCreated }: { client: StudioClient; onClose: () => void; onCreated: (persona: Persona) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  // The same key across retries of this form, so a repeated click cannot create two personas.
  const [operationKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      onCreated(await client.createPersona({ name, description, language, operationKey }));
    } catch (reason) {
      setError(messageOf(reason, "The persona could not be created. Nothing was saved."));
      setBusy(false);
    }
  }
  return (
    <Modal title="New persona" onClose={onClose}>
      {error && <Notice error>{error}</Notice>}
      <p className="pa-modal-lede">Name the presenter first. The face scan and consent come right after, about two minutes in all.</p>
      <form onSubmit={submit} aria-busy={busy}>
        <div className="field">
          <label htmlFor="persona-name">Name</label>
          <input id="persona-name" value={name} maxLength={80} required disabled={busy} autoComplete="off" placeholder="Dr. Maria, nutrition" onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="persona-description">Who they are<span>Optional</span></label>
          <textarea id="persona-description" value={description} maxLength={1000} rows={3} disabled={busy} placeholder="A calm dietitian who explains one idea per video." onChange={(event) => setDescription(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="persona-language">Speaks</label>
          <select id="persona-language" value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as Language)}>
            {LANGUAGES.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
          </select>
        </div>
        <p className="pa-note pa-next"><ScanFace size={14} aria-hidden="true" />Next: the person this persona is based on agrees and scans their face, here or on their own phone.</p>
        <div className="modal-actions">
          <button className="button secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create persona"}</button>
        </div>
      </form>
    </Modal>
  );
}

function PersonaDetail({
  client,
  persona,
  canEdit,
  onChange,
  onReload,
  onRecord,
  lookFirst,
  onDeleted,
  onClose,
  onExpired,
}: {
  client: StudioClient;
  persona: Persona;
  canEdit: boolean;
  onChange: (persona: Persona) => void;
  onReload: () => void;
  /** Opens the face scan for this persona inside the tab. */
  onRecord: () => void;
  /** Open with the new-look form showing: the scan just finished and the person chose to add a look. */
  lookFirst: boolean;
  onDeleted: () => void;
  onClose: () => void;
  onExpired: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"withdraw" | "delete" | null>(null);
  const [editing, setEditing] = useState(false);
  const [addingLook, setAddingLook] = useState(() => lookFirst && canEdit && persona.looks.length < PERSONA_LOOK_LIMIT);
  const run = async (label: string, action: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(label); setError("");
    try {
      await action();
    } catch (reason) {
      setError(messageOf(reason, fallback));
    } finally {
      setBusy(null);
    }
  };
  const consent = persona.consent;
  const absoluteScanLink = `${location.origin}${scanLink(persona.id)}`;

  return (
    <Modal title={persona.name} onClose={onClose} wide>
      <div className="pa-detail" aria-busy={busy !== null}>
        {error && <Notice error>{error}</Notice>}

        <section className="pa-section" aria-labelledby="pa-consent">
          <div className="pa-section-head">
            <h3 id="pa-consent">Consent</h3>
            <span className={`pa-status ${persona.status}`}>{STATUS[persona.status]}</span>
          </div>
          {persona.status === "ready" && consent ? (
            <div className="pa-consent">
              <span className="pa-consent-photo">{consent.photoUrl ? <img src={consent.photoUrl} alt={`Face scan of ${consent.subjectName}`} onError={onExpired} /> : <ScanFace size={22} aria-hidden="true" />}</span>
              <div>
                <p><strong>{consent.subjectName}</strong> scanned their face and agreed aloud on {dateOf(consent.createdAt)}. Every look below is covered by this consent.</p>
                {consent.canWithdraw && (confirm === "withdraw" ? (
                  <div className="pa-confirm" role="group" aria-label="Confirm withdrawal">
                    <span>The face scan and voice recordings are deleted for good, and this persona can’t be used until a new consent is recorded.</span>
                    <button className="button secondary" disabled={busy !== null} onClick={() => setConfirm(null)}>Keep consent</button>
                    <button className="button danger" disabled={busy !== null} onClick={() => run("withdraw", async () => { await client.withdrawPersonaConsent(persona.id); setConfirm(null); onReload(); }, "The consent could not be withdrawn. Nothing was deleted.")}>{busy === "withdraw" ? "Withdrawing…" : "Withdraw and delete recordings"}</button>
                  </div>
                ) : (
                  <button className="text-button pa-danger-text" disabled={busy !== null} onClick={() => setConfirm("withdraw")}>Withdraw consent</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="pa-consent-needed">
              <p>
                {persona.status === "consent_withdrawn" && consent
                  ? `${consent.subjectName} withdrew their consent on ${dateOf(consent.revokedAt ?? consent.createdAt)} and the recordings were deleted. Record a new consent to use this persona again.`
                  : "Before this persona can be used, the person it is based on agrees and scans their face. About two minutes, on a phone or a laptop with a camera."}
              </p>
              <Journey done={0} current={0} />
              <div className="pa-consent-actions">
                <button className="button primary" onClick={onRecord}><ScanFace size={16} aria-hidden="true" />Start the face scan</button>
                <CopyButton value={absoluteScanLink} label="Copy link for them" />
              </div>
              <p className="pa-note">Start now if you are the person, on this device. Otherwise send them the link: it works for members of this workspace, and the consent is saved under their own name.</p>
            </div>
          )}
        </section>

        <section className="pa-section" aria-labelledby="pa-details">
          <div className="pa-section-head">
            <h3 id="pa-details">Details</h3>
            {canEdit && !editing && <button className="text-button" onClick={() => setEditing(true)}><PenLine size={13} aria-hidden="true" />Edit</button>}
          </div>
          {editing ? (
            <PersonaForm
              persona={persona}
              busy={busy === "details"}
              onCancel={() => setEditing(false)}
              onSave={(patch) => run("details", async () => { onChange(await client.updatePersona({ personaId: persona.id, ...patch })); setEditing(false); }, "The changes could not be saved.")}
            />
          ) : (
            <dl className="pa-facts">
              <div><dt>Who they are</dt><dd>{persona.description || <span className="pa-muted">No description yet.</span>}</dd></div>
              <div><dt>Speaks</dt><dd>{LANGUAGES.find((option) => option.code === persona.language)?.name ?? persona.language}</dd></div>
              <div><dt>Created</dt><dd>{dateOf(persona.createdAt)}</dd></div>
            </dl>
          )}
        </section>

        <section className="pa-section" aria-labelledby="pa-looks">
          <div className="pa-section-head">
            <h3 id="pa-looks">Looks</h3>
            {canEdit && !addingLook && persona.looks.length < PERSONA_LOOK_LIMIT && <button className="text-button" onClick={() => setAddingLook(true)}><Plus size={13} aria-hidden="true" />Add a look</button>}
          </div>
          <p className="pa-note">A look is how the persona appears on screen: what they wear, their hair, the setting. Add a reference photo if you have one.</p>
          {!persona.looks.length && !addingLook && (
            <div className="pa-looks-empty">
              <span aria-hidden="true"><Shirt size={18} /></span>
              <p>No looks yet. {canEdit ? "Add one for each outfit or setting you want on camera." : ""}</p>
            </div>
          )}
          {!!persona.looks.length && (
            <ul className="pa-looks">
              {persona.looks.map((look) => <LookRow key={look.id} client={client} look={look} canEdit={canEdit} onChange={onChange} onExpired={onExpired} />)}
            </ul>
          )}
          {addingLook && (
            <LookForm
              client={client}
              personaId={persona.id}
              onCancel={() => setAddingLook(false)}
              onSaved={(next) => { onChange(next); setAddingLook(false); }}
            />
          )}
        </section>

        {canEdit && (
          <section className="pa-section pa-delete">
            {confirm === "delete" ? (
              <div className="pa-confirm" role="group" aria-label="Confirm deletion">
                <span>Deletes the persona, its looks and their photos.{consent && !consent.revokedAt ? " The consent stays with the person; they can withdraw it separately." : ""}</span>
                <button className="button secondary" disabled={busy !== null} onClick={() => setConfirm(null)}>Keep persona</button>
                <button className="button danger" disabled={busy !== null} onClick={() => run("delete", async () => { await client.deletePersona(persona.id); onDeleted(); }, "The persona could not be deleted.")}>{busy === "delete" ? "Deleting…" : "Delete persona"}</button>
              </div>
            ) : (
              <button className="text-button pa-danger-text" disabled={busy !== null} onClick={() => setConfirm("delete")}><Trash2 size={13} aria-hidden="true" />Delete persona</button>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}

function PersonaForm({ persona, busy, onCancel, onSave }: { persona: Persona; busy: boolean; onCancel: () => void; onSave: (patch: { name: string; description: string; language: Language }) => void }) {
  const [name, setName] = useState(persona.name);
  const [description, setDescription] = useState(persona.description);
  const [language, setLanguage] = useState<Language>(persona.language);
  return (
    <form className="pa-form" onSubmit={(event) => { event.preventDefault(); onSave({ name, description, language }); }} aria-busy={busy}>
      <div className="field">
        <label htmlFor="persona-edit-name">Name</label>
        <input id="persona-edit-name" value={name} maxLength={80} required disabled={busy} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="persona-edit-description">Who they are<span>Optional</span></label>
        <textarea id="persona-edit-description" value={description} maxLength={1000} rows={3} disabled={busy} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="persona-edit-language">Speaks</label>
        <select id="persona-edit-language" value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as Language)}>
          {LANGUAGES.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
        </select>
      </div>
      <div className="pa-form-actions">
        <button className="button secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="button primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

function LookRow({ client, look, canEdit, onChange, onExpired }: { client: StudioClient; look: PersonaLook; canEdit: boolean; onChange: (persona: Persona) => void; onExpired: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (editing) return <li><LookForm client={client} personaId={look.personaId} look={look} onCancel={() => setEditing(false)} onSaved={(next) => { onChange(next); setEditing(false); }} /></li>;
  return (
    <li className="pa-look">
      <span className="pa-look-photo">{look.imageUrl ? <img src={look.imageUrl} alt={`Reference photo: ${look.name}`} loading="lazy" decoding="async" onError={onExpired} /> : <ImagePlus size={18} aria-hidden="true" />}</span>
      <div className="pa-look-text">
        <strong>{look.name}</strong>
        {look.description && <p>{look.description}</p>}
        {error && <p className="pa-error" role="alert">{error}</p>}
      </div>
      {canEdit && (
        <div className="pa-look-actions">
          <button className="icon-button" aria-label={`Edit ${look.name}`} disabled={busy} onClick={() => setEditing(true)}><PenLine size={15} /></button>
          <button
            className="icon-button"
            aria-label={`Delete ${look.name}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true); setError("");
              try { onChange(await client.deletePersonaLook(look.id)); } catch (reason) { setError(messageOf(reason, "The look could not be deleted.")); setBusy(false); }
            }}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
          </button>
        </div>
      )}
    </li>
  );
}

/** Adds a look, or edits one when `look` is given. A new photo is uploaded first, then saved with the look. */
function LookForm({ client, personaId, look, onCancel, onSaved }: { client: StudioClient; personaId: string; look?: PersonaLook; onCancel: () => void; onSaved: (persona: Persona) => void }) {
  const [name, setName] = useState(look?.name ?? "");
  const [description, setDescription] = useState(look?.description ?? "");
  const [photo, setPhoto] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [operationKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!photo) { setPreview(null); return; }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  const id = look?.id ?? "new";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    try {
      let imageKey: string | null | undefined = look ? undefined : null;
      if (photo) {
        setBusy("Uploading photo…");
        imageKey = await client.uploadPersonaPhoto(personaId, photo);
      } else if (removePhoto) imageKey = null;
      setBusy("Saving…");
      onSaved(
        look
          ? await client.updatePersonaLook({ lookId: look.id, name, description, ...(imageKey !== undefined ? { imageKey } : {}) })
          : await client.createPersonaLook({ personaId, name, description, imageKey, operationKey }),
      );
    } catch (reason) {
      setError(messageOf(reason, "The look could not be saved."));
      setBusy(null);
    }
  }
  const shown = preview ?? (removePhoto ? null : look?.imageUrl ?? null);
  return (
    <form className="pa-form pa-look-form" onSubmit={submit} aria-busy={busy !== null}>
      {error && <Notice error>{error}</Notice>}
      <div className="pa-look-form-grid">
        <label className="pa-photo-pick" htmlFor={`look-photo-${id}`}>
          {shown ? <img src={shown} alt="" /> : <><ImagePlus size={20} aria-hidden="true" /><span>Add photo</span></>}
          <input
            id={`look-photo-${id}`}
            type="file"
            accept={PHOTO_TYPES}
            disabled={busy !== null}
            aria-label="Reference photo (JPEG, PNG or WebP, up to 15 MB)"
            onChange={(event) => { const file = event.target.files?.[0] ?? null; setPhoto(file); if (file) setRemovePhoto(false); }}
          />
        </label>
        <div>
          <div className="field">
            <label htmlFor={`look-name-${id}`}>Look</label>
            <input id={`look-name-${id}`} value={name} maxLength={80} required disabled={busy !== null} autoComplete="off" placeholder="Studio, navy blazer" onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`look-description-${id}`}>Wardrobe, hair and setting<span>Optional</span></label>
            <textarea id={`look-description-${id}`} value={description} maxLength={1000} rows={2} disabled={busy !== null} placeholder="Hair tied back, soft key light, plain grey backdrop." onChange={(event) => setDescription(event.target.value)} />
          </div>
          {look?.hasImage && !photo && (
            <label className="pa-check">
              <input type="checkbox" checked={removePhoto} disabled={busy !== null} onChange={(event) => setRemovePhoto(event.target.checked)} />
              Remove the photo
            </label>
          )}
        </div>
      </div>
      <div className="pa-form-actions">
        <button className="button secondary" type="button" disabled={busy !== null} onClick={onCancel}>Cancel</button>
        <button className="button primary" disabled={busy !== null || !name.trim()}>{busy ?? (look ? "Save look" : "Add look")}</button>
      </div>
    </form>
  );
}

/** The grid's own geometry while the personas load: portrait frames and the two text lines under them. */
function PersonaGridSkeleton() {
  return (
    <ul className="pa-grid pa-skeleton" aria-hidden="true">
      {[0, 1, 2, 3].map((n) => (
        <li key={n}>
          <span className="pa-card">
            <span className="pa-portrait" />
            <span className="pa-card-text"><i className="pa-sk-name" /><i className="pa-sk-line" /></span>
          </span>
        </li>
      ))}
    </ul>
  );
}
