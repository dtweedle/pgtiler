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

The page fetches Martin's `/catalog` endpoint on load and dynamically builds the sidebar layer list. No hardcoded tile source URLs — any new PMTiles, MBTiles, or PostGIS table that Martin discovers will appear automatically.
