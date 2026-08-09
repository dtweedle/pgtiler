/**
 * Resolves wrangler `[vars]` (all strings, all optional) into typed config.
 *
 * Kept separate so every service takes a `Config` rather than an `Env`, which
 * means tests construct config literals instead of faking environment strings.
 */

import type { Config, Env } from "./types";

export const ARCHIVE_SUFFIX = ".pmtiles";

/** Versioned tile URLs are content-addressed, so they never need revalidating. */
export const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Unversioned (or stale-versioned) URLs are not content-addressed — keep them short. */
export const DEFAULT_UNVERSIONED_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

/**
 * TileJSON is the only document clients refetch, so it must notice a new archive
 * quickly. The tiles underneath it are the part worth caching hard.
 */
export const DEFAULT_TILEJSON_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

export const DEFAULT_ARCHIVE_TTL_SECONDS = 60;

/** Hex characters of the R2 ETag kept in the URL. 10 ≈ 40 bits, ample for cache busting. */
export const VERSION_LENGTH = 10;

export function loadConfig(env: Env): Config {
  const ttl = Number(env.ARCHIVE_TTL_SECONDS ?? DEFAULT_ARCHIVE_TTL_SECONDS);

  return {
    allowedArchives: (env.ALLOWED_ARCHIVES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    cacheControl: env.CACHE_CONTROL ?? DEFAULT_CACHE_CONTROL,
    unversionedCacheControl: env.UNVERSIONED_CACHE_CONTROL ?? DEFAULT_UNVERSIONED_CACHE_CONTROL,
    tileJsonCacheControl: DEFAULT_TILEJSON_CACHE_CONTROL,
    archiveTtlMs: (Number.isFinite(ttl) ? ttl : DEFAULT_ARCHIVE_TTL_SECONDS) * 1000,
    corsOrigin: env.CORS_ORIGIN ?? "*",
  };
}

/**
 * Whether an archive may be served.
 *
 * The character check comes first and is the security-relevant half: it keeps a
 * request from walking out of the bucket. The allowlist is configuration — an
 * empty `ALLOWED_ARCHIVES` means "anything in the bucket".
 */
export function isArchiveAllowed(config: Config, archive: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(archive) || archive.includes("..")) return false;
  if (config.allowedArchives.length === 0) return true;
  return config.allowedArchives.includes(archive);
}
