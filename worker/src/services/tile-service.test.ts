/**
 * Exercised against the real squiggly.v1.base-test.pmtiles bytes, so the pmtiles
 * parsing, directory traversal and EtagMismatch retry are all genuinely running
 * — in plain Node, with no workerd and no R2 emulation.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config";
import { readArchive } from "../test-support/archives";
import { FakeClock, FakeObjectStore } from "../test-support/fake-object-store";
import type { Config, Env } from "../types";
import { versionCode } from "../utils/version";
import { ArchiveStore } from "./archive-store";
import { TileService } from "./tile-service";

const ETAG_1 = "1111111111aaaaaaaaaabbbbbbbbbbcc";
const ETAG_2 = "2222222222aaaaaaaaaabbbbbbbbbbcc";
const V1 = versionCode(ETAG_1);
const V2 = versionCode(ETAG_2);

/** A tile that exists in base-test, and one that doesn't. */
const PRESENT = { z: 6, x: 57, y: 38 };
const ABSENT = { z: 6, x: 1, y: 1 };

/**
 * A tile that exists in terrain-test (Bright, VIC).
 *
 * Hard-coded rather than derived from the header: terrain-test's centerLon /
 * centerLat are junk (they point at Argentina), so the usual centre-of-bounds
 * calculation lands on empty space.
 */
const RASTER_PRESENT = { z: 8, x: 231, y: 155 };

let vectorBytes: Uint8Array;
let rasterBytes: Uint8Array;

beforeAll(() => {
  vectorBytes = readArchive("squiggly.v1.base-test");
  rasterBytes = readArchive("squiggly.v1.terrain-test");
});

const config = (): Config => loadConfig({ BUCKET: {} as R2Bucket } as Env);

function setup(bytes = vectorBytes, ttlMs = 60_000) {
  const clock = new FakeClock();
  const objects = new FakeObjectStore().put("base.pmtiles", bytes, ETAG_1);
  const store = new ArchiveStore(objects, ttlMs, clock);
  return { clock, objects, store, tiles: new TileService(store, config()) };
}

describe("getTileJson", () => {
  it("emits a versioned tiles template with the archive's extension", async () => {
    const { tiles } = setup();
    const result = await tiles.getTileJson("base", "https://maps.example.com");

    expect(result?.tilejson.tiles).toEqual([
      `https://maps.example.com/base/${V1}/{z}/{x}/{y}.mvt`,
    ]);
    expect(result?.etag).toBe(ETAG_1);
  });

  it("carries zoom range and bounds from the archive header", async () => {
    const { tiles } = setup();
    const result = await tiles.getTileJson("base", "https://x");

    expect(result?.tilejson.tilejson).toBe("3.0.0");
    expect(result?.tilejson.minzoom).toBe(0);
    expect(result?.tilejson.maxzoom).toBe(14);
    expect(result?.tilejson.bounds).toHaveLength(4);
    expect(result?.tilejson.vector_layers).toBeDefined();
  });

  it("uses .png for a raster archive", async () => {
    const { tiles } = setup(rasterBytes);
    const result = await tiles.getTileJson("base", "https://x");
    expect(String((result?.tilejson.tiles as string[])[0])).toContain(".png");
  });

  it("returns null for an unknown archive", async () => {
    const { tiles } = setup();
    expect(await tiles.getTileJson("nope", "https://x")).toBeNull();
  });
});

describe("getTile", () => {
  it("returns an uncompressed vector tile at the current version", async () => {
    const { tiles } = setup();
    const result = await tiles.getTile("base", V1, PRESENT.z, PRESENT.x, PRESENT.y, "mvt");

    expect(result).toMatchObject({
      kind: "tile",
      contentType: "application/vnd.mapbox-vector-tile",
      version: V1,
      contentAddressed: true,
    });

    // Compression is the edge's job. Setting Content-Encoding on a Worker
    // response gets the header stripped while the body stays encoded, so
    // clients receive gzip bytes labelled as plain MVT. Assert we hand back
    // raw protobuf — no gzip magic — so that can't regress.
    const body = new Uint8Array((result as { body: ArrayBuffer }).body);
    expect([body[0], body[1]]).not.toEqual([0x1f, 0x8b]);
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it("passes a raster tile through as PNG", async () => {
    const { tiles } = setup(rasterBytes);
    const result = await tiles.getTile(
      "base",
      V1,
      RASTER_PRESENT.z,
      RASTER_PRESENT.x,
      RASTER_PRESENT.y,
      "png",
    );

    expect(result).toMatchObject({ kind: "tile", contentType: "image/png" });
    // PNG magic — bytes reach the client untouched.
    const body = new Uint8Array((result as { body: ArrayBuffer }).body);
    expect([...body.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("reports an absent tile as empty rather than an error", async () => {
    const { tiles } = setup();
    const result = await tiles.getTile("base", V1, ABSENT.z, ABSENT.x, ABSENT.y, "mvt");
    expect(result?.kind).toBe("empty");
  });

  it("rejects an extension the archive does not serve", async () => {
    const { tiles } = setup();
    const result = await tiles.getTile("base", V1, PRESENT.z, PRESENT.x, PRESENT.y, "png");
    expect(result).toMatchObject({ kind: "error", status: 404 });
    expect((result as { message: string }).message).toContain(".mvt");
  });

  it("rejects a zoom outside the archive's range", async () => {
    const { tiles } = setup();
    const result = await tiles.getTile("base", V1, 20, 1, 1, "mvt");
    expect(result).toMatchObject({ kind: "error", status: 404 });
  });

  it("returns null for an unknown archive", async () => {
    const { tiles } = setup();
    expect(await tiles.getTile("nope", V1, 0, 0, 0, "mvt")).toBeNull();
  });
});

describe("version resolution", () => {
  it("marks a mismatched version as not content-addressed", async () => {
    const { tiles } = setup();
    const result = await tiles.getTile("base", "deadbeef00", PRESENT.z, PRESENT.x, PRESENT.y, "mvt");
    expect(result).toMatchObject({ version: V1, contentAddressed: false });
  });

  it("marks an unversioned request as not content-addressed", async () => {
    const { tiles } = setup();
    const result = await tiles.getTile("base", null, PRESENT.z, PRESENT.x, PRESENT.y, "mvt");
    expect(result).toMatchObject({ version: V1, contentAddressed: false });
  });

  /**
   * The regression that matters.
   *
   * Inside the memoisation window the store still reports the old ETag, while
   * pmtiles hits its `onlyIf` guard, retries, and reads the *new* archive. If
   * the version came from the memoised ETag the request would look like a match
   * and be stamped `immutable` — pinning new bytes under the old version's URL
   * for a year.
   */
  it("does not mark a request immutable when the archive changed under a warm isolate", async () => {
    const { tiles, objects, clock } = setup(vectorBytes, 60_000);

    // Warm the ETag memo and the pmtiles directory cache.
    const before = await tiles.getTile("base", V1, PRESENT.z, PRESENT.x, PRESENT.y, "mvt");
    expect(before).toMatchObject({ contentAddressed: true, version: V1 });

    // Re-upload: same bytes, new ETag — as a differing chunk size would produce.
    objects.replace("base.pmtiles", vectorBytes, ETAG_2);
    clock.advance(30_000); // still inside the 60s memo window

    const after = await tiles.getTile("base", V1, PRESENT.z, PRESENT.x, PRESENT.y, "mvt");

    expect(objects.preconditionFailures).toBeGreaterThan(0);
    expect(after).toMatchObject({ kind: "tile", version: V2, contentAddressed: false });
  });

  it("treats an unconfirmable read as not content-addressed", async () => {
    const { tiles } = setup();

    // Warm the directories, then ask for a tile that isn't there. No R2 read
    // happens, so nothing proves which version answered.
    await tiles.getTile("base", V1, PRESENT.z, PRESENT.x, PRESENT.y, "mvt");
    const result = await tiles.getTile("base", V1, ABSENT.z, ABSENT.x, ABSENT.y, "mvt");

    expect(result).toMatchObject({ kind: "empty", contentAddressed: false });
  });
});

describe("cacheControlFor", () => {
  it("is immutable only when content-addressed", () => {
    const c = config();
    const { tiles } = setup();

    expect(tiles.cacheControlFor({ contentAddressed: true })).toBe(c.cacheControl);
    expect(tiles.cacheControlFor({ contentAddressed: true })).toContain("immutable");

    expect(tiles.cacheControlFor({ contentAddressed: false })).toBe(c.unversionedCacheControl);
    expect(tiles.cacheControlFor({ contentAddressed: false })).not.toContain("immutable");
  });
});
