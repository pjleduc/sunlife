// Sun-hours heatmap compute kernel. Runs as an ES module Web Worker
// (new Worker(url, {type:'module'})) but the core is pure and importable in
// Node tests — the onmessage wiring at the bottom only activates in a real
// worker scope.
//
// Input message (from src/heatmap.js):
//   {
//     bbox: {south, west, north, east},     // degrees, the grid extent
//     date: {y, m, d},                      // m is 0-based; used for leaf season
//     samples: [{sunBearing, altitude}],    // precomputed on the main thread —
//                                           // SunCalc is a vendored UMD browser
//                                           // global and can't be imported here
//     buildings: [{rings, height, minHeight?}],
//     trees: [{rings, height, minHeight?, leafCycle?}],
//     treesEnabled: boolean,
//     cols, rows,                           // grid dimensions
//     stepMinutes,                          // minutes between sun samples (default 20)
//   }
// Output messages:
//   {type:'progress', done, total}                       // done/total in rows
//   {type:'done', hours: Float32Array, cols, rows, maxHours}  // buffer transferred
//
// hours is row-major with row 0 at the NORTH edge (top of the rendered image);
// hours[row * cols + col] is direct-sun hours at that cell center on the date.
// maxHours is the possible daylight hours (sun-above-horizon samples × step),
// which is also the colormap maximum.
//
// Performance design (a 96×96 grid over a dense city block ray-casts millions
// of cell×sample pairs):
//   - Obstacles are converted to local meters around the bbox center once and
//     bucketed into a coarse spatial grid (BIN_SIZE bins; each obstacle is
//     registered in every bin its bounding box overlaps, so large woods are
//     found from any nearby cell).
//   - Each cell only considers obstacles within OBSTACLE_DIST_CAP. The 600 m
//     cap is a deliberate accuracy tradeoff: an obstacle 600 m away must be
//     taller than 600·tan(altitude) ≈ 105 m even at a low 10° sun to shade a
//     cell, so only skyscrapers and mountains (which we don't model anyway)
//     are misjudged.
//   - Per sample, an obstacle whose height/distance ratio is below
//     tan(altitude) provably cannot shade the cell (any footprint crossing is
//     at t ≥ distance, so tMin·tan > height) and is skipped with one compare —
//     at high sun this culls almost everything, with no accuracy loss.
//   - Edges live in one flat Float64Array; the ray test mirrors
//     geometry.js's isSunBlocked slab semantics exactly (see the equivalence
//     test in test/heatmap.test.js) but takes the cell offset inline instead
//     of allocating translated edge lists per cell.
//   - Sun positions are shared across the whole grid — over a
//     neighborhood-sized bbox the sun's direction varies by hundredths of a
//     degree — and arrive precomputed from the main thread.

import { mPerDegLon, M_PER_DEG_LAT } from './geometry.js';
import { leafActive } from './trees.js';

export const OBSTACLE_DIST_CAP = 600; // meters; see accuracy note above
export const BIN_SIZE = 200; // meters per spatial-grid bin

function dropClosingPoint(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}

// Convert one obstacle to local meters around center {lng, lat}. Returns
// {rings, edges, height, minHeight, minX, minY, maxX, maxY} where edges are
// [ax, ay, bx, by] in the shared center frame.
export function localObstacle(center, item, mLon) {
  const rings = item.rings.map((ring) =>
    dropClosingPoint(ring).map(([lon, lat]) => [
      (lon - center.lng) * mLon,
      (lat - center.lat) * M_PER_DEG_LAT,
    ])
  );
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const edges = [];
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % n];
      edges.push([ax, ay, bx, by]);
      if (ax < minX) minX = ax;
      if (ax > maxX) maxX = ax;
      if (ay < minY) minY = ay;
      if (ay > maxY) maxY = ay;
    }
  }
  if (!edges.length) return null;
  return { rings, edges, height: item.height, minHeight: item.minHeight || 0, minX, minY, maxX, maxY };
}

// Bucket obstacles (anything with a minX/minY/maxX/maxY bbox in meters) into
// binSize bins; each obstacle lands in every bin its bbox overlaps so large
// footprints (woods, long hedges) are still found from any nearby cell.
export function bucketObstacles(obstacles, binSize = BIN_SIZE) {
  const bins = new Map();
  obstacles.forEach((ob, idx) => {
    const x0 = Math.floor(ob.minX / binSize);
    const x1 = Math.floor(ob.maxX / binSize);
    const y0 = Math.floor(ob.minY / binSize);
    const y1 = Math.floor(ob.maxY / binSize);
    for (let by = y0; by <= y1; by++) {
      for (let bx = x0; bx <= x1; bx++) {
        const key = `${bx}:${by}`;
        let arr = bins.get(key);
        if (!arr) bins.set(key, (arr = []));
        arr.push(idx);
      }
    }
  });
  return { binSize, bins, obstacles, stamps: new Int32Array(obstacles.length), stamp: 0 };
}

// Collect indices of obstacles whose bounding box lies within cap meters of
// (x, y) into outIdx with bbox distances in outDist; returns the count.
// Deduped across bins with a generation stamp (no per-call allocation), for
// reuse with the same buffers on every grid cell.
export function gatherNearbyInto(buckets, x, y, cap, outIdx, outDist) {
  const { binSize, bins, obstacles, stamps } = buckets;
  const stamp = ++buckets.stamp;
  const cap2 = cap * cap;
  let n = 0;
  const x0 = Math.floor((x - cap) / binSize);
  const x1 = Math.floor((x + cap) / binSize);
  const y0 = Math.floor((y - cap) / binSize);
  const y1 = Math.floor((y + cap) / binSize);
  for (let by = y0; by <= y1; by++) {
    for (let bx = x0; bx <= x1; bx++) {
      const arr = bins.get(`${bx}:${by}`);
      if (!arr) continue;
      for (const idx of arr) {
        if (stamps[idx] === stamp) continue;
        stamps[idx] = stamp;
        const ob = obstacles[idx];
        const dx = Math.max(ob.minX - x, 0, x - ob.maxX);
        const dy = Math.max(ob.minY - y, 0, y - ob.maxY);
        const d2 = dx * dx + dy * dy;
        if (d2 > cap2) continue;
        outIdx[n] = idx;
        outDist[n] = Math.sqrt(d2);
        n++;
      }
    }
  }
  return n;
}

// Convenience wrapper: the obstacles within cap meters of (x, y).
export function gatherNearby(buckets, x, y, cap = OBSTACLE_DIST_CAP) {
  const outIdx = new Int32Array(buckets.obstacles.length);
  const outDist = new Float64Array(buckets.obstacles.length);
  const n = gatherNearbyInto(buckets, x, y, cap, outIdx, outDist);
  const out = [];
  for (let k = 0; k < n; k++) out.push(buckets.obstacles[outIdx[k]]);
  return out;
}

// Even-odd point-in-rings test in local meters.
export function pointInRings(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % n];
      if (ay > y !== by > y) {
        const xCross = ax + ((y - ay) / (by - ay)) * (bx - ax);
        if (xCross > x) inside = !inside;
      }
    }
  }
  return inside;
}

// Center of grid cell (col, row). Row 0 is the NORTH edge so the hours array
// maps directly onto image pixels (canvas row 0 = top).
export function cellCenter(bbox, cols, rows, col, row) {
  return {
    lng: bbox.west + ((col + 0.5) * (bbox.east - bbox.west)) / cols,
    lat: bbox.north - ((row + 0.5) * (bbox.north - bbox.south)) / rows,
  };
}

// Does the obstacle whose flat edges live in edges[e0..e1) block the sun from
// the viewpoint (ox, oy)? Same math and slab semantics as geometry.js's
// isSunBlocked for a single obstacle — ray direction (rx, ry), contacts
// within half a meter ignored, blocked iff the sun line's height span across
// the footprint overlaps [minHeight, height] — only with the viewpoint offset
// applied inline so no per-cell edge copies are needed.
function obstacleBlocks(edges, e0, e1, ox, oy, rx, ry, tanAlt, height, minHeight, startInside) {
  let tMin = startInside ? 0 : Infinity;
  let tMax = -Infinity;
  for (let e = e0; e < e1; e += 4) {
    const ax = edges[e] - ox;
    const ay = edges[e + 1] - oy;
    const bx = edges[e + 2] - ox;
    const by = edges[e + 3] - oy;
    const sx = bx - ax;
    const sy = by - ay;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) continue;
    const t = (ax * sy - ay * sx) / denom;
    if (t <= 0.5) continue;
    const u = (ax * ry - ay * rx) / denom;
    if (u < 0 || u > 1) continue;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (tMax < 0) return false;
  return tMin * tanAlt <= height && tMax * tanAlt >= minHeight;
}

// Core computation: direct-sun hours for every grid cell center.
// onProgress(doneRows, totalRows) is called every few rows.
export function computeSunHoursGrid(input, onProgress) {
  const { bbox, date, buildings = [], trees = [], treesEnabled = true } = input;
  const cols = input.cols;
  const rows = input.rows;
  const stepMinutes = input.stepMinutes || 20;
  const center = {
    lng: (bbox.west + bbox.east) / 2,
    lat: (bbox.south + bbox.north) / 2,
  };
  const mLon = mPerDegLon(center.lat);

  // Trees only block while in leaf for the report month (deciduous trees drop
  // out of the winter simulation), mirroring app.js's activeTrees().
  const shadeItems = treesEnabled
    ? buildings.concat(trees.filter((t) => leafActive(t.leafCycle, date.m, center.lat)))
    : buildings;
  const obstacles = [];
  for (const item of shadeItems) {
    const ob = localObstacle(center, item, mLon);
    if (ob) obstacles.push(ob);
  }
  const buckets = bucketObstacles(obstacles);

  // Flatten the obstacle set into typed arrays for the hot loop.
  const count = obstacles.length;
  let edgeTotal = 0;
  for (const ob of obstacles) edgeTotal += ob.edges.length;
  const edges = new Float64Array(edgeTotal * 4);
  const start = new Int32Array(count + 1); // per-obstacle offsets into edges
  const heights = new Float64Array(count);
  const minHeights = new Float64Array(count);
  let off = 0;
  obstacles.forEach((ob, i) => {
    start[i] = off;
    heights[i] = ob.height;
    minHeights[i] = ob.minHeight;
    for (const [ax, ay, bx, by] of ob.edges) {
      edges[off] = ax;
      edges[off + 1] = ay;
      edges[off + 2] = bx;
      edges[off + 3] = by;
      off += 4;
    }
  });
  start[count] = off;

  const upSamples = input.samples.filter((s) => s.altitude > 0);
  const nSamples = upSamples.length;
  const rxArr = new Float64Array(nSamples);
  const ryArr = new Float64Array(nSamples);
  const tanArr = new Float64Array(nSamples);
  upSamples.forEach((s, i) => {
    rxArr[i] = Math.sin(s.sunBearing);
    ryArr[i] = Math.cos(s.sunBearing);
    tanArr[i] = Math.tan(s.altitude);
  });
  const hoursPerSample = stepMinutes / 60;
  const maxHours = nSamples * hoursPerSample;

  // Reusable per-cell buffers: nearby obstacle indices, their height/distance
  // cull ratio, and whether the cell sits inside their footprint.
  const nearIdx = new Int32Array(count);
  const nearDist = new Float64Array(count);
  const nearHd = new Float64Array(count);
  const nearInside = new Uint8Array(count);

  const hours = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = cellCenter(bbox, cols, rows, col, row);
      const x = (c.lng - center.lng) * mLon;
      const y = (c.lat - center.lat) * M_PER_DEG_LAT;
      const n = gatherNearbyInto(buckets, x, y, OBSTACLE_DIST_CAP, nearIdx, nearDist);
      for (let k = 0; k < n; k++) {
        const i = nearIdx[k];
        const d = nearDist[k];
        // d = 0 means the cell is inside the obstacle's bbox: never cull it,
        // and check whether the cell is actually inside the footprint.
        nearHd[k] = d > 0 ? heights[i] / d : Infinity;
        nearInside[k] = d === 0 && pointInRings(obstacles[i].rings, x, y) ? 1 : 0;
      }
      let h = 0;
      for (let s = 0; s < nSamples; s++) {
        const tanAlt = tanArr[s];
        let blocked = false;
        for (let k = 0; k < n; k++) {
          if (nearHd[k] < tanAlt) continue; // too far for its height to shade
          const i = nearIdx[k];
          if (
            obstacleBlocks(
              edges, start[i], start[i + 1],
              x, y, rxArr[s], ryArr[s], tanAlt,
              heights[i], minHeights[i], nearInside[k]
            )
          ) {
            blocked = true;
            break;
          }
        }
        if (!blocked) h += hoursPerSample;
      }
      hours[row * cols + col] = h;
    }
    if (onProgress && (row % 4 === 3 || row === rows - 1)) onProgress(row + 1, rows);
  }
  return { hours, cols, rows, maxHours };
}

// Worker wiring — only in a real worker scope (self without window), so
// importing this module in Node or on the main thread is side-effect free.
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    const result = computeSunHoursGrid(e.data, (done, total) =>
      self.postMessage({ type: 'progress', done, total })
    );
    self.postMessage(
      { type: 'done', hours: result.hours, cols: result.cols, rows: result.rows, maxHours: result.maxHours },
      [result.hours.buffer]
    );
  };
}
