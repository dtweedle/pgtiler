#!/usr/bin/env bash
set -euo pipefail

# Build Virtual Raster (VRT) index files from downloaded Copernicus DEM tiles.
#
# VRTs are lightweight XML files that let GDAL tools treat many .tif files
# as a single seamless raster — no pixel data is copied.
#
# Outputs:
#   australia-dem.vrt      — all tiles (used by contour generation)
#   australia-terrain.vrt  — Manilla/Snowy subset (used by terrain generation)
#
# With --test, also builds:
#   australia-dem-test.vrt     — single Bright tile
#   australia-terrain-test.vrt — single Bright tile

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEM_DIR="$PROJECT_DIR/datasets/sources/copernicus-dem"

# ── Test mode ────────────────────────────────────────────────────────────
TEST_MODE=false
if [[ "${1:-}" == "--test" ]]; then
    TEST_MODE=true
    source "$SCRIPT_DIR/test-config.sh"
fi

# Terrain subset: Snowy Mountains + 400km radius around Manilla, NSW
TERRAIN_SOUTH=-37
TERRAIN_NORTH=-27
TERRAIN_WEST=146
TERRAIN_EAST=155

# ── Preflight checks ────────────────────────────────────────────────────

if [[ ! -d "$DEM_DIR" ]] || [[ -z "$(ls "$DEM_DIR"/*.tif 2>/dev/null)" ]]; then
    echo "Error: No .tif files found in $DEM_DIR"
    echo "Run ./scripts/download-copernicus-dem.sh first."
    exit 1
fi

# ── Helper: build a VRT from tiles within a bounding box ─────────────────

build_vrt() {
    local vrt_name="$1"
    local bb_south="$2" bb_north="$3" bb_west="$4" bb_east="$5"

    local vrt_path="$PROJECT_DIR/datasets/sources/${vrt_name}.vrt"
    local container_vrt="/data/datasets/sources/${vrt_name}.vrt"

    # Collect container paths for tiles within the bounding box
    local inputs=()
    for ((lat=bb_south; lat<bb_north; lat++)); do
        for ((lon=bb_west; lon<bb_east; lon++)); do
            if ((lat >= 0)); then lp="N"; lv=$(printf "%02d" $lat)
            else lp="S"; lv=$(printf "%02d" $((-lat))); fi
            if ((lon >= 0)); then op="E"; ov=$(printf "%03d" $lon)
            else op="W"; ov=$(printf "%03d" $((-lon))); fi
            local f="$DEM_DIR/Copernicus_DSM_COG_10_${lp}${lv}_00_${op}${ov}_00_DEM.tif"
            [[ -f "$f" ]] && inputs+=("/data/datasets/sources/copernicus-dem/$(basename "$f")")
        done
    done

    if [[ ${#inputs[@]} -eq 0 ]]; then
        echo "  ⚠ No tiles found for ${vrt_name} — skipping"
        return
    fi

    docker compose run --rm gdal \
        gdalbuildvrt \
        "$container_vrt" \
        "${inputs[@]}"

    echo "  ${vrt_name}.vrt — $(grep -c '<SourceFilename' "$vrt_path") tiles"
}

# ── Build Virtual Rasters ────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Building Virtual Rasters (VRT)"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Paths inside VRTs use Docker container paths (/data/datasets/...)"
echo "  so the gdal container can read them directly."
echo ""

# Full Australia VRT — used by contour generation
echo "  All of Australia (for contours):"
docker compose run --rm gdal \
    sh -c 'gdalbuildvrt /data/datasets/sources/australia-dem.vrt /data/datasets/sources/copernicus-dem/*.tif'
echo "  australia-dem.vrt — $(grep -c '<SourceFilename' "$PROJECT_DIR/datasets/sources/australia-dem.vrt") tiles"

# Terrain subset VRT — used by terrain tile generation
echo ""
echo "  Terrain region (Snowy Mountains + Manilla 400km):"
build_vrt "australia-terrain" "$TERRAIN_SOUTH" "$TERRAIN_NORTH" "$TERRAIN_WEST" "$TERRAIN_EAST"

# Test VRTs — single Bright tile
if $TEST_MODE; then
    echo ""
    echo "  Test (Bright, VIC):"
    build_vrt "australia-dem-test" "$TEST_SOUTH" "$TEST_NORTH" "$TEST_WEST" "$TEST_EAST"
    build_vrt "australia-terrain-test" "$TEST_SOUTH" "$TEST_NORTH" "$TEST_WEST" "$TEST_EAST"
fi

echo ""
echo "Done. VRTs written to datasets/sources/"
echo ""
echo "Next steps:"
echo "  ./scripts/generate-contours.sh     — vector contour lines (uses australia-dem.vrt)"
echo "  ./scripts/generate-terrain-tiles.sh — RGB terrain tiles (uses australia-terrain.vrt)"
