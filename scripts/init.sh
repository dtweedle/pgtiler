#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== pgtiler init ==="

# Create required directories
mkdir -p "$ROOT/datasets/sources" "$ROOT/datasets/tmp" "$ROOT/tiles"

# Download OSM data
"$SCRIPT_DIR/download-osm-base-vectors.sh"

echo ""
echo "=== Init complete ==="
echo "Next: ./scripts/generate-osm-tiles.sh        — OSM base map"
echo "      ./scripts/download-copernicus-dem.sh  — elevation data"
echo "      ./scripts/build-vrts.sh               — then contours + terrain"
