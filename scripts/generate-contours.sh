#!/usr/bin/env bash
set -euo pipefail

# Generate vector contour lines from Copernicus DEM tiles and package
# as PMTiles for Martin to serve.
#
# Pipeline:
#   1. gdalwarp upsamples each .tif 3× with cubic spline → smoothed .tif
#   2. gdal_contour per smoothed tile (parallel) → GeoJSON files
#   3. tippecanoe merges all GeoJSON → vector MBTiles
#   4. pmtiles convert → contours.pmtiles
#
# Input:    datasets/sources/copernicus-dem/*.tif
# Output:   tiles/contours.pmtiles

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

DEM_DIR="$PROJECT_DIR/datasets/sources/copernicus-dem"
SMOOTH_DIR="$PROJECT_DIR/datasets/tmp/smoothed-dem${SUFFIX}"
CONTOUR_DIR="$PROJECT_DIR/datasets/tmp/contours${SUFFIX}"

CONTOUR_INTERVAL=20     # metres between contour lines
MAJOR_INTERVAL=100      # metres between major (index) contour lines
SMOOTH_FACTOR=3         # upsample factor (3× = ~10m resolution) for smoother contours
MAX_PARALLEL=8          # concurrent gdal_contour containers

MBTILES_HOST="$PROJECT_DIR/datasets/tmp/contours${SUFFIX}.mbtiles"
MBTILES_CONTAINER="/data/datasets/tmp/contours${SUFFIX}.mbtiles"

PMTILES_HOST="$PROJECT_DIR/tiles/squiggly.v1.contours${SUFFIX}.pmtiles"
PMTILES_CONTAINER="/data/tiles/squiggly.v1.contours${SUFFIX}.pmtiles"

# ── Preflight checks ──────────────────────────────────────────────────────

if [[ ! -d "$DEM_DIR" ]] || [[ -z "$(ls "$DEM_DIR"/*.tif 2>/dev/null)" ]]; then
    echo "Error: No .tif files found in $DEM_DIR"
    echo "Run ./scripts/download-copernicus-dem.sh first."
    exit 1
fi

# ── Step 1: Generate contours per tile (parallel) ─────────────────────────

mkdir -p "$SMOOTH_DIR" "$CONTOUR_DIR"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 1/4 — Smooth & Contour (parallel)"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Input:       $DEM_DIR"
echo "  Output:      $CONTOUR_DIR (one GeoJSON per tile)"
echo "  Interval:    ${CONTOUR_INTERVAL}m"
echo "  Smoothing:   ${SMOOTH_FACTOR}× upsample with cubic spline"
echo "  Parallel:    ${MAX_PARALLEL} containers"
echo ""
echo "  Each 1°×1° DEM tile is upsampled ${SMOOTH_FACTOR}× with cubic spline"
echo "  interpolation to produce smoother contour lines, then processed"
echo "  by gdal_contour."
echo ""

if $TEST_MODE; then
    tile_files=("$DEM_DIR/${TEST_TILE}.tif")
else
    tile_files=("$DEM_DIR"/*.tif)
fi
tile_count=${#tile_files[@]}

process_tile() {
    local tif_file="$1"
    local basename
    basename=$(basename "$tif_file" .tif)
    local container_input="/data/datasets/sources/copernicus-dem/${basename}.tif"
    local container_smoothed="/data/datasets/tmp/smoothed-dem${SUFFIX}/${basename}.tif"
    local host_smoothed="${SMOOTH_DIR}/${basename}.tif"
    local container_output="/data/datasets/tmp/contours${SUFFIX}/${basename}.geojson"
    local host_output="${CONTOUR_DIR}/${basename}.geojson"

    # Skip if already generated
    if [[ -f "$host_output" ]]; then
        echo "  · $basename (cached)"
        return
    fi

    # Step 1: Upsample with cubic spline for smoother contours
    if [[ ! -f "$host_smoothed" ]]; then
        if ! docker compose run --rm -T gdal \
            gdalwarp \
            -r cubicspline \
            -tr 0.000277778 0.000277778 \
            -overwrite \
            "$container_input" \
            "$container_smoothed" \
            2>/dev/null; then
            echo "  ✗ $basename (smooth failed)"
            return
        fi
    fi

    # Step 2: Generate contours from smoothed DEM
    if docker compose run --rm -T gdal \
        gdal_contour \
        -i "$CONTOUR_INTERVAL" \
        -a elevation \
        -f GeoJSON \
        "$container_smoothed" \
        "$container_output" \
        2>/dev/null; then
        echo "  ✓ $basename"
    else
        echo "  ✗ $basename (contour failed)"
    fi
}
export -f process_tile
export CONTOUR_INTERVAL CONTOUR_DIR SMOOTH_DIR SMOOTH_FACTOR SUFFIX

echo "  Processing ${tile_count} tiles..."
echo ""

printf '%s\n' "${tile_files[@]}" | xargs -P "$MAX_PARALLEL" -I {} bash -c 'process_tile "$@"' _ {}

geojson_count=$(ls "$CONTOUR_DIR"/*.geojson 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "  Generated ${geojson_count} GeoJSON files."

# ── Step 2: Merge into vector tiles with tippecanoe ──────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 2/4 — Vector Tile Generation (tippecanoe)"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Input:  ${geojson_count} GeoJSON files"
echo "  Output: $MBTILES_HOST"
echo ""
echo "  tippecanoe reads all contour GeoJSON files, simplifies"
echo "  geometries per zoom level, and builds a vector tile pyramid."
echo "  Lines are tagged with an elevation attribute."
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
    /data/datasets/tmp/contours'"${SUFFIX}"'/*.geojson'

echo ""
echo "  MBTiles written: $MBTILES_HOST"
echo "  Size: $(du -h "$MBTILES_HOST" | cut -f1)"

# ── Step 3: Convert to PMTiles ────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 3/4 — Convert to PMTiles"
echo "════════════════════════════════════════════════════════════════════"
echo ""

docker compose run --rm pmtiles \
    convert "$MBTILES_CONTAINER" "$PMTILES_CONTAINER"

echo ""
echo "  PMTiles written: $PMTILES_HOST"
echo "  Size: $(du -h "$PMTILES_HOST" | cut -f1)"

# ── Step 4: Clean up smoothed DEM tiles ───────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Step 4/4 — Cleanup"
echo "════════════════════════════════════════════════════════════════════"
echo ""

rm -rf "$SMOOTH_DIR"
echo "  Removed smoothed DEM tiles ($SMOOTH_DIR)"

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
echo "    http://localhost:3000/squiggly.v1.contours${SUFFIX}/{z}/{x}/{y}"
echo ""
echo "  Contour properties:"
echo "    elevation  — height in metres"
echo "    ID         — gdal_contour serial"
echo ""
echo "  Index contours: style with a modulo expression, e.g."
echo "    [\"==\", [\"%\", [\"get\", \"elevation\"], ${MAJOR_INTERVAL}], 0]"
echo ""
