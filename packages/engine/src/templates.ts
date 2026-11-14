import { templateInputSchema, templateSchema, type Campaign, type Template } from "../../contracts/src/index.js";
import { idempotent, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import { createProject, parse } from "./studio.js";

/**
 * Small curated set with stable IDs and versions. Each template fills real, editable drafts from the
 * supplied inputs — no model is involved, and nothing is rendered. Marketplace features are deferred.
 */
interface TemplateDefinition extends Omit<Template, "preview" | "languages" | "itemCount"> {
  items: Record<string, Array<{ title: string; script: string; caption: string }>>;
}
const brand = { key: "brand", label: "Brand or product", placeholder: "BeWell", required: true, maxLength: 80 };

const definitions: TemplateDefinition[] = [
  {
    id: "product-intro-15",
    version: 1,
    name: "15-second introduction",
    description: "One presenter-led reel that says what you offer and what to do next.",
    aspectRatio: "9:16",
    durationSeconds: 15,
    channels: ["instagram", "tiktok", "youtube"],
    visibility: "curated",
    inputs: [
      brand,
      { key: "benefit", label: "What it helps people do", placeholder: "plan your festival day in one place", required: true, maxLength: 160 },
      { key: "cta", label: "Call to action", placeholder: "Download the app today", required: false, maxLength: 80 },
    ],
    items: {
      en: [{ title: "Meet {brand}", script: "Hi! Meet {brand}. It helps you {benefit}. {cta}", caption: "Meet {brand}." }],
      el: [{ title: "Γνώρισε το {brand}", script: "Γεια σου! Αυτό είναι το {brand}. Σε βοηθά να {benefit}. {cta}", caption: "Γνώρισε το {brand}." }],
    },
  },
  {
    id: "three-angle-week",
    version: 1,
    name: "A week in three angles",
    description: "Three short videos — the problem, how it works, and why people trust it — ready to schedule across a week.",
    aspectRatio: "9:16",
    durationSeconds: 15,
    channels: ["instagram", "tiktok", "youtube"],
    visibility: "curated",
    inputs: [
      brand,
      { key: "problem", label: "The problem you solve", placeholder: "too many sessions, not enough time", required: true, maxLength: 160 },
      { key: "how", label: "How it works, in a sentence", placeholder: "pick your interests and save sessions for your day", required: true, maxLength: 200 },
      { key: "proof", label: "A fact people can check", placeholder: "available on iOS and Android", required: true, maxLength: 200 },
    ],
    items: {
      en: [
        { title: "The problem", script: "Sound familiar? {problem}. {brand} was made for exactly that.", caption: "Sound familiar?" },
        { title: "How it works", script: "Here is how {brand} works: {how}. That is it.", caption: "How {brand} works." },
        { title: "Why trust it", script: "One thing worth knowing about {brand}: {proof}.", caption: "Worth knowing." },
      ],
      el: [
        { title: "Το πρόβλημα", script: "Σου φαίνεται γνώριμο; {problem}. Το {brand} φτιάχτηκε ακριβώς γι’ αυτό.", caption: "Σου φαίνεται γνώριμο;" },
        { title: "Πώς λειτουργεί", script: "Να πώς λειτουργεί το {brand}: {how}. Τόσο απλά.", caption: "Πώς λειτουργεί το {brand}." },
        { title: "Γιατί να το εμπιστευτείς", script: "Κάτι που αξίζει να ξέρεις για το {brand}: {proof}.", caption: "Αξίζει να το ξέρεις." },
      ],
    },
  },
  {
    id: "event-reminder",
    version: 1,
    name: "Event reminder",
    description: "A friendly reminder with the date, the place and one reason to come.",
    aspectRatio: "9:16",
    durationSeconds: 15,
    channels: ["instagram", "tiktok"],
    visibility: "curated",
    inputs: [
      { key: "event", label: "Event name", placeholder: "BeWell Festival", required: true, maxLength: 80 },
      { key: "when", label: "When", placeholder: "this Saturday at 10:00", required: true, maxLength: 80 },
      { key: "where", label: "Where", placeholder: "Technopolis, Athens", required: true, maxLength: 120 },
      { key: "reason", label: "One reason to come", placeholder: "over forty sessions in one day", required: false, maxLength: 160 },
    ],
    items: {
      en: [{ title: "{event} is coming", script: "Quick reminder: {event} is {when}, at {where}. {reason} See you there!", caption: "{event} · {when}" }],
      el: [{ title: "Έρχεται το {event}", script: "Μια γρήγορη υπενθύμιση: το {event} είναι {when}, στο {where}. {reason} Σε περιμένουμε!", caption: "{event} · {when}" }],
    },
  },
];

function fill(text: string, inputs: Record<string, string>) {
  return text
    .replace(/\{(\w+)\}/g, (_match, key: string) => (inputs[key] ?? "").trim())
    .replace(/\s+([.!;,])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function listTemplates(): Template[] {
  return definitions.map(({ items, ...template }) =>
    parse(templateSchema, {
      ...template,
      languages: Object.keys(items),
      itemCount: items.en.length,
      preview: items.en.map((item) => ({ title: item.title, script: item.script })),
    }),
  );
}

export async function createFromTemplate(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Campaign> {
  // Permission first, so a caller who cannot edit never writes an idempotency record.
  requireScope(ctx, "content:edit");
  const input = parse(templateInputSchema, raw);
  const template = definitions.find((entry) => entry.id === input.templateId);
  if (!template) throw new EngineError("not_found", "That template is not available.");
  // Own keys only: a language such as "constructor" must not resolve to an inherited property.
  const items = Object.hasOwn(template.items, input.language) ? template.items[input.language] : undefined;
  if (!items) throw new EngineError("validation_error", `This template is available in: ${Object.keys(template.items).join(", ")}.`);
  const inputs: Record<string, string> = {};
  for (const field of template.inputs) {
    const value = (Object.hasOwn(input.inputs, field.key) ? input.inputs[field.key] : "").trim();
    if (field.required && !value) throw new EngineError("validation_error", `“${field.label}” is needed for this template.`);
    if (value.length > field.maxLength) throw new EngineError("validation_error", `“${field.label}” is too long.`);
    // Template inputs are inserted as plain words; braces cannot introduce new placeholders.
    inputs[field.key] = value.replace(/[{}]/g, "");
  }
  return idempotent(deps, ctx, "create_from_template", input.operationKey, input, async () =>
    createProject(deps, ctx, {
      title: fill(`${inputs.brand ?? inputs.event ?? "New"} · ${template.name}`, inputs).slice(0, 120),
      brief: `Started from the “${template.name}” template (v${template.version}). Every line is editable.`,
      companyContext: null,
      origin: ctx.actorKind === "agent" ? "agent" : "user",
      templateId: template.id,
      items: items.map((item) => ({
        title: fill(item.title, inputs),
        script: fill(item.script, inputs),
        language: input.language,
        captions: Object.fromEntries(template.channels.map((channel) => [channel, fill(item.caption, inputs)])),
      })),
      action: `Created drafts from the “${template.name}” template`,
    }),
  );
}

const BEWELL_SOURCE = {
  title: "BeWell Festival · Quintessential case study",
  url: "https://www.quintessential.gr/work/bewell-festival",
  excerpt: "Published app case study: visitor planning, cross-platform development, brand continuity.",
};

/** One-click seeded scenario. Marked `origin: "sample"` everywhere so it is never mistaken for the user's own or live-generated work. */
export async function createSampleProject(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Campaign> {
  requireScope(ctx, "content:edit");
  const input = parse(templateInputSchema.pick({ operationKey: true }).strict(), raw);
  return idempotent(deps, ctx, "create_sample_project", input.operationKey, input, async () => {
    const now = deps.now().toISOString();
    return createProject(deps, ctx, {
      title: "A week of BeWell (sample)",
      brief: "Seeded sample: three independent demo angles from Quintessential’s published BeWell case study. No endorsement or partnership is implied. Nothing here was rendered or published.",
      companyContext: {
        name: "BeWell",
        description: "Sample brand context drawn from a published app case study. Independent demonstration; not an endorsement.",
        audience: "Festival visitors planning their day",
        tone: "Clear, inviting and calm",
        sourceText: BEWELL_SOURCE.excerpt,
        sourceUrl: BEWELL_SOURCE.url,
        missingInformation: "Confirmed dates, venue and official claims must come from the brand owner.",
      },
      sources: [{ id: crypto.randomUUID(), ...BEWELL_SOURCE, permittedAssetIds: [], retrievedAt: now }],
      origin: "sample",
      items: [
        { title: "Find your next moment", script: "A festival day is full of choices. The BeWell app helped visitors explore activities, choose interests and save sessions for their day.", captions: { instagram: "A day, planned your way. #BeWell", tiktok: "A day, planned your way.", youtube: "A day, planned your way." } },
        { title: "One idea. Two platforms.", script: "Quintessential built the BeWell app with React Native. One shared codebase brought the festival experience to both iOS and Android.", captions: { instagram: "The same experience, both platforms.", tiktok: "The same experience, both platforms.", youtube: "The same experience, both platforms." } },
        { title: "A familiar feeling", script: "The BeWell app extended the festival’s visual identity into a digital companion, keeping the experience energetic and calming.", captions: { instagram: "A brand that feels familiar.", tiktok: "A brand that feels familiar.", youtube: "A brand that feels familiar." } },
      ],
      action: "Added the seeded BeWell sample project",
    });
  });
}
