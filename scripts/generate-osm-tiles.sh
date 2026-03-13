#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OSM_FILE="$ROOT/datasets/sources/australia.osm.pbf"

if [ ! -f "$OSM_FILE" ]; then
    echo "Error: $OSM_FILE not found. Run ./scripts/init.sh first."
    exit 1
fi

echo "=== Generating tiles with Planetiler ==="
docker compose --profile generate run --rm planetiler

echo ""
echo "=== Tile generation complete ==="
echo "Output: tiles/output.mbtiles"
echo "Run 'docker compose up' to start Martin and serve the tiles."
