import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function isBareImport(id: string): boolean {
  return !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0");
}

export default defineConfig({
  build: {
    target: "node20",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        "workers/start-server": resolve(__dirname, "src/workers/start-server.ts"),
        "workers/start-relay": resolve(__dirname, "src/workers/start-relay.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external(id) {
        if (nodeBuiltins.has(id)) {
          return true;
        }

        return isBareImport(id);
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        banner(chunk) {
          return chunk.name === "index" ? "#!/usr/bin/env node" : "";
        },
      },
    },
  },
});
