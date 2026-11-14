import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Static pages in public/ (docs, about, contact, privacy) are folders with an index.html. Production
 * serves them by folder URL; Vite's dev server would send `/docs/mcp/` to the app instead. Match production.
 */
function publicFolderPages(): Plugin {
  const publicDir = join(root, "public");
  return {
    name: "faceful-public-folder-pages",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = new URL(request.url ?? "/", "http://dev.local");
        const folder = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
        if (folder !== "/" && !folder.includes("..") && existsSync(join(publicDir, folder, "index.html")))
          request.url = `${folder}index.html${url.search}`;
        next();
      });
    },
  };
}
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL("../..", import.meta.url)),
    "",
  );
  return {
    root,
    envDir: "../..",
    plugins: [react(), publicFolderPages()],
    define: {
      __FIXTURE_ENABLED__: JSON.stringify(
        process.env.VERCEL_ENV !== "production" &&
          (command === "serve" || env.CASTROOM_ENABLE_FIXTURES === "true"),
      ),
    },
    build: { outDir: "../../dist", emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      // Same-origin API in development: `corepack pnpm dev:api` serves the engine on this port.
      proxy: Object.fromEntries(
        ["/v1", "/mcp", "/.well-known/oauth-protected-resource"].map((path) => [path, { target: `http://127.0.0.1:${env.API_PORT || 8787}`, changeOrigin: false }]),
      ),
    },
  };
});
