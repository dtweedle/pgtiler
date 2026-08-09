/**
 * The HTTP layer, driven through `handleRequest` with fake dependencies.
 *
 * Covers what the service tests deliberately don't: status codes, headers,
 * CORS, conditional requests and the edge cache interaction.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "./config";
import { handleRequest, type Deps } from "./handler";
import { ArchiveStore } from "./services/archive-store";
import { MemoryResponseCache } from "./services/tile-cache";
import { TileService } from "./services/tile-service";
import { readArchive } from "./test-support/archives";
import { FakeClock, FakeObjectStore } from "./test-support/fake-object-store";
import type { Env } from "./types";
import { versionCode } from "./utils/version";

const ETAG = "1111111111aaaaaaaaaabbbbbbbbbbcc";
const V = versionCode(ETAG);
const ORIGIN = "https://maps.example.com";
const PRESENT = "6/57/38";

let vectorBytes: Uint8Array;

beforeAll(() => {
  vectorBytes = readArchive("squiggly.v1.base-test");
});

function setup(envOverrides: Partial<Env> = {}) {
  const config = loadConfig({ BUCKET: {} as R2Bucket, ...envOverrides } as Env);
  const objects = new FakeObjectStore().put("base.pmtiles", vectorBytes, ETAG);
  const store = new ArchiveStore(objects, config.archiveTtlMs, new FakeClock());
  const cache = new MemoryResponseCache();

  const deps: Deps = { config, store, tiles: new TileService(store, config), cache };
  const get = (path: string, init?: RequestInit) =>
    handleRequest(new Request(`${ORIGIN}${path}`, init), deps);

  return { deps, cache, objects, get };
}

describe("routing and errors", () => {
  it("serves the archive index", async () => {
    const { get } = setup();
    const res = await get("/");
    const body = (await res.json()) as { archives: { name: string; tilejson: string }[] };

    expect(res.status).toBe(200);
    expect(body.archives[0]).toEqual({
      name: "base",
      tilejson: `${ORIGIN}/base.json`,
      tiles: `${ORIGIN}/base/{version}/{z}/{x}/{y}`,
    });
  });

  it("404s an unrecognised path", async () => {
    expect((await setup().get("/favicon.ico")).status).toBe(404);
  });

  it("404s an archive outside the allowlist", async () => {
    const { get } = setup({ ALLOWED_ARCHIVES: "something-else" });
    expect((await get("/base.json")).status).toBe(404);
  });

  it("404s a traversal attempt without touching storage", async () => {
    const { get, objects } = setup();
    expect((await get("/..%2F..%2Fetc/6/1/1.mvt")).status).toBe(404);
    expect(objects.reads).toHaveLength(0);
  });

  it("404s an out-of-bounds tile", async () => {
    expect((await setup().get(`/base/${V}/2/99/99.mvt`)).status).toBe(404);
  });

  it("405s a write method", async () => {
    const res = await setup().get("/base.json", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("answers a CORS preflight", async () => {
    const res = await setup().get("/base.json", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("honours a configured CORS origin", async () => {
    const { get } = setup({ CORS_ORIGIN: "https://app.example.com" });
    const res = await get("/base.json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });
});

describe("TileJSON responses", () => {
  it("returns a short TTL and the archive ETag", async () => {
    const res = await setup().get("/base.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
    expect(res.headers.get("Cache-Control")).not.toContain("immutable");
    expect(res.headers.get("ETag")).toBe(`"${ETAG}"`);
  });
});

describe("tile responses", () => {
  it("serves a versioned tile as immutable", async () => {
    const res = await setup().get(`/base/${V}/${PRESENT}.mvt`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("X-Tile-Version")).toBe(V);
    expect(res.headers.get("X-Tile-Cache")).toBe("miss");
  });

  it("serves an unversioned tile with a short TTL", async () => {
    const res = await setup().get(`/base/${PRESENT}.mvt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
    expect(res.headers.get("Cache-Control")).not.toContain("immutable");
  });

  it("serves a superseded version with a short TTL", async () => {
    const res = await setup().get(`/base/deadbeef00/${PRESENT}.mvt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).not.toContain("immutable");
  });

  it("returns 204 for an absent tile", async () => {
    const res = await setup().get(`/base/${V}/6/1/1.mvt`);
    expect(res.status).toBe(204);
    expect(res.headers.get("Cache-Control")).toBeTruthy();
  });

  it("404s an extension the archive does not serve", async () => {
    const res = await setup().get(`/base/${V}/${PRESENT}.png`);
    expect(res.status).toBe(404);
  });
});

describe("edge cache", () => {
  it("stores a tile under its full path and reports a hit on repeat", async () => {
    const { get, cache } = setup();

    const first = await get(`/base/${V}/${PRESENT}.mvt`);
    expect(first.headers.get("X-Tile-Cache")).toBe("miss");
    expect([...cache.entries.keys()]).toEqual([`${ORIGIN}/base/${V}/${PRESENT}.mvt`]);

    const second = await get(`/base/${V}/${PRESENT}.mvt`);
    expect(second.headers.get("X-Tile-Cache")).toBe("hit");
  });

  // Different versions must not collide, or a redeploy would serve mixed bytes.
  it("keys separately per version", async () => {
    const { get, cache } = setup();
    await get(`/base/${V}/${PRESENT}.mvt`);
    await get(`/base/deadbeef00/${PRESENT}.mvt`);
    expect(cache.entries.size).toBe(2);
  });

  it("does not re-read storage on a cache hit", async () => {
    const { get, objects } = setup();
    await get(`/base/${V}/${PRESENT}.mvt`);
    const readsAfterFirst = objects.reads.length;

    await get(`/base/${V}/${PRESENT}.mvt`);
    expect(objects.reads).toHaveLength(readsAfterFirst);
  });
});

describe("conditional requests", () => {
  it("304s a matching If-None-Match", async () => {
    const { get } = setup();
    const first = await get(`/base/${V}/${PRESENT}.mvt`);
    const etag = first.headers.get("ETag")!;

    // Second call would otherwise hit the edge cache; a fresh setup isolates
    // the revalidation path.
    const fresh = setup();
    const res = await fresh.get(`/base/${V}/${PRESENT}.mvt`, {
      headers: { "If-None-Match": etag },
    });

    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
  });

  it("serves normally when the If-None-Match does not match", async () => {
    const { get } = setup();
    const res = await get(`/base/${V}/${PRESENT}.mvt`, {
      headers: { "If-None-Match": '"stale"' },
    });
    expect(res.status).toBe(200);
  });
});
