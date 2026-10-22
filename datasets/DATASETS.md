# datasets/

This directory holds the raw data sources used to build tiles for the tiling service. Files downloaded here are inputs to the tile generation pipeline — they are not served directly.

**Do not commit anything in this directory to git.** The files are large (often hundreds of MB to several GB) and change over time as upstream sources publish updates. Instead, create or update a download script in `scripts/` that fetches the data you need. This keeps the repository lightweight and ensures anyone can reproduce the full dataset from scratch.

## Structure

- `sources/` — raw downloads (`.osm.pbf`, `.tif`) and the VRTs built from them
- `tmp/` — intermediate build artifacts (GeoTIFF, GeoJSON, MBTiles) and temp files

## Current data sources

| Path | Description |
|------|-------------|
| `sources/australia.osm.pbf` | OpenStreetMap extract for Australia (Geofabrik), ~0.9 GB |
| `sources/*.zip` | Natural Earth, water polygons and lake centrelines, fetched by Planetiler's `--download`, ~1.4 GB |
| `sources/copernicus-dem/*.tif` | 868 Copernicus GLO-30 DEM tiles at 30 m resolution (AWS S3), ~27 GB |
| `sources/australia-terrain.vrt` | Virtual raster index over the DEM tiles, read by the terrain pipeline (built by `build-vrts.sh`) |
| `sources/australia-dem.vrt` | The same index under another name. Built, but nothing reads it |
| `tmp/smoothed-dem/*.tif` | Smoothed DEM tiles for contour tracing, deleted when the run finishes |
| `tmp/contours/*.geojson` | Intermediate contour line files (one per DEM tile) |
| `tmp/contours.mbtiles` | Intermediate contour vector tiles |
| `tmp/australia-dem-clean.tif` | All of Australia merged into one GeoTIFF for terrain, ~24 GB |
| `tmp/australia-terrain.mbtiles` | Intermediate RGB-encoded terrain tiles, ~49 GB |
| `tmp/pmtiles*` | `pmtiles convert`'s temp file while terrain converts, about the MBTiles' size |
| `tmp/previous/` | The last terrain archive, kept for rollback before a full build |

`--test` builds add `-test` copies of most of these (`tmp/contours-test/`,
`tmp/australia-terrain-test.mbtiles`, …).

## Adding a new data source

1. Add the download command to the appropriate script in `scripts/`.
2. Document the source URL and what it provides in the table above.
3. Run the script — the file will land in `datasets/sources/`.
4. `datasets/sources/` and `datasets/tmp/` are already in `.gitignore`. Anything else you add under `datasets/` needs adding there too.
