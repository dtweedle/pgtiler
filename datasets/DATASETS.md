# datasets/

This directory holds the raw data sources used to build tiles for the tiling service. Files downloaded here are inputs to the tile generation pipeline — they are not served directly.

**Do not commit anything in this directory to git.** The files are large (often hundreds of MB to several GB) and change over time as upstream sources publish updates. Instead, create or update a download script in `scripts/` that fetches the data you need. This keeps the repository lightweight and ensures anyone can reproduce the full dataset from scratch.

## Structure

- `sources/` — raw downloads (`.osm.pbf`, `.shp.zip`, `.sqlite.zip`, etc.)

## Current data sources

| File | Description |
|------|-------------|
| `australia.osm.pbf` | OpenStreetMap extract for Australia |
| `natural_earth_vector.sqlite.zip` | Natural Earth cultural + physical vector data |
| `water-polygons-split-3857.zip` | OpenStreetMap water polygons (Web Mercator) |
| `lake_centerline.shp.zip` | Lake centreline geometries for label placement |

## Adding a new data source

1. Add the download command to the appropriate script in `scripts/`.
2. Document the source URL and what it provides in the table above.
3. Run the script — the file will land in `datasets/sources/`.
4. Make sure `datasets/` is listed in `.gitignore`.
