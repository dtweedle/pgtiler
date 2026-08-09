#!/usr/bin/env bash
set -euo pipefail

# Deploy or run the Cloudflare Worker that serves tiles out of the R2 PMTiles
# archives.
#
# The worker reads the archives server-side and returns one response per tile,
# so browsers never issue Range requests against R2 (which is what made the
# cached responses unreliable). See architecture/CACHING.md.
#
# Prerequisites:
#   1. A Cloudflare account with the R2 bucket already created and populated
#      (./scripts/upload-tiles.sh)
#   2. npx wrangler login   — or set CLOUDFLARE_API_TOKEN
#
# Usage:
#   ./scripts/deploy-worker.sh dev            Deploy the dev worker (dev.tweed.nz)
#   ./scripts/deploy-worker.sh production     Deploy the production worker
#   ./scripts/deploy-worker.sh --local        Run locally against a local R2 emulation
#   ./scripts/deploy-worker.sh --local-remote Run locally against the real R2 bucket
#
# dev and production are configured identically in wrangler.toml and read the
# same bucket — dev differs only in worker name and hostname. That is deliberate:
# dev is meant to reproduce production, including the real archives' multipart
# ETags, which no local emulation can.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$PROJECT_DIR/worker"

MODE="${1:-}"

usage() {
    sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-1}"
}

case "$MODE" in
    dev|production|--local|--local-remote) ;;
    -h|--help) usage 0 ;;
    "") echo "Error: no target given."; echo; usage ;;
    *)  echo "Error: unknown target '$MODE'."; echo; usage ;;
esac

if ! command -v npm &>/dev/null; then
    echo "Error: npm is not installed (needed for wrangler)."
    exit 1
fi

if [[ ! -d "$WORKER_DIR/node_modules" ]]; then
    echo "Installing worker dependencies..."
    npm --prefix "$WORKER_DIR" install
fi

# Never deploy code that doesn't compile or pass its tests.
if [[ "$MODE" == "dev" || "$MODE" == "production" ]]; then
    echo "Running typecheck and tests before deploying..."
    npm --prefix "$WORKER_DIR" run --silent typecheck
    npm --prefix "$WORKER_DIR" run --silent test
    echo ""
fi

banner() {
    echo ""
    echo "════════════════════════════════════════════════════════════════════"
    echo "  $1"
    echo "════════════════════════════════════════════════════════════════════"
    echo ""
}

case "$MODE" in
    dev)
        banner "Deploying tile worker → dev"
        npx --prefix "$WORKER_DIR" wrangler deploy --cwd "$WORKER_DIR" --env dev
        echo ""
        echo "  Verify (wrangler printed the URL above):"
        echo "    curl -s https://dev.tweed.nz/ | head -20"
        echo ""
        echo "  Edge caching works here — X-Tile-Cache goes miss then hit."
        echo ""
        echo "  Logs:  npx wrangler tail --env dev   (from worker/)"
        echo ""
        ;;
    production)
        banner "Deploying tile worker → PRODUCTION"
        npx --prefix "$WORKER_DIR" wrangler deploy --cwd "$WORKER_DIR" --env production
        echo ""
        echo "  Logs:  npx wrangler tail --env production   (from worker/)"
        echo ""
        ;;
    --local|--local-remote)
        banner "Running tile worker locally"
        echo "  http://localhost:8787/                                      — archive index"
        echo "  http://localhost:8787/{archive}.json                        — TileJSON"
        echo "  http://localhost:8787/{archive}/{version}/{z}/{x}/{y}.{ext} — tiles"
        echo ""
        if [[ "$MODE" == "--local" ]]; then
            echo "  Local R2 emulation — seed it first:"
            echo "    cd worker && npx wrangler r2 object put \\"
            echo "      squiggly-maps-v1/squiggly.v1.base-test.pmtiles \\"
            echo "      --file ../tiles/squiggly.v1.base-test.pmtiles --local"
            echo ""
            echo "  Note: local objects get single-part MD5 ETags. Production archives"
            echo "  are multipart — use --local-remote to exercise those."
            echo ""
            npx --prefix "$WORKER_DIR" wrangler dev --cwd "$WORKER_DIR" --env dev
        else
            echo "  Reading the REAL R2 bucket (real archives, real multipart ETags)."
            echo ""
            npx --prefix "$WORKER_DIR" wrangler dev --cwd "$WORKER_DIR" --env dev --remote
        fi
        ;;
esac
