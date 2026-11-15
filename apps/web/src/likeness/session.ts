import { supabase } from "../lib/supabase";
import { createLikenessApi, type LikenessApi } from "./api";

/** The likeness routes on the signed-in person's own session: the /face-scan page and the studio's Personas tab. */
export function sessionLikenessApi(): LikenessApi {
  return createLikenessApi(import.meta.env.VITE_CASTROOM_API_URL || location.origin, async () => (await supabase?.auth.getSession())?.data.session?.access_token ?? null);
}

/** Google sign-in supplies a name; an email-code account has none, and the person types it. */
export function nameOf(user: { user_metadata?: unknown } | null | undefined): string {
  const meta = user?.user_metadata as { full_name?: unknown; name?: unknown } | undefined;
  return typeof meta?.full_name === "string" ? meta.full_name : typeof meta?.name === "string" ? meta.name : "";
}

export async function sessionName(): Promise<string> {
  return nameOf((await supabase?.auth.getSession())?.data.session?.user);
}
