import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Standalone SPA build of the pomodoro UI for the iOS WKWebView wrapper.
 * It bypasses TanStack Start entirely — the app is fully client-side
 * (zustand + localStorage), so a plain static bundle is all the app needs.
 *
 * Build:  npx vite build --config ios/web/vite.config.ts
 * Output: ios/web/dist (copied into the app bundle by ios/build-ipa.sh)
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: fileURLToPath(new URL("../../public", import.meta.url)),
  plugins: [viteReact(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
