#!/usr/bin/env python3
"""
BodyParts3D OBJ meshes -> compact binary assets for the holographic page.

Ships meshes rather than baked point clouds. A cloud fixes one density at
build time; a mesh lets the renderer scatter as many particles as the active
quality tier calls for, which is what makes the low/medium/high budgets mean
anything. Quantised to int16 it is also several times smaller.

Per structure:
  <id>.bin   int16 positions, then uint16/uint32 triangle indices
  manifest.json  dequantisation bounds, counts, surface area, bbox

Coordinates convert from BodyParts3D (millimetres, +X left, -Y anterior,
+Z superior, origin near the soles) to the engine's convention (metres,
+Y up, +Z anterior) and are recentred on BODY_Y_OFFSET.
"""
import json, os, re, struct, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from groups import GROUPS, EXCLUDE, REGION_RULES

BODY_Y_OFFSET = 1.0
TARGET_HEIGHT = 1.76  # metres, the figure the engine's camera framing assumes


# ---------------------------------------------------------------- loading

def load_obj(path):
    vs, fs = [], []
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                p = line.split()
                vs.append((float(p[1]), float(p[2]), float(p[3])))
            elif line.startswith("f "):
                ix = [int(t.split("/")[0]) for t in line.split()[1:]]
                ix = [i - 1 if i > 0 else len(vs) + i for i in ix]
                for k in range(1, len(ix) - 1):
                    fs.append((ix[0], ix[k], ix[k + 1]))
    return np.asarray(vs, np.float64), np.asarray(fs, np.int64).reshape(-1, 3)


def concat(parts):
    vs, fs, off = [], [], 0
    for v, f in parts:
        if len(v) == 0:
            continue
        vs.append(v)
        if len(f):
            fs.append(f + off)
        off += len(v)
    if not vs:
        return np.zeros((0, 3)), np.zeros((0, 3), np.int64)
    return np.vstack(vs), (np.vstack(fs) if fs else np.zeros((0, 3), np.int64))


# ------------------------------------------------------------ lung hulls

def reconstruct_hull(verts, pad, smooth, iso, split_lr, grid=96):
    """
    Build a closed surface around a set of points.

    The part_of dataset has no lung parenchyma — only the bronchial and
    vascular trees that permeate it. Those trees do fill the lung volume,
    though, so painting them into an occupancy grid, blurring, and taking an
    isosurface recovers a lung-shaped envelope around them. Left and right
    are gridded separately or the mediastinum bridges into one mass.

    This is a reconstruction, not anatomy. It is used for the lung envelope
    alone, where the alternative is a bare tree floating in the chest.
    """
    from scipy.ndimage import gaussian_filter
    from skimage.measure import marching_cubes

    groups = []
    if split_lr:
        # +X is the subject's left in this dataset; the mediastinum sits at 0.
        groups = [verts[verts[:, 0] >= 0], verts[verts[:, 0] < 0]]
    else:
        groups = [verts]

    out = []
    for pts in groups:
        if len(pts) < 200:
            continue
        lo = pts.min(0) - pad * 2.5
        hi = pts.max(0) + pad * 2.5
        span = hi - lo
        step = span.max() / grid
        dims = np.maximum(np.ceil(span / step).astype(int) + 1, 4)

        vol = np.zeros(dims, np.float32)
        ijk = np.clip(((pts - lo) / step).astype(int), 0, dims - 1)
        vol[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = 1.0
        vol = gaussian_filter(vol, sigma=smooth / step)
        if vol.max() <= 0:
            continue
        vol /= vol.max()
        # Zero the border so marching cubes always closes the surface.
        vol[0, :, :] = vol[-1, :, :] = 0
        vol[:, 0, :] = vol[:, -1, :] = 0
        vol[:, :, 0] = vol[:, :, -1] = 0
        try:
            v, f, _, _ = marching_cubes(vol, level=iso)
        except (ValueError, RuntimeError):
            continue
        out.append((v * step + lo, f.astype(np.int64)))
    return concat(out)


# ------------------------------------------------------------ decimation

def _cluster(verts, faces, res, span, lo):
    cell = span / res
    key = np.floor((verts - lo) / cell).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    nf = inv[faces]
    keep = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 0] != nf[:, 2])
    src = np.flatnonzero(keep)
    uniq, first = np.unique(np.sort(nf[keep], axis=1), axis=0, return_index=True)
    return inv, uniq, src[first]


def decimate(verts, faces, target):
    """Returns (verts, faces, source_face_index)."""
    """
    Vertex clustering, with the grid resolution found by bisection.

    Clustering is chosen over quadric edge collapse on purpose: these meshes
    exist only as a surface to scatter points across, so the silhouette
    matters and crisp edges do not. It needs no connectivity and has no
    degenerate cases.

    The resolution has to be searched rather than guessed. A fixed starting
    grid that suits the skin is coarse enough to collapse the arterial tree
    into blobs — the same cell size that barely touches a torso-sized surface
    swallows a 2 mm vessel whole. Bisecting for the finest grid that still
    lands under the triangle budget spends the budget where the detail is.
    """
    if len(faces) <= target or len(verts) == 0:
        return verts, faces, np.arange(len(faces))
    lo, hi = verts.min(0), verts.max(0)
    span = float((hi - lo).max()) or 1.0

    best = None
    low, high = 8.0, 2048.0
    for _ in range(13):
        mid = (low + high) / 2
        inv, nf, src = _cluster(verts, faces, mid, span, lo)
        if len(nf) <= target:
            best = (mid, inv, nf, src)
            low = mid          # finer is still affordable
        else:
            high = mid
        if high - low < 1.0:
            break
    if best is None:
        best = (8.0,) + _cluster(verts, faces, 8.0, span, lo)

    _, inv, nf, src = best
    n = int(inv.max()) + 1
    sums = np.zeros((n, 3))
    np.add.at(sums, inv, verts)
    counts = np.bincount(inv, minlength=n).reshape(-1, 1)
    nv = sums / counts                  # centroid, not an arbitrary member
    used, remap = np.unique(nf, return_inverse=True)
    return nv[used], remap.reshape(-1, 3), src


def exterior_mask(verts, faces, skin_cells=2.2, grid=224):
    """
    Which triangles lie on or near the structure's outer surface.

    Additive blending sums every surface along a view ray, so geometry
    buried inside the organ contributes light and nothing else. The heart is
    the clearest case: its chamber cavities, valve leaflets and septa sit
    within the myocardium, and scattering particles over them fills the
    silhouette with a solid glow that hides the shape of the organ. The
    liver's Couinaud segments do the same along the faces where they abut.

    Flood-filling the air around the structure does not separate them: the
    chamber cavities open to the outside through the valve orifices and
    vessel stubs, so the fill reaches them and calls them exterior. What
    does separate them is depth. The structure is voxelised, its interior
    filled in, and a distance transform run over the result; a triangle is
    exterior when it sits within a few millimetres of the outer boundary.
    The cavity surfaces are a centimetre inside the muscle and fall out.

    The depth threshold is measured in grid cells rather than millimetres,
    so it scales with the structure: a couple of cells is ~2 mm on a heart
    and ~17 mm on a whole figure, which is the right answer in both cases.
    """
    from scipy.ndimage import binary_fill_holes, distance_transform_edt

    if len(faces) == 0:
        return np.zeros(0, bool)
    lo = verts.min(0)
    hi = verts.max(0)
    span = (hi - lo).max() or 1.0
    cell = span / grid
    dims = np.maximum(np.ceil((hi - lo) / cell).astype(int) + 5, 8)

    tri = verts[faces]
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    # Seven samples per triangle. Filling each triangle's bounding box
    # instead would thicken the surface to several cells and close the gaps
    # the transform has to measure across.
    samples = [a, b, c, (a + b) / 2, (b + c) / 2, (a + c) / 2, (a + b + c) / 3]

    def cells(points):
        return np.clip(((points - lo) / cell).astype(int) + 2, 0, dims - 1)

    occupied = np.zeros(dims, bool)
    for pts in samples:
        ix = cells(pts)
        occupied[ix[:, 0], ix[:, 1], ix[:, 2]] = True

    solid = binary_fill_holes(occupied)
    # Distance from each solid cell to the nearest cell of outside air.
    dist = distance_transform_edt(solid) * cell

    limit = skin_cells * cell
    best = np.full(len(faces), np.inf)
    for pts in samples:
        ix = cells(pts)
        best = np.minimum(best, dist[ix[:, 0], ix[:, 1], ix[:, 2]])
    return best <= limit


def projected_area(verts, faces, axis, grid=512):
    """Silhouette area along one axis, by rasterising triangle bounding boxes."""
    if len(faces) == 0:
        return 0.0
    u, v = [a for a in (0, 1, 2) if a != axis]
    pu, pv = verts[:, u], verts[:, v]
    lo = np.array([pu.min(), pv.min()])
    hi = np.array([pu.max(), pv.max()])
    span = (hi - lo).max() or 1.0
    cell = span / grid
    mask = np.zeros((grid + 2, grid + 2), bool)
    tu = pu[faces]
    tv = pv[faces]
    i0 = np.clip(((tu.min(1) - lo[0]) / cell).astype(int), 0, grid)
    i1 = np.clip(((tu.max(1) - lo[0]) / cell).astype(int), 0, grid)
    j0 = np.clip(((tv.min(1) - lo[1]) / cell).astype(int), 0, grid)
    j1 = np.clip(((tv.max(1) - lo[1]) / cell).astype(int), 0, grid)
    for a, b, c, d in zip(i0, i1, j0, j1):
        mask[a:b + 1, c:d + 1] = True
    return float(mask.sum()) * cell * cell


def crossings(verts, faces, axis, grid=256):
    """
    Surfaces crossed per view ray along one axis, as a 2D map.

    Each triangle deposits its projected area into the cell under its
    centroid, divided by the cell's own area, so a cell's value is the
    number of surface layers a ray through it passes through.
    """
    u, v = [a for a in (0, 1, 2) if a != axis]
    tri = verts[faces]
    centre = tri.mean(1)
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    n = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(n, axis=1)
    # Area as seen down this axis, not the triangle's own area: a face edge-on
    # to the viewer blocks nothing.
    norm = np.linalg.norm(n, axis=1)
    proj = area * np.abs(n[:, axis]) / np.where(norm > 0, norm, 1)

    lo = np.array([verts[:, u].min(), verts[:, v].min()])
    hi = np.array([verts[:, u].max(), verts[:, v].max()])
    span = (hi - lo).max() or 1.0
    cell = span / grid
    ix = np.clip(((centre[:, u] - lo[0]) / cell).astype(int), 0, grid)
    iy = np.clip(((centre[:, v] - lo[1]) / cell).astype(int), 0, grid)
    acc = np.zeros((grid + 1, grid + 1))
    np.add.at(acc, (ix, iy), proj)
    return acc / (cell * cell)


def depth_complexity(verts, faces, percentile=90):
    """
    How many surfaces a view ray crosses through the busiest part of the
    structure, relative to a simple closed shape.

    This is what keeps the organs at a consistent brightness. Particles are
    drawn with additive blending, so what reaches a pixel is the sum over
    every surface behind it. Spreading points by surface area alone assumes
    there is one: true for the skin, false for a heart, whose chamber
    cavities, walls, valve leaflets and vessel stubs stack along the same
    ray, and false for a brain with its folded cortex and internal nuclei.

    The figure that matters is the high end, not the average. Additive
    blending has no shoulder, so what clips is the thickest part of the
    organ; correcting to the mean leaves a heart with white in the middle
    and correct edges, which is what an earlier version of this did. The
    90th percentile over the occupied cells, averaged across three
    orthogonal views and halved so a closed convex shape scores 1, tracks
    the clipping directly.
    """
    if len(faces) == 0:
        return 1.0
    peaks = []
    for axis in (0, 1, 2):
        acc = crossings(verts, faces, axis)
        hit = acc[acc > 0.05]
        if hit.size:
            peaks.append(float(np.percentile(hit, percentile)))
    if not peaks:
        return 1.0
    return max(1.0, (sum(peaks) / len(peaks)) / 2.0)


def surface_area(verts, faces):
    if len(faces) == 0:
        return 0.0
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    return float(0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum())


# -------------------------------------------------------------- encoding

def region_tags(group, meshes, names):
    """
    One region id per triangle, from the name of the leaf mesh it came from.

    The cardiac animation contracts the ventricles against a nearly static
    atrial roof, so the renderer needs to know which chamber each particle
    belongs to. Deriving that from geometry alone is guesswork; the source
    mesh names state it outright, so the tag is baked here and the shader
    just reads it.
    """
    rules = REGION_RULES.get(group["id"])
    if not rules:
        return None
    tags = []
    for (v, f), name in zip(meshes, names):
        rid = 0
        for pattern, value in rules:
            if pattern.search(name):
                rid = value
                break
        tags.append(np.full(len(f), rid, np.uint8))
    return np.concatenate(tags) if tags else None


def write_bin(path, verts, faces, regions=None):
    lo = verts.min(0)
    hi = verts.max(0)
    scale = np.maximum((hi - lo) / 65534.0, 1e-9)
    q = np.clip(np.round((verts - lo) / scale) - 32767, -32768, 32767).astype("<i2")
    wide = len(verts) > 65535
    idx = faces.astype("<u4" if wide else "<u2")
    blob = q.tobytes() + idx.tobytes()
    if regions is not None:
        blob += np.asarray(regions, np.uint8).tobytes()
    with open(path, "wb") as fh:
        fh.write(blob)
    return dict(
        verts=int(len(verts)), tris=int(len(faces)),
        lo=[round(float(v), 6) for v in lo],
        scale=[float(v) for v in scale],
        index=32 if wide else 16,
        regions=regions is not None,
        bytes=len(blob),
        bbox=[[round(float(v), 4) for v in lo], [round(float(v), 4) for v in hi]],
    )


# ------------------------------------------------------------------ main

def centre_of(rows):
    pts = np.array([[(r["lo"][i] + r["hi"][i]) / 2 for i in range(3)] for r in rows])
    return pts.mean(0)


def clip_to_sphere(verts, faces, centre, radius):
    """Keep only the triangles whose centre lies within radius of a point."""
    if len(faces) == 0:
        return verts, faces
    mid = verts[faces].mean(axis=1)
    keep = np.linalg.norm(mid - centre, axis=1) <= radius
    v, f = compact(verts, faces[keep])
    return v, f, keep


def compact(verts, faces):
    """Drop vertices no triangle references, and reindex."""
    if len(faces) == 0:
        return verts[:0], faces
    used, remap = np.unique(faces, return_inverse=True)
    return verts[used], remap.reshape(-1, 3)


def select(group, rows):
    core, extras = [], []
    for r in rows:
        n = r["name"]
        if EXCLUDE.search(n):
            continue
        m = bool(group["match"].search(n))
        e = bool(group.get("extra") and group["extra"].search(n))
        if not (m or e):
            continue
        if group.get("reject") and group["reject"].search(n) and not (e and not m):
            continue
        if group.get("zmin") and (r["lo"][2] + r["hi"][2]) / 2 < group["zmin"]:
            continue
        (core if m else extras).append(r)
    return core, extras


def main(src, index_path, out_dir, tri_scale="1"):
    """
    tri_scale multiplies every structure's triangle budget.

    The particle renderer samples points over these surfaces, so facets are
    invisible to it and 1x is plenty. Drawing the same meshes as shaded
    surfaces exposes every facet, and needs roughly 4x. Both sets are built:
    the small one loads at boot for the figure, the large one loads for one
    organ at a time when it is focused.
    """
    scale = float(tri_scale)
    rows = [r for r in json.load(open(index_path)) if r.get("name")]
    os.makedirs(out_dir, exist_ok=True)

    zmin = min(r["lo"][2] for r in rows)
    zmax = max(r["hi"][2] for r in rows)
    mpu = TARGET_HEIGHT / (zmax - zmin)
    print("BP3D height %.1f mm -> %.6f m/unit" % (zmax - zmin, mpu))

    manifest = {
        "generator": "bp3d/pipeline/build.py",
        "triScale": scale,
        "source": "BodyParts3D 4.0 part_of, 99% reduced",
        "attribution": "BodyParts3D, (c) The Database Center for Life Science "
                       "licensed under CC Attribution-Share Alike 2.1 Japan",
        "space": {"units": "metres", "up": "+Y", "anterior": "+Z",
                  "metresPerUnit": mpu, "bodyYOffset": BODY_Y_OFFSET},
        "structures": {},
    }

    for g in GROUPS:
        core, extras = select(g, rows)
        sel = core + extras
        if not sel:
            print("  %-10s nothing matched" % g["id"])
            continue
        core_meshes = [load_obj(os.path.join(src, r["file"])) for r in core]
        extra_meshes = [load_obj(os.path.join(src, r["file"])) for r in extras]
        core_tags = region_tags(g, core_meshes, [r["name"] for r in core])
        extra_tags = region_tags(g, extra_meshes, [r["name"] for r in extras])

        core_v, core_f = concat(core_meshes)
        extra_v, extra_f = concat(extra_meshes)

        radius = g.get("clipRadius")
        if radius and len(core_v) and len(extra_f):
            # The great vessels are what this exists for. The heart needs its
            # aortic root, arch and caval openings to read as a heart — an
            # echo module is useless without them — but the inferior vena cava
            # is one mesh running to the pelvis, which hangs a metre-long pipe
            # off the bottom of the organ. Cutting the supporting geometry to
            # a sphere around the core keeps the stubs and loses the runs.
            before_tris = len(extra_f)
            extra_v, extra_f, mask = clip_to_sphere(
                extra_v, extra_f, core_v.mean(0), radius)
            if extra_tags is not None:
                extra_tags = extra_tags[mask]
            print("  %-10s clipped supporting geometry %d -> %d tris"
                  % (g["id"], before_tris, len(extra_f)))

        verts, faces = concat([(core_v, core_f), (extra_v, extra_f)])
        tags = None
        if core_tags is not None:
            tags = np.concatenate([core_tags, extra_tags]) if extra_tags is not None else core_tags

        if g.get("hull"):
            h = g["hull"]
            hv, hf = reconstruct_hull(verts, h["pad"], h["smooth"], h["iso"],
                                      h["split_lr"], h.get("grid", 96))
            if len(hf):
                hv, hf, _ = decimate(hv, hf, int(h["tris"] * scale))
                print("  %-10s hull %d tris from %d points"
                      % (g["id"], len(hf), len(verts)))
                nf_before = len(faces)
                verts, faces = concat([(verts, faces), (hv, hf)])
                if tags is not None:
                    tags = np.concatenate([tags, np.zeros(len(faces) - nf_before, np.uint8)])

        # BP3D -> engine space.
        xyz = np.empty_like(verts)
        xyz[:, 0] = verts[:, 0] * mpu
        xyz[:, 1] = verts[:, 2] * mpu - zmin * mpu - BODY_Y_OFFSET
        xyz[:, 2] = -verts[:, 1] * mpu
        before = len(faces)
        xyz, faces, src_face = decimate(xyz, faces, int(g["tris"] * scale))
        if tags is not None:
            tags = tags[src_face]

        meta = write_bin(os.path.join(out_dir, g["id"] + ".bin"), xyz, faces, tags)
        meta.update(label=g["label"], sources=len(sel), sourceTris=int(before),
                    area=round(surface_area(xyz, faces), 5),
                    depth=round(depth_complexity(xyz, faces), 4))
        if g.get("note"):
            meta["note"] = g["note"]
        if g.get("hull"):
            meta["reconstructed"] = True
        manifest["structures"][g["id"]] = meta
        print("  %-10s %4d meshes  %7d -> %6d tris  %7.1f KB  area %.3f m2  depth %.2f"
              % (g["id"], len(sel), before, meta["tris"], meta["bytes"] / 1024,
                 meta["area"], meta["depth"]))

    json.dump(manifest, open(os.path.join(out_dir, "manifest.json"), "w"), indent=1)
    total = sum(s["bytes"] for s in manifest["structures"].values())
    print("\n%d structures, %.0f KB total" % (len(manifest["structures"]), total / 1024))


if __name__ == "__main__":
    main(*sys.argv[1:5])
