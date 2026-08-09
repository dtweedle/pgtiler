/**
 * Path parsing, as a pure function.
 *
 * No I/O and no dependencies, so the whole routing table is testable with plain
 * string assertions — which matters because the versioned and unversioned tile
 * patterns are easy to get subtly wrong.
 */

export type Route =
  | { kind: "index" }
  | { kind: "tilejson"; archive: string }
  | {
      kind: "tile";
      archive: string;
      /** null for the unversioned `/{archive}/{z}/{x}/{y}.{ext}` form. */
      version: string | null;
      z: number;
      x: number;
      y: number;
      ext: string;
    }
  | { kind: "not-found" };

/** `/{archive}/{version}/{z}/{x}/{y}.{ext}` */
const VERSIONED_TILE = /^\/([^/]+)\/([A-Za-z0-9]+)\/(\d+)\/(\d+)\/(\d+)\.([a-z]+)$/;
/** `/{archive}/{z}/{x}/{y}.{ext}` */
const BARE_TILE = /^\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.([a-z]+)$/;
/** `/{archive}.json` */
const TILEJSON = /^\/([^/]+)\.json$/;

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { kind: "index" };

  // Checked first: a version code and a zoom are both digit-only, so the two
  // tile patterns are told apart by segment count, not by content.
  const versioned = pathname.match(VERSIONED_TILE);
  if (versioned) {
    return {
      kind: "tile",
      archive: versioned[1],
      version: versioned[2],
      z: Number(versioned[3]),
      x: Number(versioned[4]),
      y: Number(versioned[5]),
      ext: versioned[6],
    };
  }

  const bare = pathname.match(BARE_TILE);
  if (bare) {
    return {
      kind: "tile",
      archive: bare[1],
      version: null,
      z: Number(bare[2]),
      x: Number(bare[3]),
      y: Number(bare[4]),
      ext: bare[5],
    };
  }

  const tilejson = pathname.match(TILEJSON);
  if (tilejson) return { kind: "tilejson", archive: tilejson[1] };

  return { kind: "not-found" };
}

/** Whether z/x/y name a tile that can exist at all. */
export function isTileInBounds(z: number, x: number, y: number): boolean {
  if (z > 26) return false;
  return x < 2 ** z && y < 2 ** z;
}
