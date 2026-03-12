# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**pgtiler** is a local-first map tiling backend for a paragliding tracking service. It serves vector tiles to MapLibre GL JS on the frontend. The stack is:

- **Martin** — open-source tile server (PostGIS + PMTiles/MBTiles support)
- **PostGIS** — stores paragliding data (flight tracks, pilot positions, airspace)
- **PMTiles** — static tile archives for OSM base map and terrain (large, not committed)

## Common commands

```bash
# Start everything (PostGIS + Martin)
docker compose up

# Start fresh (wipe PostGIS data and re-run init + seed SQL)
docker compose down -v && docker compose up

# View Martin logs only
docker compose logs -f martin

# Serve the preview page (open at http://localhost:8080)
python3 -m http.server 8080 --directory preview

# Download an OSM PMTiles extract for the Alps (requires pmtiles CLI)
./scripts/download-tiles.sh

# Connect to PostGIS directly
psql postgresql://postgres:postgres@localhost:5432/paragliding
```

## Architecture

Martin auto-discovers all PostGIS tables with geometry columns and exposes them as vector tile endpoints at `http://localhost:3000/{table_name}/{z}/{x}/{y}`. Adding a new table to PostGIS is enough to get a new tile source — no Martin config changes needed unless you want to customise zoom ranges or filters.

**Tile endpoints (auto-published by Martin):**
- `/flight_tracks` — LineString, recorded GPS tracks
- `/pilot_positions` — Point, live pilot locations
- `/airspace` — Polygon, restricted airspace zones

**Static tile sources:** Drop any `.pmtiles` or `.mbtiles` file into `tiles/` and restart Martin. The filename (without extension) becomes the source ID.

**Preview page:** `preview/index.html` uses MapLibre GL JS with OpenFreeMap as the base map and adds the Martin layers on top. Run a local HTTP server to avoid CORS issues (see above).

## Database schema

All tables use `GEOMETRY(..., 4326)` (WGS84). New SQL migrations go in `db/` as `NN-description.sql` — Docker runs them alphabetically on first container start.

## Terrain

3D terrain requires a `raster-dem` tile source in terrarium or mapbox encoding. Set `TERRAIN_URL` in `preview/index.html`. Free options: Maptiler Cloud (free API key), or download terrain PMTiles and serve via Martin.

## Key URLs when running locally

| URL | What |
|-----|------|
| `http://localhost:3000` | Martin health / root |
| `http://localhost:3000/catalog` | All available tile sources |
| `http://localhost:3000/{source}` | TileJSON for a source |
| `http://localhost:8080` | MapLibre preview page |
| `localhost:5432` | PostGIS (user: postgres, db: paragliding) |
