import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { memory: "bin/memory.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    splitting: false,
    sourcemap: false,
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node18",
    platform: "node",
    dts: true,
    splitting: false,
    sourcemap: false,
  },
]);
