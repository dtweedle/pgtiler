# scripts/

Shell scripts for downloading data, generating tiles, and running local services. All processing tools run inside Docker containers — no local GDAL, tippecanoe, or Python geospatial installs needed.

## Scripts

| Script | What it does |
|--------|-------------|
| `init.sh` | Creates directories and downloads all required datasets |
| `download-osm-base-vectors.sh` | Downloads the Australia OSM extract from Geofabrik |
| `download-copernicus-dem.sh` | Downloads ~1450 Copernicus GLO-30 DEM tiles from AWS S3, then runs `build-vrts.sh` |
| `build-vrts.sh` | Builds VRT index files from DEM tiles: `australia-dem.vrt` (all tiles, for contours) and `australia-terrain.vrt` (Manilla/Snowy subset, for terrain) |
| `generate-osm-tiles.sh` | Runs Planetiler to convert OSM data into OpenMapTiles vector tiles → `squiggly.v1.base.pmtiles` |
| `generate-contours.sh` | Upsamples DEM 3× with cubic spline, generates 20m contour lines (parallel), builds vector tiles with tippecanoe → `squiggly.v1.contours.pmtiles` |
| `generate-terrain-tiles.sh` | Merges terrain VRT to clean GeoTIFF, encodes as RGB terrain tiles (terrarium encoding) with rio-rgbify → `squiggly.v1.terrain.pmtiles` |
| `test-config.sh` | Shared configuration for `--test` mode (single Bright, VIC tile) |
| `preview.sh` | Starts a local HTTP server for the preview page. `R2_PUBLIC_URL=<url> ./scripts/preview.sh` points it at a deployed worker |
| `upload-tiles.sh` | Uploads production `.pmtiles` archives to the R2 bucket via rclone |
| `deploy-worker.sh` | Deploys the Cloudflare Worker in `worker/` that serves tiles from those archives. Takes `dev` \| `production` \| `--local` \| `--local-remote` |
| `upload-style.sh` | Uploads `styles/squiggly-outdoor.json` to R2 with its source URLs rewritten to `R2_PUBLIC_URL` |

## Running order

```bash
# 1. Download source data
./scripts/init.sh
./scripts/download-copernicus-dem.sh   # also builds VRTs

# 2. Generate tiles (can run independently after VRTs exist)
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
approaches, known gaps — see [architecture/GENERATION.md](../architecture/GENERATION.md).
