/**
 * Prepare a demo workspace on the configured Supabase project, through the same engine operations the
 * studio uses (tenant-scoped, idempotent, audited). Nothing is rendered, scheduled or published.
 *
 *   node --env-file=.env.local --import tsx scripts/demo-seed.ts --email someone@example.com
 *   node --env-file=.env.local --import tsx scripts/demo-seed.ts --email someone@example.com --reset
 *   node --env-file=.env.local --import tsx scripts/demo-seed.ts --demo-account      # DEMO_USER_EMAIL / DEMO_USER_PASSWORD
 *   … --workspace-name "Quintessential"   # optional: rename that personal workspace
 *
 * What it seeds in that person's personal workspace:
 *   • the brand kit (BeWell: colour, voice, guardrails),
 *   • the labelled BeWell sample project with its source,
 *   • draft posting times for next Monday, Wednesday and Friday at 09:00 Europe/Athens (drafts, never scheduled).
 *
 * `--reset` first deletes every project in that workspace (items, versions, jobs and media rows cascade) and the
 * workspace's agent tokens. It touches only the named person's personal workspace and asks for no confirmation,
 * so pass it deliberately. `--demo-account` creates (or reuses) a password-only account for automated recordings.
 */
import { createClient } from "@supabase/supabase-js";
import { Temporal } from "@js-temporal/polyfill";
import { resolveContext } from "../packages/engine/src/access";
import { getRuntime } from "../packages/engine/src/runtime";
import { listCampaigns, reviseContent, updateBrand } from "../packages/engine/src/studio";
import { createSampleProject } from "../packages/engine/src/templates";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const env = process.env;
const deps = getRuntime();
const admin = createClient(env.SUPABASE_URL!, env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

async function findUser(email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const user = data.users.find((entry) => entry.email?.toLowerCase() === email.toLowerCase());
    if (user) return user;
    if (data.users.length < 200) return null;
  }
  return null;
}

let email = value("email");
if (flag("demo-account")) {
  email = env.DEMO_USER_EMAIL;
  const password = env.DEMO_USER_PASSWORD;
  if (!email || !password) throw new Error("Set DEMO_USER_EMAIL and DEMO_USER_PASSWORD in .env.local");
  const existing = await findUser(email);
  if (!existing) {
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { purpose: "faceful demo recordings" } });
    if (error) throw error;
    console.log(`Created demo account ${email}`);
  } else await admin.auth.admin.updateUserById(existing.id, { password });
}
if (!email) throw new Error("Pass --email <address> or --demo-account");
const user = await findUser(email);
if (!user) throw new Error(`No account exists for ${email}. Sign in once in the studio first.`);

const ctx = await resolveContext(deps, { kind: "human", userId: user.id, email: user.email ?? email }, null, `demo-seed-${crypto.randomUUID()}`);
if (ctx.org.personal_owner_id !== user.id) throw new Error("Refusing to seed: resolved workspace is not this person's personal workspace.");
const workspaceName = value("workspace-name");
if (workspaceName) {
  // Personal workspaces are named from the email address; a demo reads better with a real name.
  await deps.store.update("organizations", { id: ctx.org.id, personal_owner_id: user.id }, { name: workspaceName.slice(0, 120) });
  ctx.org.name = workspaceName.slice(0, 120);
}
console.log(`Workspace: ${ctx.org.name} (${ctx.org.id})`);

if (flag("reset")) {
  const projects = await deps.store.select("projects", { org_id: ctx.org.id });
  for (const project of projects) {
    await deps.store.remove("castroom_director_access", { campaign_id: project.id }).catch(() => undefined);
    await deps.store.remove("projects", { id: project.id, org_id: ctx.org.id });
  }
  const tokens = await deps.store.update("agent_connections", { org_id: ctx.org.id, revoked_at: null }, { revoked_at: new Date().toISOString() });
  console.log(`Reset: removed ${projects.length} project(s), revoked ${tokens.length} agent token(s).`);
}

await updateBrand(deps, ctx, {
  name: "BeWell",
  description: "Festival companion app: plan your day, save sessions, find your next moment. Independent demo; not an endorsement.",
  tone: "Clear, warm, calm",
  audience: "Festival visitors",
  color: "#5F6C66",
  rules: [
    "Use factual statements supported by the source.",
    "Avoid medical or wellbeing guarantees.",
    "Do not imply a client endorsement or partnership.",
    "Keep the tone clear, inviting and calm.",
  ],
  operationKey: crypto.randomUUID(),
});
console.log("Brand kit saved.");

let sample = (await listCampaigns(deps, ctx)).find((campaign) => campaign.origin === "sample");
if (!sample) {
  sample = await createSampleProject(deps, ctx, { operationKey: crypto.randomUUID() });
  console.log(`Sample project created: ${sample.title}`);
} else console.log(`Sample project already present: ${sample.title}`);

// Draft posting times: next Monday, Wednesday, Friday at 09:00 in the workspace timezone (requests, not schedules).
const zone = ctx.org.timezone as string;
const today = Temporal.Now.plainDateISO(zone);
const monday = today.add({ days: ((8 - today.dayOfWeek) % 7) || 7 });
const days = [monday, monday.add({ days: 2 }), monday.add({ days: 4 })];
for (const [index, item] of sample.items.slice(0, 3).entries()) {
  if (item.targets.length) continue;
  const at = days[index].toPlainDateTime({ hour: 9 }).toZonedDateTime(zone).toInstant().toString({ smallestUnit: "millisecond" });
  await reviseContent(deps, ctx, {
    contentId: item.id,
    expectedRevision: item.revision,
    operationKey: crypto.randomUUID(),
    patch: { targets: ["instagram", "tiktok", "youtube"].map((platform) => ({ platform, accountId: null, scheduledAt: at, timezone: zone })) },
  }, "Proposed a posting time");
}
console.log(`Draft posting times set for ${days.map((day) => day.toString()).join(", ")} at 09:00 ${zone}.`);
console.log(`Done. Open https://faceful.vercel.app/studio/?view=canvas&campaign=${sample.id}`);
