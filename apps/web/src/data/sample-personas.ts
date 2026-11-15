import type { Persona } from "@castroom/contracts";

/**
 * Fictional presenters for the local preview, so the New project Look step can be seen with real-looking faces.
 * The pictures are generated (public/art/fog/sample, see NOTE.txt there); the people do not exist and gave no
 * consent, so these exist only in the fixture and only when the page is opened with `?faces=sample`.
 */
export function samplePersonas(): Persona[] {
  if (typeof location === "undefined" || !new URLSearchParams(location.search).has("faces")) return [];
  const at = "2026-11-15T09:00:00.000Z";
  const photo = (name: string) => new URL(`/art/fog/sample/${name}.webp`, location.origin).href;
  const consent = (id: string, subjectName: string, still: string) => ({ id, subjectName, language: "en" as const, createdAt: at, revokedAt: null, photoUrl: photo(still), canWithdraw: false });
  const look = (id: string, personaId: string, name: string, description: string, position: number) => ({ id, personaId, name, description, hasImage: true, imageUrl: photo(id.replace("sample-look-", "")), position, createdAt: at, updatedAt: at });
  return [
    {
      id: "sample-maya",
      name: "Maya",
      description: "Friendly, clear explainer.",
      language: "en",
      status: "ready",
      consent: consent("sample-consent-maya", "Maya Laskari", "maya-scan"),
      looks: [look("sample-look-maya-studio", "sample-maya", "Studio", "Camel blazer, white top.", 0), look("sample-look-maya-weekend", "sample-maya", "Weekend", "Knit sweater, outdoors.", 1)],
      createdAt: at,
      updatedAt: at,
    },
    {
      id: "sample-nikos",
      name: "Nikos",
      description: "Calm, reassuring expert.",
      language: "el",
      status: "ready",
      consent: consent("sample-consent-nikos", "Nikos Pappas", "nikos-scan"),
      looks: [look("sample-look-nikos-clinic", "sample-nikos", "Clinic", "White coat, light blue shirt.", 0)],
      createdAt: at,
      updatedAt: at,
    },
    { id: "sample-elena", name: "Elena", description: "", language: "el", status: "needs_consent", consent: null, looks: [], createdAt: at, updatedAt: at },
  ];
}
