# Faceful agent-readiness evidence

Scope: public first-party documentation at `https://faceful.dtheo.dev` and the intended protected Faceful action surface. Updated 14 November 2026. Historical scanner records below retain the origin that was actually scanned; a score for the old Vercel hostname is not evidence for the renamed domain. Current redesign follows `95cd773`; new deployed evidence is recorded in `docs/demo/evidence`. No overall conformance or numerical score is claimed.

The [AgentReady v2.0 guide](https://www.agentready.org/) was checked on 14 November 2026 against the installed requirement map. **MUST**, **SHOULD**, and **MAY** retain their actual levels. A justified SHOULD deferral remains an unmet recommendation; optional features are not release requirements. The retired `AR-READ-10` is not reinstated.

Evidence labels: **S** = inspected static source; **D** = deployed HTTP evidence, captured for public routes; **C** = authenticated client evidence, currently absent. Status is pass, fail, unknown, or not applicable. Source-only results do not establish deployed behavior.

## Find

| Requirement / level | Status; evidence | Impact / action / verification |
| --- | --- | --- |
| AR-FIND-01 MUST | Pass for public docs; D | Public origin and docs respond without credentials; robots excludes tenant routes. Existing deployment protection remains. This does not prove all crawlers can access every environment. |
| AR-FIND-02 SHOULD | Pass for public docs; S/D | Canonical setup, limits, permissions and recovery pages return initial HTML with links. Live onboarding remains unavailable. |
| AR-FIND-03 SHOULD | Pass; S/D | Public-only sitemap and robots reference resolve at the canonical origin. |
| AR-FIND-04 MAY | Fail; not implemented | Low: AI Catalog deferred until real action resources exist. Do not publish invented endpoints. |

## Read

| Requirement / level | Status; evidence | Impact / action / verification |
| --- | --- | --- |
| AR-READ-01 MUST | Pass for public pages; S/D | Docs contain visible answers in initial HTML. Homepage was expanded after the first scanner result; final HTTP response records are retained. |
| AR-READ-02 MUST | Partial; D | Absent public routes return real 404 with recovery links. Live API throttling/429 hints remain unverified pending backend. |
| AR-READ-03 SHOULD | Pass for public pages; S/D | Initial homepage explains purpose and links setup, capabilities and private studio. |
| AR-READ-04 SHOULD | Pass for honest development guidance; live setup fails | Blocker: no endpoint/token issuer yet. Exercise complete first-call setup after backend integration. |
| AR-READ-05 SHOULD | Pass for S | Examples use semantic `pre/code` and language classes. Verify rendered wrapping. |
| AR-READ-06 SHOULD | Pass for public resources; domain setup blocked | Public OpenAPI and CLI now link from the homepage, docs and llms index. Live domain API/MCP remain unavailable. |
| AR-READ-07 SHOULD | Pass; S/D | `/llms.txt` links canonical public docs and discloses unavailable execution. |
| AR-READ-08 SHOULD | Pass for docs; S/D | Factual WebPage JSON-LD repeats visible title/purpose. Homepage SoftwareApplication JSON-LD now matches visible development status; no fabricated offers/ratings. |
| AR-READ-09 MAY | Pass for public docs | Homepage, all eight documentation routes and 404 negotiate Markdown with `Vary: Accept`. |
| AR-READ-11 SHOULD | Pass for S on known limits; pricing not applicable | No paid product/prices offered. Docs disclose unknown quotas/costs and pending capabilities; add actual limits from service. |

## Act

| Requirement / level | Status; evidence | Impact / action / verification |
| --- | --- | --- |
| AR-ACT-01 SHOULD | Fail; C absent | Blocker: scoped token issuer and live consent/revocation must be tested. Token fallback is not OAuth. |
| AR-ACT-02 SHOULD | Pass for public discovery; domain API pending | OpenAPI 3.1.1 describes four real read operations with runtime-derived schemas, unique operationIds, parameters and RFC 9457 errors. SwaggerParser and HTTP checks validate it. |
| AR-ACT-03 SHOULD | Fail; no live MCP | Blocker: implement authenticated Streamable HTTP and verify discovery in both target clients. Registry publication pending. |
| AR-ACT-04 MAY | Fail; deferred | Low: server-card conventions/host support must be confirmed before publication. |
| AR-ACT-05 MAY | Fail; deferred | Low: MCP Apps is optional; external studio serves the first journey. |
| AR-ACT-06 SHOULD | Partial | Repository CLI supports real public reads and local bounded-plan validation, with tests. Public registry distribution and campaign execution are unavailable; an authorized checkout is required. |
| AR-ACT-07 SHOULD | Fail; justified deferral | Low: WebMCP remains a draft; target clients use remote MCP. Feature-detect if later adopted. |
| AR-ACT-08 MAY | Not applicable | No agent purchase/billing task or paid checkout in this build. |
| AR-ACT-09 MAY | Not applicable | No open-ended public content-query service is needed for the bounded campaign workflow. |
| AR-ACT-10 MUST (conditional, applicable) | Fail; C absent | Blocker: Faceful promises agent task execution; documentation or REST alone is insufficient. Ship useful MCP and run the real campaign. |

All Act failures describe the current unintegrated studio candidate, not a finding about unseen Minas code. Update evidence after his backend is available; do not infer coverage from this table or a contract schema.

## Official scanner procedure

Run the official `is-agentic` CLI against **only the intended public origin** after deployment, using its current [docs](https://is-agentic.com/docs). Never submit tenant URLs, signed media links, or credentials. The documented command is `corepack pnpm dlx is-agentic <public-domain> --json`.

Preserve the canonical report URL, scan timestamp, target origin, raw result, and cache status. A stored result can be returned from the upstream freshness cache; a null score remains null. The [methodology](https://is-agentic.com/methodology) says public scans have point-in-time limits and do not certify security, accessibility, or compatibility. Fix observed essential gaps and recheck; keep genuine Codex/Claude trials as separate evidence.

Scanner executed against https://hackathon-gen-ai-nine.vercel.app: **46**, timestamp **2026-11-14T13:21:51.936Z**, [canonical report](https://is-agentic.com/scan/hackathon-gen-ai-nine.vercel.app). Follow-up after fixes returned the same cached result. Raw reports and direct post-fix HTTP checks are in `docs/demo/evidence`; no improved score or full conformance is claimed. Remaining essential action-interface findings require the real backend, not decorative metadata.

## Integration checks

1. Fetch `/`, `/docs/`, `/docs/setup/`, `/docs/capabilities/`, `/docs/security/`, `/docs/errors/`, `/llms.txt`, `/robots.txt`, and `/sitemap.xml` with bounded ordinary requests. Verify visible initial answers, headers, links, and canonical host.
2. Fetch one unique nonexistent public route and verify a real 404 rather than a successful SPA shell.
3. Verify private studio/API resources remain authenticated and excluded from public discovery. Robots/noindex is not access control.
4. Confirm actual MCP/OpenAPI links only after backend deployment. Test expired/revoked token and wrong workspace behavior before calling setup ready.
5. Reconcile this matrix with the final candidate and save executed evidence in `docs/demo/verification.md`.

## 14 November neutral redesign and readiness pass

The requested fixes now include prerendered homepage content; root/docs Markdown negotiation; Markdown 404s; read-only JSON discovery with OpenAPI; RFC 9457 errors; explicit proposed scope definitions; JSON-LD/canonical/OG metadata; trust pages; agent when-to-use instructions; and a repository CLI. `scripts/verify-public.ts` checks 63 HTTP responses/files. Local results are in `evidence/public-local-redesign.json`; production results follow deployment.

The machine-readable permission definitions deliberately say `proposed_not_issued`. They do **not** satisfy enforced scoped authentication. OAuth metadata is not fabricated: the absent issuer returns a truthful JSON 404. Real OAuth/agent grants, MCP, Humanlike and publisher receipts remain Minas integration gates. Publishing a CLI package needs registry credentials and a chosen public package identity; no package was published. Organization street address/contact details were not supplied and are not invented. Search indexing cannot be guaranteed by a deployment. A free public read API is not represented as a free video-rendering plan. These prevent any claim of 100% readiness.

Fresh official rescan after deployment: **98/100**, `2026-11-14T14:01:58.128Z`, all10 essential scanner checks passed. Report: https://is-agentic.com/scan/hackathon-gen-ai-nine.vercel.app. The CLI initially returned cached46; the official report's Rescan action produced the new snapshot. Remaining report items: search indexing, API version policy, rate-limit headers, partial MCP/CLI and function-input discovery. This pass then added real X-API-Version negotiation, typed version parameters and a documented deprecation policy. It did not invent quota headers, OAuth or MCP. The scanner's public-surface score does not close the real campaign ACT-10 gate.

Final official rescan: **99/100**, `2026-11-14T14:05:07.815Z`, all10 essential checks passed. `evidence/is-agentic-final.json` preserves the report. Remaining scanner findings are search discoverability, rate-limit response headers, partial MCP and partial CLI distribution. `pnpm whoami` confirmed registry authentication is unavailable. These are real remaining gaps; no100% conformance or complete production workflow is claimed.


## Faceful follow-up: discoverability and remaining recommendations

This pass adds HTTP `Link` discovery to successful public HTML/Markdown pages, public API responses and recoverable public 404s. The links use the canonical Faceful origin: OpenAPI (`service-desc`), API/MCP/CLI guides (`service-doc`), integration status (`status`) and `llms.txt` (`index`). The service relations follow [RFC 8631](https://www.rfc-editor.org/rfc/rfc8631). Private studio and domain routes retain their existing pass-through behavior. `/mcp` is still a truthful unavailable-endpoint response; it is not redirected to an HTML guide or represented as a working MCP server. These changes strengthen AR-READ-06 (SHOULD) discovery linkage but do not guarantee search rankings.

### Rate-limit recommendation: still unmet

On 14 November 2026, the IETF tracker lists [draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) as an active Internet-Draft, not a published RFC. Its current fields are `RateLimit-Policy` and `RateLimit`, with policy quota/window and remaining quota/time parameters. A fixed response header without enforcement and current accounting would not implement that behavior. No application quota counter is configured for the public discovery routes, so none is advertised. Successful read responses retain their caching policy.

[Vercel’s rate-limiting SDK documentation](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk) requires a configured WAF rule and the `@vercel/firewall` package. It documents per-region counters and a `rateLimited` decision; the documented API does not provide remaining/reset accounting. The existing public proxy does not have that integration or a shared quota store. An isolate-local counter would reset with deployment instances and could not establish a global client quota, so this pass does not introduce one solely for the scanner.

The concrete remaining step is to choose the actual request scope/window and configure its authoritative enforcement with the deployment/backend owner. Then verify the real rejection response and accurate recovery guidance in a controlled environment. Advertise only the policy and accounting the limiter can actually supply; use `Retry-After` on genuine throttling when its retry time is known. Keep rendering/publishing unit reservations in Minas’s domain service. Do not induce throttling on production to manufacture evidence.

### MCP, CLI and search blockers

- **MCP / AR-ACT-03 SHOULD and AR-ACT-10 conditional MUST:** Minas must supply the shared authenticated transport, scoped credential flow and domain execution. Test fresh Codex and Claude Code sessions against it before registry publication or a successful setup claim. A second public docs-only MCP implementation would not complete the promised campaign journey.
- **CLI / AR-ACT-06 SHOULD:** the repository CLI is useful for discovery and local draft validation, but public registry distribution still needs a chosen package identity and registry credentials. Its commands do not execute the campaign; publishing a package alone would not close AR-ACT-10.
- **Search discoverability:** branded titles, canonical public pages, the sitemap, visible links and HTTP discovery now point to Faceful. Crawlers still need to index the new domain. Search Console ownership/submission and any registry listing require the relevant owner account; neither indexing nor top-ten ranking can be guaranteed by code.

Verification in this pass: `corepack pnpm exec tsx --test tests/readiness.test.ts tests/cli.test.ts tests/public-routing.test.ts` passed **24 tests**, including schema validation, canonical discovery links, unavailable MCP behavior and private-route preservation. `corepack pnpm typecheck` and `corepack pnpm check:proxy` passed. This is local source/runtime evidence; production headers and a new canonical-domain scanner result must be recorded after deployment. No new score or 100% conformance is claimed.


## Final local verification before deployment

At `2026-11-14T15:52:39.963Z`, the existing built assets plus refreshed public proxy passed **69 HTTP checks** at `http://127.0.0.1:4173` using `scripts/verify-public.ts`. The existing `dist` was not rebuilt. The checks covered raw HTML, Markdown negotiation, document/API bodies, GET/HEAD, actual 404/405 responses, API-version rejection and public assets. The owned server was restarted from PID `96727` as PID `46890` to load the updated proxy. Raw local evidence is in `/tmp/faceful-public-local-final.json` for this working session.

At `2026-11-14T15:53:13.327Z`, eight read-only production requests to `https://faceful.dtheo.dev` still returned the earlier deployment: Castroom content and canonical/sitemap/robots references to `hackathon-gen-ai-nine.vercel.app`, without the new RFC discovery links. The equivalent local pages returned Faceful branding, the new canonical domain and the new public page/API discovery headers. The comparison is in `/tmp/faceful-discovery-final-check.json`. This identifies a pending deployment rather than completed production verification; rerun the canonical-origin checks after deployment. No protected routes, credentials or production side effects were used.

Remaining concrete release gates are unchanged: deploy the current Faceful candidate and verify its public headers; configure an authoritative limiter before advertising quota telemetry; integrate and test Minas’s authenticated MCP/domain service; obtain registry identity/credentials for public CLI distribution; and allow verified new-domain discovery/indexing. The earlier scanner score does not establish those outcomes.
