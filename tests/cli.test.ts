import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runCli, limits, parseOrigin } from "../packages/cli/src/cli";
import { handlePublicRequest } from "../packages/public-api/src/index";
const encoder = new TextEncoder();
async function run(args: string[], overrides: Parameters<typeof runCli>[1] = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(args, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, ...overrides });
  return { code, stdout, stderr, result: stdout ? JSON.parse(stdout) : undefined, error: stderr ? JSON.parse(stderr).error : undefined };
}
const publicFetch: typeof fetch = async (input, options) => handlePublicRequest(new Request(input, options))!;

test("CLI reads real public route schemas with JSON stdout and no credentials", async () => {
  const calls: Request[] = [];
  const fetch: typeof publicFetch = async (input, options) => {
    assert.equal(options?.redirect, "manual"); assert.equal(options?.credentials, "omit");
    const request = new Request(input, options); calls.push(request);
    assert.equal(request.headers.get("Authorization"), null); assert.equal(request.headers.get("Cookie"), null);
    assert.equal(request.method, "GET"); assert.equal(request.headers.get("Accept"), "application/json");
    return handlePublicRequest(request)!;
  };
  for (const args of [["status"], ["scopes"], ["docs"], ["docs", "setup"]]) {
    const value = await run(args, { fetch }); assert.equal(value.code, 0); assert.equal(value.stderr, ""); assert.ok(value.result);
  }
  assert.deepEqual(calls.map((request) => new URL(request.url).pathname), ["/api/public/status", "/api/public/permissions", "/api/public/docs", "/api/public/docs/setup"]);
});

test("CLI supports a validated HTTPS origin without leaking credential-like invalid input", async () => {
  const value = await run(["status", "--origin", "https://preview.example"], { fetch: async (input, options) => { assert.equal(String(input), "https://preview.example/api/public/status"); return publicFetch(input, options); } });
  assert.equal(value.code, 0);
  assert.equal(parseOrigin("https://example.com/"), "https://example.com");
  for (const origin of ["http://example.com", "https://user:private-token@example.com", "https://example.com/path", "https://example.com/?key=private-token", "https://example.com/#private-token", "bad-url"]) {
    const result = await run(["status", "--origin", origin]); assert.equal(result.code, 1); assert.equal(result.stdout, ""); assert.equal(result.error.code, "invalid_origin"); assert.ok(!result.stderr.includes("private-token"));
  }
});

test("CLI rejects unsupported commands, ambiguous options and path injection without a request", async () => {
  let calls = 0;
  const fetch: typeof publicFetch = async () => { calls++; throw new Error("Should not fetch"); };
  for (const args of [["publish"], ["status", "unexpected"], ["docs", "../../private"], ["docs", "https://example.com"], ["docs", "setup", "extra"], ["--origin"], ["status", "--origin", "https://example.com", "--origin", "https://other.example"], ["validate-plan"]]) {
    const value = await run(args, { fetch }); assert.equal(value.code, 1, args.join(" ")); assert.equal(value.error.code, "invalid_arguments");
  }
  assert.equal(calls, 0);
  const help = await run(["--help"], { fetch }); assert.equal(help.code, 0); assert.equal(help.result.distribution, "private_repository_checkout");
});

test("CLI validates a bounded plan locally using the shared schema, never sending or echoing content", async () => {
  const input = await readFile("packages/cli/examples/three-video-plan.json");
  let networkCalls = 0;
  const fetch: typeof publicFetch = async () => { networkCalls++; throw new Error("No network allowed"); };
  const value = await run(["validate-plan", "local.json"], { fetch, readPlan: async () => input });
  assert.equal(value.code, 0); assert.equal(value.result.itemCount, 3);
  assert.equal(value.result.persisted, false); assert.equal(value.result.rendered, false); assert.equal(value.result.publishingAuthorized, false);
  assert.ok(!value.stdout.includes("Example Company")); assert.ok(!value.stdout.includes("Start with a clear brief"));
  assert.equal(networkCalls, 0);
  const realFile = await run(["validate-plan", "packages/cli/examples/three-video-plan.json"]); assert.equal(realFile.code, 0);
});

test("CLI rejects invalid, oversized and unreadable plans without private values in errors", async () => {
  const base = JSON.parse(await readFile("packages/cli/examples/three-video-plan.json", "utf8"));
  for (const input of [{ ...base, approved: true }, { ...base, items: [] }, { ...base, items: [...base.items, base.items[0]] }, { ...base, operationKey: "private-secret-invalid" }, { ...base, items: [{ title: "Title", script: "x".repeat(5001) }] }]) {
    const value = await run(["validate-plan", "private-file.json"], { readPlan: async () => encoder.encode(JSON.stringify(input)) });
    assert.equal(value.code, 1); assert.equal(value.error.code, "invalid_plan"); assert.ok(!value.stderr.includes("private-secret-invalid")); assert.equal(value.stdout, "");
  }
  for (const [bytes, expected] of [[encoder.encode("private-not-json"), "invalid_json"], [new Uint8Array(limits.planBytes + 1), "plan_too_large"]] as const) {
    const value = await run(["validate-plan", "local.json"], { readPlan: async () => bytes }); assert.equal(value.error.code, expected);
  }
  const unreadable = await run(["validate-plan", "missing.json"], { readPlan: async () => { throw new Error("private filename"); } });
  assert.equal(unreadable.error.code, "plan_unreadable"); assert.ok(!unreadable.stderr.includes("private filename"));
});

test("CLI refuses redirects and gives bounded recoverable errors for failed public reads", async () => {
  const responses = [
    [new Response("", { status: 302, headers: { Location: "https://other.example" } }), "redirect_refused"],
    [new Response("private error payload", { status: 404 }), "http_404"],
    [new Response("html", { headers: { "Content-Type": "text/html" } }), "invalid_response"],
    [new Response("not-json", { headers: { "Content-Type": "application/json" } }), "invalid_response"],
    [Response.json({ unknown: "private response" }), "invalid_response"],
    [new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": String(limits.responseBytes + 1) } }), "response_too_large"],
    [new Response("x".repeat(limits.responseBytes + 1), { headers: { "Content-Type": "application/json" } }), "response_too_large"],
  ] as const;
  for (const [response, expected] of responses) {
    let calls = 0;
    const value = await run(["status"], { fetch: async () => { calls++; return response; } });
    assert.equal(value.code, 1); assert.equal(value.error.code, expected); assert.equal(value.stdout, ""); assert.equal(calls, 1); assert.ok(!value.stderr.includes("private"));
  }
  const network = await run(["status"], { fetch: async () => { throw new Error("private transport secret"); } });
  assert.equal(network.error.code, "network_error"); assert.ok(!network.stderr.includes("secret"));
  const timeout = await run(["status"], { timeoutMs: 1, fetch: async (_input, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.equal(timeout.error.code, "request_timeout"); assert.equal(timeout.code, 1);
});
