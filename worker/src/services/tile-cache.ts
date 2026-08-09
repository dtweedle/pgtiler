/**
 * The edge cache, behind an interface.
 *
 * `caches.default` is a global with no local equivalent, so reaching for it
 * directly inside the tile logic is what previously forced every cache
 * assertion through a running worker. Injecting it means tests can use
 * MemoryResponseCache and assert on what was stored.
 */

import type { ResponseCache } from "../types";

/** Production: Cloudflare's per-datacenter edge cache. */
export class EdgeResponseCache implements ResponseCache {
  constructor(
    private cache: Cache,
    /** Writes are deferred so the response isn't held up by the cache put. */
    private waitUntil: (p: Promise<unknown>) => void,
  ) {}

  async match(key: string): Promise<Response | undefined> {
    return this.cache.match(new Request(key, { method: "GET" }));
  }

  put(key: string, response: Response): void {
    this.waitUntil(this.cache.put(new Request(key, { method: "GET" }), response));
  }
}

/** Tests and `--dry` runs: an in-process map with no expiry semantics. */
export class MemoryResponseCache implements ResponseCache {
  readonly entries = new Map<string, Response>();

  async match(key: string): Promise<Response | undefined> {
    const hit = this.entries.get(key);
    return hit ? hit.clone() : undefined;
  }

  put(key: string, response: Response): void {
    this.entries.set(key, response);
  }
}

/** A cache that stores nothing. Useful for isolating non-cache behaviour. */
export class NullResponseCache implements ResponseCache {
  async match(): Promise<Response | undefined> {
    return undefined;
  }

  put(): void {}
}
