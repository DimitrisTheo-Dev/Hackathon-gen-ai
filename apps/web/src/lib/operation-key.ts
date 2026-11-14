/** Keep retry identity across UI remounts/reloads; no content or credentials are stored. */
export async function operationKey(
  workspaceId: string,
  action: string,
  payload: unknown,
): Promise<string> {
  const canonical = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
            .join(",")}}`
        : (JSON.stringify(value) ?? "null");
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical({ workspaceId, action, payload })),
  );
  const hash = Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const storageKey = `castroom-operation-${hash}`;
  const existing = sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const key = crypto.randomUUID();
  // Fail before submission if retry identity cannot be saved.
  sessionStorage.setItem(storageKey, key);
  return key;
}
