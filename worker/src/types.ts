/**
 * Shared types and the interfaces the services are injected with.
 *
 * The storage and cache interfaces are deliberately narrower than the Cloudflare
 * types they stand in for. `R2Bucket` and the Cache API satisfy them structurally
 * in production, while a test can supply a plain object with three methods.
 */

/** Cloudflare bindings and `[vars]` from wrangler.toml. */
export interface Env {
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

/** Env resolved to typed values with defaults applied. See config.ts. */
export interface Config {
  allowedArchives: string[];
  cacheControl: string;
  unversionedCacheControl: string;
  tileJsonCacheControl: string;
  archiveTtlMs: number;
  corsOrigin: string;
}

// ── Storage ──────────────────────────────────────────────────────────────

export interface StoredObjectMeta {
  etag: string;
}

export interface StoredObjectBody extends StoredObjectMeta {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface GetOptions {
  range: { offset: number; length: number };
  /** Fail the read unless the object still has this ETag. */
  onlyIf?: { etagMatches: string };
}

/**
 * The subset of R2Bucket the worker uses.
 *
 * A `get` that returns a value without `arrayBuffer` means the `onlyIf`
 * precondition failed — R2 signals this by returning metadata and no body.
 */
export interface ObjectStore {
  head(key: string): Promise<StoredObjectMeta | null>;
  get(key: string, options: GetOptions): Promise<StoredObjectMeta | StoredObjectBody | null>;
  list(options: { limit: number }): Promise<{ objects: { key: string }[] }>;
}

// ── Edge cache ───────────────────────────────────────────────────────────

/**
 * The subset of the Cache API the worker uses, keyed by plain string.
 *
 * `put` is fire-and-forget: in production it is handed to `ctx.waitUntil`, so
 * callers must not depend on it having completed.
 */
export interface ResponseCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): void;
}

/** Injectable clock, so ETag memoisation expiry can be tested without waiting. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

// ── Service results ──────────────────────────────────────────────────────

/**
 * What TileService returns. Deliberately not a `Response`: keeping the decisions
 * (which bytes, which version, is this content-addressed) separate from their
 * HTTP encoding is what makes the logic assertable without parsing headers.
 */
export type TileResult =
  | {
      kind: "tile";
      body: ArrayBuffer;
      contentType: string;
      /** Version that actually produced these bytes. */
      version: string;
      /** True when the request's version matches the bytes, so the URL is content-addressed. */
      contentAddressed: boolean;
    }
  | {
      kind: "empty";
      version: string;
      contentAddressed: boolean;
    }
  | {
      kind: "error";
      status: number;
      message: string;
    };

export interface TileJsonResult {
  tilejson: Record<string, unknown>;
  /** Full archive ETag, used as the document's HTTP ETag. */
  etag: string;
}

export class ArchiveNotFound extends Error {}
