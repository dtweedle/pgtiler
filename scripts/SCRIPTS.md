# scripts/

Shell scripts for downloading data, generating tiles, and running local services. All processing tools run inside Docker containers — no local GDAL, tippecanoe, or Python geospatial installs needed.

## Scripts

| Script | What it does |
|--------|-------------|
| `init.sh` | Creates directories and downloads all required datasets |
| `download-osm-base-vectors.sh` | Downloads the Australia OSM extract from Geofabrik |
| `download-copernicus-dem.sh` | Downloads ~1450 Copernicus GLO-30 DEM tiles from AWS S3, then builds a virtual raster (VRT) |
| `generate-osm-tiles.sh` | Runs Planetiler to convert OSM data into OpenMapTiles vector tiles |
| `generate-contours.sh` | Generates 20m contour lines from DEM tiles (parallel), builds vector tiles with tippecanoe, converts to PMTiles |
| `generate-terrain-tiles.sh` | Encodes DEM as RGB terrain tiles (terrarium encoding) with rio-rgbify, converts to PMTiles |
| `preview.sh` | Starts a local HTTP server for the preview page |

## Running order

```bash
# 1. Download source data
./scripts/init.sh
./scripts/download-copernicus-dem.sh

# 2. Generate tiles (can run independently)
./scripts/generate-osm-tiles.sh
./scripts/generate-contours.sh
./scripts/generate-terrain-tiles.sh

# 3. Restart Martin + preview
docker compose restart martin
./scripts/preview.sh
```

## Adding a new script

Follow the existing pattern: `set -euo pipefail`, resolve `PROJECT_DIR` from `SCRIPT_DIR`, use `docker compose run --rm <service>` for processing tools, and include progress logging.
