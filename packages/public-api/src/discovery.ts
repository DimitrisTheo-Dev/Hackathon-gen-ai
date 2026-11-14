import { publicOrigin } from "./documents.js";

/** RFC 8631 links to implemented resources, never to an unconfigured MCP transport. */
export const publicDiscoveryLinkHeader = [
  `<${publicOrigin}/openapi.json>; rel="service-desc describedby"; type="application/vnd.oai.openapi+json"; title="Faceful public API description"`,
  `<${publicOrigin}/docs/api/>; rel="service-doc"; type="text/html"; title="Faceful API documentation"`,
  `<${publicOrigin}/docs/mcp/>; rel="service-doc"; type="text/html"; title="Faceful MCP availability and setup"`,
  `<${publicOrigin}/docs/cli/>; rel="service-doc"; type="text/html"; title="Faceful repository CLI"`,
  `<${publicOrigin}/api/public/status>; rel="status"; type="application/json"; title="Faceful integration status"`,
  `<${publicOrigin}/llms.txt>; rel="index"; type="text/plain"; title="Faceful agent instructions"`,
].join(", ");
