# TODO

## Docker images
- [ ] Replace third-party Docker images with safe public images from GHCR or build own multi-arch images
  - `helmi03/rio-rgbify` — no official image; consider building own from https://github.com/mapbox/rio-rgbify
  - `protomaps/go-pmtiles` — verify provenance or build from source
  - `ghcr.io/felt/tippecanoe` — official Felt image, currently used with `platform: linux/amd64` (runs via Rosetta on Apple Silicon). Ideally find or build a native arm64 image.

## Data freshness
- [ ] Check Copernicus DEM datestamp to see if newer data is available before downloading
  - Compare local tile timestamps against S3 `LastModified` headers
  - Copernicus GLO-30 has had periodic updates — worth checking for re-releases
