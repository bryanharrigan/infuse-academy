# Shading preview

Offline particle renderer for comparing shading models before committing one
to the WebGL shader.

It reads the same `public/anatomy/*.bin` the site serves, scatters points the
same way the browser does, and splats them additively — so the output is a
faithful preview of what the shader would produce, not a mock-up.

```bash
python3 tools/shading-preview/render.py heart liver lungs brain
# -> options.png, one row per organ, one column per model
```

Needs numpy, scipy and Pillow.

## Why it exists

Each shading model is a handful of lines, but judging one needs a picture,
and getting a picture out of the live engine means a bundle, a headless
browser and three minutes. This turns that into three seconds, which is the
difference between trying five ideas and trying one.

The models in `weights()` mirror what the shader does. If you change one
there, change it here too, or the next person will compare against a lie.

## What it showed

That the live renderer was ignoring the surface normal the sampler already
computes. Every particle was lit identically regardless of which way its
surface faced, so a closed organ summed its near wall, its far wall and
everything between into one undifferentiated mass. Weighting by the normal —
Fresnel for the edges, a key light for the faces, and a gentle hold-back for
surfaces turned away — is what `rim+light` in this file became in the shader.

It also showed the limit. Organs whose detail is coarse relative to their
size on screen (liver, lungs, kidneys, skeleton) resolve well. The heart and
the brain carry the most interior surface — depth complexity 21.8 and 37.6
against the skin's 7.0 — and at the size they are displayed, their internal
structure falls below the particle spacing. Shading alone does not recover
them; that needs either a tighter camera or culling occluded geometry in the
asset pipeline.
