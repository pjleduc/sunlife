// Terrain occlusion from AWS Open Data Terrain Tiles ("terrarium" PNGs,
// https://registry.opendata.aws/terrain-tiles/). Answers one question for the
// sun reports: does a hill or mountain on the horizon hide the sun from this
// point?
//
// Layout mirrors src/geometry.js: the math core (TerrainGrid, terrarium
// decoding, slippy-map tile math) is pure and runs under node --test; the
// browser-only tile fetching/decoding lives in loadTerrainAround at the
// bottom of the file.
//
// Conventions (same as geometry.js):
//   - Positions are lon/lat degrees; bearings are radians clockwise from
//     north (x = east = sin(bearing), y = north = cos(bearing)).
//   - Altitude is radians above the horizon. Elevations are meters.

import { mPerDegLon, M_PER_DEG_LAT } from './geometry.js';

export const TERRAIN_TILE_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_ZOOM = 11; // ~76 m/pixel at the equator; 3x3 tiles ~ +-25 km
export const TERRAIN_RESOLUTION_M = 76; // nominal grid spacing at TERRAIN_ZOOM
export const TILE_SIZE = 256;

// Ray-march parameters for the horizon test: start close (a backyard berm),
// grow geometrically so 25 km costs ~110 elevation lookups per sun position.
const MARCH_START_M = 40;
const MARCH_GROWTH = 1.06;
const MARCH_MAX_M = 25000;

// Earth-curvature drop for a level sight line is d^2 / (2R). Standard
// atmospheric refraction bends light slightly downward (toward the earth),
// which partially cancels curvature; the usual surveyor's approximation folds
// it in by using an effective earth radius of R * 1.17 (~7.45e6 m). We do the
// same, so the ray height at distance d is:
//   eyeElevation + d * tan(altitude) - d^2 / (2 * EFFECTIVE_EARTH_RADIUS_M)
const EARTH_RADIUS_M = 6371000;
export const EFFECTIVE_EARTH_RADIUS_M = EARTH_RADIUS_M * 1.17;

// ---------------------------------------------------------------------------
// Terrarium decoding (pure)
// ---------------------------------------------------------------------------

// Decode a flat RGBA pixel array (length width*height*4) into elevations in
// meters: elevation = (R * 256 + G + B / 256) - 32768. Alpha is ignored.
export function decodeTerrarium(rgba, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = rgba[o] * 256 + rgba[o + 1] + rgba[o + 2] / 256 - 32768;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slippy-map (XYZ) tile math (pure)
// ---------------------------------------------------------------------------

export function lonLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

// Fractional tile coordinates are accepted, so (x + px/256) addresses a pixel.
export function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y, z) {
  return (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z));
}

// ---------------------------------------------------------------------------
// TerrainGrid (pure)
// ---------------------------------------------------------------------------

// A geographic elevation grid. Samples sit at "pixel centers": column c is at
// longitude west + c * lonStep; row 0 is the north edge.
//
// Web Mercator note: tile pixel rows are NOT equally spaced in latitude. Over
// a 3x3 z11 tile block the deviation is small but real, so loadTerrainAround
// passes rowLats — a per-row latitude lookup table computed from each pixel
// row's mercator Y. When present, elevationAt locates rows by binary search
// in that table (geographically exact); without it, rows are assumed evenly
// spaced by latStep (fine for synthetic test grids). north/latStep are kept
// as nominal metadata either way.
//
// No-data cells (failed tile fetches) hold NaN; any lookup touching them
// returns null, which callers treat as "no terrain information here".
export class TerrainGrid {
  constructor({ data, cols, rows, west, north, lonStep, latStep, rowLats = null }) {
    this.data = data; // Float32Array, row-major, row 0 = north
    this.cols = cols;
    this.rows = rows;
    this.west = west;
    this.north = north;
    this.lonStep = lonStep;
    this.latStep = latStep;
    this.rowLats = rowLats; // optional Float64Array/Array, descending latitudes
  }

  // Geographic center of the grid, used by callers to decide when a report
  // point has strayed far enough to warrant reloading tiles.
  get center() {
    const lng = this.west + ((this.cols - 1) / 2) * this.lonStep;
    const mid = (this.rows - 1) / 2;
    const lat = this.rowLats
      ? (this.rowLats[Math.floor(mid)] + this.rowLats[Math.ceil(mid)]) / 2
      : this.north - mid * this.latStep;
    return { lng, lat };
  }

  // Bilinear-interpolated elevation in meters, or null outside coverage or
  // when any contributing cell is no-data (NaN propagates through the blend).
  elevationAt(lng, lat) {
    const fc = (lng - this.west) / this.lonStep;
    if (fc < 0 || fc > this.cols - 1) return null;

    let fr;
    if (this.rowLats) {
      const rl = this.rowLats;
      if (lat > rl[0] || lat < rl[this.rows - 1]) return null;
      let lo = 0;
      let hi = this.rows - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (rl[mid] >= lat) lo = mid;
        else hi = mid;
      }
      fr = lo + (rl[lo] - lat) / (rl[lo] - rl[hi] || 1);
    } else {
      fr = (this.north - lat) / this.latStep;
      if (fr < 0 || fr > this.rows - 1) return null;
    }

    const c0 = Math.max(0, Math.min(Math.floor(fc), this.cols - 2));
    const r0 = Math.max(0, Math.min(Math.floor(fr), this.rows - 2));
    const tx = fc - c0;
    const ty = fr - r0;
    const i = r0 * this.cols + c0;
    const v =
      this.data[i] * (1 - tx) * (1 - ty) +
      this.data[i + 1] * tx * (1 - ty) +
      this.data[i + this.cols] * (1 - tx) * ty +
      this.data[i + this.cols + 1] * tx * ty;
    return Number.isFinite(v) ? v : null;
  }

  // Does terrain hide the sun from a viewpoint at absolute elevation
  // eyeElevation (meters above sea level)? Ray-marches from the point along
  // the sun bearing, starting at MARCH_START_M and growing x MARCH_GROWTH per
  // step out to MARCH_MAX_M; blocked iff the ground anywhere rises above the
  // sun ray, whose height includes the refraction-corrected earth-curvature
  // drop (see EFFECTIVE_EARTH_RADIUS_M). Samples outside the grid (or on
  // no-data) never block. Sun at or below the horizon counts as blocked,
  // matching isSunBlocked in geometry.js.
  sunBlockedByTerrain(lng, lat, eyeElevation, sunBearing, altitude) {
    if (altitude <= 0) return true;
    const tanAlt = Math.tan(altitude);
    const dLon = Math.sin(sunBearing) / mPerDegLon(lat); // deg east per meter
    const dLat = Math.cos(sunBearing) / M_PER_DEG_LAT; // deg north per meter
    for (let dist = MARCH_START_M; dist <= MARCH_MAX_M; dist *= MARCH_GROWTH) {
      const ground = this.elevationAt(lng + dLon * dist, lat + dLat * dist);
      if (ground === null) continue;
      const rayHeight =
        eyeElevation + dist * tanAlt - (dist * dist) / (2 * EFFECTIVE_EARTH_RADIUS_M);
      if (ground > rayHeight) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Browser-only tile loading
// ---------------------------------------------------------------------------

// Fetch one terrarium tile and return its flat RGBA pixels, or null on any
// failure (network, decode) — the caller fills that tile with no-data.
async function fetchTilePixels(x, y, z) {
  try {
    const url = TERRAIN_TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`terrain tile HTTP ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());
    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    } else {
      canvas = document.createElement('canvas'); // older Safari fallback
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  } catch (err) {
    console.warn(`Terrain tile ${z}/${x}/${y} failed`, err);
    return null;
  }
}

// Load the 3x3 block of TERRAIN_ZOOM tiles centered on the tile containing
// centerLngLat ({lng, lat}) and assemble them into one TerrainGrid covering
// roughly +-25 km. Tiles that fail to fetch stay NaN (no-data); throws only
// if every tile failed.
export async function loadTerrainAround(centerLngLat, zoom = TERRAIN_ZOOM) {
  const { x: cx, y: cy } = lonLatToTile(centerLngLat.lng, centerLngLat.lat, zoom);
  const n = 2 ** zoom;
  const size = 3 * TILE_SIZE;
  const data = new Float32Array(size * size).fill(NaN);
  const x0 = cx - 1;
  const y0 = cy - 1;

  let loaded = 0;
  const jobs = [];
  for (let ty = 0; ty < 3; ty++) {
    const tileY = y0 + ty;
    if (tileY < 0 || tileY >= n) continue; // beyond the poles: stays no-data
    for (let tx = 0; tx < 3; tx++) {
      const tileX = (((x0 + tx) % n) + n) % n; // wrap across the antimeridian
      jobs.push(
        fetchTilePixels(tileX, tileY, zoom).then((rgba) => {
          if (!rgba) return;
          loaded++;
          const elev = decodeTerrarium(rgba, TILE_SIZE, TILE_SIZE);
          for (let row = 0; row < TILE_SIZE; row++) {
            data.set(
              elev.subarray(row * TILE_SIZE, (row + 1) * TILE_SIZE),
              (ty * TILE_SIZE + row) * size + tx * TILE_SIZE
            );
          }
        })
      );
    }
  }
  await Promise.all(jobs);
  if (!loaded) throw new Error('All terrain tiles failed to load');

  // Per-row latitudes from each pixel row's mercator Y (see TerrainGrid note);
  // longitudes are exactly linear in mercator X, so a single lonStep is exact.
  const rowLats = new Float64Array(size);
  for (let r = 0; r < size; r++) rowLats[r] = tileYToLat(y0 + (r + 0.5) / TILE_SIZE, zoom);
  return new TerrainGrid({
    data,
    cols: size,
    rows: size,
    west: tileXToLon(x0 + 0.5 / TILE_SIZE, zoom),
    north: rowLats[0],
    lonStep: 360 / (n * TILE_SIZE),
    latStep: (rowLats[0] - rowLats[size - 1]) / (size - 1), // nominal average
    rowLats,
  });
}
