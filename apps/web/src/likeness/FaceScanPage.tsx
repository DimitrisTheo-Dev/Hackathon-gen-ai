import { useMemo } from "react";
import type { Session } from "@supabase/supabase-js";
import LikenessCapture from "./LikenessCapture";
import { nameOf, sessionLikenessApi } from "./session";

/**
 * `/face-scan`: the likeness capture on its own page, outside the studio shell, for a person recording on
 * their own device from a link. In the studio the same capture runs inside the Personas tab.
 * `/face-scan?persona=<id>` records the consent for that persona (the Personas tab hands out this link).
 */
export default function FaceScanPage({ session }: { session: Session }) {
  const api = useMemo(() => sessionLikenessApi(), []);
  const personaId = useMemo(() => new URLSearchParams(location.search).get("persona")?.trim().slice(0, 160) || undefined, []);
  const back = personaId ? `/studio/?view=personas&persona=${encodeURIComponent(personaId)}` : "/studio/";
  return <LikenessCapture open api={api} defaultName={nameOf(session.user)} personaId={personaId} onClose={() => location.assign(back)} doneAction={{ label: personaId ? "Back to the persona" : "Back to the studio", href: back }} />;
}
