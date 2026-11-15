/**
 * Faceful reel renders on Cloudflare Containers.
 *
 * Every minute (cron) this Worker asks the engine for waiting render jobs, exactly as a render worker on a server does
 * (POST /v1/worker/reel/claim with REEL_WORKER_TOKEN), and starts one container per claimed job. The container runs the
 * same worker as everywhere else (../src/worker.ts, in SERVE_PORT mode): it renders the timeline, makes a voiceover when
 * the job has none, uploads the MP4 and exits, so a container only runs (and is billed) while it renders. A container
 * that dies, or does not start, loses the job's lease and the engine hands the job out again.
 *
 * GET /health says whether rendering is on and which speech services the containers get. Nothing else is served.
 */
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  RENDERER: DurableObjectNamespace<ReelRenderer>;
  FACEFUL_API_URL: string;
  RENDERING?: string;
  REEL_WORKER_TOKEN?: string;
  SUPABASE_URL?: string;
  FACEFUL_R2_ACCOUNT_ID?: string;
  MEDIA_HOST_ALLOWLIST?: string;
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
  AZURE_SPEECH_ENDPOINT?: string;
  AZURE_TTS_VOICE?: string;
  AZURE_TTS_VOICE_EL?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  CARTESIA_API_KEY?: string;
  CARTESIA_VOICE_ID?: string;
}

const PORT = 8080;
/** Jobs claimed per minute at most; the engine allows three waiting or running renders per workspace. */
const PER_TICK = 4;
/** What the container gets from this Worker's settings. */
const PASSED = ["SUPABASE_URL", "FACEFUL_R2_ACCOUNT_ID", "MEDIA_HOST_ALLOWLIST", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "AZURE_SPEECH_ENDPOINT", "AZURE_TTS_VOICE", "AZURE_TTS_VOICE_EL", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID"] as const;

export class ReelRenderer extends Container<Env> {
  defaultPort = PORT;
  // A render's run timeout is 20 minutes; the container exits as soon as its job is done.
  sleepAfter = "30m";
  enableInternet = true;
  entrypoint = ["node", "workers/reel-render/src/worker.ts"];

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const passed = Object.fromEntries(PASSED.flatMap((name) => (env[name] ? [[name, env[name]!]] : [])));
    this.envVars = { ...passed, FACEFUL_API_URL: env.FACEFUL_API_URL, REEL_WORKER_TOKEN: env.REEL_WORKER_TOKEN ?? "", SERVE_PORT: String(PORT), RENDER_CONCURRENCY: "4" };
  }
}

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...fields }));

async function claim(env: Env, workerId: string): Promise<{ id: string } | null> {
  const response = await fetch(`${env.FACEFUL_API_URL.replace(/\/+$/, "")}/v1/worker/reel/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.REEL_WORKER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ workerId }),
  });
  if (!response.ok) throw new Error(`claim answered ${response.status}`);
  return ((await response.json()) as { job: { id: string } | null }).job;
}

/** Claims what is waiting and starts a container for each job. */
async function dispatch(env: Env) {
  if (env.RENDERING === "off" || !env.REEL_WORKER_TOKEN) return;
  for (let count = 0; count < PER_TICK; count++) {
    const workerId = `cloudflare-${crypto.randomUUID().slice(0, 13)}`;
    let job: { id: string } | null;
    try {
      job = await claim(env, workerId);
    } catch (error) {
      log("claim_failed", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!job) return;
    log("dispatching", { job: job.id, workerId });
    try {
      const answer = await getContainer(env.RENDERER, job.id).fetch(new Request("http://container/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workerId, job }) }));
      if (answer.status !== 202) throw new Error(`the render container answered ${answer.status}`);
    } catch (error) {
      // The job is left to its lease: when it runs out, the engine hands the job to the next worker (here or elsewhere),
      // and fails it with a reason after three tries.
      log("dispatch_failed", { job: job.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatch(env));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/health") return new Response("Not found", { status: 404 });
    const voices = [env.AZURE_SPEECH_KEY && (env.AZURE_SPEECH_REGION || env.AZURE_SPEECH_ENDPOINT) ? "azure" : null, env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID ? "elevenlabs" : null, env.CARTESIA_API_KEY && env.CARTESIA_VOICE_ID ? "cartesia" : null].filter(Boolean);
    return Response.json({ rendering: env.RENDERING !== "off" && Boolean(env.REEL_WORKER_TOKEN), engine: env.FACEFUL_API_URL, voices });
  },
};
