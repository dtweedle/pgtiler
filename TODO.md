# TODO

## Docker images
- [ ] Replace third-party Docker images with safe public images from GHCR or build own multi-arch images
  - `helmi03/rio-rgbify` — no official image; consider building own from https://github.com/mapbox/rio-rgbify
  - `protomaps/go-pmtiles` — verify provenance or build from source
  - `ghcr.io/felt/tippecanoe` — official Felt image, currently used with `platform: linux/amd64` (runs via Rosetta on Apple Silicon). Ideally find or build a native arm64 image.
