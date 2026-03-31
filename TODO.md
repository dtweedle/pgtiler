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

## Speed up terrain tile generation

### Findings (March 2026)

Benchmarked on Eastern Seaboard (W146 S-37 E155 N-27, ~69 DEM tiles, z0-12, 16,805 tiles).

**The fundamental constraint:** Terrarium encoding packs elevation into RGB as a base-256
number (`elevation = R×256 + G + B/256 - 32768`). Any resampling of the encoded RGB values
(bilinear, cubic, etc.) averages the R, G, B channels independently. At every 256m elevation
boundary where G wraps 255→0 and R increments, this breaks the carry relationship and produces
errors up to 128m — visible as spike artifacts along contour lines. The only correct approach
is to resample raw elevation first, then encode per-pixel. gdal2tiles cannot do this — it has
no plugin point between resample and write.

**Approaches tested:**

| Approach | Time | Output | Quality |
|----------|------|--------|---------|
| rio-rgbify (single, 10 workers) | **1320.7s** | 4.9G | Correct — resamples then encodes |
| GDAL from terrarium VRT (bilinear) | 1026.9s | 4.5G | Broken — encoding artifacts at 256m boundaries |
| GDAL from terrarium VRT (nearest) | 151.4s | 2.9G | No artifacts but ugly aliasing/striping |
| GDAL parallel pool (near, 10 jobs) | 151.4s | 2.9G | Same — nearest avoids artifacts but looks terrible |
| Custom Python tiler (resample→encode) | 397.2s | 4.8G | Tile boundary seam artifacts, multiple iterations failed |
| rio-rgbify parallel zoom split (3 jobs) | 2244.1s | 4.9G | Correct but 1.7x slower than single |
| rio-rgbify parallel zoom split (4 jobs) | 8965.4s | 4.9G | 6.8x slower |
| rio-rgbify parallel zoom split (6 jobs) | 21952.5s | 4.9G | 16.6x slower |

**Key takeaways:**

1. **rio-rgbify is the only viable tool** — it handles resample→encode correctly out of the box
2. **Parallel zoom splitting makes rio-rgbify dramatically worse** — each instance reads the
   entire GeoTIFF, thrashing disk I/O and memory. Internal `-j` workers are far more efficient.
3. **gdal2tiles + terrarium VRT is fundamentally broken** for bilinear resampling. Nearest
   neighbour avoids encoding artifacts but produces unacceptable visual quality.
4. **Custom tiler** (Python + GDAL ReadAsArray + terrarium encode) went through 4 iterations:
   gdal.Warp per tile (OOM), WarpedVRT (too slow), pre-reprojected GeoTIFF (tile boundary seams),
   padded reads (bugged). Abandoned.
5. **gdalwarp step is fast** (~73s) — the bottleneck is entirely in tile encoding/writing.

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
