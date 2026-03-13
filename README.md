# pgtiler

A local-first map tiling backend for a paragliding tracking service. Generates and serves vector tiles, contour lines, and terrain data from open datasets. Built on [Martin](https://martin.maplibre.org/) (tile server), [Planetiler](https://github.com/onthegomap/planetiler) (tile generator), and [MapLibre GL JS](https://maplibre.org/) (frontend preview).

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [AWS CLI](https://aws.amazon.com/cli/) (for Copernicus DEM download — no AWS account needed)
- [Python 3](https://www.python.org/) (for the preview server)
- ~2 GB disk for Australia OSM extract, ~15 GB for Copernicus DEM tiles, ~2-4 GB for generated tile archives

## Quick start

```bash
# 1. Start services
docker compose up -d

# 2. Download OSM data + generate base map tiles
./scripts/init.sh
./scripts/generate-osm-tiles.sh

# 3. Download Copernicus DEM + build virtual raster
./scripts/download-copernicus-dem.sh

# 4. Generate contour + terrain tiles (see pipeline sections below)
./scripts/generate-contours.sh
./scripts/generate-terrain-tiles.sh

# 5. Restart Martin to pick up new tile sources
docker compose restart martin

# 6. Open the preview map
./scripts/preview.sh
# → open http://localhost:8080
```

## Project structure

```
pgtiler/
├── datasets/
│   ├── sources/                         # Raw downloads — gitignored
│   │   ├── australia.osm.pbf            # OSM extract from Geofabrik
│   │   ├── copernicus-dem/              # ~1450 GeoTIFF tiles from AWS
│   │   └── australia-dem.vrt            # Virtual raster index (see below)
│   └── tmp/                             # Intermediate build artifacts — gitignored
│       ├── contours/                    # GeoJSON contour files (per tile)
│       ├── contours.mbtiles             # Intermediate vector tiles
│       └── australia-terrain.mbtiles    # Intermediate RGB terrain tiles
├── tiles/                               # Final tile archives served by Martin — gitignored
│   ├── output.mbtiles                   # OSM base map vector tiles
│   ├── contours.pmtiles                 # Vector contour lines
│   └── australia-terrain.pmtiles        # RGB-encoded terrain (hillshade + 3D)
├── preview/
│   ├── index.html                       # MapLibre GL JS preview page
│   └── outdoor-style.json              # Standalone Squiggly Outdoor style
├── scripts/
│   ├── init.sh                          # Download all datasets
│   ├── download-osm-base-vectors.sh     # Download Australia OSM extract
│   ├── download-copernicus-dem.sh       # Download Copernicus DEM + build VRT
│   ├── generate-osm-tiles.sh               # OSM → vector tiles (Planetiler)
│   ├── generate-contours.sh            # DEM → contour lines (PMTiles)
│   ├── generate-terrain-tiles.sh       # DEM → RGB terrain (PMTiles)
│   └── preview.sh                       # Start local preview server
├── .env.example                         # Template for API keys
├── docker-compose.yml                   # All services
├── martin-config.yaml                   # Martin tile server config
└── CLAUDE.md                            # AI assistant instructions
```

## Docker services

All processing tools run inside Docker — no local installs needed beyond the AWS CLI.

| Service | Image | Profile | Purpose |
|---------|-------|---------|---------|
| `martin` | `ghcr.io/maplibre/martin` | default | Tile server (PMTiles/MBTiles) |
| `planetiler` | `ghcr.io/onthegomap/planetiler` | `generate` | OSM → OpenMapTiles vector tiles |
| `gdal` | `ghcr.io/osgeo/gdal:alpine-small` | `tools` | `gdalbuildvrt`, `gdal_contour` |
| `rgbify` | `helmi03/rio-rgbify` | `tools` | DEM → RGB-encoded terrain tiles |
| `tippecanoe` | `metacollin/tippecanoe` | `tools` | GeoJSON → vector MBTiles |
| `pmtiles` | `protomaps/go-pmtiles` | `tools` | MBTiles → PMTiles conversion |

Services with the `tools` profile only run on-demand via `docker compose run --rm <service>`. They do not start with `docker compose up`.

---

## Pipeline: OSM Base Map

Converts an OpenStreetMap extract into vector tiles using the OpenMapTiles schema.

```
australia.osm.pbf (Geofabrik)
  → Planetiler → output.mbtiles
    → Martin serves as vector tiles
```

**Step 1 — Download OSM extract:**

`./scripts/download-osm-base-vectors.sh` fetches the latest Australia extract from [Geofabrik](https://download.geofabrik.de/) (~2 GB) into `datasets/sources/australia.osm.pbf`.

**Step 2 — Generate vector tiles:**

`./scripts/generate-osm-tiles.sh` runs [Planetiler](https://github.com/onthegomap/planetiler) via Docker. Planetiler reads the `.osm.pbf` file and builds a tile pyramid in the [OpenMapTiles](https://openmaptiles.org/schema/) schema — splitting map features (roads, water, buildings, landuse, POIs, etc.) into thematic layers, simplifying geometries per zoom level, and writing the result as `tiles/output.mbtiles`.

**Output:** Martin auto-serves the MBTiles file. The filename `output` becomes the source ID, so tiles are available at `http://localhost:3000/output/{z}/{x}/{y}`.

---

## Pipeline: Contour Lines

Generates vector contour lines from elevation data and packages them as PMTiles.

```
~1450 × Copernicus .tif (30m elevation grids)
  → gdalbuildvrt → australia-dem.vrt (virtual raster index)
    → gdal_contour (8 parallel) → GeoJSON files (one per tile)
      → tippecanoe → contours.mbtiles (vector tiles)
        → pmtiles convert → contours.pmtiles
          → Martin serves as vector tiles
```

**Step 1 — Download DEM tiles:**

`./scripts/download-copernicus-dem.sh` downloads [Copernicus GLO-30](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model) DEM tiles from AWS S3 (`s3://copernicus-dem-30m`). Each tile is a 1°×1° GeoTIFF containing a grid of elevation values in metres at 30m resolution. Australia requires ~1450 tiles. Downloads run 10 in parallel using `xargs -P`. No AWS account or API key is needed — the bucket is publicly accessible with `--no-sign-request`.

**Step 2 — Build virtual raster:**

At the end of the download, the script runs `gdalbuildvrt` inside the `gdal` Docker container. This creates `australia-dem.vrt` — a lightweight XML file (~few KB) that tells GDAL tools "treat these 1450 files as a single seamless raster." No pixel data is copied or merged. All subsequent tools read the VRT (or the individual tiles) as their input. The VRT uses container paths (`/data/datasets/...`) so it works inside Docker.

**Step 3 — Trace contour lines:**

`./scripts/generate-contours.sh` runs `gdal_contour` on each `.tif` tile independently, with 8 containers running in parallel. For each tile, `gdal_contour` walks the elevation grid cell by cell, interpolating where each contour line crosses between adjacent pixels, and outputs LineString geometries with an `elevation` attribute. Lines are generated at **20m intervals**. The output format is GeoJSON (one file per DEM tile) written to `datasets/tmp/contours/`.

**Step 4 — Build vector tiles:**

[Tippecanoe](https://github.com/felt/tippecanoe) reads all the GeoJSON files, merges them, simplifies geometries per zoom level (coarser at low zoom, detailed at high zoom), and builds a vector tile pyramid as `datasets/tmp/contours.mbtiles`. Tiles are generated for zoom levels 8–14. The output layer is named `contours` with an `elevation` property on each line feature.

**Step 5 — Convert to PMTiles:**

`pmtiles convert` repackages the MBTiles (SQLite) into a PMTiles archive with a clustered spatial index. The result is `tiles/contours.pmtiles`. PMTiles is a single-file format where any tile can be fetched with one HTTP range request — no database needed.

**Output:** Martin auto-serves the PMTiles file at `http://localhost:3000/contours/{z}/{x}/{y}`. In MapLibre, major contour lines (every 100m) can be styled differently using the expression `["==", ["%", ["get", "elevation"], 100], 0]`.

---

## Pipeline: Terrain (Hillshade + 3D)

Encodes elevation data as RGB terrain tiles that MapLibre uses for both hillshade rendering and 3D terrain displacement.

```
~1450 × Copernicus .tif (30m elevation grids)
  → gdalbuildvrt → australia-dem.vrt (same VRT from contour pipeline)
    → rio rgbify (terrarium encoding) → australia-terrain.mbtiles
      → pmtiles convert → australia-terrain.pmtiles
        → Martin serves as raster-dem tiles
          → MapLibre renders hillshade + 3D terrain client-side
```

**Step 1 — RGB encoding:**

`./scripts/generate-terrain-tiles.sh` runs [rio-rgbify](https://github.com/mapbox/rio-rgbify) inside the `rgbify` Docker container. This tool reads each elevation pixel from the VRT and encodes the value into the red, green, and blue channels of a PNG tile using the "terrarium" encoding:

```
elevation = (R × 256 + G + B / 256) - 32768
```

Each pixel's RGB values together encode the elevation as a 24-bit number. This packs precise elevation data into standard PNG images that browsers and tile servers can handle natively. The tool builds a tile pyramid from zoom 0 (whole world in one 256×256 tile) down to zoom 12 (~38m/pixel, matching the 30m source resolution). Each zoom level has 4× the tiles of the level above. Output is `datasets/tmp/australia-terrain.mbtiles`.

**Step 2 — Convert to PMTiles:**

Same as the contour pipeline — `pmtiles convert` repackages MBTiles into `tiles/australia-terrain.pmtiles`.

**Output:** Martin serves the PMTiles as a raster-dem source. MapLibre uses these tiles for two purposes from the same source:

- **Hillshade** — the browser decodes elevation back from the RGB pixel values and computes light/shadow at a configurable sun angle and intensity. No server-side rendering needed — you can adjust the look at runtime.
- **3D terrain** — MapLibre's `setTerrain()` reads the same decoded elevation and displaces the map surface vertically, turning the flat map into a 3D mesh you can tilt and rotate.

```js
// Add the source once
map.addSource('terrain', {
  type: 'raster-dem',
  tiles: ['http://localhost:3000/australia-terrain/{z}/{x}/{y}'],
  encoding: 'terrarium',
  tileSize: 256
});

// Hillshade layer
map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'terrain' });

// 3D terrain
map.setTerrain({ source: 'terrain', exaggeration: 1.5 });
```

---

## Key URLs (when running locally)

| URL | What |
|-----|------|
| `http://localhost:3000` | Martin health / root |
| `http://localhost:3000/catalog` | All available tile sources |
| `http://localhost:3000/{source}` | TileJSON for a source |
| `http://localhost:3000/contours/{z}/{x}/{y}` | Contour vector tiles |
| `http://localhost:3000/australia-terrain/{z}/{x}/{y}` | RGB terrain tiles |
| `http://localhost:8080` | MapLibre preview page |

## Preview page

`preview/index.html` uses MapLibre GL JS with four sidebar sections:

- **External Maps** — third-party reference basemaps (OpenFreeMap, ESRI Satellite, OpenTopoMap)
- **Squiggly Maps** — custom-styled map (SquigglyOutdoorV1) rendered from local Martin tiles
- **Raw Squiggly Layers** — individual vector sub-layers with toggleable overlays for debugging
- **External Layers** — toggleable overlays (ESRI Hillshade)

The page dynamically fetches Martin's `/catalog` endpoint and builds the layer list at runtime.

## Styling

The Squiggly Outdoor style (`preview/outdoor-style.json`) is a MapTiler Outdoor-inspired style for OpenMapTiles vector tiles. It can be loaded directly into [Maputnik](https://maputnik.github.io/) for visual editing. When editing in Maputnik, add a data source with the TileJSON URL `http://localhost:3000/output`.

Font glyphs are served from `fonts.openmaptiles.org` (Open Sans Regular, Bold, and Italic).

## Adding a new region

1. Edit `scripts/download-osm-base-vectors.sh` to change the Geofabrik URL and filename
2. Update the `--osm_path` in `docker-compose.yml` to match the new filename
3. Edit the bounding box in `scripts/download-copernicus-dem.sh` (`SOUTH`, `NORTH`, `WEST`, `EAST`)
4. Run `./scripts/init.sh && ./scripts/generate-osm-tiles.sh`
5. Run `./scripts/download-copernicus-dem.sh && ./scripts/generate-contours.sh && ./scripts/generate-terrain-tiles.sh`

## Data sources and licenses

| Dataset | Source | License |
|---------|--------|---------|
| OpenStreetMap | [Geofabrik](https://download.geofabrik.de/) | [ODbL](https://www.openstreetmap.org/copyright) |
| Copernicus GLO-30 DEM | [AWS S3](https://registry.opendata.aws/copernicus-dem/) | [Copernicus licence](https://spacedata.copernicus.eu/data-offer/core-datasets) (free, attribution required) |
| Natural Earth | [naturalearthdata.com](https://www.naturalearthdata.com/) | [Public domain](https://www.naturalearthdata.com/about/terms-of-use/) |
| OpenMapTiles schema | [openmaptiles.org](https://openmaptiles.org/) | [BSD-3-Clause](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md) |
