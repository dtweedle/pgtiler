/**
 * pgtiler tile worker
 *
 * Serves individual tiles out of the PMTiles archives stored in R2, instead of
 * letting MapLibre hammer the bucket with HTTP Range requests.
 *
 * Why: a public R2 bucket serving `.pmtiles` over Range requests caches badly —
 * the edge cache is keyed on the URL, not the byte range, so a re-upload (or an
 * unlucky cache fill) can hand back bytes from a different version of the
 * archive. Reading the archive server-side and emitting one immutable response
 * per tile gives every tile its own cache entry and its own ETag.
 *
 * Tile URLs carry a version shortcode derived from the archive's R2 ETag, so a
 * re-upload moves every tile onto a new URL. That is what lets tiles be cached
 * as `immutable` in the browser as well as at the edge — an ETag folded into
 * the edge cache key alone would leave already-cached browsers serving stale
 * tiles for as long as their max-age.
 *
 * Routes:
 *   GET /                                      — index of available archives
 *   GET /{archive}.json                        — TileJSON (hands out the current version)
 *   GET /{archive}/{version}/{z}/{x}/{y}.{ext} — a single tile, immutable
 *   GET /{archive}/{z}/{x}/{y}.{ext}           — unversioned tile, briefly cacheable
 */

import {
  Compression,
  EtagMismatch,
  PMTiles,
  ResolvedValueCache,
  TileType,
  type RangeResponse,
  type Source,
} from "pmtiles";

interface Env {
  BUCKET: R2Bucket;
  /** Comma-separated archive names (no .pmtiles). Empty = allow anything in the bucket. */
  ALLOWED_ARCHIVES?: string;
  /** Cache-Control for a tile requested at the archive's current version. */
  CACHE_CONTROL?: string;
  /** Cache-Control for a tile requested without a version, or at a superseded one. */
  UNVERSIONED_CACHE_CONTROL?: string;
  /** How long (seconds) an isolate may reuse a cached archive ETag before re-checking R2. */
  ARCHIVE_TTL_SECONDS?: string;
  /** Access-Control-Allow-Origin value. */
  CORS_ORIGIN?: string;
}

const ARCHIVE_SUFFIX = ".pmtiles";
/** Versioned tile URLs are content-addressed, so they never need revalidating. */
const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Unversioned (or stale-versioned) URLs are not content-addressed — keep them short. */
const DEFAULT_UNVERSIONED_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const DEFAULT_ARCHIVE_TTL_SECONDS = 60;
/** Hex characters of the R2 ETag kept in the URL. 10 ≈ 40 bits, ample for cache busting. */
const VERSION_LENGTH = 10;

// Directory/header cache, per isolate. Keyed by archive name + ETag internally,
// so entries from a superseded upload are never reused.
const pmtilesCache = new ResolvedValueCache(200, undefined, nativeDecompress);

/** Archive ETags, memoised per isolate so we don't HEAD R2 on every tile request. */
const archiveEtags = new Map<string, { etag: string; expiresAt: number }>();

async function nativeDecompress(buf: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) return buf;
  if (compression === Compression.Gzip) {
    const stream = new Response(buf).body;
    if (!stream) throw new Error("Failed to read response stream");
    return new Response(stream.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  throw new Error(`Unsupported compression: ${compression}`);
}

async function gzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Response(buf).body;
  if (!stream) throw new Error("Failed to read response stream");
  return new Response(stream.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

/** Reads a byte range out of an R2 object, honouring the archive ETag. */
class R2Source implements Source {
  /**
   * ETag of the most recent successful read, or null if this request was served
   * entirely from the isolate's directory cache without touching R2.
   *
   * This is the only trustworthy version signal. `archiveEtag()` is memoised for
   * up to ARCHIVE_TTL_SECONDS, so an isolate can believe a superseded ETag is
   * current — but every range read is guarded by `onlyIf`, so a read that
   * succeeds proves which object the bytes came from.
   */
  lastEtag: string | null = null;

  constructor(
    private bucket: R2Bucket,
    private archive: string,
  ) {}

  getKey(): string {
    return this.archive;
  }

  async getBytes(
    offset: number,
    length: number,
    _signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    const object = await this.bucket.get(this.archive + ARCHIVE_SUFFIX, {
      range: { offset, length },
      onlyIf: etag ? { etagMatches: etag } : undefined,
    });

    if (!object) throw new ArchiveNotFound(this.archive);
    // Precondition failed — the archive was replaced mid-read. Let pmtiles retry;
    // it invalidates its directory cache and reads again without the guard.
    if (!("body" in object)) throw new EtagMismatch();

    this.lastEtag = object.etag;
    return { data: await object.arrayBuffer(), etag: object.etag };
  }
}

class ArchiveNotFound extends Error {}

function tileExt(tileType: TileType): string {
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

function contentType(tileType: TileType): string {
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

/**
 * Short, URL-safe version code for an archive.
 *
 * R2 ETags are already content hashes — MD5 for a single-shot upload, MD5-of-
 * part-MD5s with a `-N` part-count suffix for a multipart one (which anything
 * over a few hundred MB will be). Truncating one gives a stable shortcode that
 * changes exactly when the object does, with nothing to maintain at upload time.
 *
 * Caveat: a multipart ETag depends on the chunk size as well as the bytes, so
 * re-uploading identical content with a different `--s3-chunk-size` yields a
 * new code. That costs a cache refill, nothing worse.
 */
function versionCode(etag: string): string {
  return etag.replace(/[^A-Za-z0-9]/g, "").slice(0, VERSION_LENGTH).toLowerCase();
}

/**
 * Current ETag of an archive, memoised briefly.
 *
 * This is what makes re-uploads safe: the ETag goes into the edge cache key, so
 * a new upload lands on a fresh set of cache entries rather than colliding with
 * the old ones.
 */
async function archiveEtag(env: Env, archive: string): Promise<string | null> {
  const now = Date.now();
  const cached = archiveEtags.get(archive);
  if (cached && cached.expiresAt > now) return cached.etag;

  const head = await env.BUCKET.head(archive + ARCHIVE_SUFFIX);
  if (!head) {
    archiveEtags.delete(archive);
    return null;
  }

  const ttl = Number(env.ARCHIVE_TTL_SECONDS ?? DEFAULT_ARCHIVE_TTL_SECONDS);
  archiveEtags.set(archive, {
    etag: head.etag,
    expiresAt: now + (Number.isFinite(ttl) ? ttl : DEFAULT_ARCHIVE_TTL_SECONDS) * 1000,
  });
  return head.etag;
}

/**
 * Archive header, guaranteed to match `etag`.
 *
 * Directory entries are cached under a key that includes the ETag, but the
 * header itself is cached under the archive name alone — so an isolate that
 * saw a previous upload has to be told to drop it.
 */
async function freshHeader(pmt: PMTiles, source: Source, etag: string) {
  const header = await pmt.getHeader();
  if (header.etag === etag) return header;
  await pmtilesCache.invalidate(source);
  return pmt.getHeader();
}

function isAllowed(env: Env, archive: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(archive) || archive.includes("..")) return false;
  const allowed = (env.ALLOWED_ARCHIVES ?? "").trim();
  if (!allowed) return true;
  return allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(archive);
}

function baseHeaders(env: Env): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": env.CORS_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "If-None-Match, Range",
    "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Encoding",
  });
}

function jsonResponse(env: Env, body: unknown, status = 200, cacheControl?: string): Response {
  const headers = baseHeaders(env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", cacheControl ?? "public, max-age=300");
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function errorResponse(env: Env, status: number, message: string): Response {
  const headers = baseHeaders(env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

async function handleTileJson(
  env: Env,
  url: URL,
  archive: string,
  pmt: PMTiles,
  source: Source,
  etag: string,
): Promise<Response> {
  const header = await freshHeader(pmt, source, etag);
  const metadata = (await pmt.getMetadata()) as Record<string, unknown>;
  const ext = tileExt(header.tileType);
  const version = versionCode(etag);

  const tilejson: Record<string, unknown> = {
    tilejson: "3.0.0",
    scheme: "xyz",
    name: metadata.name ?? archive,
    description: metadata.description,
    attribution: metadata.attribution,
    vector_layers: metadata.vector_layers,
    // The version segment is the whole point of this indirection: this document
    // is the only thing clients refetch, so it is where a redeploy takes effect.
    tiles: [`${url.origin}/${archive}/${version}/{z}/{x}/{y}.${ext}`],
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    center: [header.centerLon, header.centerLat, header.centerZoom],
  };
  for (const key of Object.keys(tilejson)) {
    if (tilejson[key] === undefined) delete tilejson[key];
  }

  const headers = baseHeaders(env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  // Short TTL: the style resolves this once per map load, and it must notice a
  // new archive quickly. Tiles underneath it are the part worth caching hard.
  headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  headers.set("ETag", `"${etag}"`);
  return new Response(JSON.stringify(tilejson, null, 2), { status: 200, headers });
}

async function handleTile(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  url: URL,
  archive: string,
  z: number,
  x: number,
  y: number,
  ext: string,
  requestedVersion: string | null,
  pmt: PMTiles,
  source: R2Source,
  etag: string,
): Promise<Response> {
  const cache = caches.default;
  const shortCacheControl = env.UNVERSIONED_CACHE_CONTROL ?? DEFAULT_UNVERSIONED_CACHE_CONTROL;

  // The version already sits in the path, so it keys the edge cache for free.
  // Requests at a stale version share a key, which is why they expire quickly.
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });

  const tileEtag = `"${etag}:${z}/${x}/${y}"`;
  if (request.headers.get("If-None-Match") === tileEtag) {
    const headers = baseHeaders(env);
    headers.set("ETag", tileEtag);
    // Only a short-TTL URL can reach here: an `immutable` response is never
    // revalidated during its freshness window, so it never sends If-None-Match.
    headers.set("Cache-Control", shortCacheControl);
    return new Response(null, { status: 304, headers });
  }

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Tile-Cache", "hit");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const header = await freshHeader(pmt, source, etag);
  const expectedExt = tileExt(header.tileType);
  if (ext !== expectedExt) {
    return errorResponse(env, 404, `Archive '${archive}' serves .${expectedExt} tiles, not .${ext}`);
  }
  if (z < header.minZoom || z > header.maxZoom) {
    return errorResponse(env, 404, `Zoom ${z} outside archive range ${header.minZoom}-${header.maxZoom}`);
  }

  const tile = await pmt.getZxy(z, x, y);

  // Decide the lifetime from the ETag that actually produced these bytes, not
  // from the memoised HEAD. Within ARCHIVE_TTL_SECONDS of a re-upload an isolate
  // still believes the old ETag is current; pmtiles will have transparently
  // re-read the *new* archive underneath it, so trusting the memoised value here
  // would stamp `immutable` on new bytes served under the old version's URL and
  // pin that mismatch at the edge and in browsers for a year.
  //
  // A null lastEtag means nothing was read from R2 (warm directories, absent
  // tile). Unconfirmable, so it gets the short TTL.
  const servedVersion = source.lastEtag ? versionCode(source.lastEtag) : null;
  const cacheControl =
    servedVersion !== null && requestedVersion === servedVersion
      ? (env.CACHE_CONTROL ?? DEFAULT_CACHE_CONTROL)
      : shortCacheControl;

  const headers = baseHeaders(env);
  headers.set("Cache-Control", cacheControl);
  headers.set("ETag", tileEtag);
  headers.set("X-Tile-Version", servedVersion ?? versionCode(etag));

  let response: Response;
  if (!tile) {
    // Absent tile is a normal, cacheable answer — an empty area of the archive.
    response = new Response(null, { status: 204, headers });
  } else {
    headers.set("Content-Type", contentType(header.tileType));
    let body: ArrayBuffer = tile.data;
    // pmtiles hands back decompressed bytes; vector tiles are worth re-gzipping
    // on the way out, image tiles are already compressed.
    if (header.tileType === TileType.Mvt) {
      body = await gzip(body);
      headers.set("Content-Encoding", "gzip");
    }
    response = new Response(body, { status: 200, headers });
  }

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  const out = new Headers(response.headers);
  out.set("X-Tile-Cache", "miss");
  return new Response(response.body, { status: response.status, headers: out });
}

async function handleIndex(env: Env, url: URL): Promise<Response> {
  const listed = await env.BUCKET.list({ limit: 1000 });
  const archives = listed.objects
    .filter((o) => o.key.endsWith(ARCHIVE_SUFFIX))
    .map((o) => o.key.slice(0, -ARCHIVE_SUFFIX.length))
    .filter((name) => isAllowed(env, name))
    .sort();

  return jsonResponse(env, {
    archives: archives.map((name) => ({
      name,
      tilejson: `${url.origin}/${name}.json`,
      tiles: `${url.origin}/${name}/{version}/{z}/{x}/{y}`,
    })),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      const headers = baseHeaders(env);
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(env, 405, "Method not allowed");
    }

    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    if (path === "/" || path === "") return handleIndex(env, url);

    // Versioned and unversioned tile paths differ in segment count, so the two
    // patterns can't both match — a version code and a zoom are both digits.
    const versionedMatch = path.match(
      /^\/([^/]+)\/([A-Za-z0-9]+)\/(\d+)\/(\d+)\/(\d+)\.([a-z]+)$/,
    );
    const bareMatch = versionedMatch
      ? null
      : path.match(/^\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.([a-z]+)$/);
    const jsonMatch = path.match(/^\/([^/]+)\.json$/);

    const tileMatch = versionedMatch ?? bareMatch;
    const requestedVersion = versionedMatch ? versionedMatch[2] : null;
    // Drop the version group so the trailing z/x/y/ext indices line up either way.
    const coords = versionedMatch ? versionedMatch.slice(3) : bareMatch?.slice(2);

    const archive = tileMatch?.[1] ?? jsonMatch?.[1];
    if (!archive) return errorResponse(env, 404, "Not found");
    if (!isAllowed(env, archive)) return errorResponse(env, 404, `Unknown archive '${archive}'`);

    try {
      const etag = await archiveEtag(env, archive);
      if (!etag) return errorResponse(env, 404, `Unknown archive '${archive}'`);

      const source = new R2Source(env.BUCKET, archive);
      const pmt = new PMTiles(source, pmtilesCache, nativeDecompress);

      if (jsonMatch) return await handleTileJson(env, url, archive, pmt, source, etag);

      const z = Number(coords![0]);
      const x = Number(coords![1]);
      const y = Number(coords![2]);
      const ext = coords![3];
      if (z > 26 || x >= 2 ** z || y >= 2 ** z) return errorResponse(env, 404, "Tile out of bounds");

      return await handleTile(
        env, ctx, request, url, archive, z, x, y, ext, requestedVersion, pmt, source, etag,
      );
    } catch (err) {
      if (err instanceof ArchiveNotFound) {
        return errorResponse(env, 404, `Unknown archive '${archive}'`);
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${path}: ${message}`);
      return errorResponse(env, 500, message);
    }
  },
} satisfies ExportedHandler<Env>;
