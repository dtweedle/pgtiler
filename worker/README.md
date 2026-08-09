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

## Layout

```
src/
  index.ts              entry point — wires dependencies, nothing else
  handler.ts            routing and HTTP encoding, takes its deps as arguments
  router.ts             path parsing (pure)
  config.ts             wrangler [vars] → typed Config, archive allowlist
  types.ts              shared types + the interfaces services are injected with
  services/
    archive-store.ts    R2 access, ETag memoisation, pmtiles directory cache
    tile-service.ts     tile + TileJSON logic, returns plain results
    tile-cache.ts       edge cache behind an interface (Edge/Memory/Null impls)
  utils/                version, compression, tile-format, http
  test-support/         fakes: object store, clock, archive loader
```

Three deliberate seams make this testable without a running worker:

- **Services take an `ObjectStore`, not an `R2Bucket`.** The interface in
  `types.ts` is the handful of methods actually used; `R2Bucket` satisfies it
  structurally, and `FakeObjectStore` serves real `.pmtiles` bytes from memory.
- **`TileService` returns results, not `Response`s.** Which bytes, which version,
  whether the URL is content-addressed — all assertable without parsing headers.
  `handler.ts` is the only place that knows about HTTP.
- **Per-isolate state lives on `ArchiveStore` instances, not module globals.**
  ETag memoisation and the pmtiles directory cache can't leak between tests, and
  the clock is injected so expiry is testable without sleeping.

## Testing

```bash
npm test              # vitest, plain Node — no workerd, no R2 emulation
npm run test:watch
npm run typecheck     # worker source and tests, separately
```

Tests run against the real `tiles/squiggly.v1.*-test.pmtiles` archives, so pmtiles
parsing, directory traversal and the `EtagMismatch` retry are genuinely
exercised. Generate them first if missing (`./scripts/generate-osm-tiles.sh
--test` and friends from the repo root).

`typecheck` runs two configs. `tsconfig.json` covers worker source with Workers
types only, so anything unavailable in workerd fails there rather than at deploy
time; `tsconfig.test.json` adds Node types for the tests.

What still needs a real runtime, and is therefore worth a `--remote` pass before
deploying: **multipart ETags**. Local archives are small enough to upload in one
part and get a plain MD5; production archives are multipart and get the
`<hash>-<parts>` form. `versionCode` handles both and is unit-tested on both, but
only `wrangler dev --remote` proves it end to end against R2.

## Deploy

```bash
# from the repo root
./scripts/deploy-worker.sh dev             # deploy to *.workers.dev
./scripts/deploy-worker.sh production      # deploy to maps.tweed.nz
./scripts/deploy-worker.sh --local         # run on :8787, local R2 emulation
./scripts/deploy-worker.sh --local-remote  # run on :8787, real R2 bucket
```

First time: `cd worker && npx wrangler login`.

`dev` and `production` are configured identically in `wrangler.toml` and read
the same bucket — dev differs only in worker name and hostname. That is the
point: dev exercises the real archives, including their multipart ETags, which
no local emulation reproduces. The worker only reads, so pointing dev at
production data is safe.

Both deploy targets run `typecheck` and `test` first and abort on failure.

### Custom domain

`maps.tweed.nz` currently resolves to the R2 bucket's public domain. To move it
to the worker:

1. Cloudflare dashboard → R2 → `squiggly-maps-v1` → Settings → **remove** the
   `maps.tweed.nz` custom domain (and disable public access — the worker reads
   through its R2 binding, the bucket does not need to be public).
2. Uncomment the `[[env.production.routes]]` block in `wrangler.toml`.
3. `./scripts/deploy-worker.sh production`

Until then the worker is reachable at its `*.workers.dev` URL.

## Local dev

`--local` uses a local R2 emulation, not the real bucket, so seed it first:

```bash
cd worker
npx wrangler r2 object put squiggly-maps-v1/squiggly.v1.base-test.pmtiles \
  --file ../tiles/squiggly.v1.base-test.pmtiles --local
```

Then `./scripts/deploy-worker.sh --local` and `curl http://localhost:8787/` to
see what's available.

`--local-remote` skips the seeding and reads the real bucket instead — slower,
but the only local mode that exercises production archives and their multipart
ETags.

## Config (`wrangler.toml`)

Vars are defined **per environment** (`[env.dev.vars]`, `[env.production.vars]`)
and are currently identical between the two. Wrangler does not inherit `vars` or
bindings from the top level into named environments, so anything added must be
added to both.

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
