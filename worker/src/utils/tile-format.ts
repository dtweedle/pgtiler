/**
 * Maps a PMTiles archive's declared tile type to its URL extension and MIME type.
 *
 * The archive header is the authority here, not the request: `base` and
 * `contours` hold MVT, `terrain` holds PNG, and a request whose extension
 * disagrees is rejected rather than guessed at.
 */

import { TileType } from "pmtiles";

export function tileExt(tileType: TileType): string {
  switch (tileType) {
    case TileType.Mvt:
      return "mvt";
    case TileType.Png:
      return "png";
    case TileType.Jpeg:
      return "jpg";
    case TileType.Webp:
      return "webp";
    case TileType.Avif:
      return "avif";
    default:
      return "bin";
  }
}

export function contentType(tileType: TileType): string {
  switch (tileType) {
    case TileType.Mvt:
      return "application/vnd.mapbox-vector-tile";
    case TileType.Png:
      return "image/png";
    case TileType.Jpeg:
      return "image/jpeg";
    case TileType.Webp:
      return "image/webp";
    case TileType.Avif:
      return "image/avif";
    default:
      return "application/octet-stream";
  }
}

