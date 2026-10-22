/**
 * pgtiler tile worker — entry point.
 *
 * Serves individual tiles out of the PMTiles archives in R2, instead of letting
 * MapLibre read the archives directly over HTTP Range requests.
 *
 * Why: the archives are 1.2–4.8 GB, past Cloudflare's cacheable-object limit, so
 * every Range request missed through to R2 — and the edge cache keys on URL, not
 * byte range. Reading the archive server-side and emitting one response per tile
 * gives every tile its own cache entry and its own ETag.
 *
 * Tile URLs carry a version shortcode derived from the archive's R2 ETag, so a
 * re-upload moves every tile onto a new URL. That is what lets tiles be cached
 * `immutable` in the browser as well as at the edge.
 *
 * Routes:
 *   GET /                                      — index of available archives
 *   GET /{archive}.json                        — TileJSON (hands out the current version)
 *   GET /{archive}/{version}/{z}/{x}/{y}.{ext} — a single tile, immutable
 *   GET /{archive}/{z}/{x}/{y}.{ext}           — unversioned tile, briefly cacheable
 *
 * This file does nothing but wire dependencies. The logic lives in
 * `handler.ts` and `services/`, which take those dependencies as arguments so
 * they can be exercised without a running worker. See `docs/CACHING.md`.
 */

import { loadConfig } from "./config";
import { handleRequest, type Deps } from "./handler";
import { ArchiveStore } from "./services/archive-store";
import { EdgeResponseCache } from "./services/tile-cache";
import { TileService } from "./services/tile-service";
import type { Env, ObjectStore } from "./types";

/**
 * Per-isolate state.
 *
 * The archive store holds the pmtiles directory cache and memoised ETags, both
 * of which are worth keeping across requests. It is built lazily and reused,
 * but keyed on the bucket binding so a different Env (as in a test, or
 * `wrangler dev` reloading) doesn't inherit a stale one.
 */
let cachedStore: { bucket: R2Bucket; store: ArchiveStore } | undefined;

function getStore(env: Env, ttlMs: number): ArchiveStore {
  if (cachedStore?.bucket !== env.BUCKET) {
    cachedStore = {
      bucket: env.BUCKET,
      store: new ArchiveStore(env.BUCKET as unknown as ObjectStore, ttlMs),
    };
  }
  return cachedStore.store;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(env);
    const store = getStore(env, config.archiveTtlMs);

    const deps: Deps = {
      config,
      store,
      tiles: new TileService(store, config),
      cache: new EdgeResponseCache(caches.default, (p) => ctx.waitUntil(p)),
    };

    return handleRequest(request, deps);
  },
} satisfies ExportedHandler<Env>;
