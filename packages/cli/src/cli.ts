import { open } from "node:fs/promises";
import { z } from "zod";
import { startCampaignInputSchema } from "../../contracts/src/index";
import { documentIndexSchema, documentSchema, permissionsSchema, statusSchema } from "../../public-api/src/index";
import { publicOrigin } from "../../public-api/src/documents";

export const limits = { timeoutMs: 10_000, responseBytes: 256 * 1024, planBytes: 64 * 1024 } as const;
type Dependencies = {
  fetch?: typeof fetch;
  readPlan?: (path: string) => Promise<Uint8Array>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  timeoutMs?: number;
};
class CliError extends Error {
  constructor(readonly code: string, message: string, readonly resolution: string) { super(message); }
}
const help = {
  tool: "Castroom repository CLI", version: "1.0.0", distribution: "private_repository_checkout",
  commands: ["status", "scopes", "docs [slug]", "validate-plan <file.json>"],
  options: ["--origin <https://public-origin>"], limits,
  note: "Read public guidance or validate a bounded draft locally. No authentication, campaign writes, rendering or publishing.",
};
export function parseOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError("invalid_origin", "The public origin is not a valid URL.", "Use an HTTPS origin without credentials, path, query or fragment."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CliError("invalid_origin", "The public origin must use HTTPS and contain no credentials, path, query or fragment.", "Use --origin https://your-public-deployment.example.");
  }
  return url.origin;
}
async function readPlanFile(path: string): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limits.planBytes) throw new CliError("plan_too_large", "Plan input must be a regular JSON file of at most 64 KiB.", "Reduce the plan to at most three items and remove unrelated data.");
    const buffer = new Uint8Array(limits.planBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limits.planBytes) throw new CliError("plan_too_large", "Plan input exceeds 64 KiB.", "Reduce the input file size.");
    return buffer.slice(0, bytesRead);
  } finally { await file.close(); }
}
async function readBoundedBody(response: Response) {
  const length = response.headers.get("Content-Length");
  if (length && Number(length) > limits.responseBytes) {
    await response.body?.cancel();
    throw new CliError("response_too_large", "Public response exceeds 256 KiB.", "Use the official public API origin.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CliError("invalid_response", "The public endpoint returned no content.", "Check /docs/api/ and retry a supported read operation.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limits.responseBytes) {
        await reader.cancel();
        throw new CliError("response_too_large", "Public response exceeds 256 KiB.", "Use the official public API origin.");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function publicRead(path: string, origin: string, schema: z.ZodType, dependencies: Dependencies) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? limits.timeoutMs);
  try {
    const response = await (dependencies.fetch ?? fetch)(`${origin}${path}`, {
      method: "GET", headers: { Accept: "application/json", "X-API-Version": "1" }, credentials: "omit", redirect: "manual", signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) throw new CliError("redirect_refused", "The public endpoint returned a redirect.", "Set --origin to the final verified HTTPS origin. Redirects are never followed.");
    if (!response.ok) throw new CliError(`http_${response.status}`, `The public endpoint returned HTTP ${response.status}.`, response.status === 404 ? "Use docs without a slug to list available documents." : "Check the public deployment status and retry later.");
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) throw new CliError("invalid_response", "The public endpoint did not return JSON.", "Use the documented Castroom public API origin.");
    let parsed: unknown;
    try { parsed = JSON.parse(await readBoundedBody(response)); }
    catch (error) { if (error instanceof CliError) throw error; if (controller.signal.aborted) throw new CliError("request_timeout", "The public read exceeded its time limit.", "Check connectivity and retry the read operation."); throw new CliError("invalid_response", "The public endpoint returned invalid JSON.", "Use the official public API origin and retry later."); }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new CliError("invalid_response", "The public response does not match the documented schema.", "Check whether the CLI and deployment use the same contract version.");
    return result.data;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (controller.signal.aborted) throw new CliError("request_timeout", "The public read exceeded its time limit.", "Check connectivity and retry the read operation.");
    throw new CliError("network_error", "The public endpoint could not be reached.", "Check connectivity and the HTTPS public origin. No request is retried automatically.");
  } finally { clearTimeout(timeout); }
}
export async function runCli(args: string[], dependencies: Dependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    const words = [...args]; let origin = publicOrigin;
    const originIndex = words.indexOf("--origin");
    if (originIndex >= 0) {
      if (!words[originIndex + 1] || words[originIndex + 1].startsWith("--")) throw new CliError("invalid_arguments", "--origin requires an HTTPS origin.", "Run with --help for supported commands.");
      origin = parseOrigin(words[originIndex + 1]); words.splice(originIndex, 2);
    }
    if (words.length === 0 || (words.length === 1 && ["--help", "help"].includes(words[0]))) { stdout(`${JSON.stringify(help)}\n`); return 0; }
    const [command, argument, ...extra] = words;
    if (extra.length || words.some((word) => word.startsWith("--"))) throw new CliError("invalid_arguments", "Unrecognized arguments.", "Run with --help for supported commands.");
    let result: unknown;
    if (command === "validate-plan") {
      if (!argument) throw new CliError("invalid_arguments", "validate-plan requires a JSON file.", "Use validate-plan packages/cli/examples/three-video-plan.json.");
      let bytes: Uint8Array;
      try { bytes = await (dependencies.readPlan ?? readPlanFile)(argument); }
      catch (error) { if (error instanceof CliError) throw error; throw new CliError("plan_unreadable", "The plan file could not be read.", "Provide a readable local JSON file of at most 64 KiB."); }
      if (bytes.byteLength > limits.planBytes) throw new CliError("plan_too_large", "Plan input exceeds 64 KiB.", "Reduce the plan to at most three items and remove unrelated data.");
      let input: unknown;
      try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new CliError("invalid_json", "The plan file is not valid UTF-8 JSON.", "Correct its JSON syntax and retry. No plan content was sent to a server."); }
      const parsed = startCampaignInputSchema.safeParse(input);
      if (!parsed.success) {
        stderr(`${JSON.stringify({ error: { code: "invalid_plan", message: "The local plan does not match the shared campaign draft contract.", resolution: "Use 1–3 items with a title and script, company context, and a UUID operationKey. Remove unsupported fields.", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) } })}\n`);
        return 1;
      }
      result = { valid: true, operationKey: parsed.data.operationKey, itemCount: parsed.data.items.length, scriptCharacters: parsed.data.items.map((item) => item.script.length), persisted: false, rendered: false, publishingAuthorized: false };
    } else if (command === "status" && !argument) result = await publicRead("/api/public/status", origin, statusSchema, dependencies);
    else if (command === "scopes" && !argument) result = await publicRead("/api/public/permissions", origin, permissionsSchema, dependencies);
    else if (command === "docs") {
      if (argument && !/^[a-z][a-z-]{0,39}$/.test(argument)) throw new CliError("invalid_arguments", "Document slugs must contain lowercase letters and hyphens.", "Run docs without a slug to list available documents.");
      result = await publicRead(argument ? `/api/public/docs/${argument}` : "/api/public/docs", origin, argument ? documentSchema : documentIndexSchema, dependencies);
    } else throw new CliError("invalid_arguments", "Unknown command or unexpected argument.", "Run with --help for supported commands.");
    stdout(`${JSON.stringify(result)}\n`); return 0;
  } catch (error) {
    const problem = error instanceof CliError ? error : new CliError("cli_error", "The command could not be completed.", "Check the command and retry. No production action is available in this CLI.");
    stderr(`${JSON.stringify({ error: { code: problem.code, message: problem.message, resolution: problem.resolution } })}\n`); return 1;
  }
}
