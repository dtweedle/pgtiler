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
# Uses the rgbify and pmtiles Docker services.
# Input:    datasets/sources/australia-dem.vrt (built by download-copernicus-dem.sh)
# Output:   tiles/australia-terrain.pmtiles

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VRT_HOST="$PROJECT_DIR/datasets/sources/australia-dem.vrt"
VRT_CONTAINER="/data/datasets/sources/australia-dem.vrt"

CLEAN_TIF_HOST="$PROJECT_DIR/datasets/tmp/australia-dem-clean.tif"
CLEAN_TIF_CONTAINER="/data/datasets/tmp/australia-dem-clean.tif"

MBTILES_CONTAINER="/data/datasets/tmp/australia-terrain.mbtiles"
MBTILES_HOST="$PROJECT_DIR/datasets/tmp/australia-terrain.mbtiles"

PMTILES_CONTAINER="/data/tiles/australia-terrain.pmtiles"
PMTILES_HOST="$PROJECT_DIR/tiles/australia-terrain.pmtiles"

MIN_ZOOM=0
MAX_ZOOM=12

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
echo "  Step 1/3 — Prepare VRT (set nodata → 0)"
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
echo "  Step 2/3 — RGB Terrain Encoding"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Input:    $VRT_HOST"
echo "  Output:   $MBTILES_HOST"
echo "  Zoom:     ${MIN_ZOOM}–${MAX_ZOOM}"
echo "  Encoding: terrarium"
echo ""
echo "  rio-rgbify reads each elevation pixel and encodes the value"
echo "  into the red, green, and blue channels of a PNG tile. This"
echo "  lets browsers decode precise elevation from standard image"
echo "  tiles without needing a special raster format."
echo ""
echo "  The tile pyramid is built from zoom ${MIN_ZOOM} (whole world in"
echo "  one tile) down to zoom ${MAX_ZOOM} (~38m/pixel — matching the"
echo "  30m source resolution). Each zoom level has 4x the tiles of"
echo "  the level above."
echo ""
echo "  This will take a while..."
echo ""

# Remove stale output if present
rm -f "$MBTILES_HOST"

docker compose run --rm rgbify \
    --max-z "$MAX_ZOOM" \
    --min-z "$MIN_ZOOM" \
    --format png \
    "$CLEAN_TIF_CONTAINER" \
    "$MBTILES_CONTAINER"

echo ""
echo "  MBTiles written: $MBTILES_HOST"
echo "  Size: $(du -h "$MBTILES_HOST" | cut -f1)"

# ── Step 3: MBTiles → PMTiles ─────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 3/3 — Convert to PMTiles"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Input:  $MBTILES_HOST"
echo "  Output: $PMTILES_HOST"
echo ""
echo "  PMTiles is a single-file tile archive with a clustered spatial"
echo "  index. Any tile can be fetched with one HTTP range request —"
echo "  no database server needed. Martin serves PMTiles directly."
echo ""

docker compose run --rm pmtiles \
    convert "$MBTILES_CONTAINER" "$PMTILES_CONTAINER"

echo ""
echo "  PMTiles written: $PMTILES_HOST"
echo "  Size: $(du -h "$PMTILES_HOST" | cut -f1)"

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
echo "      tiles: ['http://localhost:3000/australia-terrain/{z}/{x}/{y}'],"
echo "      encoding: 'terrarium',"
echo "      tileSize: 256"
echo "    });"
echo ""
echo "  Then use it for hillshade:"
echo "    map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'terrain' });"
echo ""
echo "  And/or 3D terrain:"
echo "    map.setTerrain({ source: 'terrain', exaggeration: 1.5 });"
echo ""
