/**
 * The request handler, with every dependency passed in.
 *
 * `index.ts` wires the production implementations; a test wires fakes and calls
 * `handleRequest` directly. Nothing here reaches for a global.
 */

import { isArchiveAllowed } from "./config";
import { isTileInBounds, parseRoute } from "./router";
import type { ArchiveStore } from "./services/archive-store";
import type { TileService } from "./services/tile-service";
import { ArchiveNotFound, type Config, type ResponseCache, type TileResult } from "./types";
import { baseHeaders, errorResponse, jsonResponse, preflightResponse } from "./utils/http";

export interface Deps {
  config: Config;
  store: ArchiveStore;
  tiles: TileService;
  cache: ResponseCache;
}

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const { config } = deps;

  if (request.method === "OPTIONS") return preflightResponse(config);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(config, 405, "Method not allowed");
  }

  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname);
  const route = parseRoute(path);

  if (route.kind === "not-found") return errorResponse(config, 404, "Not found");
  if (route.kind === "index") return handleIndex(deps, url.origin);

  if (!isArchiveAllowed(config, route.archive)) {
    return errorResponse(config, 404, `Unknown archive '${route.archive}'`);
  }

  try {
    if (route.kind === "tilejson") return await handleTileJson(deps, route.archive, url.origin);

    if (!isTileInBounds(route.z, route.x, route.y)) {
      return errorResponse(config, 404, "Tile out of bounds");
    }
    return await handleTile(deps, request, url, route);
  } catch (err) {
    if (err instanceof ArchiveNotFound) {
      return errorResponse(config, 404, `Unknown archive '${route.archive}'`);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${path}: ${message}`);
    return errorResponse(config, 500, message);
  }
}

async function handleIndex(deps: Deps, origin: string): Promise<Response> {
  const archives = (await deps.store.list()).filter((name) =>
    isArchiveAllowed(deps.config, name),
  );

  return jsonResponse(deps.config, {
    archives: archives.map((name) => ({
      name,
      tilejson: `${origin}/${name}.json`,
      tiles: `${origin}/${name}/{version}/{z}/{x}/{y}`,
    })),
  });
}

async function handleTileJson(deps: Deps, archive: string, origin: string): Promise<Response> {
  const result = await deps.tiles.getTileJson(archive, origin);
  if (!result) return errorResponse(deps.config, 404, `Unknown archive '${archive}'`);

  const headers = baseHeaders(deps.config);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", deps.config.tileJsonCacheControl);
  headers.set("ETag", `"${result.etag}"`);
  return new Response(JSON.stringify(result.tilejson, null, 2), { status: 200, headers });
}

async function handleTile(
  deps: Deps,
  request: Request,
  url: URL,
  route: Extract<ReturnType<typeof parseRoute>, { kind: "tile" }>,
): Promise<Response> {
  const { config, cache } = deps;
  const { archive, version, z, x, y, ext } = route;

  // The version already sits in the path, so it keys the edge cache for free.
  // Requests at a stale version share a key, which is why they expire quickly.
  const cacheKey = `${url.origin}${url.pathname}`;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Tile-Cache", "hit");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const result = await deps.tiles.getTile(archive, version, z, x, y, ext);
  if (!result) return errorResponse(config, 404, `Unknown archive '${archive}'`);
  if (result.kind === "error") return errorResponse(config, result.status, result.message);

  const tileEtag = `"${result.version}:${z}/${x}/${y}"`;
  const cacheControl = deps.tiles.cacheControlFor(result);

  if (request.headers.get("If-None-Match") === tileEtag) {
    const headers = baseHeaders(config);
    headers.set("ETag", tileEtag);
    headers.set("Cache-Control", cacheControl);
    return new Response(null, { status: 304, headers });
  }

  const response = buildTileResponse(config, result, tileEtag, cacheControl);
  cache.put(cacheKey, response.clone());

  const headers = new Headers(response.headers);
  headers.set("X-Tile-Cache", "miss");
  return new Response(response.body, { status: response.status, headers });
}

function buildTileResponse(
  config: Config,
  result: Extract<TileResult, { kind: "tile" | "empty" }>,
  tileEtag: string,
  cacheControl: string,
): Response {
  const headers = baseHeaders(config);
  headers.set("Cache-Control", cacheControl);
  headers.set("ETag", tileEtag);
  headers.set("X-Tile-Version", result.version);

  if (result.kind === "empty") return new Response(null, { status: 204, headers });

  headers.set("Content-Type", result.contentType);
  return new Response(result.body, { status: 200, headers });
}
