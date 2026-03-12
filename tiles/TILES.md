# tiles/

This directory holds the generated vector tile archives (`.mbtiles`, `.pmtiles`) that Martin serves. Files here are the output of the tile generation pipeline — they are not committed to git.

**Do not commit tile files.** They are large (often 1-10 GB) and can be regenerated from source data. Use the scripts to rebuild them:

```bash
./scripts/init.sh            # download datasets
./scripts/generate-tiles.sh  # generate tiles into this directory
```

Martin auto-discovers any `.mbtiles` or `.pmtiles` file placed here. The filename (without extension) becomes the tile source ID in Martin's catalog.
