# TODO

## Docker images

- [ ] Replace third-party Docker images with safe public images from GHCR or build own multi-arch images
  - `helmi03/rio-rgbify` — no official image; consider building own from https://github.com/mapbox/rio-rgbify. It's amd64 only, so it runs emulated on Apple Silicon, and it's the 5-hour step of the terrain build. A native arm64 build is the most promising speed-up (unmeasured)
  - `protomaps/go-pmtiles` — verify provenance or build from source
  - `tippecanoe` — built from source (felt/tippecanoe) via `docker/tippecanoe.Dockerfile`, `platform: linux/arm64`. Native on Apple Silicon; the Rosetta concern noted here previously no longer applies.

## Contour styling

- [x] Smoother zoom transition — both styles now fade contours in: Squiggly Outdoor over z9–11, Hams Outdoor with 100 m lines over z8–9.5 and 20 m lines by z11
- [ ] Reduce line density — render fewer contour lines at lower zoom levels (e.g. only 100m intervals at z8–10, 50m at z11–12, full 20m at z13+)

## Data freshness

- [ ] Check Copernicus DEM datestamp to see if newer data is available before downloading
  - Compare local tile timestamps against S3 `LastModified` headers
  - Copernicus GLO-30 has had periodic updates — worth checking for re-releases

## Speed up terrain tile generation

### Findings

Benchmarked March 2026 (Eastern Seaboard, 69 DEM tiles, z0–12, 16,805 tiles).
**Written up in [docs/GENERATION.md](docs/GENERATION.md)** —
the constraint (terrarium is base-256, so resampling encoded RGB corrupts
elevation at 256 m boundaries), the full comparison table, and why parallel
zoom-splitting makes rio-rgbify 1.7–16.6× *slower*.

### Remaining ideas to try

- [ ] **Index the MBTiles before converting** — rio-rgbify writes no index, so
      `pmtiles convert` reads through the table for every tile and takes hours at
      full scale. One `CREATE UNIQUE INDEX` in the metadata step; see
      [docs/GENERATION.md](docs/GENERATION.md#problem-1--no-index-on-the-tiles-table)

- [ ] Try higher `-j` worker counts on single rio-rgbify (e.g. 16, 20) — 10 workers gave 1320s,
      may have headroom
- [ ] Try uncompressed or COG intermediate GeoTIFF to speed up reads within rio-rgbify
- [ ] Investigate if a Rust/C terrain encoder exists (rio-rgbify is Python/rasterio — may have
      overhead from PIL PNG encoding per tile)
- [ ] Check if rio-rgbify source can be patched to use faster PNG writing (e.g. fpnge, libpng
      with lower compression)
- [ ] Consider reducing max zoom — z11 instead of z12 cuts tile count by ~75%. Terrain tiles
      are 512 × 512 px, so z11 is ~38 m/pixel at the equator, close to the 30 m source, while
      z12 is ~19 m/pixel, finer than the data and therefore interpolated
