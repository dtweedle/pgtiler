#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8080}"

echo "Serving preview at http://localhost:${PORT}"
python3 -m http.server "$PORT" --directory "$ROOT/preview"
