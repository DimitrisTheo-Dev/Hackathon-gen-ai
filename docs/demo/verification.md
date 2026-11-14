# Castroom verification record

Updated 14 November 2026. This record separates inspected configuration, local fixtures, and real provider/client evidence. It is not a release pass.

## Known baseline

- Pre-existing commit: `7714fbd2a43c7154de2636417ae1ff1bcffa4c03`, a React/Vite/TypeScript placeholder connected to private GitHub and Vercel.
- The earlier placeholder’s Supabase public API check succeeded. That checks endpoint reachability and a publishable key, not domain authorization, RLS, production workflow, or MCP authentication.
- Current studio work is on `work/dimitris-studio`; record the final candidate SHA at integration.
- Source ownership: Dimitris owns web/root/contracts after agreement; Minas owns API, database, production/composition, publishing, and MCP execution.

## Executed documentation checks

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| Installed Codex version | `codex-cli 0.169.0` | Executed `codex --version` on 14 Nov 2026. |
| Codex HTTP/token command syntax | Supported by local help | `codex mcp add --help` lists `--url` and `--bearer-token-env-var`. No server was installed or called. |
| Installed Claude version | `2.1.150 (Claude Code)` | Executed `claude --version` on 14 Nov 2026. |
| Claude HTTP command syntax | Supported by local help | `claude mcp add --help` lists HTTP transport. No server was installed or called. |
| Claude environment-referenced configuration | Documented | Official [MCP documentation](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson) checked; fresh authenticated trial pending. |
| Static docs source | Pass, five pages | Parsed HTML: one title/H1 per page, `lang=en`, canonical URLs, valid internal docs links, visible answer text. |
| Local docs HTTP | Pass, isolated static server | All five `/docs/` pages returned 200 text/html; CSS returned 200 text/css; one absent `/docs/` path returned 404. Python static server on 127.0.0.1:4181; this does not prove Vercel routing. |
| Docs token contrast | Calculated from CSS literals | Ink/paper 12.30:1; muted/paper 4.71:1; accent/paper 6.45:1; selected accent/lavender 5.90:1; notice heading/lavender 8.01:1. Rendered/computed colors not inspected. |
| Docs browser | Unverified in this worker | IAB access host unavailable. Root owns native Chrome verification to avoid session conflicts. |
| Submission time | 15 Nov 2026, 18:00 Athens | [Agenda](https://hackathon.polymath42.com/agenda), fetched 14 Nov 2026. |
| Repo/judge visibility | Process unconfirmed | Inspected [terms](https://hackathon.polymath42.com/terms) and agenda do not require public visibility or name reviewer accounts. |

## Acceptance evidence still required

| Journey | Status | Required evidence |
| --- | --- | --- |
| Fresh Codex setup and `studio_get_context` | Blocked | Live MCP endpoint, scoped token issuer, clean client profile, authenticated response, backend last-seen event, elapsed setup time. |
| Fresh Claude Code setup and context | Blocked | Same evidence, separately exercised in Claude Code. |
| Agent creates three persistent items visible in UI | Blocked | Accepted operation and persisted IDs from the shared service, not local fixtures. |
| UI edit visible to agent | Blocked | Saved revision, subsequent agent read, stale-render invalidation, conflict recovery. |
| Refresh/resume and closed-client durability | Blocked | Real background job continues after disconnect; refresh shows persisted state. |
| Humanlike audio and final composition | Blocked | Playable real output; caption/brand composition in exported bytes; authorized avatar proof. |
| All three channel outcomes | Blocked | Selected real accounts, independent provider acceptance/delivery receipts and recovery. |
| Denial/security gate | Blocked | Wrong tenant, missing scope, expired/revoked token, forged approval, stale manifest, quota race, duplicate intent, injected source. No external publish call on denial. |
| Desktop/intermediate/mobile interactions | Pending studio integration | Browser-operated selection/edit/save, keyboard, long text, recoverable failures and reduced motion. CSS emulation is not native-device coverage. |
| Public docs raw HTML and 404 behavior | Pending deployment | Fetch canonical docs and unique absent route at final public origin. |
| Official is-agentic audit | Pending deployment | Public origin only; save canonical report URL, timestamp, raw result, and whether cached/null. |
| Successful run recording / fallback media | Unavailable | Capture a real completed run; label replay and retain redacted receipts. |

## Rehearsal measurement sheet

Record one actual attempt per client without replacing a failed attempt with an undocumented success:

| Field | Value |
| --- | --- |
| Candidate SHA and deployment URL | Pending |
| Client version / fresh-profile method | Pending |
| Setup start / authenticated context receipt | Pending |
| Setup elapsed seconds | Not measured; no two-minute claim |
| Campaign ID / run ID | Pending |
| Render jobs attempted / videos completed | Pending |
| Provider-accepted jobs / published posts, by platform | Pending |
| Human interventions, with event IDs | Pending |
| Wall-clock time / active operator time | Pending |
| Manual baseline | Not measured; estimates must be labeled |
| Render/publishing cost | Not measured; dollar cap unverified |

## Evidence rules

Do not put access tokens, cookies, provider secrets, private payloads, or full signed media URLs in this file or screenshots. Keep fixture progress distinct from provider events. A public audit score is not a security certification or a substitute for authenticated client trials. Revocation does not prove cancellation of accepted schedules.

## Studio verification, 14 November 2026

- `npm test`: 17 tests pass. Covers revision conflicts, unchanged retry identity, same-key/different-payload rejection, persistence, render/copy distinction, writable field whitelist, unavailable publication, corrupt storage, live auth-before-fetch, strict responses, no fixture fallback, interrupted writes, source URL validation, manual batch bounds, source instruction treated as data, and Athens DST ambiguity/gap rejection. These are frontend/transport tests, not backend tenant/RLS or quota-race certification.
- `npm run build`: TypeScript and Vite pass. Studio loads as a separate chunk. A 545 kB main-chunk warning remains; no performance target is claimed.
- Explicit production build with the fixture flag set: no fixture module/storage marker and no source maps in emitted assets. Explicit preview build includes the opt-in fixture module.
- Source secret-pattern scan: no secret-key/private-key patterns in tracked/untracked source; `.env.local` ignored. The supplied secret key was not used or committed. This limited scan is not a complete credential audit.
- Native Chrome, local Vite, light theme: inspected full desktop and a narrower desktop window; selected the first video, entered a replacement script, switched to the second video and back, observed preserved unsaved text, saved, saw v2 and one local edit, refreshed and observed the same v2/script. Opened schedule review: zero destinations, concrete provider blockers, Approve disabled. Closed dialog and focus returned to Review schedule.
- Opened the manual create dialog; accessible fields and explicit local-fixture notice were observed. A browser focus change interrupted the later form interaction. Full manual submit, mobile, keyboard-only path and long-text rendered checks are not yet verified.
- Largest observed visual issue: oversized portrait cards pushed status below the fold. Reduced board max width to 640px; final rendered recheck remains pending due concurrent Chrome use. Existing screenshots were inspected in conversation but are not a retained evidence artifact.
- Supplied Moonjar screenshots are now available and inspected. Their shell/canvas/panel relationships guide original Castroom styling. No proprietary assets were copied.
- No uncoached human trial or measured setup/first-playable-video time occurred. No generated video, authenticated agent handshake, live approval or published post is claimed.
