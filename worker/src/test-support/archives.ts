/**
 * Locates the real .pmtiles test archives.
 *
 * Uses process.cwd() rather than import.meta.url: with both @cloudflare/
 * workers-types and @types/node loaded, the two `URL` declarations conflict and
 * `fileURLToPath` won't typecheck. Vitest runs with cwd at the config root
 * (worker/), so a relative hop is enough.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TILES_DIR = join(process.cwd(), "..", "tiles");

export function readArchive(name: string): Uint8Array {
  const path = join(TILES_DIR, `${name}.pmtiles`);
  if (!existsSync(path)) {
    throw new Error(
      `Missing test archive ${path}.\n` +
        `Generate it with: ./scripts/generate-osm-tiles.sh --test (from the repo root)`,
    );
  }
  return new Uint8Array(readFileSync(path));
}
