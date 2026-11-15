// pnpm routine <command> "<brief>": starts the Claude Code routine with a preset command.
// Reads CLAUDE_ROUTINE_URL (the Fire URL, or its trig_ id) and CLAUDE_ROUTINE_TOKEN from .env.local.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFireText, CommandError, COMMANDS, findCommand, routinePrompt } from "./commands";
import { fireRoutine, normalizeFireUrl, RoutineError } from "./fire";

type Dependencies = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

const usage = () => `Start the Claude Code routine with a preset command.

  pnpm routine <command> "<brief>"     start a run, print its session link
  pnpm routine preview <command> "<brief>"   show the text a run would get, without starting it
  pnpm routine list                    the commands
  pnpm routine prompt                  the routine's saved prompt, to paste at claude.ai/code/routines

Commands:
${COMMANDS.map((command) => `  ${command.id.padEnd(12)} ${command.summary}\n  ${"".padEnd(12)} e.g. pnpm routine ${command.id} "${command.example}"`).join("\n")}

Add --json for machine-readable output. Needs CLAUDE_ROUTINE_URL and CLAUDE_ROUTINE_TOKEN in .env.local.
`;

/** Returns the exit code: 0 done, 1 failed, 2 wrong usage. */
export async function runRoutineCli(argv: string[], dependencies: Dependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env;
  const out = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const err = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const [first, ...rest] = args;

  if (!first || first === "help" || first === "--help" || first === "-h") { out(usage()); return first ? 0 : 2; }
  if (first === "list") {
    out(json ? `${JSON.stringify(COMMANDS.map(({ id, title, summary, brief, example }) => ({ id, title, summary, brief, example })), null, 2)}\n` : `${COMMANDS.map((command) => `${command.id}: ${command.summary}\n  brief: ${command.brief}`).join("\n")}\n`);
    return 0;
  }
  if (first === "prompt") { out(routinePrompt()); return 0; }

  const preview = first === "preview";
  const [commandId, ...briefWords] = preview ? rest : args;
  if (!commandId || !findCommand(commandId)) {
    err(`${commandId ? `There is no "${commandId}" command.` : "Name a command."}\n\n${usage()}`);
    return 2;
  }
  let text: string;
  try { text = buildFireText(commandId, briefWords.join(" ")); }
  catch (error) { err(`${(error as CommandError).message}\n`); return 2; }
  if (preview) { out(`${text}\n`); return 0; }

  const fireUrl = env.CLAUDE_ROUTINE_URL?.trim() ?? "";
  const token = env.CLAUDE_ROUTINE_TOKEN?.trim() ?? "";
  if (!fireUrl || !token) {
    err(`Set ${[!fireUrl && "CLAUDE_ROUTINE_URL (the routine's Fire URL)", !token && "CLAUDE_ROUTINE_TOKEN"].filter(Boolean).join(" and ")} in .env.local. Both come from the routine's API trigger at claude.ai/code/routines.\n`);
    return 1;
  }
  try {
    normalizeFireUrl(fireUrl);
    const started = await fireRoutine({ fireUrl, token, text, fetch: dependencies.fetch });
    out(json ? `${JSON.stringify({ command: commandId, ...started })}\n` : `Started ${commandId}. Watch it here:\n${started.sessionUrl}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RoutineError) { err(json ? `${JSON.stringify({ error: { code: error.code, status: error.status, message: error.message } })}\n` : `${error.message}\n`); return 1; }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRoutineCli(process.argv.slice(2));
}
