# Castroom agent-readiness evidence

Scope: public first-party documentation and the intended protected Castroom action surface. Updated 14 November 2026. Current redesign follows `95cd773`; new deployed evidence is recorded in `docs/demo/evidence`. No overall conformance or numerical score is claimed.

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
| AR-ACT-10 MUST (conditional, applicable) | Fail; C absent | Blocker: Castroom promises agent task execution; documentation or REST alone is insufficient. Ship useful MCP and run the real campaign. |

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
