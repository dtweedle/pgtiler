import { VERSION_LENGTH } from "../config";

/**
 * Short, URL-safe version code for an archive.
 *
 * R2 ETags are already content hashes — MD5 for a single-shot upload, MD5-of-
 * part-MD5s with a `-N` part-count suffix for a multipart one (which anything
 * over a few hundred MB will be). Truncating one gives a stable shortcode that
 * changes exactly when the object does, with nothing to maintain at upload time.
 *
 * Stripping non-alphanumerics handles both forms, plus the quotes some clients
 * and APIs wrap ETags in.
 *
 * Caveat: a multipart ETag depends on the chunk size as well as the bytes, so
 * re-uploading identical content with a different `--s3-chunk-size` yields a
 * new code. That costs a cache refill, nothing worse.
 */
export function versionCode(etag: string): string {
  return etag
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, VERSION_LENGTH)
    .toLowerCase();
}
