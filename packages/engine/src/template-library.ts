import { libraryTemplateSchema, type LibraryTemplate } from "../../contracts/src/index.js";
import type { EngineDeps } from "./access.js";
import { parse } from "./studio.js";

/**
 * The template library: first-party short-form video templates, one row each in `public.templates`
 * (supabase/migrations/20261115100000_templates.sql). Rows and sample media are published from the
 * content-creator repository (templates/_kit/publish.mjs); media sits in the private media bucket under
 * templates/<id>/ and is handed out here as short-lived signed URLs. Reading the library changes nothing.
 */
interface TemplateRow {
  id: string;
  version: number;
  family: "face" | "no_face";
  name: string;
  summary: string;
  use_for: string;
  language: string;
  languages: string[];
  aspect_ratio: "9:16";
  fps: number;
  duration_min: number;
  duration_max: number;
  sample_topic: string;
  sample_seconds: number | string;
  voice: string;
  fonts: string[];
  inputs: Array<{ key: string; label: string }>;
  script: Array<{ id: string; text: string }>;
  video_path: string;
  poster_path: string;
  stills: Array<{ beat: string; path: string }>;
  variants: Array<{ language: string; path: string }>;
}

export async function listLibraryTemplates(deps: EngineDeps): Promise<LibraryTemplate[]> {
  const rows = await deps.store.select<TemplateRow>("templates", { published: true }, { order: ["position", "asc"] });
  if (!rows.length) return [];
  const ttl = deps.config.mediaUrlTtlSeconds;
  const paths = rows.flatMap((row) => [row.video_path, row.poster_path, ...row.stills.map((s) => s.path), ...row.variants.map((v) => v.path)]);
  const urls = await deps.store.media.signedUrls([...new Set(paths)], ttl);
  // Signed URLs from a cached signer can be older than this read; half the lifetime is the safe promise.
  const expiresAt = new Date(deps.now().getTime() + (ttl * 1000) / 2).toISOString();
  return rows.map((row) =>
    parse(libraryTemplateSchema, {
      id: row.id,
      version: row.version,
      family: row.family,
      name: row.name,
      summary: row.summary,
      useFor: row.use_for,
      language: row.language,
      languages: row.languages,
      aspectRatio: row.aspect_ratio,
      fps: row.fps,
      durationRange: [row.duration_min, row.duration_max],
      sampleTopic: row.sample_topic,
      sampleSeconds: Number(row.sample_seconds),
      voice: row.voice,
      fonts: row.fonts,
      inputs: row.inputs,
      script: row.script,
      videoUrl: urls[row.video_path] ?? null,
      posterUrl: urls[row.poster_path] ?? null,
      stills: row.stills.map((s) => ({ beat: s.beat, url: urls[s.path] ?? null })),
      variants: row.variants.map((v) => ({ language: v.language, url: urls[v.path] ?? null })),
      expiresAt,
    }),
  );
}
