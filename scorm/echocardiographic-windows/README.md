# Echocardiographic Windows — SCORM 1.2 module

An interactive module on the standard echo windows, built around a particle
heart that beats through the cardiac cycle and shows the ultrasound plane each
window actually cuts.

Seven sections plus a scored knowledge check: orientation and the probe
marker, the cardiac cycle, parasternal long axis, parasternal short axis,
apical four- and five-chamber, subcostal, and recovering a poor window.

## Build

```
node build.mjs --zip
```

Produces `package/` (the unpacked SCO) and `echocardiographic-windows.zip`,
which is what you upload to Absorb. The manifest sits at the archive root, as
SCORM requires. esbuild resolves from the repo's own `node_modules` — Vite
depends on it, so there is nothing extra to install.

## Test

```
NODE_PATH=../../node_modules node test/run.mjs
```

Serves the built package behind a stub SCORM 1.2 LMS in headless Chromium,
walks every section, answers the knowledge check both correctly and
incorrectly, and asserts the run-time calls: `LMSInitialize`, lesson status
transitions, `score.raw` / `score.min` / `score.max`, `lesson_location` and
`suspend_data` bookmarking (including the 4096-character limit), `LMSCommit`,
`session_time`, and `LMSFinish` on unload. It also fails the run if the
package makes any external network request. Screenshots land in `test/shots/`.

## How it fits together

| File | Role |
|---|---|
| `src/content.ts` | All clinical copy and the five assessment items. Edit the teaching content here without touching application code. |
| `src/heart-engine.ts` | The 3D heart: cardiac cycle deformation, the echo view definitions, the ultrasound sector, structure labels. |
| `src/scorm.ts` | SCORM 1.2 API discovery and wrapper. Degrades to an in-memory store when no LMS is present, so the package can be previewed standalone. |
| `src/course.ts` | Controller — rendering, navigation, the knowledge check, and reporting. |
| `build.mjs` | Bundles to a self-contained package and zips it. Fails the build if anything external sneaks in. |

Geometry comes from `app/components/holographic/anatomy.ts`, the same source
the `/holographic` route uses, so there is one definition of what a heart
looks like in this project. The `region` tags on the heart parts are what let
the ventricles, atria and great vessels contract independently.

## Absorb notes

- Upload the zip as a SCORM 1.2 course. Mastery score is 80, declared in the
  manifest and enforced in the module.
- The module reports `passed` or `failed` with a percentage score, and
  bookmarks the learner's position so a resumed attempt reopens where they
  left off.
- It is fully self-contained: no CDN, no external fonts, no network calls.
  It will run on an offline or air-gapped LMS.
