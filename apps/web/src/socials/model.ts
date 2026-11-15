/** What Settings shows and says about social accounts, kept apart from the view so it can be tested without a browser. */
import type { SocialAccount, SocialProviderInfo } from "./api";

/** The sub tabs of Settings, in order. A new one is an entry here and a panel in views/Settings.tsx. */
export const SETTINGS_TABS = [
  { value: "accounts", label: "Social accounts" },
  { value: "webhooks", label: "Webhooks" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

/** The sub tab named in the address (`?view=settings&tab=webhooks`); the first one when none or an unknown one is. */
export function settingsTabFrom(search: string): SettingsTab {
  const named = new URLSearchParams(search).get("tab");
  return SETTINGS_TABS.find((entry) => entry.value === named)?.value ?? SETTINGS_TABS[0].value;
}

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

/** What a platform's webhook address accepts right now. */
export function webhookAcceptance(platform: { label: string; nativeWebhook: boolean }, generic: boolean): string {
  if (platform.nativeWebhook) return `Accepts ${platform.label}’s own deliveries${generic ? " and Faceful’s signed format" : ""}.`;
  return generic ? "Accepts Faceful’s signed format only." : "Not accepting deliveries yet.";
}

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
export const cancelledNote = (count: number) => (count ? ` ${plural(count, "unsent post was", "unsent posts were")} cancelled.` : "");
