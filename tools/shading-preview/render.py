#!/usr/bin/env python3
"""
Offline particle renderer for comparing shading models.

Reads the same binary meshes the site serves, scatters points over them the
same way the browser does, and splats them additively — so what comes out is
a faithful preview of what the WebGL shader would produce, not a mock-up.

The point of it is the one thing the live renderer does not currently do:
use the surface normal. Every particle is lit identically today, which is
why a heart reads as a luminous mass rather than as a surface.
"""
import json, sys
import numpy as np

OUT = "/home/claude/bp3d/out"


# ----------------------------------------------------------------- geometry

def load(sid):
    m = json.load(open(f"{OUT}/manifest.json"))["structures"][sid]
    raw = open(f"{OUT}/{sid}.bin", "rb").read()
    nv = m["verts"]
    q = np.frombuffer(raw, "<i2", count=nv * 3).reshape(-1, 3).astype(np.float64)
    v = (q + 32767) * np.array(m["scale"]) + np.array(m["lo"])
    it = "<u4" if m["index"] == 32 else "<u2"
    f = np.frombuffer(raw, it, count=m["tris"] * 3, offset=nv * 6).reshape(-1, 3).astype(np.int64)
    return v, f, m


def scatter(v, f, n, seed=1):
    """Area-weighted surface sampling, with the triangle normal per point."""
    rng = np.random.default_rng(seed)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    cr = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(cr, axis=1)
    pick = rng.choice(len(f), size=n, p=area / area.sum())
    u = rng.random((n, 1)); w = rng.random((n, 1))
    bad = (u + w > 1); u[bad] = 1 - u[bad]; w[bad] = 1 - w[bad]
    A, B, C = a[pick], b[pick], c[pick]
    pts = A + (B - A) * u + (C - A) * w
    nrm = cr[pick]
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    return pts, nrm


# ------------------------------------------------------------------- camera

def look_at(eye, target, up=(0, 1, 0)):
    f = target - eye; f /= np.linalg.norm(f)
    r = np.cross(f, np.asarray(up, float)); r /= np.linalg.norm(r)
    u = np.cross(r, f)
    return np.stack([r, u, -f])


def project(pts, eye, target, W, H, fov=42.0):
    R = look_at(eye, target)
    cam = (pts - eye) @ R.T
    z = -cam[:, 2]
    scale = (H / 2) / np.tan(np.radians(fov) / 2)
    x = cam[:, 0] / np.maximum(z, 1e-6) * scale + W / 2
    y = -cam[:, 1] / np.maximum(z, 1e-6) * scale + H / 2
    return x, y, z, R


# ------------------------------------------------------------------ shading

def weights(style, nrm, view, light, z, pts):
    """Per-particle brightness multiplier. One function per option."""
    ndv = np.einsum("ij,ij->i", nrm, view)          # +1 facing camera
    ndl = nrm @ light

    if style == "flat":
        # What ships today: the normal is ignored entirely, so every surface
        # along the ray contributes the same and the organ fills solid.
        return np.ones(len(nrm))

    rim = (1.0 - np.abs(ndv)) ** 2.2
    front = np.clip(ndv, 0, 1)

    if style == "rim":
        # Fresnel alone. Brightest where the surface turns away from the eye,
        # so the silhouette and every fold inside it draw themselves. This is
        # what real volumetric holograms look like, and it is the single
        # biggest change available here.
        return 0.07 + 0.93 * rim

    if style == "rim+light":
        # Fresnel for the edges, a key light for the form between them, so
        # the organ has volume rather than being a wireframe of its own
        # outline.
        return 0.07 + 0.70 * rim + 0.48 * np.clip(ndl, 0, 1)

    if style == "rim+depth":
        # Fresnel, with surfaces facing away from the eye held back. The far
        # wall of a closed organ stops summing through the near one, which is
        # the specific cause of the solid-blob look.
        return (0.07 + 0.93 * rim) * (0.22 + 0.78 * front)

    if style == "rim+slice":
        # Fresnel modulated into horizontal bands: the structure reads as a
        # stack of scan planes, which is the most overtly medical of the set.
        band = 0.45 + 0.55 * np.cos(pts[:, 1] * 520.0) ** 6
        return (0.07 + 0.93 * rim) * band

    if style == "lit":
        return 0.18 + 0.82 * np.clip(ndl, 0, 1)

    raise ValueError(style)


# ------------------------------------------------------------------ splat

def splat(x, y, w, W, H, radius_px, tint):
    """Additive accumulation of soft sprites into an RGB float buffer."""
    buf = np.zeros((H, W, 3))
    r = int(np.ceil(radius_px * 2))
    ox, oy = np.meshgrid(np.arange(-r, r + 1), np.arange(-r, r + 1))
    d2 = (ox ** 2 + oy ** 2) / max(radius_px ** 2, 1e-6)
    kern = np.clip(1.0 - d2, 0, 1) ** 2.4
    kern /= kern.sum()

    ix = np.round(x).astype(int); iy = np.round(y).astype(int)
    ok = (ix >= 0) & (ix < W) & (iy >= 0) & (iy < H)
    acc = np.zeros((H, W))
    np.add.at(acc, (iy[ok], ix[ok]), w[ok])

    from scipy.signal import fftconvolve
    img = fftconvolve(acc, kern, mode="same")
    for k in range(3):
        buf[:, :, k] = img * tint[k]
    return buf


def bloom(buf, strength=0.5, sigma=9.0, threshold=0.35):
    from scipy.ndimage import gaussian_filter
    bright = np.clip(buf - threshold, 0, None)
    return buf + gaussian_filter(bright, (sigma, sigma, 0)) * strength


def tonemap(buf, exposure=1.0):
    x = buf * exposure
    # ACES-ish, matching the renderer's filmic curve closely enough.
    a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    return np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1)


# -------------------------------------------------------------------- main

def render(sid, style, W=560, H=560, n=90000, expose=1.0):
    v, f, m = load(sid)
    pts, nrm = scatter(v, f, n)
    lo, hi = np.array(m["bbox"][0]), np.array(m["bbox"][1])
    centre = (lo + hi) / 2
    radius = 0.5 * np.linalg.norm(hi - lo)

    eye = centre + np.array([0.34, 0.14, 1.0]) / np.linalg.norm([0.34, 0.14, 1.0]) * radius * 2.5
    x, y, z, R = project(pts, eye, centre, W, H)

    view = eye - pts
    view /= np.linalg.norm(view, axis=1, keepdims=True)
    light = np.array([0.4, 0.7, 0.6]); light /= np.linalg.norm(light)

    w = weights(style, nrm, view, light, z, pts)
    # Same exposure identity the engine uses, so styles are comparable: the
    # total light is held constant and only its distribution changes.
    w = w / w.mean()

    tint = {"heart": (1.00, 0.62, 0.55), "liver": (1.00, 0.80, 0.45),
            "brain": (0.62, 0.78, 1.00), "lungs": (0.45, 0.95, 0.85),
            "kidneys": (0.75, 0.65, 1.00)}.get(sid, (0.55, 0.85, 1.00))

    buf = splat(x, y, w, W, H, radius_px=1.35, tint=tint)
    buf *= expose * 0.30
    buf = bloom(buf)
    img = tonemap(buf)
    return (img * 255).astype(np.uint8)


if __name__ == "__main__":
    from PIL import Image, ImageDraw
    styles = ["flat", "rim", "rim+light", "rim+depth", "rim+slice"]
    organs = sys.argv[1:] or ["heart", "liver", "brain"]
    pad, lab = 6, 26
    W = H = 560
    sheet = Image.new("RGB", (W * len(styles) + pad * (len(styles) - 1),
                              (H + lab) * len(organs) + pad * (len(organs) - 1)), (6, 9, 16))
    for r, sid in enumerate(organs):
        for c, st in enumerate(styles):
            im = Image.fromarray(render(sid, st))
            sheet.paste(im, (c * (W + pad), r * (H + lab + pad) + lab))
            d = ImageDraw.Draw(sheet)
            title = ("CURRENT" if st == "flat" else st.upper()) + f"   {sid}"
            d.text((c * (W + pad) + 8, r * (H + lab + pad) + 6), title, fill=(150, 200, 235))
            print(f"  {sid:9s} {st}")
    sheet.save("/home/claude/styles/options.png")
    print("wrote /home/claude/styles/options.png")
