# pgtiler

A local-first map tiling backend for a paragliding tracking service. Generates and serves vector tiles, contour lines, and terrain data from open datasets. Built on [Martin](https://martin.maplibre.org/) (tile server), [Planetiler](https://github.com/onthegomap/planetiler) (tile generator), and [MapLibre GL JS](https://maplibre.org/) (frontend preview).

## Documentation

| Where | What |
|---|---|
| [docs/DOCS.md](docs/DOCS.md) | Index to everything below — start here |
| [docs/DEVELOPING.md](docs/DEVELOPING.md) | Developer workflow: test mode, checking output, local servers, before and after a full build |
| [docs/GENERATION.md](docs/GENERATION.md) | How the archives are built and why each pipeline is shaped that way |
| [docs/SERVING.md](docs/SERVING.md) | How a tile reaches the screen — formats, URL schemes, request path |
| [docs/CACHING.md](docs/CACHING.md) | The four cache layers, versioning and redeploys |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Terms used across the notes |
| [worker/README.md](worker/README.md) | Cloudflare Worker layout, config and deployment |
| [scripts/SCRIPTS.md](scripts/SCRIPTS.md) | One line per script |
| [preview/PREVIEW.md](preview/PREVIEW.md) | The MapLibre preview page and styles |

The `docs/` notes are written for [Obsidian](https://obsidian.md/): open the repo
folder as a vault and the `[[wikilinks]]` between them work, with hover previews
and backlinks. On GitHub those links show as plain text.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose — every geospatial tool runs in a container
- [AWS CLI](https://aws.amazon.com/cli/) — Copernicus DEM download, no AWS account needed
- [Python 3](https://www.python.org/) — preview server and `check-terrain.py`
- [rclone](https://rclone.org/) and [Node.js / npm](https://nodejs.org/) — only for publishing (R2 uploads, the worker)
- **Disk:** ~2 GB OSM extract, ~27 GB Copernicus DEM (868 tiles), ~11 GB of archives today. A full-Australia terrain build needs very roughly another 100 GB while it runs. See [DEVELOPING.md](docs/DEVELOPING.md#5--pre-flight-and-the-full-build).

## Quick start

```bash
docker compose up -d                       # 1. Martin tile server on :3000
./scripts/init.sh                          # 2. OSM extract
./scripts/generate-osm-tiles.sh            #    → base map
./scripts/download-copernicus-dem.sh       # 3. DEM tiles (also builds the VRTs)
./scripts/generate-contours.sh             # 4. contours   — hours
./scripts/generate-terrain-tiles.sh        #    terrain    — hours
docker compose restart martin              # 5. pick up the new archives
./scripts/preview.sh                       # 6. http://localhost:8080
```

Every generation script takes `--test`, which builds a single 1°×1° tile around
Bright, Victoria in minutes. **Use it before any full build.** The workflow is in
[docs/DEVELOPING.md](docs/DEVELOPING.md).

## Tile archives

| Archive | Contents | Martin source / worker archive |
|---|---|---|
| `tiles/squiggly.v1.base.pmtiles` | OSM vector tiles (OpenMapTiles schema), z0–14 | `squiggly.v1.base` |
| `tiles/squiggly.v1.contours.pmtiles` | 20 m contour lines, `elevation` attribute, z8–14 | `squiggly.v1.contours` |
| `tiles/squiggly.v1.terrain.pmtiles` | Terrarium-encoded DEM for hillshade + 3D, z0–12 | `squiggly.v1.terrain` |

The filename minus `.pmtiles` is the source ID both locally and in production.
`v1` is a schema version, bumped by hand when styles would break. `--test`
variants are suffixed `-test`. How each is built: [docs/GENERATION.md](docs/GENERATION.md).

## Project structure

```
pgtiler/
├── datasets/
│   ├── sources/                         # Raw downloads — gitignored
│   │   ├── australia.osm.pbf            # OSM extract from Geofabrik
│   │   ├── copernicus-dem/              # 868 GeoTIFF tiles from AWS (~27 GB)
│   │   ├── australia-dem.vrt            # VRT: all tiles (for contours)
│   │   └── australia-terrain.vrt        # VRT: all tiles (for terrain — same set)
│   └── tmp/                             # Intermediate build artifacts — gitignored
│       ├── contours/                    # GeoJSON contour files (per tile)
│       ├── contours.mbtiles             # Intermediate vector tiles
│       └── australia-terrain.mbtiles    # Intermediate RGB terrain tiles
├── docker/
│   └── tippecanoe.Dockerfile            # Custom tippecanoe build
├── tiles/                               # Final tile archives served by Martin — gitignored
│   ├── squiggly.v1.base.pmtiles         # OSM base map vector tiles
│   ├── squiggly.v1.contours.pmtiles     # Vector contour lines
│   └── squiggly.v1.terrain.pmtiles      # RGB-encoded terrain (hillshade + 3D)
├── styles/                              # Production MapLibre styles (uploaded to R2)
│   ├── squiggly-outdoor.json
│   └── hams-outdoor.json
├── preview/
│   ├── index.html                       # MapLibre GL JS preview page
│   ├── outdoor-style.json               # Standalone style copy (for Maputnik)
│   ├── config.js                        # Auto-generated by preview.sh (gitignored)
│   ├── styles → ../styles               # Symlink, created by preview.sh
│   └── PREVIEW.md                       # Preview page documentation
├── worker/                              # Cloudflare Worker serving tiles from R2
│   ├── src/                             # index, handler, router, services, utils
│   ├── wrangler.toml                    # dev + production environments
│   └── README.md                        # Worker docs
├── docs/                                # Obsidian notes — design record + workflow
│   ├── DOCS.md                          # Index — start here
│   ├── DEVELOPING.md                    # Test, verify, then build at scale
│   ├── GENERATION.md                    # How the archives are built, and why
│   ├── SERVING.md                       # How tiles reach the screen
│   ├── CACHING.md                       # The four cache layers
│   └── GLOSSARY.md                      # Terms used across the notes
├── scripts/
│   ├── init.sh                          # Download all datasets
│   ├── download-osm-base-vectors.sh     # Download Australia OSM extract
│   ├── download-copernicus-dem.sh       # Download Copernicus DEM tiles
│   ├── build-vrts.sh                    # Build VRT index files from DEM tiles
│   ├── generate-osm-tiles.sh            # OSM → vector tiles (Planetiler)
│   ├── generate-contours.sh             # DEM → contour lines (PMTiles)
│   ├── generate-terrain-tiles.sh        # DEM → RGB terrain (PMTiles)
│   ├── upload-tiles.sh                  # Upload production tiles to Cloudflare R2
│   ├── deploy-worker.sh                 # Deploy / run the tile worker
│   ├── upload-style.sh                  # Upload style JSON to R2
│   ├── check-terrain.py                 # Verify a terrain build before upload
│   ├── test-config.sh                   # Shared test mode configuration
│   ├── preview.sh                       # Start local preview server
│   └── SCRIPTS.md                       # Script documentation
├── .env.example                         # R2 upload configuration template
├── docker-compose.yml                   # All services
├── martin-config.yaml                   # Martin tile server config
├── TODO.md                              # Open work
└── CLAUDE.md                            # AI assistant instructions
```


## Publishing (Cloudflare R2 + Worker)

Production tiles live in an R2 bucket and are served by a Cloudflare Worker that
returns one cacheable response per tile.

1. Configure an rclone remote for R2 (steps in the header of `scripts/upload-tiles.sh`)
2. `cp .env.example .env` and fill in `R2_BUCKET`, `R2_REMOTE` and `R2_PUBLIC_URL`
3. `./scripts/upload-tiles.sh` — uploads every non-test archive in `tiles/`
4. `./scripts/deploy-worker.sh dev`, check `dev.tweed.nz`, then `./scripts/deploy-worker.sh production`
5. `./scripts/upload-style.sh` — uploads `styles/squiggly-outdoor.json` pointed at `R2_PUBLIC_URL`

Point clients at `{R2_PUBLIC_URL}/{archive}.json` (TileJSON), never at tile paths
or the raw `.pmtiles`. dev and production read the **same bucket**, so an upload
is live on both at once. Check it first: see
[docs/DEVELOPING.md](docs/DEVELOPING.md#7--upload-and-verify-on-dev). Why it's
built this way: [docs/SERVING.md](docs/SERVING.md) and
[docs/CACHING.md](docs/CACHING.md). Worker details: [worker/README.md](worker/README.md).

## Data sources and licenses

| Dataset | Source | License |
|---------|--------|---------|
| OpenStreetMap | [Geofabrik](https://download.geofabrik.de/) | [ODbL](https://www.openstreetmap.org/copyright) |
| Copernicus GLO-30 DEM | [AWS S3](https://registry.opendata.aws/copernicus-dem/) | [Copernicus licence](https://spacedata.copernicus.eu/data-offer/core-datasets) (free, attribution required) |
| Natural Earth | [naturalearthdata.com](https://www.naturalearthdata.com/) | [Public domain](https://www.naturalearthdata.com/about/terms-of-use/) |
| OpenMapTiles schema | [openmaptiles.org](https://openmaptiles.org/) | [BSD-3-Clause](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md) |
