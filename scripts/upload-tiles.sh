#!/usr/bin/env bash
set -euo pipefail

# Upload production .pmtiles files to Cloudflare R2.
# Skips -test files. Uses rclone for multipart upload support.
#
# Prerequisites:
#   1. brew install rclone
#   2. Create an R2 API token in the Cloudflare dashboard:
#      → R2 → Manage R2 API Tokens → Create API Token
#      → Permissions: Object Read & Write
#      → Copy the Access Key ID and Secret Access Key
#   3. Configure rclone:
#      rclone config
#      → n (New remote)
#      → name: r2
#      → Storage: s3
#      → provider: Cloudflare
#      → access_key_id: <from step 2>
#      → secret_access_key: <from step 2>
#      → endpoint: https://<account-id>.r2.cloudflarestorage.com
#      → Leave everything else as default
#
# Configuration (set in .env or export before running):
#   R2_REMOTE  — rclone remote name (default: r2)
#   R2_BUCKET  — R2 bucket name (required)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TILES_DIR="$PROJECT_DIR/tiles"

# Load .env if present
if [[ -f "$PROJECT_DIR/.env" ]]; then
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
fi

R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-}"

# ── Preflight checks ────────────────────────────────────────────────────

if ! command -v rclone &>/dev/null; then
    echo "Error: rclone is not installed."
    echo "  brew install rclone"
    echo ""
    echo "Then configure it for R2 (see comments at top of this script)."
    exit 1
fi

if [[ -z "$R2_BUCKET" ]]; then
    echo "Error: R2_BUCKET is not set."
    echo ""
    echo "Set it in .env or export it:"
    echo "  echo 'R2_BUCKET=your-bucket-name' >> .env"
    echo "  # or"
    echo "  R2_BUCKET=your-bucket-name ./scripts/upload-tiles.sh"
    exit 1
fi

# Verify the remote exists in rclone config
if ! rclone listremotes | grep -q "^${R2_REMOTE}:$"; then
    echo "Error: rclone remote '${R2_REMOTE}' not found."
    echo ""
    echo "Run 'rclone config' to set it up (see comments at top of this script)."
    exit 1
fi

# ── Find files to upload ─────────────────────────────────────────────────

files=()
for f in "$TILES_DIR"/squiggly.v1.*.pmtiles; do
    [[ -f "$f" ]] || continue
    # Skip test files
    [[ "$(basename "$f")" == *-test* ]] && continue
    files+=("$f")
done

if [[ ${#files[@]} -eq 0 ]]; then
    echo "No squiggly.v1.*.pmtiles files found in $TILES_DIR"
    exit 0
fi

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  Uploading tiles to R2"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Remote:  ${R2_REMOTE}:${R2_BUCKET}"
echo "  Files:   ${#files[@]}"
echo ""

for f in "${files[@]}"; do
    name="$(basename "$f")"
    size="$(du -h "$f" | cut -f1)"
    echo "  ↑ ${name} (${size})..."
    rclone copyto "$f" "${R2_REMOTE}:${R2_BUCKET}/${name}" --progress --s3-chunk-size 64M
    echo "  ✓ ${name}"
    echo ""
done

echo "════════════════════════════════════════════════════════════════════"
echo "  Done"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Files available at:"
echo "    https://<your-custom-domain>/${files[0]##*/}"
echo ""
echo "  Or via R2 public URL (if public access enabled):"
echo "    https://<account-id>.r2.dev/${R2_BUCKET}/<filename>"
echo ""
