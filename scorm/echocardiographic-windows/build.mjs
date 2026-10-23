/**
 * scorm/echocardiographic-windows/build.mjs
 *
 * Bundles the module into a self-contained SCORM 1.2 package under
 * ./package, then zips it.
 *
 *   node build.mjs           build package/
 *   node build.mjs --zip     build and write echocardiographic-windows.zip
 *
 * three.js is bundled in rather than loaded from a CDN: a SCORM package can
 * be opened from a file path, an intranet or an offline LMS, so any external
 * request is a module that breaks for some learner somewhere.
 */
import * as esbuild from "esbuild";
import { cp, mkdir, rm, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "src");
const out = path.join(here, "package");

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "assets"), { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(src, "course.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2019",
  outfile: path.join(out, "assets", "course.js"),
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

await cp(path.join(src, "index.html"), path.join(out, "index.html"));
await cp(path.join(src, "course.css"), path.join(out, "assets", "course.css"));
await cp(path.join(src, "imsmanifest.xml"), path.join(out, "imsmanifest.xml"));

// The heart geometry travels inside the package. It is the same asset the
// main site serves from public/anatomy, copied rather than duplicated so the
// two can never drift, and fetched relatively at runtime — a SCORM package
// runs from whatever origin the LMS unpacks it to, and may run with no
// network at all.
const anatomyDir = path.join(here, "..", "..", "public", "anatomy");
const heartBin = path.join(anatomyDir, "heart.bin");
if (!existsSync(heartBin)) {
  throw new Error(
    `missing ${heartBin} — run the anatomy pipeline (bp3d/pipeline/build.py) first`
  );
}
await cp(heartBin, path.join(out, "assets", "heart.bin"));

// Only the heart's entry, so the package does not carry a manifest listing
// ten structures it has no files for.
const full = JSON.parse(await readFile(path.join(anatomyDir, "manifest.json"), "utf8"));
if (!full.structures?.heart) {
  throw new Error("anatomy manifest has no heart structure");
}
await writeFile(
  path.join(out, "assets", "anatomy.json"),
  JSON.stringify(
    { ...full, structures: { heart: full.structures.heart } },
    null,
    1
  )
);
await cp(
  path.join(anatomyDir, "ATTRIBUTION.txt"),
  path.join(out, "assets", "ATTRIBUTION.txt")
);

// Guard the self-contained promise: fail the build rather than ship a
// package that silently reaches out to the network.
const html = await readFile(path.join(out, "index.html"), "utf8");
const js = await readFile(path.join(out, "assets", "course.js"), "utf8");
const external = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\//gi)];
if (external.length) {
  throw new Error(`index.html references external resources: ${external.map((m) => m[0]).join(", ")}`);
}
for (const [label, text] of [["course.js", js]]) {
  if (/\bfetch\(\s*["']https?:/.test(text) || /importScripts\(/.test(text)) {
    throw new Error(`${label} appears to fetch an external resource`);
  }
}

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`bundled ${(bytes / 1024).toFixed(0)} kB of JS`);

if (process.argv.includes("--zip")) {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const zip = path.join(here, "echocardiographic-windows.zip");
  if (existsSync(zip)) await rm(zip);
  // Zip the CONTENTS of package/, not the folder: SCORM requires
  // imsmanifest.xml at the archive root.
  await run("zip", ["-r", "-q", zip, "."], { cwd: out });
  console.log(`wrote ${path.relative(process.cwd(), zip)}`);
}
