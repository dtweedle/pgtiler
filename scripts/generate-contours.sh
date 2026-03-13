#!/usr/bin/env bash
set -euo pipefail

# Generate vector contour lines from Copernicus DEM tiles and package
# as PMTiles for Martin to serve.
#
# Pipeline:
#   1. gdal_contour per .tif tile (parallel) → GeoJSON files
#   2. tippecanoe merges all GeoJSON → vector MBTiles
#   3. pmtiles convert → contours.pmtiles
#
# Input:    datasets/sources/copernicus-dem/*.tif
# Output:   tiles/contours.pmtiles

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEM_DIR="$PROJECT_DIR/datasets/sources/copernicus-dem"
CONTOUR_DIR="$PROJECT_DIR/datasets/tmp/contours"

CONTOUR_INTERVAL=20     # metres between contour lines
MAJOR_INTERVAL=100      # metres between major (index) contour lines
MAX_PARALLEL=8          # concurrent gdal_contour containers

MBTILES_HOST="$PROJECT_DIR/datasets/tmp/contours.mbtiles"
MBTILES_CONTAINER="/data/datasets/tmp/contours.mbtiles"

PMTILES_HOST="$PROJECT_DIR/tiles/contours.pmtiles"
PMTILES_CONTAINER="/data/tiles/contours.pmtiles"

# ── Preflight checks ──────────────────────────────────────────────────────

if [[ ! -d "$DEM_DIR" ]] || [[ -z "$(ls "$DEM_DIR"/*.tif 2>/dev/null)" ]]; then
    echo "Error: No .tif files found in $DEM_DIR"
    echo "Run ./scripts/download-copernicus-dem.sh first."
    exit 1
fi

# ── Step 1: Generate contours per tile (parallel) ─────────────────────────

mkdir -p "$CONTOUR_DIR"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 1/3 — Contour Generation (parallel)"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Input:       $DEM_DIR"
echo "  Output:      $CONTOUR_DIR (one GeoJSON per tile)"
echo "  Interval:    ${CONTOUR_INTERVAL}m"
echo "  Parallel:    ${MAX_PARALLEL} containers"
echo ""
echo "  Each 1°×1° DEM tile is processed by its own gdal_contour"
echo "  container, tracing isolines and writing GeoJSON."
echo ""

tile_count=$(ls "$DEM_DIR"/*.tif | wc -l | tr -d ' ')

process_tile() {
    local tif_file="$1"
    local basename
    basename=$(basename "$tif_file" .tif)
    local container_input="/data/datasets/sources/copernicus-dem/${basename}.tif"
    local container_output="/data/datasets/tmp/contours/${basename}.geojson"
    local host_output="${CONTOUR_DIR}/${basename}.geojson"

    # Skip if already generated
    if [[ -f "$host_output" ]]; then
        echo "  · $basename (cached)"
        return
    fi

    if docker compose run --rm -T gdal \
        gdal_contour \
        -i "$CONTOUR_INTERVAL" \
        -a elevation \
        -f GeoJSON \
        "$container_input" \
        "$container_output" \
        2>/dev/null; then
        echo "  ✓ $basename"
    else
        echo "  ✗ $basename (failed)"
    fi
}
export -f process_tile
export CONTOUR_INTERVAL CONTOUR_DIR

echo "  Processing ${tile_count} tiles..."
echo ""

ls "$DEM_DIR"/*.tif | xargs -P "$MAX_PARALLEL" -I {} bash -c 'process_tile "$@"' _ {}

geojson_count=$(ls "$CONTOUR_DIR"/*.geojson 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "  Generated ${geojson_count} GeoJSON files."

# ── Step 2: Merge into vector tiles with tippecanoe ──────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 2/3 — Vector Tile Generation (tippecanoe)"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Input:  ${geojson_count} GeoJSON files"
echo "  Output: $MBTILES_HOST"
echo ""
echo "  tippecanoe reads all contour GeoJSON files, simplifies"
echo "  geometries per zoom level, and builds a vector tile pyramid."
echo "  Lines are tagged with elevation and is_major attributes."
echo ""

rm -f "$MBTILES_HOST"

docker compose run --rm tippecanoe \
    sh -c 'tippecanoe \
    -o '"$MBTILES_CONTAINER"' \
    --name="contours" \
    --layer="contours" \
    --attribution="© Copernicus DEM" \
    --minimum-zoom=8 \
    --maximum-zoom=14 \
    --simplification=4 \
    --detect-shared-borders \
    --no-feature-limit \
    --no-tile-size-limit \
    --force \
    /data/datasets/tmp/contours/*.geojson'

echo ""
echo "  MBTiles written: $MBTILES_HOST"
echo "  Size: $(du -h "$MBTILES_HOST" | cut -f1)"

# ── Step 3: Convert to PMTiles ────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 3/3 — Convert to PMTiles"
echo "════════════════════════════════════════════════════════════════════"
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
echo "  Contour tiles served at:"
echo "    http://localhost:3000/contours/{z}/{x}/{y}"
echo ""
echo "  Contour properties:"
echo "    elevation  — height in metres"
echo "    is_major   — true for every ${MAJOR_INTERVAL}m line"
echo ""
