---
tags:
  - architecture
  - glossary
aliases:
  - Terminology
  - Terms
related:
  - "[[CACHING]]"
  - "[[SERVING]]"
  - "[[GENERATION]]"
updated: 2026-10-22
---

# Glossary

Terms the architecture notes lean on, defined once. Link to a term with
`[[GLOSSARY#Term]]`; hovering the link previews the definition in place.

---

## HTTP and caching

### ETag

An **ETag** ("entity tag") is a short string a server attaches to a response to
identify *this exact version of this exact resource*. It's opaque — the client
never interprets it, only compares it for equality.

```http
ETag: "d41d8cd98f00b204e9800998ecf8427e"
```

Its normal job is to save bandwidth. A browser that already has a copy can ask
"has this changed since the version tagged X?" and get back a tiny `304 Not
Modified` instead of the whole body.

What matters for us is a property of how **R2 computes** them: R2 derives the
ETag from the object's *contents*. For an object uploaded in one shot it's the
MD5 hash of the bytes. For a multipart upload — which anything over a few
hundred megabytes will be — it's the MD5 of the concatenated part MD5s, followed
by a dash and the part count:

```
a3f1c9e40b7d2856f0918ab3cd4e7f21-72
```

So the ETag is *already a content hash*. We don't have to compute or track a
version ourselves: re-upload an archive, and its ETag changes. That single fact
is what the whole versioning scheme rests on — see [[CACHING#Versioning and redeploys]].

Note the two forms in the Workers API: `R2Object.etag` is the bare value,
`R2Object.httpEtag` is the same thing wrapped in quotes for use in a header.

### Fresh, stale, and revalidation

A cached response is **fresh** for a period set by the server. While fresh, a
cache serves it with no network contact at all.

When that period expires the response becomes **stale**. Stale does *not* mean
deleted — the bytes are still there. It means the cache won't serve them without
checking first. That check is a **conditional request**: the cache re-requests
the resource with an `If-None-Match: "<etag>"` header, meaning "only send a body
if it differs from this version." The server replies either `200` with fresh
content, or `304 Not Modified` with no body at all, which tells the cache to keep
what it has and reset the freshness clock.

**Revalidation** is that round trip. It's cheap, but it's still a round trip.

### Cache-Control

The header that sets all of the above. The pieces we use:

| Directive | Meaning |
|---|---|
| `public` | Any cache may store this, including shared ones like a CDN. |
| `max-age=N` | Fresh for N seconds. |
| `immutable` | Never revalidate while fresh — *even if the user hits reload*. |
| `stale-while-revalidate=N` | Once stale, serve the old copy immediately for N more seconds while fetching a replacement in the background. |
| `s-maxage=N` | Overrides `max-age`, but only for shared caches. Not currently used here. |

`max-age` is always a **ceiling, not a guarantee**. Caches are finite and evict
under pressure, so a response can vanish long before it expires. You can rely on
"at most this long," never "at least this long."

`immutable` is the interesting one. Normally a browser refresh forces
revalidation of everything on the page regardless of `max-age`. `immutable`
suppresses that. It's only honest when the URL genuinely cannot change meaning —
which is what the version segment buys us.

### Age

When a shared cache serves something it has been holding, it adds an `Age`
header saying how many seconds it has had it. Downstream caches subtract that
from `max-age`. A tile with `max-age=31536000` that sat at the edge for a month
arrives at the browser with about eleven months of freshness left, not twelve.
The budget is shared across the whole chain, not restarted at each hop.

### Cache key

What a cache uses to decide whether two requests are "the same request." By
default it's essentially the URL. **This is the crux of the [[CACHING#Why the old design failed|original bug]]:** the
cache key does *not* include the `Range` header, so two requests for different
byte ranges of the same file look identical to the cache.

### Content-addressed URL

A URL whose path contains a hash of the content it returns. Because the content
can't change without the URL changing, such a URL can be cached forever. Updating
means publishing at a *new* URL rather than invalidating the old one — the
difference between "everyone must forget what they know" and "everyone naturally
starts asking for something else."

### Range request

An HTTP request for part of a file:

```http
Range: bytes=0-16383
```

The server answers `206 Partial Content` with just those bytes. This is how the
PMTiles format is designed to be read over a network — seek to the header, seek
to a directory, seek to the tile — without downloading the archive.

## Cloudflare

### PoP (colo)

Cloudflare's edge locations. A **PoP** (point of presence), also called a
**colo** (colocation facility), is one physical data centre. There are hundreds
worldwide, and each maintains its own cache storage.

### Isolate

The lightweight sandbox a Worker runs in — a V8 isolate, much cheaper than a
container. Cloudflare spins up many of them, per PoP, and discards them freely.
Any state a Worker holds in a module-level variable lives only in *one* isolate,
is not shared with others, and disappears when that isolate is recycled. This
matters for [[CACHING#The stale-isolate hazard|the stale-isolate hazard]].

---

## Tiles and data

### PMTiles

A single-file tile archive — header, root directory, metadata, leaf directories,
tile data — laid out so any tile can be found with a few byte-range reads and no
index server. Tiles are ordered along a Hilbert curve, so neighbours on the map
are neighbours in the file. Every archive this project serves is one. Walkthrough
in [[SERVING#How PMTiles resolves a tile]].

### MBTiles

A SQLite database of tiles, keyed by zoom, column and row (TMS row order, so `y`
is flipped relative to XYZ). Tippecanoe and rio-rgbify write it; `pmtiles convert`
repackages it as PMTiles. Here it is only ever an intermediate in `datasets/tmp/`.

### TileJSON

A small JSON document describing a tile source: the tile URL template, zoom
range, bounds, attribution, and for vector sources the `vector_layers`. MapLibre
fetches it once, at style load. In this project it is the indirection that hands
out the current [[#Version code|version code]] — see
[[CACHING#Versioning and redeploys]].

### Version code

The first 10 hex characters of an archive's R2 [[#ETag]], placed in tile URLs
(`/{archive}/{version}/{z}/{x}/{y}.{ext}`). It changes on every re-upload. Not to
be confused with the hand-managed `v1` schema version in the archive filename —
see [[SERVING#The archives]].

### VRT

A GDAL Virtual Raster: an XML index that makes many GeoTIFFs behave as one
seamless raster without copying any pixels. The paths inside are container paths
(`/data/datasets/...`). See [[GENERATION#The VRT layer]].

### Terrarium encoding

Elevation packed into the RGB channels of a PNG:
`elevation = (R × 256 + G + B ÷ 256) − 32768`. It is a base-256 number, so
elevation must be resampled *before* encoding, never the encoded pixels — see
[[GENERATION#Why rio-rgbify, despite being the slowest correct option]].

### raster-dem

The MapLibre source type that decodes terrarium (or Mapbox Terrain-RGB) PNGs back
into heights, feeding hillshade layers and 3D terrain. See
[[SERVING#How a style consumes it]].

### Overzoom

Rendering a source beyond its maxzoom by scaling its deepest tiles. Vector tiles
overzoom cleanly; raster tiles go soft. See
[[SERVING#Why base and contours are vector, terrain is raster]].

### Copernicus GLO-30

The global 30 m digital elevation model from the EU's Copernicus programme,
published as 1°×1° GeoTIFFs on a public S3 bucket. The source for both contours
and terrain; attribution is required. See [[GENERATION#Source data]].
