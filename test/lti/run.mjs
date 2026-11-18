/**
 * test/lti/run.mjs
 *
 * Bundles lti.test.ts (resolving the `~` alias the app uses) and runs it.
 * Uses esbuild, which resolves from the repo's own node_modules because Vite
 * depends on it — so there is nothing extra to install and no package.json
 * change, deliberately, so running the tests never triggers an `npm ci` on
 * the origin.
 *
 * The bundle is written to the OS temp directory rather than beside this
 * file, so running the tests never leaves a build artifact in the repo and
 * .gitignore needs no entry for it.
 *
 * Run from anywhere:  node test/lti/run.mjs
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const scratch = mkdtempSync(path.join(tmpdir(), "infuse-lti-test-"));
const outfile = path.join(scratch, "bundle.mjs");

try {
  await build({
    entryPoints: [path.join(here, "lti.test.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    packages: "external",
    alias: { "~": path.join(repoRoot, "app") },
    logLevel: "warning",
  });

  await import(pathToFileURL(outfile).href);
} finally {
  // The test file calls process.exit on completion, so this runs only on the
  // failure paths. Temp dirs left behind by a successful run are harmless and
  // the OS clears them; cleaning here would race the exit.
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* nothing useful to do if the scratch dir is already gone */
  }
}
