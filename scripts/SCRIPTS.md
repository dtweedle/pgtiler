# scripts/

Shell scripts for downloading data, generating tiles, and running local services. All processing tools run inside Docker containers — no local GDAL, tippecanoe, or Python geospatial installs needed.

## Scripts

| Script | What it does |
|--------|-------------|
| `init.sh` | Creates the `datasets/` and `tiles/` directories and downloads the OSM extract. The DEM is a separate download |
| `download-osm-base-vectors.sh` | Downloads the Australia OSM extract from Geofabrik |
| `download-copernicus-dem.sh` | Downloads the 868 Copernicus GLO-30 DEM tiles covering Australia from AWS S3 with the AWS CLI on the host (no account needed), skipping any already present, then runs `build-vrts.sh` |
| `build-vrts.sh` | Builds VRT index files from DEM tiles: `australia-terrain.vrt`, which the terrain pipeline reads, and `australia-dem.vrt`, the same 868 tiles, which nothing reads. Contours read the GeoTIFFs directly |
| `generate-osm-tiles.sh` | Runs Planetiler to convert OSM data into OpenMapTiles vector tiles → `squiggly.v1.base.pmtiles` |
| `generate-contours.sh` | Smooths each DEM tile with a cubic-spline resample, generates 20m contour lines (parallel), builds vector tiles with tippecanoe → `squiggly.v1.contours.pmtiles` |
| `generate-terrain-tiles.sh` | Merges terrain VRT to clean GeoTIFF, encodes as RGB terrain tiles (terrarium encoding) with rio-rgbify, sets name/attribution/bounds, converts with its temp file in `datasets/tmp/` → `squiggly.v1.terrain.pmtiles`. `RGBIFY_WORKERS=N` sets the worker count (default: Docker's CPUs). The conversion takes hours at full scale: see [GENERATION.md](../docs/GENERATION.md#problem-1--no-index-on-the-tiles-table) |
| `check-terrain.py` | Checks a terrain MBTiles before conversion/upload: metadata, coverage per zoom, decoded spot heights, 256 m-boundary spike scan. Standard-library Python |
| `test-config.sh` | Shared configuration for `--test` mode (single Bright, VIC tile) |
| `preview.sh` | Starts a local HTTP server for the preview page. `R2_PUBLIC_URL=<url> ./scripts/preview.sh` points it at a deployed worker |
| `upload-tiles.sh` | Uploads every non-test `squiggly.v1.*.pmtiles` in `tiles/` to the R2 bucket via rclone, in 64 MB parts |
| `deploy-worker.sh` | Deploys the Cloudflare Worker in `worker/` that serves tiles from those archives, after its typecheck and tests pass. Takes `dev` \| `production` \| `--local` \| `--local-remote`. Production has no hostname yet (see [worker/README.md](../worker/README.md#custom-domain)) |
| `upload-style.sh` | Uploads `styles/squiggly-outdoor.json` to R2 with its source URLs rewritten to `R2_PUBLIC_URL` |

## Running order

```bash
# 1. Download source data
./scripts/init.sh                      # directories + OSM extract
./scripts/download-copernicus-dem.sh   # DEM tiles, then builds the VRTs

# 2. Generate tiles (independent of each other; only terrain needs the VRTs)
./scripts/generate-osm-tiles.sh
./scripts/generate-contours.sh
./scripts/generate-terrain-tiles.sh

# 3. Restart Martin + preview
docker compose restart martin
./scripts/preview.sh
```

## Test mode

All generation scripts accept `--test` to process only a single 1°×1° DEM tile around Bright, Victoria. Outputs are suffixed with `-test` (e.g. `squiggly.v1.terrain-test.pmtiles`).

```bash
./scripts/build-vrts.sh --test
./scripts/generate-contours.sh --test
./scripts/generate-terrain-tiles.sh --test
./scripts/generate-osm-tiles.sh --test
```

## Adding a new script

Follow the existing pattern: `set -euo pipefail`, resolve `PROJECT_DIR` from `SCRIPT_DIR`, use `docker compose run --rm <service>` for processing tools, and include progress logging. Source `test-config.sh` when adding `--test` support.

For why each pipeline is shaped the way it is — parameter rationale, rejected
approaches, known gaps — see [docs/GENERATION.md](../docs/GENERATION.md).
