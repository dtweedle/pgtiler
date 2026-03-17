#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

OSM_FILE="$ROOT/datasets/sources/australia.osm.pbf"
OUTPUT_FILE="/data/output/squiggly.v1.base${SUFFIX}.pmtiles"

if [ ! -f "$OSM_FILE" ]; then
    echo "Error: $OSM_FILE not found. Run ./scripts/init.sh first."
    exit 1
fi

echo "=== Generating tiles with Planetiler ==="

PLANETILER_ARGS=(
    --osm_path=/data/sources/australia.osm.pbf
    --output="$OUTPUT_FILE"
    --download
    --force
)

if $TEST_MODE; then
    echo "  Test mode: clipping to Bright, Victoria (${TEST_WEST},${TEST_SOUTH},${TEST_EAST},${TEST_NORTH})"
    PLANETILER_ARGS+=(--bounds="${TEST_WEST},${TEST_SOUTH},${TEST_EAST},${TEST_NORTH}")
fi

docker compose --profile generate run --rm planetiler "${PLANETILER_ARGS[@]}"

echo ""
echo "=== Tile generation complete ==="
echo "Output: tiles/squiggly.v1.base${SUFFIX}.pmtiles"
echo "Run 'docker compose restart martin' to pick up the new tile source."
