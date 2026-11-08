import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
const common = { bundle: true, logLevel: "warning", sourcemap: true };

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: ["../core/src/mcpServer.ts"],
    outfile: "dist/mcpServer.mjs",
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  }),
  build({
    ...common,
    entryPoints: ["webview/main.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
  }),
]);
copyFileSync("webview/style.css", "dist/webview.css");
