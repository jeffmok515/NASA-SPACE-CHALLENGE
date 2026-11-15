"""Generate static South Pole map layers from NASA GeoTIFFs.

Uses a valid illumination GeoTIFF from data/raw/ when available, otherwise
falls back to the repository's NASA AVGVISIB product in sunlight_module/raw_data.
An unreadable or missing elevation GeoTIFF triggers a synthetic Shackleton-style
terrain surface; it is marked in the run summary and is not NASA elevation data.
"""
from __future__ import annotations

import json
import math
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from pyproj import CRS, Transformer
from rasterio.enums import Resampling
from rasterio.transform import xy
from rasterio.warp import reproject
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "data" / "processed"
MOON_RADIUS_M = 1_737_400.0
SOLAR_CONSTANT_W_M2 = 1361.0
PANEL_EFFICIENCY = 0.20
OUTPUT_SIZE = 150
# A stereographic radius of about 304 km corresponds to 80°S on the Moon.
# Using it as the half-width of the square includes that latitude at every
# longitude; the output mask clips the square corners back to the 80°S circle.
REGION_HALF_WIDTH_M = 304_000.0

ILLUMINATION_CANDIDATES = (
    RAW_DIR / "sunlight.tif",
    RAW_DIR / "sunlight.tiff",
    RAW_DIR / "AVGVISIB_65S_240M_201608.tiff",
    ROOT / "sunlight_module" / "raw_data" / "AVGVISIB_65S_240M_201608.tiff",
)
ELEVATION_CANDIDATES = (
    RAW_DIR / "elevation.tif",
    RAW_DIR / "elevation.tiff",
    RAW_DIR / "LDEC_60S_240MPP_ADJ.tiff",
    RAW_DIR / "Site04_final_adj_5mpp_surf.tif",
    RAW_DIR / "ldem.tif",
)


def first_readable_raster(candidates: tuple[Path, ...], label: str) -> Path:
    """Choose the first candidate raster that rasterio can actually open."""
    failures: list[str] = []
    for path in candidates:
        if not path.is_file():
            continue
        try:
            with rasterio.open(path) as src:
                if src.count < 1 or src.crs is None:
                    raise ValueError("missing raster band or CRS")
                if src.width < 2 or src.height < 2:
                    raise ValueError("raster is too small")
            return path
        except Exception as exc:
            failures.append(f"{path}: {exc}")
    if failures:
        warnings.warn(f"No readable {label} GeoTIFF found. " + " | ".join(failures))
    raise FileNotFoundError(f"No readable {label} GeoTIFF found in the configured locations")


def scaled_window(src: rasterio.io.DatasetReader, window: Window,
                  out_shape: tuple[int, int]) -> np.ndarray:
    """Read a downsampled band, apply scale/offset, and mask nodata as NaN."""
    masked = src.read(1, window=window, out_shape=out_shape,
                      resampling=Resampling.average, masked=True).astype(np.float64)
    raw = np.asarray(masked.data, dtype=np.float64)
    invalid = np.ma.getmaskarray(masked) | ~np.isfinite(raw) | (raw == -32768.0)
    if src.nodata is not None:
        invalid |= np.isclose(raw, src.nodata, rtol=0.0, atol=1e-8)
    scale = float(src.scales[0]) if src.scales else 1.0
    offset = float(src.offsets[0]) if src.offsets else 0.0
    values = raw * scale + offset
    values[invalid] = np.nan
    return values


def polar_region_window(src: rasterio.io.DatasetReader) -> Window:
    """Return a South Pole-centered square window in the raster's projected CRS."""
    if not src.crs.is_projected:
        raise ValueError(f"Expected projected lunar polar raster, got {src.crs}")
    transform = src.transform
    # Window bounds are expressed in projected metres. Standard LOLA polar grids
    # place the South Pole at X=0, Y=0.
    col0 = (0.0 - transform.c) / transform.a
    row0 = (0.0 - transform.f) / transform.e
    half_cols = REGION_HALF_WIDTH_M / abs(transform.a)
    half_rows = REGION_HALF_WIDTH_M / abs(transform.e)
    col_start = max(0, int(math.floor(col0 - half_cols)))
    row_start = max(0, int(math.floor(row0 - half_rows)))
    col_stop = min(src.width, int(math.ceil(col0 + half_cols)))
    row_stop = min(src.height, int(math.ceil(row0 + half_rows)))
    if col_stop - col_start < 2 or row_stop - row_start < 2:
        raise ValueError("Illumination GeoTIFF does not cover the South Pole region")
    return Window(col_start, row_start, col_stop - col_start, row_stop - row_start)


def normalize_illumination_percent(data: np.ndarray) -> np.ndarray:
    """Convert scaled fractions or percent values to 0–100 percent."""
    result = np.asarray(data, dtype=np.float64).copy()
    valid = np.isfinite(result)
    if not valid.any():
        return result
    low, high = float(np.nanmin(result)), float(np.nanmax(result))
    if low >= 0.0 and high <= 1.5:
        result *= 100.0
    elif low >= 0.0 and high > 100.0:
        # Guard for integer packed values that have no useful scale metadata.
        result *= 100.0 / high
    return np.clip(result, 0.0, 100.0)


def lunar_latlon(x: np.ndarray, y: np.ndarray, crs_value: Any) -> tuple[np.ndarray, np.ndarray]:
    """Convert lunar stereographic coordinates into latitude and longitude."""
    crs = CRS.from_user_input(crs_value)
    try:
        radius = float(crs.ellipsoid.semi_major_metre)
    except (AttributeError, TypeError, ValueError):
        radius = math.nan
    if math.isfinite(radius) and abs(radius - MOON_RADIUS_M) / MOON_RADIUS_M < 0.01:
        geog = CRS.from_proj4(f"+proj=longlat +R={MOON_RADIUS_M} +no_defs +type=crs")
        lon, lat = Transformer.from_crs(crs, geog, always_xy=True).transform(x, y)
        return np.asarray(lat), (np.asarray(lon) + 180.0) % 360.0 - 180.0
    rho = np.hypot(x, y)
    lat = -90.0 + np.degrees(2.0 * np.arctan(rho / (2.0 * MOON_RADIUS_M)))
    lon = (np.degrees(np.arctan2(x, y)) + 180.0) % 360.0 - 180.0
    return lat, lon


def make_synthetic_shackleton_dem(transform: rasterio.Affine,
                                  shape: tuple[int, int]) -> np.ndarray:
    """Create a smooth fallback crater: depressed bowl, raised rim, lunar ridges."""
    rows, cols = np.indices(shape, dtype=np.float64)
    xs, ys = rasterio.transform.xy(transform, rows, cols, offset="center")
    x, y = np.asarray(xs).reshape(shape), np.asarray(ys).reshape(shape)
    radius = np.hypot(x, y)
    bowl = -2_500.0 * np.exp(-((radius / 7_500.0) ** 2))
    rim = 700.0 * np.exp(-(((radius - 10_500.0) / 1_100.0) ** 2))
    ridges = 24.0 * np.sin(x / 7_800.0) * np.cos(y / 9_200.0)
    regional_relief = 0.00035 * x - 0.00022 * y
    return bowl + rim + ridges + regional_relief


def try_read_elevation(path: Path, target_transform: rasterio.Affine,
                       target_crs: Any, shape: tuple[int, int]) -> np.ndarray:
    """Warp a readable DEM onto the target grid, honoring band scale/offset."""
    with rasterio.open(path) as src:
        masked = src.read(1, masked=True).astype(np.float64)
        values = np.asarray(masked.data, dtype=np.float64)
        invalid = np.ma.getmaskarray(masked) | ~np.isfinite(values) | (values == -32768.0)
        if src.nodata is not None:
            invalid |= np.isclose(values, src.nodata, rtol=0.0, atol=1e-8)
        values = values * (float(src.scales[0]) if src.scales else 1.0) + (float(src.offsets[0]) if src.offsets else 0.0)
        values[invalid] = np.nan
        units = (src.units[0] or "").lower() if src.units else ""
        if units in {"km", "kilometer", "kilometers", "kilometre", "kilometres"}:
            values *= 1000.0
        if np.isfinite(values).any() and np.nanmedian(values) > 1_000_000.0:
            values -= MOON_RADIUS_M
        destination = np.full(shape, np.nan, dtype=np.float64)
        reproject(source=values, destination=destination,
                  src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
                  dst_transform=target_transform, dst_crs=target_crs,
                  dst_nodata=np.nan, resampling=Resampling.bilinear,
                  init_dest_nodata=True)
        if np.isfinite(destination).any():
            return destination
    raise ValueError(f"DEM {path} has no valid overlap with the South Pole region")


def calculate_slope(elevation: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """Calculate slope in degrees using projected pixel spacing in metres."""
    valid = np.isfinite(elevation)
    if not valid.any():
        return np.full(elevation.shape, np.nan)
    filled = np.where(valid, elevation, np.nanmedian(elevation))
    dz_dy, dz_dx = np.gradient(filled, dy, dx)
    slope = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))
    safe = valid.copy()
    safe[1:, :] &= valid[:-1, :]
    safe[:-1, :] &= valid[1:, :]
    safe[:, 1:] &= valid[:, :-1]
    safe[:, :-1] &= valid[:, 1:]
    slope[~safe] = np.nan
    return slope


def distance_to_shadow(shadow: np.ndarray, pixel_m: float) -> np.ndarray:
    """Approximate Euclidean distance to the nearest shadow without SciPy."""
    shadow_rows, shadow_cols = np.nonzero(shadow)
    if shadow_rows.size == 0:
        return np.full(shadow.shape, np.inf, dtype=np.float64)
    query_rows, query_cols = np.indices(shadow.shape)
    queries = np.column_stack((query_rows.ravel(), query_cols.ravel()))
    targets = np.column_stack((shadow_rows, shadow_cols))
    result = np.empty(len(queries), dtype=np.float64)
    # Chunk the broadcast so even dense shadow masks use bounded memory.
    for start in range(0, len(queries), 256):
        batch = queries[start:start + 256]
        dr = batch[:, None, 0] - targets[None, :, 0]
        dc = batch[:, None, 1] - targets[None, :, 1]
        result[start:start + len(batch)] = np.sqrt(np.min(dr * dr + dc * dc, axis=1)) * pixel_m
    return result.reshape(shadow.shape)


def derive_solar_and_suitability(sunlight: np.ndarray, slope: np.ndarray,
                                pixel_m: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    solar = SOLAR_CONSTANT_W_M2 * sunlight / 100.0 * 24.0 * PANEL_EFFICIENCY / 1000.0
    valid = np.isfinite(sunlight) & np.isfinite(slope)
    shadow = (sunlight < 5.0) & valid
    if shadow.any():
        distance_m = distance_to_shadow(shadow, pixel_m)
        ice_bonus = np.clip(1.0 - distance_m / 12_000.0, 0.0, 1.0)
        # A site inside permanent shadow has resources but poor power access.
        ice_bonus[shadow] = 0.0
    else:
        ice_bonus = np.zeros_like(sunlight)
    terrain_score = np.clip(1.0 - np.maximum(slope - 5.0, 0.0) / 20.0, 0.0, 1.0)
    terrain_score = np.where(slope > 15.0, terrain_score * 0.2, terrain_score)
    score = 100.0 * (0.5 * terrain_score + 0.3 * sunlight / 100.0 + 0.2 * ice_bonus)
    score = np.where(valid, np.clip(score, 0.0, 100.0), np.nan)
    risk = np.full(score.shape, "Hazardous", dtype=object)
    risk[(score >= 35.0) & (slope <= 15.0)] = "Moderate"
    risk[(score >= 70.0) & (slope <= 15.0)] = "Optimal"
    risk[~valid] = "NoData"
    return solar, score, risk


def write_location_file(path: Path, locations: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as stream:
        json.dump({"locations": locations}, stream, separators=(",", ":"), allow_nan=False)


def process() -> dict[str, int]:
    illumination_path = first_readable_raster(ILLUMINATION_CANDIDATES, "illumination")
    with rasterio.open(illumination_path) as src:
        source_crs = src.crs
        window = polar_region_window(src)
        out_shape = (OUTPUT_SIZE, OUTPUT_SIZE)
        sunlight = normalize_illumination_percent(scaled_window(src, window, out_shape))
        target_transform = src.window_transform(window) * rasterio.Affine.scale(
            window.width / OUTPUT_SIZE, window.height / OUTPUT_SIZE)
        target_crs = src.crs
        dx = math.hypot(target_transform.a, target_transform.d)
        dy = math.hypot(target_transform.b, target_transform.e)
        rows, cols = np.indices(out_shape)
        xs, ys = xy(target_transform, rows, cols, offset="center")
        xs, ys = np.asarray(xs).reshape(out_shape), np.asarray(ys).reshape(out_shape)
        lat, lon = lunar_latlon(xs, ys, target_crs)

    dem_source: Path | None = None
    elevation: np.ndarray | None = None
    dem_errors = []
    for candidate in ELEVATION_CANDIDATES:
        if not candidate.is_file():
            continue
        try:
            elevation = try_read_elevation(candidate, target_transform, target_crs, out_shape)
            dem_source = candidate
            break
        except Exception as exc:
            dem_errors.append(f"{candidate}: {exc}")
    if elevation is None:
        warnings.warn("No usable DEM GeoTIFF overlaps the illumination grid; generating synthetic Shackleton-style terrain. " + " | ".join(dem_errors))
        elevation = make_synthetic_shackleton_dem(target_transform, out_shape)
        dem_description = "synthetic Shackleton-style fallback (not NASA elevation data)"
    else:
        dem_description = str(dem_source)

    slope = calculate_slope(elevation, dx, dy)
    solar, scores, risks = derive_solar_and_suitability(sunlight, slope, math.sqrt(dx * dy))
    valid = np.isfinite(lat) & np.isfinite(lon) & (lat >= -90.0) & (lat <= -80.0)
    valid &= np.isfinite(sunlight) & np.isfinite(elevation) & np.isfinite(slope)
    if not valid.any():
        raise ValueError("No valid South Pole points available for export")

    locations_sun = []
    locations_terrain = []
    locations_solar = []
    locations_suitability = []
    for r, c in zip(*np.nonzero(valid)):
        coord = {"lat": round(float(lat[r, c]), 6), "lon": round(float(lon[r, c]), 6)}
        illum = float(sunlight[r, c])
        slp = float(slope[r, c])
        elev = float(elevation[r, c])
        energy = float(solar[r, c])
        score = float(scores[r, c])
        locations_sun.append({**coord, "value": round(illum, 4), "illumination_pct": round(illum, 4), "unit": "%"})
        locations_terrain.append({**coord, "value": round(slp, 4), "slope_degrees": round(slp, 4), "elevation_m": round(elev, 3), "unit": "degrees"})
        locations_solar.append({**coord, "value": round(energy, 5), "unit": "kWh/m²/day"})
        locations_suitability.append({**coord, "value": round(score, 3), "risk_rating": str(risks[r, c]), "slope_degrees": round(slp, 4), "illumination_pct": round(illum, 4), "unit": "score_0_100"})

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = {
        "sunlight.json": locations_sun,
        "terrain.json": locations_terrain,
        "solar_energy.json": locations_solar,
        "suitability.json": locations_suitability,
    }
    for filename, locations in outputs.items():
        write_location_file(OUT_DIR / filename, locations)

    print("Lunar South Pole static data processing complete")
    print(f"  NASA illumination GeoTIFF: {illumination_path}")
    print(f"  Elevation source: {dem_description}")
    print(f"  Input CRS: {source_crs}")
    print(f"  Output pixel resolution: dx={dx:.2f} m, dy={dy:.2f} m")
    print(f"  Elevation min/max: {np.nanmin(elevation):.2f} / {np.nanmax(elevation):.2f} m")
    print(f"  Slope min/max: {np.nanmin(slope):.3f} / {np.nanmax(slope):.3f} degrees")
    print(f"  Sunlight min/max: {np.nanmin(sunlight):.3f} / {np.nanmax(sunlight):.3f} %")
    print(f"  Solar energy min/max: {np.nanmin(solar):.4f} / {np.nanmax(solar):.4f} kWh/m²/day")
    print(f"  Valid locations exported per file: {int(valid.sum())}")
    print(f"  Output directory: {OUT_DIR}")
    return {filename: len(locations) for filename, locations in outputs.items()}


if __name__ == "__main__":
    process()
