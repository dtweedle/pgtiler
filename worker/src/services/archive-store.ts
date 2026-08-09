/**
 * All R2 access, plus the per-isolate caches that used to be module globals.
 *
 * Holding them on an instance is the main testability change: each test builds
 * its own store, so ETag memoisation and pmtiles directory caching can't leak
 * between cases. The clock is injected for the same reason — memoisation expiry
 * is testable without sleeping.
 */

import { EtagMismatch, PMTiles, ResolvedValueCache, type RangeResponse, type Source } from "pmtiles";

import { ARCHIVE_SUFFIX } from "../config";
import { ArchiveNotFound, systemClock } from "../types";
import type { Clock, ObjectStore, StoredObjectBody } from "../types";
import { decompress } from "../utils/compression";

function hasBody(o: object): o is StoredObjectBody {
  return "arrayBuffer" in o;
}

/**
 * A pmtiles `Source` backed by one R2 object.
 *
 * One instance per request: `lastEtag` is request-scoped state, and sharing it
 * across concurrent requests would make the version decision race.
 */
export class R2Source implements Source {
  /**
   * ETag of the most recent successful read, or null if the request was served
   * entirely from the directory cache without touching R2.
   *
   * This is the only trustworthy version signal. `getEtag` is memoised, so an
   * isolate can believe a superseded ETag is current — but every range read is
   * guarded by `onlyIf`, so a read that *succeeds* proves which object the bytes
   * came from.
   */
  lastEtag: string | null = null;

  constructor(
    private store: ObjectStore,
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
    const object = await this.store.get(this.archive + ARCHIVE_SUFFIX, {
      range: { offset, length },
      onlyIf: etag ? { etagMatches: etag } : undefined,
    });

    if (!object) throw new ArchiveNotFound(this.archive);
    // Precondition failed — the archive was replaced mid-read. Let pmtiles retry;
    // it invalidates its directory cache and reads again without the guard.
    if (!hasBody(object)) throw new EtagMismatch();

    this.lastEtag = object.etag;
    return { data: await object.arrayBuffer(), etag: object.etag };
  }
}

/** An archive opened for one request. */
export interface OpenArchive {
  pmt: PMTiles;
  source: R2Source;
  /** Memoised current ETag. May lag a re-upload by up to the configured TTL. */
  etag: string;
}

export class ArchiveStore {
  /**
   * Header and directory pages, shared across requests in this isolate. Keyed
   * internally by archive name + ETag, so entries from a superseded upload are
   * never reused.
   */
  private pmtilesCache = new ResolvedValueCache(200, undefined, decompress);

  /** Archive ETags, memoised so we don't HEAD R2 on every tile request. */
  private etags = new Map<string, { etag: string; expiresAt: number }>();

  constructor(
    private store: ObjectStore,
    private ttlMs: number,
    private clock: Clock = systemClock,
  ) {}

  /** Current ETag of an archive, or null if it isn't in the bucket. */
  async getEtag(archive: string): Promise<string | null> {
    const now = this.clock.now();
    const cached = this.etags.get(archive);
    if (cached && cached.expiresAt > now) return cached.etag;

    const head = await this.store.head(archive + ARCHIVE_SUFFIX);
    if (!head) {
      this.etags.delete(archive);
      return null;
    }

    this.etags.set(archive, { etag: head.etag, expiresAt: now + this.ttlMs });
    return head.etag;
  }

  /** Opens an archive for one request, or returns null if it doesn't exist. */
  async open(archive: string): Promise<OpenArchive | null> {
    const etag = await this.getEtag(archive);
    if (!etag) return null;

    const source = new R2Source(this.store, archive);
    const pmt = new PMTiles(source, this.pmtilesCache, decompress);
    return { pmt, source, etag };
  }

  /**
   * Archive header, guaranteed to match `etag`.
   *
   * Directory entries are cached under a key that includes the ETag, but the
   * header is cached under the archive name alone — so an isolate that saw a
   * previous upload has to be told to drop it.
   */
  async freshHeader(open: OpenArchive) {
    const header = await open.pmt.getHeader();
    if (header.etag === open.etag) return header;
    await this.pmtilesCache.invalidate(open.source);
    return open.pmt.getHeader();
  }

  /** Archive names in the bucket, without the .pmtiles suffix. */
  async list(): Promise<string[]> {
    const listed = await this.store.list({ limit: 1000 });
    return listed.objects
      .filter((o) => o.key.endsWith(ARCHIVE_SUFFIX))
      .map((o) => o.key.slice(0, -ARCHIVE_SUFFIX.length))
      .sort();
  }
}
