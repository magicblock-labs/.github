// Bundles the devnet approval page into web/dist: one script built from the
// lockfile, so nothing is fetched from a CDN at runtime.
//
//   npm run build:web   # web/dist, as deployed to GitHub Pages
//   npm run dev:web     # rebuild on change and serve on http://localhost:8000

import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, "dist");
const serve = process.argv.includes("--serve");

const options = {
  entryPoints: [path.join(here, "app.js"), path.join(here, "style.css")],
  outdir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: !serve,
  sourcemap: true,
  // Solana libraries expect Node's Buffer, process and `global`.
  inject: [path.join(here, "node-shims.js")],
  define: { global: "globalThis", "process.env.NODE_ENV": serve ? '"development"' : '"production"' },
  logLevel: "info",
};

const copyHtml = () => fs.copyFile(path.join(here, "index.html"), path.join(outdir, "index.html"));
await fs.rm(outdir, { recursive: true, force: true });
await fs.mkdir(outdir, { recursive: true });
await copyHtml();

if (serve) {
  const context = await esbuild.context(options);
  await context.watch();
  watch(path.join(here, "index.html"), copyHtml); // esbuild only watches what it bundles
  await context.serve({ servedir: outdir, port: 8000 });
  console.log("Serving http://localhost:8000");
} else {
  await esbuild.build(options);
}
