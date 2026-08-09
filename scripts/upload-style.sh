#!/usr/bin/env bash
set -euo pipefail

# Build and upload the squiggly-outdoor style JSON to R2.
#
# The style's source URLs point at the tile worker (scripts/deploy-worker.sh),
# which serves TileJSON + individual tiles out of the PMTiles archives. This
# script rewrites the host in those URLs to whatever R2_PUBLIC_URL is set to.
#
# Configuration (set in .env or export before running):
#   R2_REMOTE      — rclone remote name (default: r2)
#   R2_BUCKET      — R2 bucket name (required)
#   R2_PUBLIC_URL  — public URL the tile worker is served on (required)

# Host baked into styles/*.json; replaced with R2_PUBLIC_URL on upload.
STYLE_DEFAULT_HOST="https://maps.tweed.nz"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STYLES_DIR="$PROJECT_DIR/styles"

# Load .env if present
if [[ -f "$PROJECT_DIR/.env" ]]; then
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
fi

R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-}"
R2_PUBLIC_URL="${R2_PUBLIC_URL:-}"

# ── Preflight checks ────────────────────────────────────────────────────

if ! command -v rclone &>/dev/null; then
    echo "Error: rclone is not installed."
    echo "  brew install rclone"
    exit 1
fi

if [[ -z "$R2_BUCKET" ]]; then
    echo "Error: R2_BUCKET is not set. See .env.example"
    exit 1
fi

if [[ -z "$R2_PUBLIC_URL" ]]; then
    echo "Error: R2_PUBLIC_URL is not set. See .env.example"
    exit 1
fi

if ! rclone listremotes | grep -q "^${R2_REMOTE}:$"; then
    echo "Error: rclone remote '${R2_REMOTE}' not found."
    exit 1
fi

# ── Build and upload ─────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Uploading style to R2"
echo "════════════════════════════════════════════════════════════════════"
echo ""

STYLE_SRC="$STYLES_DIR/squiggly-outdoor.json"
STYLE_OUT=$(mktemp)
trap 'rm -f "$STYLE_OUT"' EXIT

# Point the style's sources at the configured tile worker host
sed "s|${STYLE_DEFAULT_HOST}|${R2_PUBLIC_URL%/}|g" "$STYLE_SRC" > "$STYLE_OUT"

name="squiggly-outdoor.json"
echo "  ↑ ${name}..."
rclone copyto "$STYLE_OUT" "${R2_REMOTE}:${R2_BUCKET}/${name}" \
    --header-upload "Content-Type: application/json" \
    --header-upload "Cache-Control: public, max-age=3600"
echo "  ✓ ${name}"
echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Done"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Style URL: ${R2_PUBLIC_URL}/${name}"
echo ""
echo "  Usage:"
echo "    const map = new maplibregl.Map({"
echo "      style: '${R2_PUBLIC_URL}/${name}'"
echo "    });"
echo ""
