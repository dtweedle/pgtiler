# datasets/

This directory holds the raw data sources used to build tiles for the tiling service. Files downloaded here are inputs to the tile generation pipeline — they are not served directly.

**Do not commit anything in this directory to git.** The files are large (often hundreds of MB to several GB) and change over time as upstream sources publish updates. Instead, create or update a download script in `scripts/` that fetches the data you need. This keeps the repository lightweight and ensures anyone can reproduce the full dataset from scratch.

## Structure

- `sources/` — raw downloads (`.osm.pbf`, `.tif`, `.vrt`)
- `tmp/` — intermediate build artifacts (GeoJSON, MBTiles)

## Current data sources

| Path | Description |
|------|-------------|
| `sources/australia.osm.pbf` | OpenStreetMap extract for Australia (Geofabrik) |
| `sources/copernicus-dem/*.tif` | ~1450 Copernicus GLO-30 DEM tiles at 30m resolution (AWS S3) |
| `sources/australia-dem.vrt` | Virtual raster index over the DEM tiles (built by download script) |
| `tmp/contours/*.geojson` | Intermediate contour line files (one per DEM tile) |
| `tmp/contours.mbtiles` | Intermediate contour vector tiles |
| `tmp/australia-terrain.mbtiles` | Intermediate RGB-encoded terrain tiles |

## Adding a new data source

1. Add the download command to the appropriate script in `scripts/`.
2. Document the source URL and what it provides in the table above.
3. Run the script — the file will land in `datasets/sources/`.
4. Make sure `datasets/` is listed in `.gitignore`.
