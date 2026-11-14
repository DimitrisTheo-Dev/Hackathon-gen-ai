# Castroom verification record

Updated 14 November 2026. This record separates inspected configuration, local fixtures, and real provider/client evidence. It is not a release pass.

## Known baseline

- Pre-existing commit: `7714fbd2a43c7154de2636417ae1ff1bcffa4c03`, a React/Vite/TypeScript placeholder connected to private GitHub and Vercel.
- The earlier placeholder’s Supabase public API check succeeded. That checks endpoint reachability and a publishable key, not domain authorization, RLS, production workflow, or MCP authentication.
- Studio candidate: `742589c963b27b0d0ca45d4b3be5f65757acd4a6` on `work/dimitris-studio`. Public origin: https://hackathon-gen-ai-nine.vercel.app. Main and repository privacy are unchanged.
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
| Docs browser | Pass for setup page | Native Safari opened the deployed `/docs/setup/`; headings, both client templates, explicit unavailable status, and recovery links appeared. |
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
| Desktop/intermediate/mobile interactions | Partial | Chrome/Safari desktop and narrower-window interactions exercised. Full-width editor return and mobile navigation operated. Exact 390px, full keyboard-only journey, long-text stress and reduced-motion checks remain unverified. |
| Public docs raw HTML and 404 behavior | Pass for recorded routes | Public HTML/Markdown, `/docs/`, private no-store `/studio/`, and absent-page 404 checks in `evidence/http-after-fixes.json`. |
| Official is-agentic audit | Executed; cached follow-up | Score 46 at 2026-11-14T13:21:51.936Z. Follow-up returned the same timestamp/result after fixes; no improved score claimed. |
| Successful run recording / fallback media | Unavailable | Capture a real completed run; label replay and retain redacted receipts. |

## Rehearsal measurement sheet

Record one actual attempt per client without replacing a failed attempt with an undocumented success:

| Field | Value |
| --- | --- |
| Candidate SHA and deployment URL | `742589c` / https://hackathon-gen-ai-nine.vercel.app |
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

- `npm test`: 19 tests pass (rerun after the final navigation fix). Covers revision conflicts, unchanged retry identity, same-key/different-payload rejection, persistence, render/copy distinction, writable field whitelist, unavailable publication, corrupt storage, live auth-before-fetch, strict responses, no fixture fallback, interrupted writes, source URL validation, manual batch bounds, source instruction treated as data, and Athens DST ambiguity/gap rejection, public Markdown negotiation, and real 404 recovery responses. These are frontend/transport tests, not backend tenant/RLS or quota-race certification.
- `npm run build`: TypeScript and Vite pass. Studio loads as a separate chunk. A 545 kB main-chunk warning remains; no performance target is claimed.
- Explicit production build with the fixture flag set: no fixture module/storage marker and no source maps in emitted assets. Explicit preview build includes the opt-in fixture module.
- Source secret-pattern scan: no secret-key/private-key patterns in tracked/untracked source; `.env.local` ignored. The supplied secret key was not used or committed. This limited scan is not a complete credential audit.
- Native Chrome, local Vite, light theme: inspected full desktop and a narrower desktop window; selected the first video, entered a replacement script, switched to the second video and back, observed preserved unsaved text, saved, saw v2 and one local edit, refreshed and observed the same v2/script. Opened schedule review: zero destinations, concrete provider blockers, Approve disabled. Closed dialog and focus returned to Review schedule.
- Native Safari: completed manual brief → editable supplied summary → one draft. Company, audience, tone, campaign title and exact script were retained; no video or provider job was claimed. Changed the script and used Undo to restore it. Inspected channel controls with no connected accounts and agent chooser with honest unavailable status. This is local fixture evidence only.
- Reduced oversized desktop cards to a 640px board and re-inspected the three-card composition in Safari: card status was visible. A narrower Safari window exposed a hidden navigation menu caused by important-rule layer precedence; corrected it, opened the menu, switched projects, and returned from the full-width editor. Selected the second BeWell item, reloaded and observed the same campaign/item. Exact CSS viewport dimensions were not measured. Screenshots were inspected in conversation but are not retained artifacts; visual gate areas remain unverified in the saved record.
- Supplied Moonjar screenshots are now available and inspected. Their shell/canvas/panel relationships guide original Castroom styling. No proprietary assets were copied.
- No uncoached human trial or measured setup/first-playable-video time occurred. No generated video, authenticated agent handshake, live approval or published post is claimed.

## Public deployment and audit

- Public docs remain public; studio responses use `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`. Live data still requires Supabase authentication and the domain API. No robots setting substitutes for authorization.
- The official [is-agentic report](https://is-agentic.com/scan/hackathon-gen-ai-nine.vercel.app) recorded 46 at `2026-11-14T13:21:51.936Z`. Both raw reports are retained. The follow-up is cached: the timestamp and old findings did not change.
- Fixed and independently fetched: richer initial homepage HTML, root Markdown negotiation with `Vary: Accept`, Markdown 404 recovery, and trailing-slash studio routes. These checks do not recalculate the scanner score.
- Real OpenAPI/MCP metadata, scoped authentication, deterministic denial checks and provider actions remain blocked on engine integration. No invented endpoints, OAuth claims or public access changes were added for the scanner.
- Git remote still has only `main` and `work/dimitris-studio` at final inspection. Minas's branch/API is not yet available. Shared contract remains proposed, not agreed.
- `evidence/ui-quality.json` records a blocked live-flow gate and the exact limits of local UI evidence. No uncoached teammate trial, live client setup time, first-playable-video time, or provider-cost measurement is available.

Final deployments: production `dpl_HJeZgDWLL7Vhnoc8yoRrd1oDi9bm` and preview `dpl_51AmeD2xSNYkC1XP5qLPVbBihvYb` are READY for `742589c`. [Protected studio preview](https://hackathon-gen-khh4z973p-my-team-29ecd279.vercel.app/dev/studio/) requires Vercel access. Final public entry asset excludes fixture imports/storage markers; the production sign-in boundary was opened in Safari without submitting an email. See `evidence/final-deployment.json`.

Typography follow-up: docs now use the same Avenir Next / Segoe UI fallback stack as the studio. Narrow desktop Safari review found no visible clipping in heading, prose, notice or navigation. Mechanical typography scan returned no findings and build passed. No suppressions were added; live integration gates remain unchanged.

## Neutral redesign / pnpm readiness pass, 14 November 2026

This section supersedes the earlier typography and browser limitations for the tested frontend scope. Prior deployment IDs above remain historical. The new build uses full self-hosted Inter Variable with its SIL license, warm neutral tokens, a prerendered public landing and responsive studio. A narrowly scoped Impeccable `overused-font: Inter` exception records the user's explicit font choice. No other suppressions were added.

- pnpm 12.18.0 workspace and frozen install pass; npm lockfile removed. Node24 is the deployment target; local Node26.10 emits an upstream tsx deprecation warning on stderr.
- 36 unit/contract/CLI tests pass. OpenAPI validates as 3.1.1 with SwaggerParser and shares response schemas with runtime validators.
- Chromium159 / Playwright1.65.1: browser suite exercises raw HTML without JavaScript, sample selection, keyboard workflow, create/select/edit/save/reload, caption-only revision, command palette, filters, blocked approval, offline drafts, corrupt-storage errors, auth boundary, long Greek/English titles and 200%-equivalent 720px reflow. Exact widths:1440,1280,1024,768,430,390,375,320. No horizontal overflow in tested views. This is CSS viewport emulation, not native phone/keyboard testing or a literal browser-menu zoom test.
- Fresh reviewer independently operated create→edit→save→refresh→review at1440/390. Found and rechecked mobile card/footer overlap; fixed nonshrinking canvas sizing. Grouped identical review blockers with affected-item scope. Tablet project drawer visibility was fixed and tested. No uncoached human study is claimed.
- 63 local HTTP checks pass, covering all public pages, Markdown docs, JSON routes, HEAD,405/404 recovery, discovery files, font/license and OG image. Production checks are retained separately after deployment.
- Explicit production build excludes fixture storage/module and source maps even with the fixture flag set. Private shell HTML has no landing markup. Public root JS is250.92kB /77.99kB gzip, with auth and studio loaded separately; this is a build measurement, not a Core Web Vitals claim.
- No live MCP handshake, Humanlike video/audio, exported final composition, provider acceptance/publication, RLS/quota-race evidence, or setup/first-video time is available. The real hero workflow remains blocked on the shared engine.

Screenshots and interaction log: `evidence/redesign/` and `evidence/browser-redesign.txt`. Moonjar desktop/mobile home/features and supplied product reference images were inspected; reference media are retained only outside the repository. Mobbin hero search informed composition review; no proprietary images were shipped.

Production smoke test caught a deployment-only failure after merge: Node ESM could not resolve extensionless public-handler imports. Production was rolled back to the prior working deployment while fixing it. Explicit `.js` import specifiers now survive TypeScript emission; `check:proxy` compiles and runs the emitted handler in plain Node, and the production build executes that regression check. Root engine is pinned to24.x so Vercel does not select26 from a broad >=24 range.

The corrected `7941619` production deployment passed all63 public HTTP/file checks. Live Chromium opened `/`, `/docs/api/`, and `/studio/` with zero page/console errors; the private route retained `private, no-store` and `noindex, nofollow`. The repository CLI successfully read live status and setup documentation without credentials. Official rescan returned98/100 at14:01:58.128Z, up from46; raw reports are retained. A subsequent public API refinement adds enforced `X-API-Version: 1`,400 recovery for unsupported versions, typed inputs for all four operations, and RFC9745/8594 deprecation policy. Unit tests now37; build also checks emitted ESM imports and exact JSON-LD CSP hash.

Final application candidate: `2b87dd52e6c93746f0c6f8847044ef0b3b76d604`, on both `main` and `work/dimitris-studio`. Vercel production `dpl_DsZELBqU3wL3DCTfvFLSDyDDFSPo` is READY at https://hackathon-gen-ai-nine.vercel.app. All65 post-versioning endpoint/file checks passed; see `evidence/public-production-final.json`. Live root/docs/studio browser checks again returned200 with zero console/page errors. Final official score99/100 at `2026-11-14T14:05:07.815Z`; report and remaining findings are in `evidence/is-agentic-final.json`. This evidence-only follow-up does not change application assets.

Coworker handoff: pull `main`; install with `corepack pnpm install --frozen-lockfile`; run `corepack pnpm dev` and open `/dev/studio/` for the labeled local fixture. Shared domain contract remains proposed in `packages/contracts`; integrate Minas through `apps/web/src/data/live.ts` and `VITE_CASTROOM_API_URL`. No backend branch has appeared. Public discovery routes are separate and must not be mistaken for the domain execution API.

## Mobile-native / Grainient refinement, 14 November 2026

This pass preserves the React/Vite application, shared client/contract and desktop three-region shell. It does not migrate to Next.js. Mobile uses a compact project switcher, thumb navigation, progressively disclosed brief/filters, full-screen selected editor and bottom-sheet dialogs. Native dialog focus containment, scroll locking, browser Back, draft preservation, safe-area/visual-viewport handling and a small interruptible critically damped spring are implemented without a motion dependency. Only the explicit handle owns dismissal gestures. Safe reversible previews and cached project selection update optimistically and roll back on failure; revisions, rendering, approval and delivery remain server-confirmed.

Applied installed mobile-native, apple-design, animate and Impeccable's adapt guidance. The visual pass retains Inter, neutral operational controls and Moonjar composition. Grainient's first freebie, Astral-01, was downloaded through its public Download button after checking its license; its golden/cream/mist-blue artwork is optimized from5120×2880 to1600×900 WebP,11,796 bytes. It is served locally, with attribution in `apps/web/public/art/ATTRIBUTION.txt`, and used only around previews/selected decorative surfaces. No subscription purchase, hotlinked asset or purple accent was introduced.

Executed checks: build/typecheck including compiled Node ESM and prerender/CSP tests;40 unit tests;21 Playwright tests;67 local HTTP/file checks. Browser engines: Chromium159.0.8154.6 and WebKit27.2. Viewports:1440,1280,1024,768,430,390,375,320 plus844×390 landscape and720×500 reflow. Tested landing menu/preview, project selection rollback, filtering, editor/Back, retained drafts, failed save rollback, offline, loading, empty, expired media, corrupt storage, blocked review, keyboard focus and reduced motion. Chromium CDP touch caught and verified a real cascade bug where the global button touch-action cancelled handle drags; scoped layering now preserves vertical handle gestures and native content scrolling. No page errors in the cross-engine flows. The mechanical design scan returned no findings; no new suppressions were added (the earlier explicit Inter exception remains).

Screenshots and logs: `evidence/mobile-refinement/`. Physical-device safe areas, software keyboards, hardware gesture feel, VoiceOver/TalkBack and literal browser200% zoom remain pending. Use [the iOS Safari / Android Chrome checklist](mobile-device-qa.md). No live Humanlike, MCP or publisher success is claimed; Minas's integration remains the release gate for the full production journey.
