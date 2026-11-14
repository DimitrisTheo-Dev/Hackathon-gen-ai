# Castroom agent-readiness evidence

Scope: public first-party documentation and the intended protected Castroom action surface. Updated 14 November 2026. Candidate SHA and deployed verification must be filled at integration. No overall conformance or numerical score is claimed.

The [AgentReady v2.0 guide](https://www.agentready.org/) was checked on 14 November 2026 against the installed requirement map. **MUST**, **SHOULD**, and **MAY** retain their actual levels. A justified SHOULD deferral remains an unmet recommendation; optional features are not release requirements. The retired `AR-READ-10` is not reinstated.

Evidence labels: **S** = inspected static source; **D** = deployed HTTP evidence, currently pending; **C** = authenticated client evidence, currently absent. Status is pass, fail, unknown, or not applicable. Source-only results do not establish deployed behavior.

## Find

| Requirement / level | Status; evidence | Impact / action / verification |
| --- | --- | --- |
| AR-FIND-01 MUST | Unknown; D pending | High: fetch public docs under normal crawler policy and inspect robots/WAF. Do not expose tenant routes. |
| AR-FIND-02 SHOULD | Pass for S; D pending | Canonical docs answer setup, limits, permissions, recovery. Verify deployed deep links. |
| AR-FIND-03 SHOULD | Unknown; root files owned by integration | Add/inspect public-only sitemap and robots reference; verify canonical URLs resolve. |
| AR-FIND-04 MAY | Fail; not implemented | Low: AI Catalog deferred until real action resources exist. Do not publish invented endpoints. |

## Read

| Requirement / level | Status; evidence | Impact / action / verification |
| --- | --- | --- |
| AR-READ-01 MUST | Pass for S; D pending | `apps/web/public/docs/**/index.html` contains visible answers without JS. Fetch final build paths. |
| AR-READ-02 MUST | Unknown; D pending | High: absent page must return 404; throttling must use 429/retry hints. Inspect configuration/tests without load testing production. |
| AR-READ-03 SHOULD | Unknown for homepage; S docs navigation passes | Verify initial homepage product explanation and real links after root integration. |
| AR-READ-04 SHOULD | Pass for honest development guidance; live setup fails | Blocker: no endpoint/token issuer yet. Exercise complete first-call setup after backend integration. |
| AR-READ-05 SHOULD | Pass for S | Examples use semantic `pre/code` and language classes. Verify rendered wrapping. |
| AR-READ-06 SHOULD | Partial coverage recorded as fail | Docs link the planned root index; real OpenAPI/MCP artifacts remain unavailable. Link only validated endpoints. |
| AR-READ-07 SHOULD | Unknown; root index owned by integration | Verify `/llms.txt` contains canonical public docs and current limits. |
| AR-READ-08 SHOULD | Pass for S; D pending | Factual WebPage JSON-LD repeats visible title/purpose. No fabricated offers/ratings. |
| AR-READ-09 MAY | Fail; not implemented | Low: Markdown alternatives deferred; initial HTML is the required reading path. |
| AR-READ-11 SHOULD | Pass for S on known limits; pricing not applicable | No paid product/prices offered. Docs disclose unknown quotas/costs and pending capabilities; add actual limits from service. |

## Act

| Requirement / level | Status; evidence | Impact / action / verification |
| --- | --- | --- |
| AR-ACT-01 SHOULD | Fail; C absent | Blocker: scoped token issuer and live consent/revocation must be tested. Token fallback is not OAuth. |
| AR-ACT-02 SHOULD | Fail; no live OpenAPI | High: Minas must supply real schema tied to shared operations and errors. Validate responses. |
| AR-ACT-03 SHOULD | Fail; no live MCP | Blocker: implement authenticated Streamable HTTP and verify discovery in both target clients. Registry publication pending. |
| AR-ACT-04 MAY | Fail; deferred | Low: server-card conventions/host support must be confirmed before publication. |
| AR-ACT-05 MAY | Fail; deferred | Low: MCP Apps is optional; external studio serves the first journey. |
| AR-ACT-06 SHOULD | Fail; justified deferral | Low: standalone SDKs/CLI deferred in favor of targeted MCP clients; avoid two language SDKs without a user need. |
| AR-ACT-07 SHOULD | Fail; justified deferral | Low: WebMCP remains a draft; target clients use remote MCP. Feature-detect if later adopted. |
| AR-ACT-08 MAY | Not applicable | No agent purchase/billing task or paid checkout in this build. |
| AR-ACT-09 MAY | Not applicable | No open-ended public content-query service is needed for the bounded campaign workflow. |
| AR-ACT-10 MUST (conditional, applicable) | Fail; C absent | Blocker: Castroom promises agent task execution; documentation or REST alone is insufficient. Ship useful MCP and run the real campaign. |

All Act failures describe the current unintegrated studio candidate, not a finding about unseen Minas code. Update evidence after his backend is available; do not infer coverage from this table or a contract schema.

## Official scanner procedure

Run the official `is-agentic` CLI against **only the intended public origin** after deployment, using its current [docs](https://is-agentic.com/docs). Never submit tenant URLs, signed media links, or credentials. The documented command is `npx is-agentic <public-domain> --json`.

Preserve the canonical report URL, scan timestamp, target origin, raw result, and cache status. A stored result can be returned from the upstream freshness cache; a null score remains null. The [methodology](https://is-agentic.com/methodology) says public scans have point-in-time limits and do not certify security, accessibility, or compatibility. Fix observed essential gaps and recheck; keep genuine Codex/Claude trials as separate evidence.

Scanner status: **not yet run for the Castroom candidate**. No fabricated score or report URL.

## Integration checks

1. Fetch `/`, `/docs/`, `/docs/setup/`, `/docs/capabilities/`, `/docs/security/`, `/docs/errors/`, `/llms.txt`, `/robots.txt`, and `/sitemap.xml` with bounded ordinary requests. Verify visible initial answers, headers, links, and canonical host.
2. Fetch one unique nonexistent public route and verify a real 404 rather than a successful SPA shell.
3. Verify private studio/API resources remain authenticated and excluded from public discovery. Robots/noindex is not access control.
4. Confirm actual MCP/OpenAPI links only after backend deployment. Test expired/revoked token and wrong workspace behavior before calling setup ready.
5. Reconcile this matrix with the final candidate and save executed evidence in `docs/demo/verification.md`.
