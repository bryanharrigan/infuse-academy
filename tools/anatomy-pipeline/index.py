#!/usr/bin/env python3
"""
Index a BodyParts3D partof OBJ directory.

Every file carries its own "Representation ID : BPxxxx" in the header, so the
directory is self-describing once paired with the published parts list. This
reads only the headers plus a cheap geometric summary, and writes one JSON
index the rest of the pipeline works from.
"""
import json, os, sys, re

REP = re.compile(r"Representation ID\s*:\s*(BP\d+)")
FID = re.compile(r"File ID\s*:\s*(FJ\d+)")

def summarise(path):
    rep = fid = None
    nv = nf = 0
    lo = [1e18] * 3
    hi = [-1e18] * 3
    with open(path, "r", errors="replace") as fh:
        for line in fh:
            if line.startswith("#"):
                if rep is None:
                    m = REP.search(line)
                    if m: rep = m.group(1)
                if fid is None:
                    m = FID.search(line)
                    if m: fid = m.group(1)
            elif line.startswith("v "):
                p = line.split()
                nv += 1
                for i in range(3):
                    c = float(p[i + 1])
                    if c < lo[i]: lo[i] = c
                    if c > hi[i]: hi[i] = c
            elif line.startswith("f "):
                nf += 1
    return {
        "file": os.path.basename(path), "rep": rep, "fid": fid,
        "verts": nv, "faces": nf,
        "lo": [round(v, 2) for v in lo], "hi": [round(v, 2) for v in hi],
        "size": [round(hi[i] - lo[i], 2) for i in range(3)],
        "centre": [round((hi[i] + lo[i]) / 2, 2) for i in range(3)],
    }

def main(src, out):
    rows = []
    names = sorted(n for n in os.listdir(src) if n.endswith(".obj"))
    for i, n in enumerate(names):
        try:
            rows.append(summarise(os.path.join(src, n)))
        except Exception as e:
            print("  skip", n, e, file=sys.stderr)
        if (i + 1) % 200 == 0:
            print("  indexed %d/%d" % (i + 1, len(names)), file=sys.stderr)
    json.dump(rows, open(out, "w"))
    print("indexed %d meshes -> %s" % (len(rows), out))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
