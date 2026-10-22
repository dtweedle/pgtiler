#!/usr/bin/env bash
set -euo pipefail

# Generate RGB-encoded terrain tiles from the Copernicus DEM virtual raster.
# These tiles serve double duty in MapLibre:
#   1. Hillshade — client-side light/shadow rendering from decoded elevation
#   2. 3D terrain — mesh displacement using the same elevation data
#
# The "terrarium" encoding packs elevation into RGB channels:
#   elevation = (R × 256 + G + B / 256) - 32768
#
# Uses the gdal, rgbify and pmtiles Docker services.
# Input:    datasets/sources/australia-terrain.vrt (built by build-vrts.sh)
# Output:   tiles/squiggly.v1.terrain.pmtiles
#
# Environment:
#   RGBIFY_WORKERS  rio-rgbify worker processes (default: CPUs available to Docker)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Test mode ────────────────────────────────────────────────────────────
TEST_MODE=false
if [[ "${1:-}" == "--test" ]]; then
    TEST_MODE=true
    source "$SCRIPT_DIR/test-config.sh"
fi

if $TEST_MODE; then
    SUFFIX="$TEST_SUFFIX"
else
    SUFFIX=""
fi

VRT_HOST="$PROJECT_DIR/datasets/sources/australia-terrain${SUFFIX}.vrt"
VRT_CONTAINER="/data/datasets/sources/australia-terrain${SUFFIX}.vrt"

CLEAN_TIF_HOST="$PROJECT_DIR/datasets/tmp/australia-dem${SUFFIX}-clean.tif"
CLEAN_TIF_CONTAINER="/data/datasets/tmp/australia-dem${SUFFIX}-clean.tif"

MBTILES_CONTAINER="/data/datasets/tmp/australia-terrain${SUFFIX}.mbtiles"
MBTILES_HOST="$PROJECT_DIR/datasets/tmp/australia-terrain${SUFFIX}.mbtiles"

PMTILES_CONTAINER="/data/tiles/squiggly.v1.terrain${SUFFIX}.pmtiles"
PMTILES_HOST="$PROJECT_DIR/tiles/squiggly.v1.terrain${SUFFIX}.pmtiles"

# convert writes here first and the result is moved into tiles/ only once it is
# complete, so the archive Martin is serving stays intact until then.
STAGED_PMTILES_CONTAINER="/data/datasets/tmp/squiggly.v1.terrain${SUFFIX}.pmtiles"
STAGED_PMTILES_HOST="$PROJECT_DIR/datasets/tmp/squiggly.v1.terrain${SUFFIX}.pmtiles"

MIN_ZOOM=0
MAX_ZOOM=12

# Written into the archive metadata. rio-rgbify sets none of this itself, so
# without it TileJSON has no attribution, an empty name and whole-world bounds.
# Copernicus requires attribution; this matches the contour archive's.
ARCHIVE_NAME="squiggly.v1.terrain${SUFFIX}"
ARCHIVE_DESCRIPTION="Copernicus GLO-30 DEM, terrarium-encoded"
ATTRIBUTION="© Copernicus DEM"

# rio-rgbify encodes tiles in a pool of worker processes and defaults to 4.
# Use every CPU Docker has unless told otherwise.
if [[ -z "${RGBIFY_WORKERS:-}" ]]; then
    RGBIFY_WORKERS="$(docker info --format '{{.NCPU}}' 2>/dev/null || true)"
    [[ "$RGBIFY_WORKERS" =~ ^[0-9]+$ ]] || RGBIFY_WORKERS=4
fi

# Run inside the rgbify container (it has Python, sqlite3 and rasterio).
# Reads the clean GeoTIFF's extent and writes it, with name and attribution,
# into the MBTiles metadata table. Written to run on Python 2 or 3.
SET_METADATA_PY='
import sqlite3, sys
import rasterio

args = [a.decode("utf-8") if isinstance(a, bytes) else a for a in sys.argv[1:8]]
tif, mbtiles, name, description, attribution, minzoom, maxzoom = args

with rasterio.open(tif) as src:
    b = src.bounds
west, east = b.left, b.right
south, north = max(b.bottom, -85.0511), min(b.top, 85.0511)

meta = {
    "name": name,
    "description": description,
    "attribution": attribution,
    "bounds": "%.6f,%.6f,%.6f,%.6f" % (west, south, east, north),
    "center": "%.6f,%.6f,%d" % ((west + east) / 2, (south + north) / 2, min(int(maxzoom), 5)),
    "minzoom": minzoom,
    "maxzoom": maxzoom,
}

db = sqlite3.connect(mbtiles)
for key in sorted(meta):
    db.execute("DELETE FROM metadata WHERE name = ?", (key,))
    db.execute("INSERT INTO metadata (name, value) VALUES (?, ?)", (key, meta[key]))
    print("  set " + key)
db.commit()
db.close()
'

# ── Preflight checks ──────────────────────────────────────────────────────

if [[ ! -f "$VRT_HOST" ]]; then
    echo "Error: VRT not found at $VRT_HOST"
    echo "Run ./scripts/download-copernicus-dem.sh first."
    exit 1
fi

mkdir -p "$PROJECT_DIR/datasets/tmp"
mkdir -p "$PROJECT_DIR/tiles"

# ── Step 1: Create clean VRT with nodata ─────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 1/4 — Prepare VRT (set nodata → 0)"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  rio-rgbify doesn't respect GDAL nodata masks, so gaps in"
echo "  the VRT produce garbage floats that crash the encoder."
echo "  gdalwarp merges all tiles into a single compressed GeoTIFF"
echo "  with gaps filled to 0 (sea level)."
echo ""

rm -f "$CLEAN_TIF_HOST"

docker compose run --rm -T gdal \
    gdalwarp \
    -t_srs EPSG:4326 \
    -dstnodata 0 \
    -wo "INIT_DEST=0" \
    -co BIGTIFF=YES \
    -co COMPRESS=DEFLATE \
    -co PREDICTOR=2 \
    -co TILED=YES \
    -overwrite \
    "$VRT_CONTAINER" \
    "$CLEAN_TIF_CONTAINER"

echo "  Clean GeoTIFF written: $CLEAN_TIF_HOST"
echo "  Size: $(du -h "$CLEAN_TIF_HOST" | cut -f1)"

# ── Step 2: RGB encode → MBTiles ──────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 2/4 — RGB Terrain Encoding"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Input:    $CLEAN_TIF_HOST"
echo "  Output:   $MBTILES_HOST"
echo "  Zoom:     ${MIN_ZOOM}–${MAX_ZOOM}"
echo "  Encoding: terrarium"
echo "  Workers:  ${RGBIFY_WORKERS} (override with RGBIFY_WORKERS=N)"
echo ""
echo "  rio-rgbify reads each elevation pixel and encodes the value"
echo "  into the red, green, and blue channels of a PNG tile. This"
echo "  lets browsers decode precise elevation from standard image"
echo "  tiles without needing a special raster format."
echo ""
echo "  The tile pyramid is built from zoom ${MIN_ZOOM} (whole world in"
echo "  one tile) down to zoom ${MAX_ZOOM} (512px tiles, ~19m/pixel at the"
echo "  equator — finer than the 30m source). Each zoom level has 4x the"
echo "  tiles of the level above."
echo ""
echo "  This will take a while..."
echo ""

# Remove stale output if present
rm -f "$MBTILES_HOST"

# Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768
# rio-rgbify formula:  elevation = base_val + (R * 65536 + G * 256 + B) * interval
# So: base_val = -32768, interval = 1/256 = 0.00390625
docker compose run --rm rgbify \
    --base-val -32768 \
    --interval 0.00390625 \
    --max-z "$MAX_ZOOM" \
    --min-z "$MIN_ZOOM" \
    --format png \
    -j "$RGBIFY_WORKERS" \
    "$CLEAN_TIF_CONTAINER" \
    "$MBTILES_CONTAINER"

echo ""
echo "  MBTiles written: $MBTILES_HOST"
echo "  Size: $(du -h "$MBTILES_HOST" | cut -f1)"

# ── Step 3: Archive metadata ─────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 3/4 — Archive metadata"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  name:        $ARCHIVE_NAME"
echo "  attribution: $ATTRIBUTION"
echo "  bounds:      extent of $(basename "$CLEAN_TIF_HOST")"
echo ""
echo "  pmtiles convert carries the MBTiles metadata table across: bounds"
echo "  and center into the archive header, the rest into the JSON metadata"
echo "  that the worker builds TileJSON from."
echo ""

docker compose run --rm -T --entrypoint sh rgbify -c \
    'if command -v python3 >/dev/null 2>&1; then exec python3 "$@"; else exec python "$@"; fi' sh \
    -c "$SET_METADATA_PY" \
    "$CLEAN_TIF_CONTAINER" "$MBTILES_CONTAINER" \
    "$ARCHIVE_NAME" "$ARCHIVE_DESCRIPTION" "$ATTRIBUTION" "$MIN_ZOOM" "$MAX_ZOOM"

# ── Step 4: MBTiles → PMTiles ─────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 4/4 — Convert to PMTiles"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Input:  $MBTILES_HOST"
echo "  Output: $PMTILES_HOST"
echo ""
echo "  PMTiles is a single-file tile archive with a clustered spatial"
echo "  index. Any tile can be fetched with one HTTP range request —"
echo "  no database server needed. Martin serves PMTiles directly."
echo ""

rm -f "$STAGED_PMTILES_HOST"

# convert stages every tile in a temp file about the size of the MBTiles. Its
# default /tmp is inside Docker Desktop's VM disk (58 GB, shared with images and
# volumes), which the full Australia build overflowed at 81%. Keep it on the
# bind mount, which is the host disk.
docker compose run --rm pmtiles \
    convert --tmpdir=/data/datasets/tmp "$MBTILES_CONTAINER" "$STAGED_PMTILES_CONTAINER"

mv -f "$STAGED_PMTILES_HOST" "$PMTILES_HOST"

echo ""
echo "  PMTiles written: $PMTILES_HOST"
echo "  Size: $(du -h "$PMTILES_HOST" | cut -f1)"
echo ""
echo "  Archive header and metadata — check bounds and attribution:"
echo ""
docker compose run --rm pmtiles show "$PMTILES_CONTAINER"

# ── Summary ───────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Done"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Restart Martin to pick up the new tile source:"
echo "    docker compose restart martin"
echo ""
echo "  In MapLibre, add a raster-dem source:"
echo "    map.addSource('terrain', {"
echo "      type: 'raster-dem',"
echo "      tiles: ['http://localhost:3000/squiggly.v1.terrain${SUFFIX}/{z}/{x}/{y}'],"
echo "      encoding: 'terrarium',"
echo "      tileSize: 512"
echo "    });"
echo ""
echo "  Then use it for hillshade:"
echo "    map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'terrain' });"
echo ""
echo "  And/or 3D terrain:"
echo "    map.setTerrain({ source: 'terrain', exaggeration: 1.5 });"
echo ""
