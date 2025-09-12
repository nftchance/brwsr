import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        main: "src/electron/main.ts",
        preload: "src/electron/preload.ts",
        pane_preload: "src/electron/pane_preload.ts",
    },
    outDir: "dist-electron",
    format: ["cjs"],
    target: "node18",
    platform: "node",
    splitting: false,
    sourcemap: true,
    clean: true,
    dts: false,
    treeshake: true,
    external: ["electron"],            // <-- IMPORTANT
});
