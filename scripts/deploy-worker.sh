#!/usr/bin/env bash
set -euo pipefail

# Deploy the Cloudflare Worker that serves tiles out of the R2 PMTiles archives.
#
# The worker reads the archives server-side and returns one response per tile,
# so browsers never issue Range requests against R2 (which is what made the
# cached responses unreliable).
#
# Prerequisites:
#   1. A Cloudflare account with the R2 bucket already created and populated
#      (./scripts/upload-tiles.sh)
#   2. npx wrangler login   — or set CLOUDFLARE_API_TOKEN
#
# Usage:
#   ./scripts/deploy-worker.sh          # deploy
#   ./scripts/deploy-worker.sh --dev    # run locally on http://localhost:8787

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$PROJECT_DIR/worker"

MODE="deploy"
if [[ "${1:-}" == "--dev" ]]; then
    MODE="dev"
fi

if ! command -v npm &>/dev/null; then
    echo "Error: npm is not installed (needed for wrangler)."
    exit 1
fi

if [[ ! -d "$WORKER_DIR/node_modules" ]]; then
    echo "Installing worker dependencies..."
    npm --prefix "$WORKER_DIR" install
fi

echo ""
echo "════════════════════════════════════════════════════════════════════"
if [[ "$MODE" == "dev" ]]; then
    echo "  Running tile worker locally"
    echo "════════════════════════════════════════════════════════════════════"
    echo ""
    echo "  http://localhost:8787/                            — archive index"
    echo "  http://localhost:8787/{archive}.json              — TileJSON"
    echo "  http://localhost:8787/{archive}/{z}/{x}/{y}.{ext} — tiles"
    echo ""
    echo "  Local dev reads a local R2 emulation, not the real bucket. Seed it:"
    echo "    cd worker && npx wrangler r2 object put \\"
    echo "      squiggly-maps-v1/squiggly.v1.base-test.pmtiles \\"
    echo "      --file ../tiles/squiggly.v1.base-test.pmtiles --local"
    echo ""
    echo "  Add --remote to wrangler dev to hit the real bucket instead."
    echo ""
    npm --prefix "$WORKER_DIR" run dev
else
    echo "  Deploying tile worker"
    echo "════════════════════════════════════════════════════════════════════"
    echo ""
    npm --prefix "$WORKER_DIR" run deploy
    echo ""
    echo "  Logs:  cd worker && npx wrangler tail"
    echo ""
fi
