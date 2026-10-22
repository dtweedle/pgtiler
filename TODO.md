# TODO

## Docker images

- [ ] Replace third-party Docker images with safe public images from GHCR or build own multi-arch images
  - `helmi03/rio-rgbify` — no official image; consider building own from https://github.com/mapbox/rio-rgbify
  - `protomaps/go-pmtiles` — verify provenance or build from source
  - `tippecanoe` — built from source (felt/tippecanoe) via `docker/tippecanoe.Dockerfile`, `platform: linux/arm64`. Native on Apple Silicon; the Rosetta concern noted here previously no longer applies.

## Contour styling

- [ ] Smoother zoom transition — fade contour lines in gradually from low zoom to high zoom instead of appearing abruptly
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

- [ ] Try higher `-j` worker counts on single rio-rgbify (e.g. 16, 20) — 10 workers gave 1320s,
      may have headroom
- [ ] Try uncompressed or COG intermediate GeoTIFF to speed up reads within rio-rgbify
- [ ] Investigate if a Rust/C terrain encoder exists (rio-rgbify is Python/rasterio — may have
      overhead from PIL PNG encoding per tile)
- [ ] Check if rio-rgbify source can be patched to use faster PNG writing (e.g. fpnge, libpng
      with lower compression)
- [ ] Consider reducing max zoom — z11 instead of z12 cuts tile count by ~75% (source DEM is 30m,
      z12 is ~38m/pixel so z11 at ~76m/pixel may be acceptable)
