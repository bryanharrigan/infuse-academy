# Anatomy pipeline

Turns the BodyParts3D mesh release into the binary assets the Holographic
page scatters particles over (`public/anatomy/*.bin`).

This runs **offline, by hand**, when the structures or their budgets change.
It is not part of `npm run build` — the output is committed, because the
inputs are a 218 MB download that has nothing to do with deploying the site.

## Input

[BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html)
4.0, the `part_of` build at 99% polygon reduction:
`partof_BP3D_4.0_obj_99.zip` — 1,258 OBJ files, one per anatomical leaf.

Each file states its own identity in its header (`English name`,
`Concept ID`, `Representation ID`), so no separate parts list is needed.

## Running it

```bash
unzip partof_BP3D_4.0_obj_99.zip -d /tmp/bp3d
python3 tools/anatomy-pipeline/index.py /tmp/bp3d/partof_BP3D_4.0_obj_99 /tmp/bp3d/index.json
python3 tools/anatomy-pipeline/build.py /tmp/bp3d/partof_BP3D_4.0_obj_99 /tmp/bp3d/index.json public/anatomy
node --experimental-strip-types test/anatomy.test.mjs
```

Needs numpy, scipy and scikit-image.

## What it does

1. **Groups** the leaves into display structures by matching their English
   names (`groups.py`). Matching is on whole words — substring matching puts
   the liver's venous tree in the skeleton, because "tributary" contains
   "rib".
2. **Clips** supporting geometry to a sphere around each structure's core.
   The heart needs its aortic root and arch to read as a heart, but the
   inferior vena cava is one mesh that runs to the pelvis.
3. **Reconstructs** the lung envelope. The `part_of` release has no lung
   parenchyma, only the bronchial and vascular trees that fill it, so those
   are painted into an occupancy grid, blurred, and an isosurface taken.
   Left and right are gridded separately or the mediastinum bridges them
   into one mass. This is the only reconstructed surface; everything else,
   the liver's Couinaud segments included, is scanned anatomy.
4. **Converts** millimetres / Z-up / −Y-anterior into metres / Y-up /
   +Z-anterior, with the soles at `y = −BODY_Y_OFFSET`.
5. **Decimates** by vertex clustering, with the grid resolution bisected per
   structure. A fixed grid that suits the skin collapses the arterial tree
   into blobs.
6. **Quantises** positions to int16 over each structure's own bounding box —
   about 30 µm of error at body scale, well under the particle radius.
7. **Tags** heart triangles by chamber, so the cardiac animation can
   contract the ventricles against a static atrial roof.

## Licence

See `public/anatomy/ATTRIBUTION.txt`. The website says CC BY 4.0; the file
headers say CC BY-SA 2.1 Japan. Settle which applies before these assets go
anywhere commercial.
