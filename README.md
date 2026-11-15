# water-map

Real global topography and bathymetry (ETOPO 2022) in the **Spilhaus projection**, with an adjustable
sea level and two render modes:

- **Realistic**: hypsometric tint relative to the water level, hillshade, ice, a 15° graticule, and land
  that dissolves into paper with distance inland.
- **Abstract**: about 1,000,000 equal-area dots on ultramarine. Each dot's size is set by how much of
  Earth's surface lies at its elevation, and its colour by its height above or below the water.

Vite + TypeScript + three.js (WebGL2). Fully static, no backend.

## Run

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/
npm run verify       # Playwright screenshots + checks (after build), output in tests/out/
```

URL parameters: `mode=realistic|abstract`, `level=<m>`, `intro=0`, `size=2048|4096`, `dots=<n>`, `full=1`.

## Data pipeline

`tools/preprocess.py` turns ETOPO 2022 into the assets in `public/data/`. The raw downloads are not
committed.

```sh
python -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
curl -LO https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc
curl -LO https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_bed_elev_netcdf/ETOPO_2022_v1_60s_N90W180_bed.nc
.venv/bin/python tools/preprocess.py --surface ETOPO_2022_v1_60s_N90W180_surface.nc \
                                     --bed ETOPO_2022_v1_60s_N90W180_bed.nc --out public/data
```

The script uses PROJ's `+proj=spilhaus`, which needs PROJ 9.6 or later; the pyproj wheels bundle 9.8. Its default
orientation already matches the classic map, so no rotation or flip is applied. PROJ's iterative inverse does not
converge in a thin band along the edges of the square. There the script solves the forward projection with
Gauss-Newton and a line search instead.

| Asset | Contents |
| --- | --- |
| `terrain_{4096,2048}.png` | R,G = elevation (uint16, m + 11000); B = ice fraction (surface − bedrock) |
| `flood_{4096,2048}.png` | R,G = flood level: the lowest sea level at which a cell joins the ocean (priority flood seeded at the ocean); B = km inland from today's ocean ÷ 2 |
| `lonlat.bin` | 513×513 float32 (lon, lat) from the inverse projection |
| `area.bin` | 512×512 float32 true Earth area per map cell (max = 1) |
| `stats.json` | cos-latitude-weighted cumulative "fraction above water" for every metre from −11000 to +9000, and the 100 m hypsometric histogram |

The flood fill runs on the unprojected grid, wrapped across the dateline. It uses morphological reconstruction
on a 2′ min-pooled copy of the grid, so narrow straits stay open. The Black Sea is seeded as ocean.

## Model

This is a bathtub model. For rises, a cell is water when its flood level ≤ the chosen level. For drops below 0 m,
raw elevation is compared instead. There is no isostatic rebound and no change to the ice sheets.

## Hosting

`.github/workflows/pages.yml` builds and deploys `dist/` to GitHub Pages on every push to `main`. It can also be
started by hand from the Actions tab. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. The site is then served at `https://<owner>.github.io/water-map/`. Phones load the 2048 textures and
300k dots automatically.
