// Pure geometry for sun/shadow computation. No DOM, no map, no SunCalc —
// everything works on plain numbers/arrays so it runs in the browser and in
// Node tests alike.
//
// Conventions:
//   - Positions are [lon, lat] (GeoJSON order) unless suffixed "Local".
//   - Local coordinates are meters: x = east, y = north, relative to a point.
//   - Bearings are radians, clockwise from north (0 = north, PI/2 = east).
//   - Altitude is radians above the horizon.

export const M_PER_DEG_LAT = 111320;

export function mPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

// Signed area * 2 of a ring in local meters. Positive = counterclockwise.
export function signedRingArea2(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s;
}

// SunCalc reports azimuth measured from south, positive toward west. The sun's
// bearing from north is therefore azimuth + PI, and the shadow falls on the
// opposite side, which lands back on the raw azimuth value (mod 2*PI).
export function sunDirections(suncalcAzimuth) {
  const tau = 2 * Math.PI;
  return {
    sunBearing: (suncalcAzimuth + Math.PI + tau) % tau,
    shadowBearing: (suncalcAzimuth + tau) % tau,
  };
}

// Shadow geometry shared by every building for one sun position, or null when
// the sun is below the horizon. perMeter is the shadow length cast per meter
// of obstacle height, clamped so near-horizon sun doesn't produce unbounded
// shadows (60 m per meter of height ~= altitude 0.95 degrees).
export function sunShadowParams(altitude, shadowBearing, maxPerMeter = 60) {
  if (altitude <= 0) return null;
  return {
    ux: Math.sin(shadowBearing),
    uy: Math.cos(shadowBearing),
    perMeter: Math.min(1 / Math.tan(altitude), maxPerMeter),
  };
}

function closeRing(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function dropClosingPoint(ring) {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}

// Shadow footprint of one building as GeoJSON MultiPolygon coordinates.
//
// Rather than unioning the swept volume (slow for live time-scrubbing), we
// emit the footprint itself plus one "strip" per run of sun-facing edges:
// [v_s ... v_e, v_e + shadow, ... v_s + shadow]. For convex footprints this
// tiles the exact swept region with no interior overlap; for concave ones the
// strips may overlap slightly, which only darkens the fill a touch.
//
// rings: [outerRing, ...holeRings] in [lon, lat]; height in meters.
export function buildingShadowPolygons(rings, height, params, maxShadowLen = 3000) {
  const lat0 = rings[0][0][1];
  const lon0 = rings[0][0][0];
  const mLon = mPerDegLon(lat0);
  const len = Math.min(height * params.perMeter, maxShadowLen);
  const vx = params.ux * len;
  const vy = params.uy * len;

  const polygons = [rings.map((r) => closeRing(r.map((p) => [p[0], p[1]])))];

  rings.forEach((ring, ringIndex) => {
    let pts = dropClosingPoint(ring).map(([lon, lat]) => [
      (lon - lon0) * mLon,
      (lat - lat0) * M_PER_DEG_LAT,
    ]);
    if (pts.length < 3) return;

    // Orient so the solid is on the left of travel (outer CCW, holes CW);
    // then the solid-outward normal of edge (dx, dy) is (dy, -dx).
    const ccw = signedRingArea2(pts) > 0;
    const wantCCW = ringIndex === 0;
    if (ccw !== wantCCW) pts = pts.slice().reverse();

    const n = pts.length;
    const facing = pts.map((p, i) => {
      const q = pts[(i + 1) % n];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      return dy * vx - dx * vy > 0;
    });
    if (facing.every(Boolean) || !facing.some(Boolean)) return; // degenerate

    // Walk maximal runs of consecutive sun-facing edges (with wraparound).
    let start = 0;
    while (facing[(start - 1 + n) % n]) start++; // start at a run boundary
    for (let scanned = 0, i = start; scanned < n; ) {
      if (!facing[i % n]) {
        scanned++;
        i++;
        continue;
      }
      const runStart = i;
      while (facing[i % n] && scanned < n) {
        scanned++;
        i++;
      }
      const strip = [];
      for (let k = runStart; k <= i; k++) strip.push(pts[k % n]);
      for (let k = i; k >= runStart; k--) {
        const p = pts[k % n];
        strip.push([p[0] + vx, p[1] + vy]);
      }
      polygons.push([
        closeRing(strip.map(([x, y]) => [lon0 + x / mLon, lat0 + y / M_PER_DEG_LAT])),
      ]);
    }
  });

  return polygons;
}

// Precompute obstacle edges in local meters around a viewpoint so repeated
// per-time-sample ray tests are cheap. point: {lng, lat};
// buildings: [{rings, height}]. Obstacles farther than maxDist are dropped.
export function prepareObstacles(point, buildings, maxDist = 1200) {
  const mLon = mPerDegLon(point.lat);
  const obstacles = [];
  for (const b of buildings) {
    const rings = b.rings.map((ring) =>
      dropClosingPoint(ring).map(([lon, lat]) => [
        (lon - point.lng) * mLon,
        (lat - point.lat) * M_PER_DEG_LAT,
      ])
    );
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const dx = Math.max(minX, 0, -maxX);
    const dy = Math.max(minY, 0, -maxY);
    if (Math.hypot(dx, dy) > maxDist) continue;

    const edges = [];
    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const a = ring[i];
        const b2 = ring[(i + 1) % n];
        edges.push([a[0], a[1], b2[0], b2[1]]);
      }
    }
    obstacles.push({ edges, height: b.height, inside: originInRings(rings) });
  }
  return obstacles;
}

// Even-odd test for the local origin against a set of rings.
function originInRings(rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % n];
      if (ay > 0 !== by > 0) {
        const xCross = ax + (-ay / (by - ay)) * (bx - ax);
        if (xCross > 0) inside = !inside;
      }
    }
  }
  return inside;
}

// Is direct sun blocked at the prepared viewpoint? Casts a ray toward the sun
// and checks whether any obstacle edge it crosses is tall enough to occlude
// the sun at that distance (flat-terrain assumption).
export function isSunBlocked(obstacles, sunBearing, altitude) {
  if (altitude <= 0) return true;
  const rx = Math.sin(sunBearing);
  const ry = Math.cos(sunBearing);
  const tanAlt = Math.tan(altitude);
  for (const ob of obstacles) {
    if (ob.inside) return true;
    for (const [ax, ay, bx, by] of ob.edges) {
      const sx = bx - ax;
      const sy = by - ay;
      const denom = rx * sy - ry * sx;
      if (Math.abs(denom) < 1e-12) continue;
      const t = (ax * sy - ay * sx) / denom;
      if (t <= 0.5) continue; // ignore self/contact within half a meter
      const u = (ax * ry - ay * rx) / denom;
      if (u < 0 || u > 1) continue;
      if (ob.height >= t * tanAlt) return true;
    }
  }
  return false;
}

// Merge ordered samples [{minutes, lit}] into contiguous lit intervals.
// step is the sampling interval in minutes; an interval's end extends to the
// start of the first unlit sample after it.
export function litWindows(samples, step) {
  const windows = [];
  let current = null;
  for (const s of samples) {
    if (s.lit) {
      if (!current) current = { start: s.minutes, end: s.minutes + step };
      else current.end = s.minutes + step;
    } else if (current) {
      windows.push(current);
      current = null;
    }
  }
  if (current) windows.push(current);
  return windows;
}
