// Runs the compiled Vercel Function entries in plain Node, exactly as the platform loads them (NodeNext ESM,
// explicit .js specifiers). Catches unresolved imports before a deployment does. No network, no real credentials.
// Deterministic regardless of where the build runs: provider credentials present in the build environment
// (Stripe, renderer, model) must not change what this structural check expects.
for (const key of Object.keys(process.env)) if (/^(STRIPE_|RENDER_|HUMANLIKE_|ANTHROPIC_|AI_GATEWAY_|DIRECTOR_|CRON_|AVATAR_)/.test(key)) delete process.env[key];
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_build_check_only';
process.env.APP_BASE_URL = 'https://faceful.example';
const engine = (await import('../.vercel/api-check/api/engine.js')).default;
const health = await engine.fetch(new Request('https://faceful.example/api/engine?__path=health'));
const body = await health.json();
if (health.status !== 200 || body.engine !== true || body.rendering.connected !== false || body.billing.mode !== 'not_configured') throw new Error(`engine health check failed: ${health.status} ${JSON.stringify(body)}`);
const denied = await engine.fetch(new Request('https://faceful.example/api/engine?__path=studio/context'));
if (denied.status !== 401) throw new Error(`unauthenticated studio request must be 401, got ${denied.status}`);
const mcp = (await import('../.vercel/api-check/api/mcp.js')).default;
const metadata = await mcp.fetch(new Request('https://faceful.example/api/mcp?__path=.well-known/oauth-protected-resource/mcp'));
const resource = await metadata.json();
if (metadata.status !== 200 || resource.resource !== 'https://faceful.example/mcp' || !Array.isArray(resource.authorization_servers)) throw new Error(`MCP resource metadata check failed: ${metadata.status} ${JSON.stringify(resource)}`);
const unauthorized = await mcp.fetch(new Request('https://faceful.example/api/mcp?__path=mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }));
if (unauthorized.status !== 401 || !unauthorized.headers.get('www-authenticate')?.includes('resource_metadata=')) throw new Error(`unauthenticated MCP request must be 401 with resource metadata, got ${unauthorized.status}`);
console.log('API function check: compiled engine and MCP entries load in plain Node; health 200, unauthenticated 401, MCP resource metadata served.');
