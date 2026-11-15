/** What Settings shows and says about social accounts, kept apart from the view so it can be tested without a browser. */
import type { SocialAccount, SocialProviderInfo } from "./api";

/** True when the account was connected through one of the providers listed here, so it is removed here too. */
export function managedHere(account: Pick<SocialAccount, "provider">, providers: Array<Pick<SocialProviderInfo, "id">>): boolean {
  return providers.some((provider) => provider.id === account.provider);
}

/** How an account is reached, in the words shown under its name. */
export function accountSource(account: Pick<SocialAccount, "provider" | "platform">, providers: Array<Pick<SocialProviderInfo, "id" | "label">>): string {
  // A provider named after its platform is that platform's own sign-in (Instagram).
  if (account.provider === account.platform) return "connected directly";
  const provider = providers.find((entry) => entry.id === account.provider);
  if (provider) return `through ${provider.label}`;
  // Not one of the providers here: the platform's own connection, made in the Schedule view (YouTube with Google).
  return account.platform === "youtube" ? "connected with Google" : "connected directly";
}

/**
 * Whether the account's activity reaches Faceful. Nobody sets this up: the engine subscribes an account when it
 * connects and asks again until the platform agrees. Null where the connection carries no activity (Buffer posts only).
 */
export function activity(account: Pick<SocialAccount, "provider" | "platform" | "state" | "webhookSubscribedAt">, platform: { nativeWebhook: boolean }): { state: "on" | "connecting"; label: string } | null {
  // An account that needs reconnecting, or that its provider no longer reaches, says so in its own chip instead.
  if (account.state !== "connected") return null;
  // YouTube's hub announces new uploads; Instagram sends comments and messages.
  const what = account.platform === "youtube" ? "New uploads" : "Comments and messages";
  if (account.webhookSubscribedAt) return { state: "on", label: `${what} come in automatically` };
  // Instagram connected directly is subscribed with its own sign-in; any YouTube channel, where the deployment holds the hub.
  if (account.provider === account.platform || (account.platform === "youtube" && platform.nativeWebhook)) return { state: "connecting", label: `${what} are connecting` };
  return null;
}

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
export const cancelledNote = (count: number) => (count ? ` ${plural(count, "unsent post was", "unsent posts were")} cancelled.` : "");
