# Tile worker

A Cloudflare Worker that serves individual tiles out of the PMTiles archives in R2.

## Why this exists

The archives used to be served straight from the R2 bucket, and MapLibre read
them with HTTP Range requests via `pmtiles://`. That caches badly: Cloudflare's
edge cache is keyed on the URL, not on the requested byte range, so responses
for `squiggly.v1.base.pmtiles` could be served back with bytes that didn't match
the range asked for — and re-uploading an archive left old byte ranges cached
under the same URL.

There was a second problem underneath that one: the archives are 1.2–4.8 GB, and
Cloudflare will not cache an object over 512 MB on Free/Pro/Business plans (5 GB
on Enterprise). They were never eligible for the edge cache at all, so every
Range request went the whole way to R2 — and a Range miss on an oversized object
can be filled by fetching the entire file, which is where the occasional
full-archive response came from.

The worker reads the archive server-side and returns **one response per tile**.
Every tile is a few KB, comfortably cacheable, with its own cache entry and `ETag`.

## Versioned tile URLs

Tile paths carry a version shortcode — the first 10 characters of the archive's
R2 ETag, which is already a content hash (MD5, or MD5-of-part-MD5s for multipart
uploads). Nothing needs to be tracked at upload time; `upload-tiles.sh` is
unchanged.

This is what makes tiles safely `immutable`. Folding the ETag into the *edge*
cache key alone would still leave browsers serving whatever they cached under a
stable URL until its `max-age` expired. Putting the version in the URL means a
re-upload moves every tile to a new address, and the old ones are simply never
requested again — no purge step.

TileJSON is the indirection point: it has a 5-minute TTL, is re-fetched on each
map load, and hands out the current version. So a redeploy propagates in minutes.

## Routes

| Route | What |
|-------|------|
| `GET /` | JSON index of servable archives |
| `GET /{archive}.json` | TileJSON — hands out the current version (5 min cache) |
| `GET /{archive}/{version}/{z}/{x}/{y}.{ext}` | A single tile, cached `immutable` for a year |
| `GET /{archive}/{z}/{x}/{y}.{ext}` | Unversioned; served, but only 60s cacheable |

`{archive}` is the object name without `.pmtiles` — e.g. `squiggly.v1.base`.
`{ext}` must match the archive's tile type: `.mvt` for vector, `.png` for the
terrain DEM. Vector tiles are re-gzipped on the way out; raster tiles are served
as-is. A tile that isn't in the archive returns `204`, which is cached too.

A request at a *superseded* version is answered from the current archive rather
than 404'd — a client whose map is already open keeps working through a redeploy
instead of showing holes — but gets the short TTL, since that URL no longer
describes the bytes it returns.

## Cache layers

| Layer | Scope | Governed by | Holds |
|-------|-------|-------------|-------|
| Browser | per user | `Cache-Control` on the response | tiles, TileJSON |
| `caches.default` | **per Cloudflare colo** | `Cache-Control` on the response passed to `cache.put` | tiles only |
| `pmtilesCache` | per isolate | LRU, 200 entries | archive header + directory pages |
| `archiveEtags` | per isolate | `ARCHIVE_TTL_SECONDS` | current ETag per archive |

Two things follow that aren't obvious:

**The Cache API is per-datacenter.** A tile warmed in Sydney is a miss in Perth.
R2 read volume scales with (unique tiles × PoPs seeing traffic), not unique
tiles. Fine for AU-centric traffic; worth knowing before assuming one global cache.

**`archiveEtags` memoisation can lag a re-upload by up to `ARCHIVE_TTL_SECONDS`.**
During that window an isolate believes a superseded ETag is current, while
pmtiles — whose reads are `onlyIf`-guarded and which retries on `EtagMismatch` —
transparently serves bytes from the *new* archive. Cache lifetime is therefore
decided from `R2Source.lastEtag`, the ETag that actually produced the bytes,
never from the memoised value. Getting this wrong stamps `immutable` on new bytes
under an old version's URL and pins the mismatch for a year.

TileJSON is deliberately **not** written to `caches.default`: it is the mechanism
by which a redeploy propagates, so it should stay as close to R2 as possible.
Adding a Cloudflare Cache Rule that catches `/*.json` on this route would
undermine that — the worker's own `Cache-Control` is the only thing that should
govern its lifetime.

## Deploy

```bash
# from the repo root
./scripts/deploy-worker.sh          # deploy
./scripts/deploy-worker.sh --dev    # local dev on :8787
```

First time:

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

### Custom domain

`maps.tweed.nz` currently resolves to the R2 bucket's public domain. To move it
to the worker:

1. Cloudflare dashboard → R2 → `squiggly-maps-v1` → Settings → **remove** the
   `maps.tweed.nz` custom domain (and disable public access — the worker reads
   through its R2 binding, the bucket does not need to be public).
2. Uncomment the `[[routes]]` block in `wrangler.toml`.
3. `./scripts/deploy-worker.sh`

Until then the worker is reachable at its `*.workers.dev` URL.

## Local dev

`wrangler dev` uses a local R2 emulation, not the real bucket. Seed it:

```bash
cd worker
npx wrangler r2 object put squiggly-maps-v1/squiggly.v1.base-test.pmtiles \
  --file ../tiles/squiggly.v1.base-test.pmtiles --local
npx wrangler dev
```

Then `curl http://localhost:8787/` to see what's available. Use
`npx wrangler dev --remote` to run against the real bucket instead.

## Config (`wrangler.toml` `[vars]`)

| Var | Default | What |
|-----|---------|------|
| `ALLOWED_ARCHIVES` | the `squiggly.v1.*` set | Comma-separated allowlist. Empty = any `.pmtiles` in the bucket. |
| `CACHE_CONTROL` | `public, max-age=31536000, immutable` | Tiles requested at the current version. |
| `UNVERSIONED_CACHE_CONTROL` | `public, max-age=60, stale-while-revalidate=300` | Tiles requested with no version, or a superseded one. |
| `ARCHIVE_TTL_SECONDS` | `60` | How long an isolate reuses a cached archive ETag before re-checking R2. |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin`. |

Responses carry `X-Tile-Cache: hit|miss` and `X-Tile-Version` — handy for
confirming the edge cache is doing its job and which archive version answered.

```bash
curl -sD- -o/dev/null https://maps.tweed.nz/squiggly.v1.base/<version>/6/57/38.mvt \
  | grep -iE 'cache-control|x-tile'
```
