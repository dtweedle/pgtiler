#!/usr/bin/env bash
set -euo pipefail

# Download Copernicus GLO-30 DEM tiles for Australia from AWS S3
# No API key required — the bucket is publicly accessible (requester-pays disabled)
# Requires: AWS CLI (brew install awscli)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$PROJECT_DIR/datasets/sources/copernicus-dem"

# Australia bounding box (mainland + Tasmania)
SOUTH=-44
NORTH=-10
WEST=112
EAST=154

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
    exit 0
fi

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

downloaded=$(find "$DEST" -name '*.tif' | wc -l | tr -d ' ')
echo ""
echo "Download complete: ${downloaded} tiles in $DEST"
echo "Total size: $(du -sh "$DEST" | cut -f1)"

# ── Build Virtual Raster ──────────────────────────────────────────────────
#
# The VRT file stores paths to the source .tif files. Since downstream
# tools run inside the gdal Docker container (where datasets/ is
# mounted at /data/datasets), we generate the VRT with container paths
# so gdal_contour, rio-rgbify, etc. can find the files.

VRT_PATH="$PROJECT_DIR/datasets/sources/australia-dem.vrt"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Building Virtual Raster (VRT)"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  This creates a lightweight XML index that lets all downstream"
echo "  tools (contour generation, terrain encoding, hillshade) read"
echo "  the ${downloaded} tiles as a single seamless raster — no pixel"
echo "  data is copied."
echo ""
echo "  Paths inside the VRT use Docker container paths (/data/datasets/...)"
echo "  so the gdal container can read them directly."
echo ""

docker compose run --rm gdal \
    gdalbuildvrt \
    /data/datasets/sources/australia-dem.vrt \
    /data/datasets/sources/copernicus-dem/*.tif

echo "  VRT written to: $VRT_PATH"
echo "  Referenced tiles: $(grep -c '<SourceFilename' "$VRT_PATH")"
echo "  File size: $(du -h "$VRT_PATH" | cut -f1)"
echo ""
echo "Done. Next steps:"
echo "  ./scripts/generate-contours.sh     — vector contour lines → PostGIS"
echo "  ./scripts/generate-terrain-tiles.sh — RGB terrain tiles → PMTiles (hillshade + 3D)"
