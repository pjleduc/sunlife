// Sun-hours heatmap controller (main thread). Builds the day's sun samples
// with the SunCalc browser global, hands the heavy ray-casting to
// src/heatmap-worker.js, and pins the rendered result to the map as a
// MapLibre image source + raster layer.
//
// Pure helpers (heatColor, gridSize) have no DOM/SunCalc dependency so this
// module is importable in Node tests; the worker/canvas/map code only runs
// when computeHeatmap is called in a browser.

import { sunDirections, mPerDegLon, M_PER_DEG_LAT } from './geometry.js';

export const HEATMAP_SOURCE = 'sun-hours';
export const HEATMAP_LAYER = 'sun-hours';
export const HEATMAP_STEP_MIN = 20; // minutes between sun samples
export const HEATMAP_MAX_CELLS = 96; // grid clamped to ≤ 96×96
const HEATMAP_ALPHA = Math.round(0.7 * 255); // ~70% max opacity

// Perceptual-ish colormap: navy (no sun) → teal → green → warm yellow (full
// daylight). Keep in sync with the .heatmap-gradient CSS legend bar.
const COLOR_STOPS = [
  [0.0, [12, 16, 64]], // #0c1040 navy
  [0.35, [20, 110, 130]], // #146e82 teal
  [0.65, [70, 170, 90]], // #46aa5a green
  [1.0, [255, 220, 80]], // #ffdc50 warm yellow
];

// t in [0,1] (fraction of possible daylight) → [r, g, b].
export function heatColor(t) {
  const x = Math.min(Math.max(t, 0), 1);
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const [t1, c1] = COLOR_STOPS[i];
    if (x <= t1) {
      const [t0, c0] = COLOR_STOPS[i - 1];
      const f = (x - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1][1].slice();
}

// Grid dimensions for a bbox: cell ≈ viewport-width / 96, total ≤ 96×96.
export function gridSize(bbox, maxCells = HEATMAP_MAX_CELLS) {
  const latMid = (bbox.north + bbox.south) / 2;
  const widthM = (bbox.east - bbox.west) * mPerDegLon(latMid);
  const heightM = (bbox.north - bbox.south) * M_PER_DEG_LAT;
  const cols = maxCells;
  const cellM = widthM / cols;
  const rows = Math.max(1, Math.min(maxCells, Math.round(heightM / cellM)));
  return { cols, rows };
}

// Sun direction/altitude for each stepMinutes sample of the date with the sun
// above the horizon, computed at the bbox center — the direction varies
// negligibly across a neighborhood view, and the worker can't load SunCalc
// (vendored UMD browser global), so these are computed here and posted over.
export function buildSunSamples(date, center, stepMinutes = HEATMAP_STEP_MIN) {
  const samples = [];
  for (let t = 0; t < 1440; t += stepMinutes) {
    const dt = new Date(date.y, date.m, date.d, 0, t);
    const pos = SunCalc.getPosition(dt, center.lat, center.lng);
    if (pos.altitude <= 0) continue;
    samples.push({
      sunBearing: sunDirections(pos.azimuth).sunBearing,
      altitude: pos.altitude,
    });
  }
  return samples;
}

let activeJob = null; // {worker, resolve} of the in-flight computation

function cancelActiveJob() {
  if (!activeJob) return;
  activeJob.worker.terminate();
  activeJob.resolve(null); // cancelled: resolve null, callers skip rendering
  activeJob = null;
}

// Compute and display the heatmap for bbox on the given date.
// Resolves {cols, rows, maxHours} when the layer is on the map, or null if the
// job was cancelled by clearHeatmap()/a newer computeHeatmap() call.
export function computeHeatmap({ map, bbox, date, buildings, trees, treesEnabled, onProgress }) {
  cancelActiveJob();
  const center = {
    lng: (bbox.west + bbox.east) / 2,
    lat: (bbox.south + bbox.north) / 2,
  };
  const samples = buildSunSamples(date, center);
  const { cols, rows } = gridSize(bbox);
  const worker = new Worker(new URL('./heatmap-worker.js', import.meta.url), { type: 'module' });

  return new Promise((resolve, reject) => {
    const job = { worker, resolve };
    activeJob = job;
    const finish = () => {
      worker.terminate();
      if (activeJob === job) activeJob = null;
    };
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.done, msg.total);
      } else if (msg.type === 'done') {
        finish();
        renderHeatmapLayer(map, bbox, msg);
        resolve({ cols: msg.cols, rows: msg.rows, maxHours: msg.maxHours });
      }
    };
    worker.onerror = (err) => {
      finish();
      reject(err.error || new Error(err.message || 'heatmap worker failed'));
    };
    worker.postMessage({
      bbox,
      date,
      samples,
      buildings,
      trees,
      treesEnabled,
      cols,
      rows,
      stepMinutes: HEATMAP_STEP_MIN,
    });
  });
}

// Remove the heatmap layer and cancel any in-flight computation.
export function clearHeatmap(map) {
  cancelActiveJob();
  if (map.getLayer(HEATMAP_LAYER)) map.removeLayer(HEATMAP_LAYER);
  if (map.getSource(HEATMAP_SOURCE)) map.removeSource(HEATMAP_SOURCE);
}

// Paint the hours grid to a tiny offscreen canvas (one pixel per cell; the
// raster layer's linear resampling smooths it) and pin it to the bbox corners.
function renderHeatmapLayer(map, bbox, { hours, cols, rows, maxHours }) {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < hours.length; i++) {
    const [r, g, b] = heatColor(maxHours > 0 ? hours[i] / maxHours : 0);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = HEATMAP_ALPHA;
  }
  ctx.putImageData(img, 0, 0);

  // Row 0 of the hours grid is the north edge, matching canvas row 0 = top.
  const coordinates = [
    [bbox.west, bbox.north],
    [bbox.east, bbox.north],
    [bbox.east, bbox.south],
    [bbox.west, bbox.south],
  ];
  if (map.getLayer(HEATMAP_LAYER)) map.removeLayer(HEATMAP_LAYER);
  if (map.getSource(HEATMAP_SOURCE)) map.removeSource(HEATMAP_SOURCE);
  map.addSource(HEATMAP_SOURCE, { type: 'image', url: canvas.toDataURL(), coordinates });
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer(
    {
      id: HEATMAP_LAYER,
      type: 'raster',
      source: HEATMAP_SOURCE,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
    },
    firstSymbol
  );
}
