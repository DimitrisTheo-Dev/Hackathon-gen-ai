import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Plus, UserRound } from "lucide-react";
import type { Persona } from "@castroom/contracts";
import type { Face } from "../model";
import "./look.css";

/* ───────── fog art, shared with the Make step ───────── */

const FOG = {
  noface: "/art/fog/noface.webp",
  presenter: "/art/fog/presenter.webp",
  camera: "/art/fog/camera.webp",
  voice: "/art/fog/voice.webp",
  create: "/art/fog/create.webp",
} as const;
/** A generated picture in the white-blue fog family (public/art/fog). Decorative: every choice names itself in text. */
export function FogArt({ name }: { name: keyof typeof FOG }) {
  return <img className="lk-fog" data-art={name} src={FOG[name]} alt="" decoding="async" draggable={false} />;
}
/** A presenter's photo standing in the fog. */
export function FogPresenter({ photo }: { photo: string | null }) {
  return (
    <span className="lk-fog-presenter">
      <FogArt name="presenter" />
      <span className="lk-fog-face">{photo ? <img src={photo} alt="" draggable={false} /> : <UserRound size={30} aria-hidden="true" />}</span>
    </span>
  );
}

/* ───────── the people on offer ───────── */

type Avatar = { id: string; name: string; previewUrl: string | null };
type Person = { key: string; name: string; photo: string | null; detail: string; ready: boolean; selected: boolean; persona: Persona | null; pick: () => void };
type Look = { id: string | null; name: string; imageUrl: string | null };

/** The picture for a persona: the chosen look's photo, else the straight-on still from its scan, else any look. */
function personaPhoto(persona: Persona, lookId: string | null) {
  const look = lookId ? persona.looks.find((entry) => entry.id === lookId) : null;
  return look?.imageUrl ?? persona.consent?.photoUrl ?? persona.looks.find((entry) => entry.imageUrl)?.imageUrl ?? null;
}
const looksOf = (persona: Persona): Look[] => [{ id: null, name: "Scan photo", imageUrl: persona.consent?.photoUrl ?? null }, ...persona.looks];
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function Photo({ src, size = 28 }: { src: string | null; size?: number }) {
  return src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} /> : <UserRound size={size} aria-hidden="true" />;
}

/**
 * The Look step, "Who appears in the video?": presenter or no face first; with a presenter, the workspace's personas
 * (with their looks) and stock presenters, and Create avatar. Choosing No face folds the people away.
 */
export function LookFaces({ personas, avatars, face, lastFace, createHref, onPick }: {
  personas: Persona[] | null;
  avatars: Avatar[];
  face: Face | null;
  lastFace: Face | null;
  /** Where a new persona is made; it opens in a new tab and this step picks the persona up when it is ready. */
  createHref: string;
  onPick: (face: Face) => void;
}) {
  const lookId = face?.kind === "persona" ? face.lookId : null;
  const isLast = (candidate: Face) =>
    Boolean(lastFace) && (JSON.stringify(lastFace) === JSON.stringify(candidate) || (lastFace?.kind === "persona" && candidate.kind === "persona" && lastFace.personaId === candidate.personaId));

  const people: Person[] = [
    ...(personas ?? []).map((persona): Person => {
      const ready = persona.status === "ready";
      const selected = face?.kind === "persona" && face.personaId === persona.id;
      const base = !ready ? (persona.status === "needs_consent" ? "Needs a face scan" : "Consent withdrawn") : persona.looks.length ? plural(persona.looks.length, "look") : "Persona";
      return {
        key: persona.id,
        name: persona.name,
        photo: personaPhoto(persona, selected ? lookId : null),
        detail: ready && isLast({ kind: "persona", personaId: persona.id, lookId: null }) ? `${base} · Last used` : base,
        ready,
        selected,
        persona,
        pick: () => onPick({ kind: "persona", personaId: persona.id, lookId: selected ? lookId : lastFace?.kind === "persona" && lastFace.personaId === persona.id ? lastFace.lookId : null }),
      };
    }),
    ...avatars.map((avatar): Person => {
      const own: Face = { kind: "avatar", avatarId: avatar.id };
      return { key: avatar.id, name: avatar.name, photo: avatar.previewUrl, detail: isLast(own) ? "Stock presenter · Last used" : "Stock presenter", ready: true, selected: face?.kind === "avatar" && face.avatarId === avatar.id, persona: null, pick: () => onPick(own) };
    }),
  ];
  const ready = people.filter((person) => person.ready);
  const chosen = people.find((person) => person.selected) ?? null;
  const loading = personas === null;
  const noneDetail = isLast({ kind: "none" }) ? "Captions and graphics only · Last used" : "Captions and graphics only";

  const [path, setPath] = useState<"presenter" | "none">(face?.kind === "none" ? "none" : "presenter");
  // The flow sets a default face once personas load; follow it.
  useEffect(() => { if (face) setPath(face.kind === "none" ? "none" : "presenter"); }, [face?.kind]);
  const choosePresenter = () => {
    setPath("presenter");
    if (!chosen) ready[0]?.pick();
  };

  // A persona made in the other tab is chosen as soon as it is ready, so coming back lands on it.
  const before = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!before.current || !personas) return;
    const fresh = personas.find((persona) => persona.status === "ready" && !before.current!.has(persona.id));
    if (fresh) {
      before.current = null;
      setPath("presenter");
      onPick({ kind: "persona", personaId: fresh.id, lookId: null });
    }
  }, [personas, onPick]);

  const faces = ready.map((person) => person.photo).filter((photo): photo is string => Boolean(photo)).slice(0, 3);
  return (
    <div className="lk">
      <h1 id="np-title">Who appears in the video?</h1>
      <p className="np-lead">Choose a presenter, or let captions and graphics carry the video.</p>
      <div className="lk-paths" role="radiogroup" aria-label="Presenter or no face">
        <button type="button" role="radio" aria-checked={path === "presenter"} className="lk-path" data-autofocus={path === "presenter" ? "" : undefined} onClick={choosePresenter}>
          <span className="lk-path-art">
            <FogArt name="presenter" />
            {faces.length > 0 ? (
              <span className="lk-faces" aria-hidden="true">{faces.map((photo) => <img key={photo} src={photo} alt="" draggable={false} />)}</span>
            ) : (
              <img className="lk-fog lk-path-ghost" src={FOG.create} alt="" />
            )}
          </span>
          <span className="lk-path-copy">
            <strong>A presenter</strong>
            <span>{ready.length ? `One of your ${plural(ready.length, "avatar")} speaks to camera.` : "Someone speaks to camera. Create your first avatar."}</span>
          </span>
          <span className="lk-check" aria-hidden="true"><Check size={13} strokeWidth={2.75} /></span>
        </button>
        <button type="button" role="radio" aria-checked={path === "none"} className="lk-path" data-autofocus={path === "none" ? "" : undefined} onClick={() => { setPath("none"); onPick({ kind: "none" }); }}>
          <span className="lk-path-art"><FogArt name="noface" /></span>
          <span className="lk-path-copy">
            <strong>No face</strong>
            <span>{noneDetail}</span>
          </span>
          <span className="lk-check" aria-hidden="true"><Check size={13} strokeWidth={2.75} /></span>
        </button>
      </div>

      {path === "presenter" && (
        <section className="lk-people-section" aria-label="Avatars">
          <h2 className="np-group">Your avatars</h2>
          <div className="lk-people">
            <div className="lk-contents" role="radiogroup" aria-label="Avatar">
              {loading && <span className="lk-tile is-loading" aria-hidden="true"><span className="lk-tile-art" /></span>}
              {people.map((person) => (
                <Tile key={person.key} art={<Photo src={person.photo} />} title={person.name} detail={person.detail} checked={person.selected} disabled={!person.ready} onSelect={person.pick} />
              ))}
            </div>
            <a className="lk-tile lk-tile-create" href={createHref} target="_blank" rel="noopener" onClick={() => { before.current = new Set((personas ?? []).map((persona) => persona.id)); }}>
              <span className="lk-tile-art">
                <FogArt name="create" />
                <span className="lk-plus" aria-hidden="true"><Plus size={20} /></span>
              </span>
              <span className="lk-tile-copy">
                <strong>Create avatar</strong>
                <span>Scan a face <ArrowUpRight size={12} aria-hidden="true" /></span>
              </span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
          {!loading && !ready.length && <p className="lk-note">No avatars yet. Create one, or choose No face to go on without a presenter.</p>}
          {chosen?.persona && chosen.persona.looks.length > 0 && <LookStrip persona={chosen.persona} lookId={lookId} onPick={onPick} />}
        </section>
      )}
    </div>
  );
}

/** One avatar: a 4:5 portrait in the fog with its name under it. */
function Tile({ art, title, detail, checked, disabled, onSelect }: { art: ReactNode; title: string; detail: string; checked: boolean; disabled?: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} disabled={disabled} className="lk-tile" onClick={onSelect}>
      <span className="lk-tile-art">
        {art}
        <span className="lk-tick" aria-hidden="true"><Check size={13} strokeWidth={2.75} /></span>
      </span>
      <span className="lk-tile-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
    </button>
  );
}

/** The chosen persona's looks: its scan photo first, then each look. */
function LookStrip({ persona, lookId, onPick }: { persona: Persona; lookId: string | null; onPick: (face: Face) => void }) {
  return (
    <section className="lk-looks" aria-label={`Looks for ${persona.name}`}>
      <h2 className="np-group">{persona.name}’s looks</h2>
      <div className="lk-strip" role="radiogroup" aria-label={`Look for ${persona.name}`}>
        {looksOf(persona).map((look) => (
          <button key={look.id ?? "scan"} type="button" role="radio" aria-checked={lookId === look.id} className="lk-look" onClick={() => onPick({ kind: "persona", personaId: persona.id, lookId: look.id })}>
            <span className="lk-look-art"><Photo src={look.imageUrl} size={20} /></span>
            <span>{look.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
