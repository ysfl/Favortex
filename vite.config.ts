import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const rootDir = resolve(__dirname, "src");
const artifactsDir = resolve(__dirname, "artifacts");

export default defineConfig(({ mode }) => {
  const isDebug = mode === "debug" || process.env.BUILD_UNMINIFIED === "true";
  const outDir = resolve(artifactsDir, isDebug ? "dist-debug" : "dist");
  return {
    root: rootDir,
    publicDir: resolve(__dirname, "public"),
    plugins: [react()],
    base: "./",
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: isDebug,
      minify: isDebug ? false : "esbuild",
      cssMinify: !isDebug,
      rollupOptions: {
        input: {
          popup: resolve(rootDir, "popup/index.html"),
          options: resolve(rootDir, "options/index.html"),
          search: resolve(rootDir, "search/index.html"),
          onboarding: resolve(rootDir, "onboarding/index.html"),
          background: resolve(rootDir, "background.ts"),
          content: resolve(rootDir, "content.ts")
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]"
        }
      }
    }
  };
});
