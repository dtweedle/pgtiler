/**
 * Tile and TileJSON logic.
 *
 * Returns plain result objects rather than Responses. Every decision worth
 * testing — which bytes, which version, whether the URL is content-addressed,
 * whether an absent tile or a bad extension — is then assertable without
 * constructing a request or parsing a header.
 */

import { TileType } from "pmtiles";

import type { Config, TileJsonResult, TileResult } from "../types";
import { contentType, tileExt } from "../utils/tile-format";
import { versionCode } from "../utils/version";
import type { ArchiveStore, OpenArchive } from "./archive-store";

export class TileService {
  constructor(
    private store: ArchiveStore,
    private config: Config,
  ) {}

  /**
   * TileJSON for an archive.
   *
   * The tiles template carries the current version. This document is the only
   * thing clients refetch, so it is where a redeploy takes effect.
   */
  async getTileJson(archive: string, origin: string): Promise<TileJsonResult | null> {
    const open = await this.store.open(archive);
    if (!open) return null;

    const header = await this.store.freshHeader(open);
    const metadata = (await open.pmt.getMetadata()) as Record<string, unknown>;
    const ext = tileExt(header.tileType);
    const version = versionCode(open.etag);

    const tilejson: Record<string, unknown> = {
      tilejson: "3.0.0",
      scheme: "xyz",
      name: metadata.name ?? archive,
      description: metadata.description,
      attribution: metadata.attribution,
      vector_layers: metadata.vector_layers,
      tiles: [`${origin}/${archive}/${version}/{z}/{x}/{y}.${ext}`],
      minzoom: header.minZoom,
      maxzoom: header.maxZoom,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
      center: [header.centerLon, header.centerLat, header.centerZoom],
    };
    for (const key of Object.keys(tilejson)) {
      if (tilejson[key] === undefined) delete tilejson[key];
    }

    return { tilejson, etag: open.etag };
  }

  /**
   * A single tile.
   *
   * `requestedVersion` is null for the unversioned URL form. It is compared
   * against the version that actually served the bytes, never against the
   * memoised ETag — see `resolveVersion`.
   */
  async getTile(
    archive: string,
    requestedVersion: string | null,
    z: number,
    x: number,
    y: number,
    ext: string,
  ): Promise<TileResult | null> {
    const open = await this.store.open(archive);
    if (!open) return null;

    const header = await this.store.freshHeader(open);

    const expectedExt = tileExt(header.tileType);
    if (ext !== expectedExt) {
      return {
        kind: "error",
        status: 404,
        message: `Archive '${archive}' serves .${expectedExt} tiles, not .${ext}`,
      };
    }
    if (z < header.minZoom || z > header.maxZoom) {
      return {
        kind: "error",
        status: 404,
        message: `Zoom ${z} outside archive range ${header.minZoom}-${header.maxZoom}`,
      };
    }

    const tile = await open.pmt.getZxy(z, x, y);
    const { version, contentAddressed } = this.resolveVersion(open, requestedVersion);

    if (!tile) {
      // An absent tile is a normal, cacheable answer — an empty area of the archive.
      return { kind: "empty", version, contentAddressed };
    }

    // Deliberately NOT compressed here. Setting Content-Encoding on a Worker
    // response gets the header stripped at the edge while the body stays
    // encoded — clients then receive gzip bytes labelled as plain MVT and fail
    // to parse them. Compression is the edge's job; we hand it plain bytes.
    return {
      kind: "tile",
      body: tile.data,
      contentType: contentType(header.tileType),
      version,
      contentAddressed,
    };
  }

  /** Cache-Control for a result, derived from whether its URL is content-addressed. */
  cacheControlFor(result: { contentAddressed: boolean }): string {
    return result.contentAddressed ? this.config.cacheControl : this.config.unversionedCacheControl;
  }

  /**
   * Which version served these bytes, and whether the URL therefore describes them.
   *
   * Decided from the ETag of the read that actually happened, not from the
   * memoised HEAD. Within the memoisation TTL of a re-upload an isolate still
   * believes the old ETag is current, while pmtiles has transparently re-read
   * the *new* archive underneath it. Trusting the memoised value here would
   * stamp `immutable` on new bytes served under the old version's URL and pin
   * that mismatch at the edge and in browsers for a year.
   *
   * A null `lastEtag` means nothing was read from R2 at all (warm directories,
   * absent tile). Unconfirmable, so it is treated as not content-addressed.
   */
  private resolveVersion(
    open: OpenArchive,
    requestedVersion: string | null,
  ): { version: string; contentAddressed: boolean } {
    const served = open.source.lastEtag ? versionCode(open.source.lastEtag) : null;
    if (served === null) {
      return { version: versionCode(open.etag), contentAddressed: false };
    }
    return { version: served, contentAddressed: requestedVersion === served };
  }
}

/** Re-exported so callers can branch on tile type without importing pmtiles. */
export { TileType };
