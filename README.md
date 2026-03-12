# pgtiler

A local-first map tiling backend that generates and serves vector tiles from OpenStreetMap data. Built on [Martin](https://martin.maplibre.org/) (tile server), [Planetiler](https://github.com/onthegomap/planetiler) (tile generator), and [MapLibre GL JS](https://maplibre.org/) (frontend preview).

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Python 3](https://www.python.org/) (for the preview server)
- ~2 GB disk space for the Australia OSM extract, plus ~1-2 GB for generated tiles

## Quick start

```bash
# 1. Download the OSM data
./scripts/init.sh

# 2. Generate vector tiles with Planetiler
./scripts/generate-tiles.sh

# 3. Start Martin tile server
docker compose up

# 4. Open the preview map (in a separate terminal)
./scripts/preview.sh
# → open http://localhost:8080
```

## Project structure

```
pgtiler/
├── datasets/
│   └── sources/           # Raw downloads (.osm.pbf) — gitignored
├── tiles/                 # Generated .mbtiles/.pmtiles — gitignored
├── preview/
│   ├── index.html         # MapLibre GL JS preview page
│   └── outdoor-style.json # Standalone Squiggly Outdoor style
├── scripts/
│   ├── init.sh                      # Download all datasets
│   ├── generate-tiles.sh            # Run Planetiler to build tiles
│   ├── preview.sh                   # Start local preview server
│   └── download-osm-base-vectors.sh # Download Australia OSM extract
├── docker-compose.yml     # Martin + Planetiler services
├── martin-config.yaml     # Martin tile server config
└── CLAUDE.md              # AI assistant instructions
```

## Architecture

**Tile generation pipeline:**

1. `init.sh` downloads the raw OSM extract (from [Geofabrik](https://download.geofabrik.de/)) into `datasets/sources/`
2. `generate-tiles.sh` runs Planetiler via Docker to convert the `.osm.pbf` into OpenMapTiles-schema vector tiles (`.mbtiles`) in `tiles/`
3. Martin auto-serves any `.mbtiles` or `.pmtiles` file in `tiles/` — the filename becomes the source ID

**Preview page** (`preview/index.html`) has three sidebar sections:

- **External Maps** — third-party reference basemaps (OpenFreeMap, ESRI Satellite, OpenTopoMap, ESRI Hillshade)
- **Squiggly Maps** — our custom-styled map (SquigglyOutdoorV1) rendered from local Martin tiles
- **Raw Squiggly Layers** — individual vector sub-layers with toggleable overlays for debugging

The preview page dynamically fetches Martin's `/catalog` endpoint and builds the layer list at runtime.

## Scripts

| Script | Description |
|--------|-------------|
| `./scripts/init.sh` | Create directories and download all required datasets |
| `./scripts/generate-tiles.sh` | Run Planetiler to generate vector tiles from OSM data |
| `./scripts/preview.sh [port]` | Start a local HTTP server for the preview page (default: 8080) |
| `./scripts/download-osm-base-vectors.sh` | Download the latest Australia OSM extract from Geofabrik |

## Key URLs (when running locally)

| URL | What |
|-----|------|
| `http://localhost:3000` | Martin health / root |
| `http://localhost:3000/catalog` | All available tile sources |
| `http://localhost:3000/{source}` | TileJSON for a source |
| `http://localhost:8080` | MapLibre preview page |

## Styling

The Squiggly Outdoor style (`preview/outdoor-style.json`) is a MapTiler Outdoor-inspired style for OpenMapTiles vector tiles. It can be loaded directly into [Maputnik](https://maputnik.github.io/) for visual editing. When editing in Maputnik, add a data source with the TileJSON URL `http://localhost:3000/output`.

Font glyphs are served from `fonts.openmaptiles.org` (Open Sans Regular, Bold, and Italic).

## Adding a new region

1. Edit `scripts/download-osm-base-vectors.sh` to change the Geofabrik URL and filename
2. Update the `--osm_path` in `docker-compose.yml` to match the new filename
3. Run `./scripts/init.sh && ./scripts/generate-tiles.sh`

## Contributing

1. **Fork and clone** the repository
2. **Set up locally** — run `./scripts/init.sh` to download the datasets, then `./scripts/generate-tiles.sh` to build tiles
3. **Make your changes** — styles live in `preview/outdoor-style.json` and `preview/index.html`, pipeline config in `docker-compose.yml`
4. **Test** — run `docker compose up` and `./scripts/preview.sh`, then check the preview at `http://localhost:8080`
5. **Submit a PR** with a clear description of what changed and why

### Guidelines

- Do not commit large files (tile archives, OSM extracts). These belong in `datasets/` and `tiles/`, both gitignored. Instead, add or update a download script in `scripts/`
- Style changes should be tested visually in the preview page or Maputnik before submitting
- Keep `outdoor-style.json` and the inline `buildOutdoorStyle()` in `index.html` in sync if you modify the style

## License

This project is open source. See individual data source licenses:

- OpenStreetMap data: [ODbL](https://www.openstreetmap.org/copyright)
- Natural Earth: [public domain](https://www.naturalearthdata.com/about/terms-of-use/)
- OpenMapTiles schema: [BSD-3-Clause](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md)
