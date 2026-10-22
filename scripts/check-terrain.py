#!/usr/bin/env python3
"""Sanity-check a terrarium terrain MBTiles before converting or uploading it.

Reads the intermediate MBTiles written by generate-terrain-tiles.sh and reports:

  1. metadata     — name, attribution, bounds (set by the script's metadata step)
  2. coverage     — tile count and lon/lat extent per zoom level
  3. spot heights — the highest decoded point within 1.5 km of known summits
                    inside the coverage, plus a sea point that should decode to
                    0 (the nodata fill)
  4. spike scan   — the largest jump between neighbouring pixels in a sample
                    of max-zoom tiles. Resampling *encoded* terrarium corrupts
                    heights at 256 m boundaries; that shows up here as jumps of
                    100+ m between adjacent ~38 m pixels.

Standard library only — no GDAL, Pillow or numpy needed.

Usage:
  python3 scripts/check-terrain.py datasets/tmp/australia-terrain-test.mbtiles
  python3 scripts/check-terrain.py datasets/tmp/australia-terrain.mbtiles --sample 40
  python3 scripts/check-terrain.py FILE --at -36.4559,148.2636   # extra points
"""

import argparse
import math
import random
import sqlite3
import struct
import sys
import zlib

# Summit coordinates (to the nearest arc-minute or so) and heights. The check
# takes the highest point within SUMMIT_RADIUS_KM, so the coordinates needn't be
# exact. Copernicus is a surface model — trees and resampling move it a few tens
# of metres either way.
SUMMIT_RADIUS_KM = 1.5
SUMMIT_TOLERANCE_M = 100
SPOT_HEIGHTS = [
    ("Mount Kosciuszko", -36.4559, 148.2633, 2228),
    ("Mount Hotham", -36.9772, 147.1339, 1861),
    ("The Horn (Buffalo)", -36.7667, 146.7667, 1723),  # inside the --test tile
    ("Mount Ossa (Tas)", -41.8708, 146.0333, 1617),
    ("Bartle Frere (Qld)", -17.3833, 145.8167, 1611),
    ("Mount Zeil (NT)", -23.4008, 132.3928, 1531),
    ("Bluff Knoll (WA)", -34.3753, 118.2503, 1099),
    ("Uluru", -25.3444, 131.0369, 863),
]
SEA_POINTS = [
    ("Tasman Sea", -38.5, 150.5),  # no DEM tile here, so it must be the 0 fill
]


# ── PNG decoding ────────────────────────────────────────────────────────────

def decode_png(data):
    """Return (width, height, channels, pixel bytes) for an 8-bit RGB/RGBA PNG."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat = 8, []
    width = height = channels = None
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, colour = struct.unpack(">IIBB", body[:10])
            if depth != 8 or colour not in (2, 6):
                raise ValueError("unsupported PNG: depth %d colour type %d" % (depth, colour))
            channels = 3 if colour == 2 else 4
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
        pos += 12 + length

    raw = zlib.decompress(b"".join(idat))
    stride = width * channels
    out = bytearray(stride * height)
    prev = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        ftype = raw[start]
        line = bytearray(raw[start + 1:start + 1 + stride])
        if ftype == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return width, height, channels, out


def elevations(data):
    """Decode a terrarium PNG to (width, height, flat list of metres)."""
    w, h, ch, px = decode_png(data)
    return w, h, [
        px[i] * 256 + px[i + 1] + px[i + 2] / 256.0 - 32768
        for i in range(0, len(px), ch)
    ]


# ── Tile maths ──────────────────────────────────────────────────────────────

def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    fx = (lon + 180.0) / 360.0 * n
    r = math.radians(lat)
    fy = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n
    return fx, fy


def tile_lon(x, z):
    return x / 2.0 ** z * 360.0 - 180.0


def tile_lat(y, z):
    n = math.pi - 2.0 * math.pi * y / 2.0 ** z
    return math.degrees(math.atan(math.sinh(n)))


def get_tile(db, z, x, y):
    row = db.execute(
        "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
        (z, x, 2 ** z - 1 - y),  # MBTiles rows are TMS: flipped relative to XYZ
    ).fetchone()
    return row[0] if row else None


def elevation_at(db, z, lon, lat):
    fx, fy = lonlat_to_tile(lon, lat, z)
    x, y = int(fx), int(fy)
    data = get_tile(db, z, x, y)
    if data is None:
        return None
    w, h, elev = elevations(data)
    px, py = min(int((fx - x) * w), w - 1), min(int((fy - y) * h), h - 1)
    return elev[py * w + px]


def highest_near(db, z, lon, lat, radius_km):
    """Highest decoded point within radius_km, looking only in the point's own tile."""
    fx, fy = lonlat_to_tile(lon, lat, z)
    x, y = int(fx), int(fy)
    data = get_tile(db, z, x, y)
    if data is None:
        return None
    w, h, elev = elevations(data)
    km_x = 40075.0 * math.cos(math.radians(lat)) / 2 ** z / w   # km per pixel
    km_y = 40075.0 * math.cos(math.radians(lat)) / 2 ** z / h
    cx, cy = (fx - x) * w, (fy - y) * h
    rx, ry = radius_km / km_x, radius_km / km_y
    best = None
    for py in range(max(0, int(cy - ry)), min(h, int(cy + ry) + 1)):
        for px in range(max(0, int(cx - rx)), min(w, int(cx + rx) + 1)):
            if ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1:
                v = elev[py * w + px]
                best = v if best is None else max(best, v)
    return best


def max_jump(w, h, elev):
    """Largest step between neighbouring pixels, ignoring the 0 nodata fill."""
    worst = 0.0
    for y in range(h):
        row = y * w
        for x in range(w):
            v = elev[row + x]
            if v == 0:
                continue
            if x + 1 < w and elev[row + x + 1] != 0:
                worst = max(worst, abs(elev[row + x + 1] - v))
            if y + 1 < h and elev[row + w + x] != 0:
                worst = max(worst, abs(elev[row + w + x] - v))
    return worst


# ── Report ──────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("mbtiles")
    ap.add_argument("--sample", type=int, default=12, help="max-zoom tiles to spike-scan (default 12)")
    ap.add_argument("--spike", type=float, default=150.0,
                    help="neighbour jump in metres that counts as suspicious (default 150)")
    ap.add_argument("--at", action="append", default=[], metavar="LAT,LON",
                    help="extra point to report, e.g. --at -36.45,148.26")
    args = ap.parse_args()

    db = sqlite3.connect("file:%s?mode=ro" % args.mbtiles, uri=True)
    problems = []

    print("\nMetadata")
    meta = dict(db.execute("SELECT name, value FROM metadata"))
    for key in ("name", "attribution", "bounds", "center", "minzoom", "maxzoom", "format"):
        print("  %-12s %s" % (key, meta.get(key, "—")))
    for key in ("name", "attribution", "bounds"):
        if not meta.get(key):
            problems.append("metadata has no %s" % key)

    print("\nCoverage")
    print("  %4s %9s  %-20s %s" % ("zoom", "tiles", "longitude", "latitude"))
    zooms = db.execute(
        "SELECT zoom_level, COUNT(*), MIN(tile_column), MAX(tile_column), MIN(tile_row), MAX(tile_row) "
        "FROM tiles GROUP BY zoom_level ORDER BY zoom_level").fetchall()
    for z, count, x0, x1, r0, r1 in zooms:
        n = 2 ** z
        print("  %4d %9d  %7.2f .. %7.2f   %6.2f .. %6.2f" % (
            z, count, tile_lon(x0, z), tile_lon(x1 + 1, z), tile_lat(n - r0, z), tile_lat(n - 1 - r1, z)))
    total = sum(r[1] for r in zooms)
    print("  total %d tiles" % total)
    if not zooms:
        sys.exit("no tiles")
    maxz = zooms[-1][0]

    print("\nSpot heights (z%d)" % maxz)
    points = [(name, lat, lon, height, True) for name, lat, lon, height in SPOT_HEIGHTS]
    points += [(name, lat, lon, 0, False) for name, lat, lon in SEA_POINTS]
    for spec in args.at:
        lat, lon = (float(v) for v in spec.split(","))
        points.append((spec, lat, lon, None, False))
    for name, lat, lon, expected, summit in points:
        if summit:
            value = highest_near(db, maxz, lon, lat, SUMMIT_RADIUS_KM)
        else:
            value = elevation_at(db, maxz, lon, lat)
        if value is None:
            print("  %-20s not covered" % name)
            continue
        line = "  %-20s %7.1f m" % (name, value)
        if expected is not None:
            line += "   (expect ~%d)" % expected
            tolerance = SUMMIT_TOLERANCE_M if summit else 5
            if abs(value - expected) > tolerance:
                line += "   ← CHECK"
                problems.append("%s decodes to %.0f m, expected ~%d" % (name, value, expected))
        print(line)

    print("\nSpike scan (%d z%d tiles, threshold %.0f m)" % (args.sample, maxz, args.spike))
    keys = db.execute("SELECT tile_column, tile_row FROM tiles WHERE zoom_level=?", (maxz,)).fetchall()
    random.seed(0)
    for col, row in random.sample(keys, min(args.sample, len(keys))):
        y = 2 ** maxz - 1 - row
        w, h, elev = elevations(get_tile(db, maxz, col, y))
        jump = max_jump(w, h, elev)
        flag = "   ← CHECK" if jump > args.spike else ""
        print("  %d/%d/%d  min %7.1f  max %7.1f  max jump %6.1f m%s" % (maxz, col, y, min(elev), max(elev), jump, flag))
        if flag:
            problems.append("tile %d/%d/%d has a %.0f m jump between neighbouring pixels" % (maxz, col, y, jump))

    print()
    if problems:
        print("Problems:")
        for p in problems:
            print("  - " + p)
        sys.exit(1)
    print("No problems found.")


if __name__ == "__main__":
    main()
