/**
 * Gzip helpers built on the platform's streaming compression.
 *
 * Both Workers and Node 18+ provide CompressionStream/DecompressionStream, so
 * these run unchanged under vitest without a workerd runtime.
 */

import { Compression } from "pmtiles";

/** Decompressor handed to pmtiles for its internal directory pages. */
export async function decompress(
  buf: ArrayBuffer,
  compression: Compression,
): Promise<ArrayBuffer> {
  if (compression === Compression.None || compression === Compression.Unknown) return buf;
  if (compression === Compression.Gzip) {
    return pipe(buf, new DecompressionStream("gzip"));
  }
  throw new Error(`Unsupported compression: ${compression}`);
}

export async function gzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return pipe(buf, new CompressionStream("gzip"));
}

async function pipe(
  buf: ArrayBuffer,
  transform: ReadableWritablePair<Uint8Array, Uint8Array>,
): Promise<ArrayBuffer> {
  const stream = new Response(buf).body;
  if (!stream) throw new Error("Failed to read response stream");
  return new Response(stream.pipeThrough(transform)).arrayBuffer();
}
