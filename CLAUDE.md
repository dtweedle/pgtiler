# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**pgtiler** is a local-first map tiling backend for a paragliding tracking service. It serves vector tiles, contour lines, and terrain data to MapLibre GL JS on the frontend. The stack is:

- **Martin** — open-source tile server (PMTiles/MBTiles support)
- **PMTiles** — static tile archives for OSM base map, contours, and terrain (large, not committed)
- **GDAL** — geospatial processing (contour generation, virtual raster)
- **Tippecanoe** — GeoJSON → vector tile conversion
- **rio-rgbify** — DEM → RGB terrain tile encoding (terrarium encoding)

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

# Download Copernicus DEM
./scripts/download-copernicus-dem.sh

# Build VRT index files (must run before contour/terrain generation)
./scripts/build-vrts.sh

# Generate contour lines (parallel, outputs PMTiles)
./scripts/generate-contours.sh

# Generate RGB terrain tiles (hillshade + 3D)
./scripts/generate-terrain-tiles.sh

# Restart Martin to pick up new tile sources
docker compose restart martin

# Serve the preview page (open at http://localhost:8080)
./scripts/preview.sh

# Production: upload archives to R2, then deploy the tile worker
./scripts/upload-tiles.sh
./scripts/deploy-worker.sh dev      # then: production. --local / --local-remote run it on :8787
./scripts/upload-style.sh

# Test mode — all generation scripts accept --test for fast iteration
./scripts/build-vrts.sh --test
./scripts/generate-contours.sh --test
./scripts/generate-terrain-tiles.sh --test
./scripts/generate-osm-tiles.sh --test

# Check a terrain build before converting/uploading (stdlib Python)
python3 scripts/check-terrain.py datasets/tmp/australia-terrain-test.mbtiles
```

The full test-and-verify workflow is in `docs/DEVELOPING.md`.

## Recording architectural decisions

Key architectural decisions live in `docs/`, one Markdown file per topic
(`docs/CACHING.md`, `docs/SERVING.md`, etc.). The developer workflow — test
mode, verifying output, what to check before a full build — is `docs/DEVELOPING.md`.

**When a decision is made that shapes how the system works — a serving strategy,
a storage layout, a cache design, a format choice — write it up there.** Not just
the conclusion: the problem that forced it, the options rejected and why, the
terminology someone would need to follow it, and explicitly which parts are
verified versus assumed. These documents are for a reader who wasn't in the
conversation.

Update the relevant file when a decision changes rather than appending a new one.
Code comments explain the line in front of you; `docs/` explains why the
shape of the system is what it is.

### Obsidian

The repo root is an Obsidian vault, and `docs/` is written for it.
`docs/DOCS.md` is the index; its *Conventions* section is the
full set of rules. In short:

- Link between notes with wikilinks — `[[CACHING#Layer 2 — The Cloudflare edge|layer 2]]`,
  `[[worker/README]]` — not Markdown links. External URLs stay Markdown links.
- Every note starts with YAML frontmatter (`tags`, `aliases`, `related`,
  `updated`). Bump `updated` when you change a note.
- Define a term once, in `docs/GLOSSARY.md`, and link to it.
- Warnings, hazards and constraints go in callouts (`> [!warning]`, `> [!danger]`, …).
- Give items other notes cite by number a block ID (`^assumption-3`).
- Heading renames break links to them — search for `#Old heading` first.
- `README.md` and the other GitHub-facing docs keep Markdown links.

## Keeping the docs current

**Before finishing any change, check whether `README.md` or `docs/` needs
updating, and say which — including when the answer is neither.** Documentation
drift is the default outcome otherwise; this check is part of the work, not a
follow-up.

- `README.md` — kept short: what the project is, setup, quick start, the
  directory tree, the deployment sequence. Detail belongs in `docs/`, not here.
- `docs/DEVELOPING.md` — how to test and verify a change: test mode, checks,
  local servers, the pre-flight list for full builds.
- `docs/` (the other notes) — anything that changes *why* the system is shaped as it is:
  a new decision, a rejected option, a revised assumption, a corrected fact.
- Also check the doc nearest the code you touched (`worker/README.md`,
  `scripts/SCRIPTS.md`) and any line references you may have invalidated.

Update the docs in the same commit as the change they describe.

## Architecture

Martin auto-serves any `.pmtiles` or `.mbtiles` file in `tiles/`. The filename (without extension) becomes the source ID — no config changes needed.

**Tile sources:**
- `squiggly.v1.base` — OSM base map vector tiles (OpenMapTiles schema)
- `squiggly.v1.contours` — vector contour lines (20m interval, `elevation` attribute)
- `squiggly.v1.terrain` — RGB-encoded DEM (terrarium encoding, for hillshade + 3D)

**VRT files (built by `build-vrts.sh`):**
- `australia-dem.vrt` — all Copernicus tiles (868), used by contour generation
- `australia-terrain.vrt` — all of Australia (same 868 tiles), used by terrain generation

**Processing pipelines (all Dockerised):**
- OSM: `Geofabrik .osm.pbf → Planetiler → .pmtiles`
- Contours: `Copernicus DEM .tif → gdalwarp (smooth) → gdal_contour (parallel) → GeoJSON → tippecanoe → .mbtiles → pmtiles → .pmtiles`
- Terrain: `Copernicus DEM .tif → australia-terrain.vrt → gdalwarp (merge) → rio-rgbify (terrarium) → .mbtiles → pmtiles → .pmtiles`

**Production serving (`worker/`):** a Cloudflare Worker reads the PMTiles archives out of R2 and serves `/{archive}.json` (TileJSON) and `/{archive}/{version}/{z}/{x}/{y}.{ext}` (one response per tile). Do **not** point clients at the raw `.pmtiles` objects over `pmtiles://` — the archives are 1.2–4.8 GB, well over Cloudflare's 512 MB cacheable-object limit, so every Range request misses to R2 and an oversized-object miss can be filled by fetching the whole file.

`{version}` is the first 10 chars of the archive's R2 ETag, which is already a content hash — nothing to track at upload time. It makes tile URLs content-addressed, so they cache `immutable` in the browser as well as at the edge, and a re-upload moves tiles to new URLs instead of needing a purge. TileJSON has a 5-minute TTL and is the only thing clients refetch, so redeploys propagate in minutes. `styles/*.json` reference the worker, not the bucket. See `worker/README.md`.

**Preview page:** `preview/index.html` uses MapLibre GL JS with OpenFreeMap as the base map and adds Martin layers on top. Run a local HTTP server to avoid CORS issues.

## Key URLs when running locally

| URL | What |
|-----|------|
| `http://localhost:3000` | Martin health / root |
| `http://localhost:3000/catalog` | All available tile sources |
| `http://localhost:3000/{source}` | TileJSON for a source |
| `http://localhost:8080` | MapLibre preview page |
