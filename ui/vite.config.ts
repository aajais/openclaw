import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      // iOS Safari startup is sensitive to payload size/parse time.
      // Keep source maps opt-in to reduce initial transfer + parse overhead in production builds.
      sourcemap: process.env.OPENCLAW_CONTROL_UI_SOURCEMAP === "1",
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      // Allow access via Tailscale Serve / MagicDNS hostname.
      // Vite blocks unknown hosts by default to prevent DNS rebinding.
      allowedHosts: ["omen.tail64e79a.ts.net"],
      // Ensure HMR works when accessing the dev server through Tailscale Serve
      // (external HTTPS origin) instead of direct localhost:5173.
      hmr: {
        protocol: "wss",
        host: "omen.tail64e79a.ts.net",
        clientPort: 4443,
        // When the UI is served under /dev/, the HMR websocket must also use that base.
        // Vite will normalize this to `${base}@vite` internally.
        path: "/dev",
      },
    },
  };
});
