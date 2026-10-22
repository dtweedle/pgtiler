# preview/

The MapLibre GL JS preview page for visually inspecting tile sources served by Martin.

## Files

- `index.html` — main preview page with sidebar controls for toggling basemaps, styled maps, and raw tile layers
- `outdoor-style.json` — standalone Squiggly Outdoor map style (OpenMapTiles schema), editable in [Maputnik](https://maputnik.github.io/)

## Running

```bash
./scripts/preview.sh        # starts on http://localhost:8080
```

Or manually:

```bash
python3 -m http.server 8080 --directory preview
```

A local HTTP server is needed to avoid CORS issues when fetching from Martin on `localhost:3000`.

## How it works

The sidebar has fixed radio-button groups. A new archive needs an option added to `index.html` before it shows up:

- **Maps** — basemap: None, Street (OpenFreeMap), Satellite (ESRI), Topo (OpenTopoMap), `squiggly.v1.base`, `squiggly.v1.base-test`
- **Contours** — none, local full, local test
- **Hillshade** — none, local full, local test, ESRI
- **Terrain** — 3D extrusion: none, local full, local test
- **Styles** — the production styles in `styles/` (`squiggly-outdoor`, `hams-outdoor`)

Local options read Martin on `localhost:3000`. The *Tile catalog* link opens Martin's `/catalog`, which lists everything Martin has discovered, including archives the sidebar doesn't offer.

If `R2_PUBLIC_URL` is set, remote options also appear in each group, loaded from the tile worker as TileJSON plus XYZ tiles. `preview.sh` writes `config.js` from `.env` on startup, and an exported value takes precedence, so you can target dev without editing `.env`:

```bash
R2_PUBLIC_URL=https://dev.tweed.nz ./scripts/preview.sh
```

## Styling

The Squiggly Outdoor style is embedded in `index.html`, inspired by MapTiler Outdoor and written for the OpenMapTiles schema. `outdoor-style.json` is a standalone copy for editing in [Maputnik](https://maputnik.github.io/). Font glyphs come from `fonts.openmaptiles.org` (Open Sans Regular, Bold and Italic). The production styles live in `styles/` and are uploaded with `scripts/upload-style.sh`.
