#!/usr/bin/env bash
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/datasets/sources"
FILE="australia.osm.pbf"
URL="https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf"

mkdir -p "$DEST"

echo "Downloading $FILE from Geofabrik..."
curl -L -o "$DEST/$FILE" "$URL"
echo "Saved to $DEST/$FILE"
