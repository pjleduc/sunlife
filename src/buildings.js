// Building footprints + heights from OpenStreetMap via the Overpass API.

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const DEFAULT_HEIGHT_M = 8; // ~2-3 storeys when OSM has no height data
const METERS_PER_LEVEL = 3.2;

// Parse an OSM length value to meters: "12", "12.5 m", "40 ft", "30'6\"".
export function parseLength(value) {
  if (value == null) return null;
  const v = String(value).trim();
  let m = v.match(/^(-?[\d.]+)\s*m?$/i);
  if (m) return parseFloat(m[1]);
  m = v.match(/^(-?[\d.]+)\s*ft$/i);
  if (m) return parseFloat(m[1]) * 0.3048;
  m = v.match(/^(\d+(?:\.\d+)?)'(?:\s*(\d+(?:\.\d+)?)")?$/);
  if (m) return parseFloat(m[1]) * 0.3048 + (parseFloat(m[2]) || 0) * 0.0254;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : null;
}

// Best-effort height in meters plus whether it was measured or estimated.
export function heightFromTags(tags = {}) {
  let h = parseLength(tags.height) ?? parseLength(tags['building:height']);
  if (h != null && h > 0) return { height: h, source: 'measured' };
  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    return { height: levels * METERS_PER_LEVEL, source: 'levels' };
  }
  return { height: DEFAULT_HEIGHT_M, source: 'default' };
}

function ringFromGeometry(geometry) {
  return geometry.map((p) => [p.lon, p.lat]);
}

function ringClosed(ring) {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return ring.length >= 4 && a[0] === b[0] && a[1] === b[1];
}

// Stitch open way segments into closed rings by matching endpoints (Overpass
// returns multipolygon members as separate, possibly unordered ways).
function assembleRings(segments) {
  const open = segments.map((s) => s.slice()).filter((s) => s.length >= 2);
  const rings = [];
  const key = (p) => `${p[0]},${p[1]}`;

  while (open.length) {
    let ring = open.pop();
    let extended = true;
    while (!ringClosed(ring) && extended) {
      extended = false;
      const tail = key(ring[ring.length - 1]);
      for (let i = 0; i < open.length; i++) {
        const seg = open[i];
        if (key(seg[0]) === tail) {
          ring = ring.concat(seg.slice(1));
        } else if (key(seg[seg.length - 1]) === tail) {
          ring = ring.concat(seg.slice(0, -1).reverse());
        } else {
          continue;
        }
        open.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ringClosed(ring)) rings.push(ring);
  }
  return rings;
}

function pointInRing(point, ring) {
  let inside = false;
  const [px, py] = point;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % n];
    if (ay > py !== by > py && px < ax + ((py - ay) / (by - ay)) * (bx - ax)) {
      inside = !inside;
    }
  }
  return inside;
}

// One Overpass element -> array of {rings: [outer, ...holes]} polygons.
export function polygonsFromElement(el) {
  if (el.type === 'way' && el.geometry) {
    const ring = ringFromGeometry(el.geometry);
    if (!ringClosed(ring)) return [];
    return [{ rings: [ring] }];
  }
  if (el.type === 'relation' && el.members) {
    const outers = assembleRings(
      el.members
        .filter((m) => m.role === 'outer' && m.geometry)
        .map((m) => ringFromGeometry(m.geometry))
    );
    const inners = assembleRings(
      el.members
        .filter((m) => m.role === 'inner' && m.geometry)
        .map((m) => ringFromGeometry(m.geometry))
    );
    return outers.map((outer) => ({
      rings: [outer, ...inners.filter((hole) => pointInRing(hole[0], outer))],
    }));
  }
  return [];
}

export function bboxString(bbox) {
  return `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
}

// POST an Overpass QL query, trying each public endpoint in turn.
export async function overpassFetch(query, { signal } = {}) {
  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const json = await res.json();
      return json.elements || [];
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError || new Error('All Overpass endpoints failed');
}

// Fetch buildings in bbox {south, west, north, east}.
// Returns [{id, rings, height, minHeight, heightSource, tags}].
export async function fetchBuildings(bbox, opts = {}) {
  const b = bboxString(bbox);
  const elements = await overpassFetch(
    `
    [out:json][timeout:30];
    (
      way["building"]["building"!="no"](${b});
      relation["building"]["building"!="no"]["type"="multipolygon"](${b});
    );
    out tags geom;
  `,
    opts
  );
  const buildings = [];
  for (const el of elements) {
    const { height, source } = heightFromTags(el.tags);
    const minHeight = parseLength(el.tags?.min_height) ?? 0;
    for (const [i, poly] of polygonsFromElement(el).entries()) {
      buildings.push({
        id: `${el.type}/${el.id}${i ? `/${i}` : ''}`,
        rings: poly.rings,
        height,
        minHeight: Math.max(0, Math.min(minHeight, height)),
        heightSource: source,
        tags: el.tags || {},
      });
    }
  }
  return buildings;
}
