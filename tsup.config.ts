import { defineConfig } from "tsup";
import * as glob from 'glob'

const entries = glob.sync('src/electron/**/*.ts')

export default defineConfig({
    entry: entries,
    outDir: "dist-electron",
    format: ["cjs"],
    target: "node18",
    platform: "node",
    splitting: false,
    sourcemap: true,
    clean: true,
    dts: false,
    treeshake: true,
    external: ["electron"],
});
