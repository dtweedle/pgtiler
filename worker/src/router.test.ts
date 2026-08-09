import { describe, expect, it } from "vitest";

import { isTileInBounds, parseRoute } from "./router";

describe("parseRoute", () => {
  it("routes the index", () => {
    expect(parseRoute("/")).toEqual({ kind: "index" });
    expect(parseRoute("")).toEqual({ kind: "index" });
  });

  it("routes TileJSON", () => {
    expect(parseRoute("/squiggly.v1.base.json")).toEqual({
      kind: "tilejson",
      archive: "squiggly.v1.base",
    });
  });

  it("routes a versioned tile", () => {
    expect(parseRoute("/squiggly.v1.base/f1c266e469/8/234/151.mvt")).toEqual({
      kind: "tile",
      archive: "squiggly.v1.base",
      version: "f1c266e469",
      z: 8,
      x: 234,
      y: 151,
      ext: "mvt",
    });
  });

  it("routes an unversioned tile", () => {
    expect(parseRoute("/squiggly.v1.base/8/234/151.mvt")).toEqual({
      kind: "tile",
      archive: "squiggly.v1.base",
      version: null,
      z: 8,
      x: 234,
      y: 151,
      ext: "mvt",
    });
  });

  // A version code and a zoom are both digit-only, so the forms are told apart
  // by segment count. An all-numeric version must not be read as a zoom.
  it("distinguishes an all-numeric version from a zoom", () => {
    const route = parseRoute("/base/1234567890/8/234/151.mvt");
    expect(route).toMatchObject({ kind: "tile", version: "1234567890", z: 8 });
  });

  it("rejects paths that are not routes", () => {
    for (const path of [
      "/squiggly.v1.base/8/234.mvt",
      "/squiggly.v1.base/8/234/151",
      "/squiggly.v1.base/8/234/151.MVT",
      "/a/b/c/d/e/f/8/1/1.mvt",
      "/favicon.ico",
    ]) {
      expect(parseRoute(path).kind, path).toBe("not-found");
    }
  });
});

describe("isTileInBounds", () => {
  it("accepts valid coordinates", () => {
    expect(isTileInBounds(0, 0, 0)).toBe(true);
    expect(isTileInBounds(8, 255, 255)).toBe(true);
  });

  it("rejects coordinates outside the zoom's grid", () => {
    expect(isTileInBounds(0, 1, 0)).toBe(false);
    expect(isTileInBounds(8, 256, 0)).toBe(false);
    expect(isTileInBounds(8, 0, 256)).toBe(false);
  });

  it("rejects absurd zooms", () => {
    expect(isTileInBounds(27, 0, 0)).toBe(false);
  });
});
