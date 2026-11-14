import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(
    mode,
    fileURLToPath(new URL("../..", import.meta.url)),
    "",
  );
  return {
    root,
    envDir: "../..",
    plugins: [react()],
    define: {
      __FIXTURE_ENABLED__: JSON.stringify(
        process.env.VERCEL_ENV !== "production" &&
          (command === "serve" || env.CASTROOM_ENABLE_FIXTURES === "true"),
      ),
    },
    build: { outDir: "../../dist", emptyOutDir: true },
    server: { host: "127.0.0.1" },
  };
});
