# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**pgtiler** is a local-first map tiling backend for a paragliding tracking service. It serves vector tiles, contour lines, and terrain data to MapLibre GL JS on the frontend. The stack is:

- **Martin** — open-source tile server (PMTiles/MBTiles support)
- **PMTiles** — static tile archives for OSM base map, contours, and terrain (large, not committed)
- **GDAL** — geospatial processing (contour generation, virtual raster)
- **Tippecanoe** — GeoJSON → vector tile conversion
- **rio-rgbify** — DEM → RGB terrain tile encoding

All processing tools run inside Docker containers — no local geospatial installs needed.

## Common commands

```bash
# Start Martin tile server
docker compose up -d

# View Martin logs
docker compose logs -f martin

# Download OSM data + generate base map tiles
./scripts/init.sh
./scripts/generate-osm-tiles.sh

# Download Copernicus DEM + build virtual raster
./scripts/download-copernicus-dem.sh

# Generate contour lines (parallel, outputs PMTiles)
./scripts/generate-contours.sh

# Generate RGB terrain tiles (hillshade + 3D)
./scripts/generate-terrain-tiles.sh

# Restart Martin to pick up new tile sources
docker compose restart martin

# Serve the preview page (open at http://localhost:8080)
./scripts/preview.sh
```

## Architecture

Martin auto-serves any `.pmtiles` or `.mbtiles` file in `tiles/`. The filename (without extension) becomes the source ID — no config changes needed.

**Tile sources:**
- `output` — OSM base map vector tiles (OpenMapTiles schema)
- `contours` — vector contour lines (20m interval, `elevation` attribute)
- `australia-terrain` — RGB-encoded DEM (terrarium encoding, for hillshade + 3D)

**Processing pipelines (all Dockerised):**
- OSM: `Geofabrik .osm.pbf → Planetiler → .mbtiles`
- Contours: `Copernicus DEM .tif → gdal_contour (parallel) → GeoJSON → tippecanoe → .mbtiles → pmtiles → .pmtiles`
- Terrain: `Copernicus DEM .tif → gdalbuildvrt → rio-rgbify → .mbtiles → pmtiles → .pmtiles`

**Preview page:** `preview/index.html` uses MapLibre GL JS with OpenFreeMap as the base map and adds Martin layers on top. Run a local HTTP server to avoid CORS issues.

## Key URLs when running locally

| URL | What |
|-----|------|
| `http://localhost:3000` | Martin health / root |
| `http://localhost:3000/catalog` | All available tile sources |
| `http://localhost:3000/{source}` | TileJSON for a source |
| `http://localhost:8080` | MapLibre preview page |
