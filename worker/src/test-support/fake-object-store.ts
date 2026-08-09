/**
 * An in-memory ObjectStore for tests.
 *
 * Backed by real .pmtiles bytes read off disk, so tests exercise the actual
 * pmtiles parsing rather than a mock of it — while staying in plain Node, with
 * no workerd and no R2 emulation.
 *
 * `replace()` simulates a re-upload: same key, new bytes, new ETag. That is the
 * scenario behind the trickiest behaviour in the worker.
 */

import type { GetOptions, ObjectStore, StoredObjectBody, StoredObjectMeta } from "../types";

interface Entry {
  bytes: Uint8Array;
  etag: string;
}

export class FakeObjectStore implements ObjectStore {
  private objects = new Map<string, Entry>();

  /** Every range read performed, in order. Lets tests assert on R2 traffic. */
  readonly reads: { key: string; offset: number; length: number }[] = [];

  /** Reads that failed their `onlyIf` precondition. */
  preconditionFailures = 0;

  put(key: string, bytes: Uint8Array, etag: string): this {
    this.objects.set(key, { bytes, etag });
    return this;
  }

  /** Replace an object's contents and ETag, as a re-upload would. */
  replace(key: string, bytes: Uint8Array, etag: string): this {
    if (!this.objects.has(key)) throw new Error(`no such object: ${key}`);
    return this.put(key, bytes, etag);
  }

  delete(key: string): this {
    this.objects.delete(key);
    return this;
  }

  async head(key: string): Promise<StoredObjectMeta | null> {
    const entry = this.objects.get(key);
    return entry ? { etag: entry.etag } : null;
  }

  async get(
    key: string,
    options: GetOptions,
  ): Promise<StoredObjectMeta | StoredObjectBody | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;

    const { offset, length } = options.range;
    this.reads.push({ key, offset, length });

    // R2 signals a failed precondition by returning metadata with no body.
    if (options.onlyIf && options.onlyIf.etagMatches !== entry.etag) {
      this.preconditionFailures++;
      return { etag: entry.etag };
    }

    const slice = entry.bytes.slice(offset, offset + length);
    return {
      etag: entry.etag,
      arrayBuffer: async () =>
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer,
    };
  }

  async list(options: { limit: number }): Promise<{ objects: { key: string }[] }> {
    return {
      objects: [...this.objects.keys()].slice(0, options.limit).map((key) => ({ key })),
    };
  }
}

/** A clock the test drives by hand, for ETag memoisation expiry. */
export class FakeClock {
  constructor(private t = 0) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}
