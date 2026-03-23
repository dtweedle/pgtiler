# TODO

## Docker images
- [ ] Replace third-party Docker images with safe public images from GHCR or build own multi-arch images
  - `helmi03/rio-rgbify` — no official image; consider building own from https://github.com/mapbox/rio-rgbify
  - `protomaps/go-pmtiles` — verify provenance or build from source
  - `ghcr.io/felt/tippecanoe` — official Felt image, currently used with `platform: linux/amd64` (runs via Rosetta on Apple Silicon). Ideally find or build a native arm64 image.

## Contour styling
- [ ] Smoother zoom transition — fade contour lines in gradually from low zoom to high zoom instead of appearing abruptly
- [ ] Reduce line density — render fewer contour lines at lower zoom levels (e.g. only 100m intervals at z8–10, 50m at z11–12, full 20m at z13+)

## Data freshness
- [ ] Check Copernicus DEM datestamp to see if newer data is available before downloading
  - Compare local tile timestamps against S3 `LastModified` headers
  - Copernicus GLO-30 has had periodic updates — worth checking for re-releases
