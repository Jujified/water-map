#!/usr/bin/env python3
"""
Preprocess ETOPO 2022 (60 arc-second) into Spilhaus-projected assets for the
water-map web app.

Usage:
    python tools/preprocess.py --surface ETOPO_2022_v1_60s_N90W180_surface.nc \
                               --bed     ETOPO_2022_v1_60s_N90W180_bed.nc \
                               --out public/data

Downloads (NOAA NCEI):
  https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc
  https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_bed_elev_netcdf/ETOPO_2022_v1_60s_N90W180_bed.nc

Requires: numpy, scipy, pyproj (PROJ >= 9.6 for +proj=spilhaus), rasterio,
scikit-image, pillow.

Outputs (all in Spilhaus map space, row 0 = top / +y, column 0 = left / -x):
  terrain_{N}.png   RGB: R,G = elevation (uint16 big-endian, metres + OFFSET),
                         B = ice fraction (0..255)
  flood_{N}.png     RGB: R,G = flood level minus elevation (uint16 metres, >= 0;
                         compresses far better than the raw level), B = distance inland
                         from the present-day ocean in units of DIST_UNIT_KM
  lonlat.bin        513x513 float32 (lon, lat) pairs at grid vertices
  area.bin          512x512 float32 relative true area per map cell (max = 1)
  stats.json        cumulative "fraction above water" table + hypsometric
                    histogram (cos-latitude weighted, unprojected grid)
  meta.json         extent, encodings, sizes
"""
import argparse
import json
import os
import time

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from pyproj import __version__ as pyproj_version
from pyproj import proj_version_str
from PIL import Image
from scipy import ndimage
from skimage.morphology import reconstruction

OFFSET = 11000  # metres added before uint16 packing
DIST_UNIT_KM = 4.0
SPILHAUS = "+proj=spilhaus +R=6371008.8"
GRID = 513  # lon/lat lookup vertices per side


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def check_proj():
    major, minor = (int(v) for v in proj_version_str.split(".")[:2])
    log(f"pyproj {pyproj_version}, PROJ {proj_version_str}")
    if (major, minor) < (9, 6):
        raise SystemExit("PROJ >= 9.6 is required for +proj=spilhaus")
    CRS(SPILHAUS)  # raises if unknown


def read_grid(path):
    uri = path if path.startswith("netcdf:") else f"netcdf:{path}:z"
    with rasterio.open(uri) as src:
        z = src.read(1).astype(np.float32)
        t = src.transform
    # north-up, 21600 x 10800, cell centres at -179.99167 .. and 89.99167 ..
    assert abs(t.c + 180) < 1e-6 and abs(t.f - 90) < 1e-6, t
    nodata = ~np.isfinite(z) | (z < -20000)
    if nodata.any():
        z[nodata] = 0
    return z


def lat_centres(nrows):
    return 90 - (np.arange(nrows) + 0.5) * 180.0 / nrows


def bilinear_global(grid, lon, lat):
    """Bilinear sample a north-up global grid (cell-centred) with lon wrap."""
    nr, nc = grid.shape
    fx = (lon + 180.0) / 360.0 * nc - 0.5
    fy = (90.0 - lat) / 180.0 * nr - 0.5
    fy = np.clip(fy, 0, nr - 1.0001)
    x0 = np.floor(fx).astype(np.int64)
    y0 = np.floor(fy).astype(np.int64)
    tx = (fx - x0).astype(np.float32)
    ty = (fy - y0).astype(np.float32)
    x1 = (x0 + 1) % nc
    x0 = x0 % nc
    y1 = y0 + 1
    a = grid[y0, x0] * (1 - tx) + grid[y0, x1] * tx
    b = grid[y1, x0] * (1 - tx) + grid[y1, x1] * tx
    return a * (1 - ty) + b * ty


def nearest_global(grid, lon, lat):
    nr, nc = grid.shape
    c = np.floor((lon + 180.0) / 360.0 * nc).astype(np.int64) % nc
    r = np.clip(np.floor((90.0 - lat) / 180.0 * nr).astype(np.int64), 0, nr - 1)
    return grid[r, c]


def ocean_mask(z):
    """Cells below 0 m connected (8-conn, lon-wrapped) to the world ocean.
    The Black Sea is also seeded: the Bosporus is narrower than a 60" cell."""
    below = z < 0
    lab, n = ndimage.label(below, structure=np.ones((3, 3), bool))
    # merge labels across the dateline
    left, right = lab[:, 0], lab[:, -1]
    parent = np.arange(n + 1)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b in zip(left, right):
        if a and b:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
    roots = np.array([find(i) for i in range(n + 1)])
    lab = roots[lab]
    nr, nc = z.shape

    def label_at(lon, lat):
        r = int((90 - lat) / 180 * nr)
        c = int((lon + 180) / 360 * nc)
        return lab[r, c]

    keep = {label_at(-150, 0), label_at(-30, 0), label_at(80, -20)}  # Pacific/Atlantic/Indian
    keep.add(label_at(34.0, 43.0))  # Black Sea
    keep.discard(0)
    log("ocean labels kept:", sorted(int(k) for k in keep))
    return np.isin(lab, list(keep))


def flood_levels(z, ocean, factor=2):
    """Priority-flood (morphological reconstruction by erosion) seeded from the
    ocean: the lowest water level at which each cell connects to the sea.
    Runs on a min-pooled grid (keeps narrow straits open), lon-wrapped."""
    nr, nc = z.shape
    zr = z.reshape(nr // factor, factor, nc // factor, factor).min(axis=(1, 3))
    orr = ocean.reshape(nr // factor, factor, nc // factor, factor).any(axis=(1, 3))
    pad = 64
    zp = np.concatenate([zr[:, -pad:], zr, zr[:, :pad]], axis=1)
    op = np.concatenate([orr[:, -pad:], orr, orr[:, :pad]], axis=1)
    mask = np.maximum(zp, -11000).astype(np.float32)
    seed = np.where(op, mask, mask.max()).astype(np.float32)
    log(f"reconstruction on {mask.shape} ...")
    f = reconstruction(seed, mask, method="erosion")[:, pad:-pad]
    # back to full resolution, never below own elevation
    f = np.repeat(np.repeat(f, factor, axis=0), factor, axis=1)
    full = np.maximum(f, z)
    full[ocean] = z[ocean]
    return full.astype(np.float32)


def pack16(v):
    u = np.clip(np.round(v + OFFSET), 0, 65535).astype(np.uint16)
    return (u >> 8).astype(np.uint8), (u & 255).astype(np.uint8)


def save_rgb(path, r, g, b):
    Image.fromarray(np.dstack([r, g, b])).save(path, optimize=True)
    log("wrote", path, os.path.getsize(path) // 1024, "KiB")


class Inverse:
    """Inverse Spilhaus with a fallback. PROJ's iterative inverse returns inf
    for a thin band (~1.5%) along the square's edges; there we solve
    fwd(lon, lat) = (x, y) by Gauss-Newton seeded from the nearest valid
    neighbour on the same grid."""

    def __init__(self):
        self.fwd = Transformer.from_crs("EPSG:4326", SPILHAUS, always_xy=True)
        self.inv = Transformer.from_crs(SPILHAUS, "EPSG:4326", always_xy=True)
        self.max_residual = 0.0
        self._kd = None

    def _tree(self):
        # forward-project a dense global sample once; nearest neighbour in
        # map space gives a seed that is already on the correct side of a cut
        if self._kd is None:
            from scipy.spatial import cKDTree
            lo, la = np.meshgrid(np.arange(-180, 180, 0.08) + 0.04, np.arange(-90, 90, 0.08) + 0.04)
            x, y = self.fwd.transform(lo.ravel(), la.ravel())
            ok = np.isfinite(x) & np.isfinite(y)
            self._seed_lon, self._seed_lat = lo.ravel()[ok], la.ravel()[ok]
            self._kd = cKDTree(np.column_stack([x[ok], y[ok]]))
        return self._kd

    def __call__(self, X, Y):
        lon, lat = self.inv.transform(X, Y)
        lon, lat = np.asarray(lon, np.float64), np.asarray(lat, np.float64)
        bad = ~(np.isfinite(lon) & np.isfinite(lat))
        if not bad.any():
            return lon, lat
        if bad.all():
            raise RuntimeError("inverse failed everywhere")
        tx, ty = X[bad], Y[bad]
        _, idx = self._tree().query(np.column_stack([tx, ty]))
        lo, la = self._seed_lon[idx].copy(), self._seed_lat[idx].copy()
        h = 1e-6

        def wrap(lo_, la_):
            # reflect over the poles, wrap longitude
            la_ = np.asarray(la_, np.float64).copy()
            lo_ = np.asarray(lo_, np.float64).copy()
            over = la_ > 90
            la_[over], lo_[over] = 180 - la_[over], lo_[over] + 180
            under = la_ < -90
            la_[under], lo_[under] = -180 - la_[under], lo_[under] + 180
            return (lo_ + 180) % 360 - 180, la_

        def resid(lo_, la_):
            fx, fy = self.fwd.transform(lo_, la_)
            r = np.hypot(tx - fx, ty - fy)
            return np.where(np.isfinite(r), r, np.inf), fx, fy

        res, fx, fy = resid(lo, la)
        for _ in range(60):
            ex, ey = tx - fx, ty - fy
            ax, ay = self.fwd.transform(lo + h, la)
            bx, by = self.fwd.transform(lo, la + np.where(la > 0, -h, h))
            hb = np.where(la > 0, -h, h)
            j11, j21 = (ax - fx) / h, (ay - fy) / h
            j12, j22 = (bx - fx) / hb, (by - fy) / hb
            det = j11 * j22 - j12 * j21
            det = np.where(np.abs(det) < 1e-30, 1e-30, det)
            dlo = (j22 * ex - j12 * ey) / det
            dla = (-j21 * ex + j11 * ey) / det
            dlo, dla = np.nan_to_num(dlo), np.nan_to_num(dla)
            # cap the step, then backtrack until the residual decreases
            cap = np.minimum(1.0, 5.0 / np.clip(np.hypot(dlo, dla), 1e-15, None))
            s = cap.copy()
            done = res < 1e-3
            nlo, nla = lo.copy(), la.copy()
            for _k in range(30):
                tlo, tla = wrap(lo + dlo * s, la + dla * s)
                tr, tfx, tfy = resid(tlo, tla)
                ok = (tr < res) & ~done
                nlo[ok], nla[ok] = tlo[ok], tla[ok]
                res = np.where(ok, tr, res)
                fx, fy = np.where(ok, tfx, fx), np.where(ok, tfy, fy)
                done |= ok
                if done.all():
                    break
                s = np.where(done, s, s * 0.5)
            lo, la = nlo, nla
            if np.nanmax(res) < 1e-2:
                break
        fx, fy = self.fwd.transform(lo, la)
        res = np.hypot(tx - fx, ty - fy)
        self.max_residual = max(self.max_residual, float(np.nanpercentile(res, 99)))
        lon[bad], lat[bad] = lo, la
        return lon, lat


def unit_vectors(lon, lat):
    lo, la = np.radians(lon), np.radians(lat)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--surface", required=True)
    ap.add_argument("--bed", required=True)
    ap.add_argument("--out", default="public/data")
    ap.add_argument("--size", type=int, default=4096)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    check_proj()

    fwd = Transformer.from_crs("EPSG:4326", SPILHAUS, always_xy=True)
    inv = Inverse()
    # Square half-width: project the whole globe and take the extreme.
    glon, glat = np.meshgrid(np.linspace(-180, 180, 1441), np.linspace(-90, 90, 721))
    gx, gy = fwd.transform(glon, glat)
    HALF = float(max(np.nanmax(np.abs(gx)), np.nanmax(np.abs(gy))))
    log(f"Spilhaus square half-width {HALF:.1f} m")

    log("reading DEMs")
    z = read_grid(args.surface)
    bed = read_grid(args.bed)
    ice = np.clip(z - bed, 0, None)
    del bed
    nr, nc = z.shape
    lats = lat_centres(nr)
    w_row = np.cos(np.radians(lats))
    log(f"elevation range {z.min():.0f} .. {z.max():.0f}")

    log("ocean mask")
    ocean = ocean_mask(z)
    log("flood levels")
    flood = flood_levels(z, ocean)

    # ---------------- statistics (unprojected, cos-lat weighted) ----------
    log("statistics")
    W = np.broadcast_to(w_row[:, None], z.shape)
    total = W.sum(dtype=np.float64)
    zmin, zmax = int(np.floor(z.min())), int(np.ceil(z.max()))
    lo_level, hi_level = -11000, 9000
    levels = np.arange(lo_level, hi_level + 1)
    # fraction of surface with value > L, for L in levels: weighted histogram at 1 m
    def frac_above(v):
        idx = np.clip(np.floor(v).astype(np.int64) - lo_level, -1, len(levels))
        h = np.bincount((idx + 1).ravel(), weights=W.ravel(), minlength=len(levels) + 2)
        # h[k] = weight with floor(v) == levels[k-1]; value > L  <=> floor(v) >= L when v not int...
        # use: above(L) = weight(floor(v) >= L+0)  (v > L  ~ floor(v) >= L for non-integers)
        cum = np.cumsum(h[::-1])[::-1]  # cum[k] = weight with idx+1 >= k
        return (cum[1 : len(levels) + 1] / total)

    above_raw = frac_above(z)
    above_flood = frac_above(flood)
    above = np.where(levels < 0, above_raw, above_flood)
    i0 = -lo_level
    log(f"fraction above water at 0 m: {above[i0]*100:.2f}%  (+66 m: {above[i0+66]*100:.2f}%, -120 m: {above[i0-120]*100:.2f}%)")

    bin_lo = int(np.floor(zmin / 100.0) * 100)
    bin_hi = int(np.ceil(zmax / 100.0) * 100)
    edges = np.arange(bin_lo, bin_hi + 1, 100)
    bidx = np.clip(((z - bin_lo) // 100).astype(np.int64), 0, len(edges) - 2)
    hist = np.bincount(bidx.ravel(), weights=W.ravel(), minlength=len(edges) - 1) / total
    del bidx, W

    # ---------------- map space sampling ----------------------------------
    N = args.size
    log(f"inverse projecting {N}x{N} map pixels")
    xs = ((np.arange(N) + 0.5) / N * 2 - 1) * HALF
    terrain_e = np.empty((N, N), np.float32)
    terrain_i = np.empty((N, N), np.float32)
    flood_m = np.empty((N, N), np.float32)
    ocean_m = np.empty((N, N), bool)
    # light prefilter so 1.85 km cells aren't aliased into ~5.8 km map pixels
    zs = ndimage.gaussian_filter(z, 0.8, mode=("nearest", "wrap"))
    chunk = 256
    for r0 in range(0, N, chunk):
        ys = -xs[r0 : r0 + chunk]
        X, Y = np.meshgrid(xs, ys)
        lon, lat = inv(X, Y)
        terrain_e[r0 : r0 + chunk] = bilinear_global(zs, lon, lat)
        terrain_i[r0 : r0 + chunk] = np.clip(bilinear_global(ice, lon, lat) / 30.0, 0, 1)
        fl = nearest_global(flood, lon, lat)
        oc = nearest_global(ocean, lon, lat)
        ocean_m[r0 : r0 + chunk] = oc
        flood_m[r0 : r0 + chunk] = fl
    del zs
    e = terrain_e
    # keep flood consistent with the (smoothed) elevation actually displayed
    flood_m = np.where(ocean_m, np.minimum(e, flood_m), np.maximum(e, flood_m))

    log("area scale")
    # true area per cell from spherical quads on a fine vertex grid
    M = 2048
    vx = np.linspace(-HALF, HALF, M + 1) * (1 - 1e-12)
    VX, VY = np.meshgrid(vx, -vx)
    vlon, vlat = inv(VX, VY)
    P = unit_vectors(vlon, vlat)
    a = P[:-1, :-1]; b = P[:-1, 1:]; c = P[1:, 1:]; d = P[1:, :-1]
    area_f = 0.5 * (np.linalg.norm(np.cross(b - a, c - a), axis=-1) + np.linalg.norm(np.cross(c - a, d - a), axis=-1))
    log(f"sphere area check: {area_f.sum() / (4*np.pi):.5f} of 4*pi")
    area512 = area_f.reshape(512, M // 512, 512, M // 512).sum(axis=(1, 3))
    area512 = (area512 / area512.max()).astype(np.float32)
    area512.tofile(os.path.join(args.out, "area.bin"))

    log("edge distance")
    # km per map pixel from local area scale
    km_per_px_cell = np.sqrt(area_f.reshape(512, M // 512, 512, M // 512).sum(axis=(1, 3)) / (N / 512) ** 2) * 6371.0
    km_per_px = np.kron(km_per_px_cell, np.ones((N // 512, N // 512), np.float32))
    dist_px = ndimage.distance_transform_edt(~ocean_m)
    dist_km = dist_px * km_per_px
    dist_b = np.clip(np.round(dist_km / DIST_UNIT_KM), 0, 255).astype(np.uint8)

    log("lon/lat lookup grid")
    gxv = np.linspace(-HALF, HALF, GRID) * (1 - 1e-12)
    GX, GY = np.meshgrid(gxv, -gxv)
    llon, llat = inv(GX, GY)
    assert np.isfinite(llon).all() and np.isfinite(llat).all()
    np.stack([llon, llat], -1).astype(np.float32).tofile(os.path.join(args.out, "lonlat.bin"))

    def write_set(n, e_, f_, i_, d_):
        er, eg = pack16(e_)
        fr, fg = pack16(np.maximum(np.round(f_) - np.round(e_), 0) - OFFSET)
        save_rgb(os.path.join(args.out, f"terrain_{n}.png"), er, eg, np.round(i_ * 255).astype(np.uint8))
        save_rgb(os.path.join(args.out, f"flood_{n}.png"), fr, fg, d_)

    write_set(N, e, flood_m, terrain_i, dist_b)
    # mobile fallback
    h = N // 2
    pool = lambda v: v.reshape(h, 2, h, 2).mean(axis=(1, 3))
    e2 = pool(e)
    # a coarse cell floods once its first quarter would; never below its own mean elevation
    f2 = np.maximum(flood_m.reshape(h, 2, h, 2).min(axis=(1, 3)), e2)
    f2 = np.where(pool(ocean_m.astype(np.float32)) >= 0.5, np.minimum(f2, e2), f2)
    write_set(h, e2, f2, pool(terrain_i), np.round(pool(dist_b.astype(np.float32))).astype(np.uint8))

    stats = {
        "levelMin": lo_level,
        "levelMax": hi_level,
        "aboveStep": 1,
        "above": [round(float(v), 6) for v in above],
        "histogram": {
            "binSize": 100,
            "binStart": bin_lo,
            "fractions": [round(float(v), 7) for v in hist],
        },
        "elevationMin": float(z.min()),
        "elevationMax": float(z.max()),
    }
    with open(os.path.join(args.out, "stats.json"), "w") as fh:
        json.dump(stats, fh, separators=(",", ":"))
    meta = {
        "projection": SPILHAUS,
        "proj": proj_version_str,
        "halfWidth": HALF,
        "sizes": [N, h],
        "elevationOffset": OFFSET,
        "floodEncoding": "flood - elevation",
        "distUnitKm": DIST_UNIT_KM,
        "lonlatGrid": GRID,
        "areaGrid": 512,
        "source": "ETOPO 2022 v1 60 arc-second (surface + bed), NOAA NCEI",
    }
    with open(os.path.join(args.out, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    log(f"99th-percentile inverse fallback residual: {inv.max_residual:.3f} m")
    log("done")


if __name__ == "__main__":
    main()
