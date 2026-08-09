/**
 * Response construction. The only layer that knows about HTTP headers —
 * services return plain results and this turns them into responses.
 */

import type { Config } from "../types";

export function baseHeaders(config: Config): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "If-None-Match, Range",
    "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Encoding",
  });
}

export function jsonResponse(
  config: Config,
  body: unknown,
  status = 200,
  cacheControl = "public, max-age=300",
): Response {
  const headers = baseHeaders(config);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", cacheControl);
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

export function errorResponse(config: Config, status: number, message: string): Response {
  const headers = baseHeaders(config);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

export function preflightResponse(config: Config): Response {
  const headers = baseHeaders(config);
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}
