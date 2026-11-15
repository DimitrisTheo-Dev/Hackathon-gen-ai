import { useMemo } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { createLikenessApi } from "./api";
import LikenessCapture from "./LikenessCapture";

/**
 * `/face-scan`: the likeness capture on its own page, outside the studio shell. It is a separate page
 * rather than a studio view because only this route's response headers allow the camera, the microphone
 * and WebAssembly (see vercel.json); the studio keeps all three switched off.
 */
export default function FaceScanPage({ session }: { session: Session }) {
  const api = useMemo(
    () => createLikenessApi(import.meta.env.VITE_CASTROOM_API_URL || location.origin, async () => (await supabase?.auth.getSession())?.data.session?.access_token ?? null),
    [],
  );
  // Google sign-in supplies a name; an email-code account has none, and the person types it.
  const meta = session.user.user_metadata as { full_name?: unknown; name?: unknown } | undefined;
  const name = typeof meta?.full_name === "string" ? meta.full_name : typeof meta?.name === "string" ? meta.name : "";
  return <LikenessCapture open api={api} defaultName={name} onClose={() => location.assign("/studio/")} doneAction={{ label: "Back to the studio", href: "/studio/" }} />;
}
