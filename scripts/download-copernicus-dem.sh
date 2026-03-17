#!/usr/bin/env bash
set -euo pipefail

# Download Copernicus GLO-30 DEM tiles for Australia from AWS S3
# No API key required — the bucket is publicly accessible (requester-pays disabled)
# Requires: AWS CLI (brew install awscli)
#
# Builds two VRTs:
#   australia-dem.vrt      — all tiles (used by contour generation)
#   australia-terrain.vrt  — Manilla/Snowy subset (used by terrain generation)
#
# With --test, also builds:
#   australia-dem-test.vrt     — single Bright tile
#   australia-terrain-test.vrt — single Bright tile

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$PROJECT_DIR/datasets/sources/copernicus-dem"

# ── Test mode ────────────────────────────────────────────────────────────
TEST_MODE=false
if [[ "${1:-}" == "--test" ]]; then
    TEST_MODE=true
    source "$SCRIPT_DIR/test-config.sh"
fi

# Australia bounding box (mainland + Tasmania) — always download everything
SOUTH=-44
NORTH=-10
WEST=112
EAST=154

# Terrain subset: Snowy Mountains + 400km radius around Manilla, NSW
# Covers the key paragliding areas in eastern Australia (~90 tiles)
TERRAIN_SOUTH=-37
TERRAIN_NORTH=-27
TERRAIN_WEST=146
TERRAIN_EAST=155

S3_BUCKET="s3://copernicus-dem-30m"
MAX_PARALLEL=10

mkdir -p "$DEST"

echo "Downloading Copernicus GLO-30 DEM tiles for Australia..."
echo "Bounding box: S=$SOUTH N=$NORTH W=$WEST E=$EAST"
echo "Parallel downloads: $MAX_PARALLEL"

# Build list of tiles to download
tile_list=()
for ((lat=SOUTH; lat<NORTH; lat++)); do
    for ((lon=WEST; lon<EAST; lon++)); do
        if ((lat >= 0)); then
            lat_prefix="N"; lat_val=$(printf "%02d" $lat)
        else
            lat_prefix="S"; lat_val=$(printf "%02d" $((-lat)))
        fi

        if ((lon >= 0)); then
            lon_prefix="E"; lon_val=$(printf "%03d" $lon)
        else
            lon_prefix="W"; lon_val=$(printf "%03d" $((-lon)))
        fi

        tile_name="Copernicus_DSM_COG_10_${lat_prefix}${lat_val}_00_${lon_prefix}${lon_val}_00_DEM"
        tif_file="${tile_name}.tif"

        # Skip if already downloaded
        if [[ -f "$DEST/$tif_file" ]]; then
            continue
        fi

        tile_list+=("$tile_name")
    done
done

total=${#tile_list[@]}
echo "Tiles to download: $total (skipping already downloaded)"

if ((total == 0)); then
    echo "Nothing to download."
else
    # Download a single tile — used by background jobs
    download_tile() {
        local tile_name="$1"
        local tif_file="${tile_name}.tif"
        local s3_path="${S3_BUCKET}/${tile_name}/${tif_file}"

        if aws s3 cp "$s3_path" "$DEST/$tif_file" --no-sign-request 2>/dev/null; then
            echo "  ✓ $tif_file"
        fi
    }
    export -f download_tile
    export S3_BUCKET DEST

    # Run downloads in parallel, queueing new jobs as each one finishes
    printf '%s\n' "${tile_list[@]}" | xargs -P "$MAX_PARALLEL" -I {} bash -c 'download_tile "$@"' _ {}
fi

downloaded=$(find "$DEST" -name '*.tif' | wc -l | tr -d ' ')
echo ""
echo "Download complete: ${downloaded} tiles in $DEST"
echo "Total size: $(du -sh "$DEST" | cut -f1)"

# ── Helper: build a VRT from tiles within a bounding box ─────────────────

build_terrain_vrt() {
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
            local f="$DEST/Copernicus_DSM_COG_10_${lp}${lv}_00_${op}${ov}_00_DEM.tif"
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
    gdalbuildvrt \
    /data/datasets/sources/australia-dem.vrt \
    /data/datasets/sources/copernicus-dem/*.tif
echo "  australia-dem.vrt — $(grep -c '<SourceFilename' "$PROJECT_DIR/datasets/sources/australia-dem.vrt") tiles"

# Terrain subset VRT — used by terrain tile generation
echo ""
echo "  Terrain region (Snowy Mountains + Manilla 400km):"
build_terrain_vrt "australia-terrain" "$TERRAIN_SOUTH" "$TERRAIN_NORTH" "$TERRAIN_WEST" "$TERRAIN_EAST"

# Test VRTs — single Bright tile
if $TEST_MODE; then
    echo ""
    echo "  Test (Bright, VIC):"
    build_terrain_vrt "australia-dem-test" "$TEST_SOUTH" "$TEST_NORTH" "$TEST_WEST" "$TEST_EAST"
    build_terrain_vrt "australia-terrain-test" "$TEST_SOUTH" "$TEST_NORTH" "$TEST_WEST" "$TEST_EAST"
fi

echo ""
echo "Done. Next steps:"
echo "  ./scripts/generate-contours.sh     — vector contour lines (uses australia-dem.vrt)"
echo "  ./scripts/generate-terrain-tiles.sh — RGB terrain tiles (uses australia-terrain.vrt)"
