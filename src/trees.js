// Trees, hedges and woodland from OpenStreetMap as shadow-casting obstacles.
//
// Sources of shade, in OSM vocabulary:
//   - natural=tree        (nodes: individual trees -> octagonal crown)
//   - natural=tree_row    (ways: lines of trees -> buffered strip)
//   - barrier=hedge       (ways: hedges -> low buffered strip)
//   - natural=wood, landuse=forest, landcover=trees (closed canopy areas)
//
// Each obstacle gets a leaf cycle so deciduous trees stop blocking sun in the
// leafless season — the difference between a gloomy and a bright winter
// living room is often a maple, not a building.

import {
  parseLength,
  polygonsFromElement,
  overpassFetch,
  bboxString,
} from './buildings.js';
import { mPerDegLon, M_PER_DEG_LAT } from './geometry.js';

export const TREE_DEFAULTS = {
  treeHeight: 12,
  crownRadius: 4,
  crownBaseFraction: 0.3, // canopy starts ~30% up the trunk
  rowHeight: 12,
  rowHalfWidth: 3,
  hedgeHeight: 2,
  hedgeHalfWidth: 0.75,
  woodHeight: 15,
};

// 'deciduous' | 'evergreen' from OSM tags. Untagged trees default to
// deciduous (the common case for urban street trees in temperate zones);
// untagged hedges default to evergreen since most are planted to stay dense.
export function leafCycleFromTags(tags = {}, fallback = 'deciduous') {
  const lc = tags.leaf_cycle;
  if (lc) return lc.includes('deciduous') ? 'deciduous' : 'evergreen';
  if (tags.leaf_type === 'needleleaved' || tags.leaf_type === 'mixed') return 'evergreen';
  return fallback;
}

// Whether foliage is on the branches in a given month (0-based) and
// hemisphere. Leaf-on is taken as April–October in the north, October–April
// in the south; evergreens always count.
export function leafActive(leafCycle, month, lat) {
  if (leafCycle !== 'deciduous') return true;
  return lat >= 0 ? month >= 3 && month <= 9 : month >= 9 || month <= 3;
}

function octagonRing(lon, lat, radius) {
  const mLon = mPerDegLon(lat);
  const ring = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 2 * Math.PI;
    ring.push([lon + (radius * Math.cos(a)) / mLon, lat + (radius * Math.sin(a)) / M_PER_DEG_LAT]);
  }
  ring.push([...ring[0]]);
  return ring;
}

// Buffer an open polyline into a closed strip polygon of width 2*halfWidth.
// Vertex normals are averaged between adjacent segments (no miter handling —
// fine for the gentle curves of tree rows and hedges).
export function lineToStrip(points, halfWidth) {
  if (points.length < 2) return null;
  const [lon0, lat0] = points[0];
  const mLon = mPerDegLon(lat0);
  const pts = points.map(([lon, lat]) => [(lon - lon0) * mLon, (lat - lat0) * M_PER_DEG_LAT]);

  const normals = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]);
  }
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const nPrev = normals[Math.max(i - 1, 0)];
    const nNext = normals[Math.min(i, normals.length - 1)];
    let nx = nPrev[0] + nNext[0];
    let ny = nPrev[1] + nNext[1];
    const len = Math.hypot(nx, ny) || 1;
    nx = (nx / len) * halfWidth;
    ny = (ny / len) * halfWidth;
    left.push([pts[i][0] + nx, pts[i][1] + ny]);
    right.push([pts[i][0] - nx, pts[i][1] - ny]);
  }
  const ring = left.concat(right.reverse());
  ring.push([...ring[0]]);
  return ring.map(([x, y]) => [lon0 + x / mLon, lat0 + y / M_PER_DEG_LAT]);
}

function treeHeightFromTags(tags = {}, fallback) {
  const h = parseLength(tags.height) ?? parseLength(tags.est_height);
  return h != null && h > 0 ? h : fallback;
}

// Fetch tree cover in bbox {south, west, north, east}.
// Returns [{id, rings, height, minHeight, leafCycle, kind}].
export async function fetchTrees(bbox, opts = {}) {
  const b = bboxString(bbox);
  const elements = await overpassFetch(
    `
    [out:json][timeout:30];
    (
      node["natural"="tree"](${b});
      way["natural"="tree_row"](${b});
      way["barrier"="hedge"](${b});
      way["natural"="wood"](${b});
      way["landuse"="forest"](${b});
      way["landcover"="trees"](${b});
      relation["natural"="wood"]["type"="multipolygon"](${b});
      relation["landuse"="forest"]["type"="multipolygon"](${b});
    );
    out tags geom;
  `,
    opts
  );

  const trees = [];
  const D = TREE_DEFAULTS;
  for (const el of elements) {
    const tags = el.tags || {};
    const id = `${el.type}/${el.id}`;

    if (el.type === 'node' && tags.natural === 'tree') {
      const height = treeHeightFromTags(tags, D.treeHeight);
      const radius = (parseLength(tags.diameter_crown) ?? 2 * D.crownRadius) / 2;
      trees.push({
        id,
        rings: [octagonRing(el.lon, el.lat, Math.max(radius, 1))],
        height,
        minHeight: height * D.crownBaseFraction,
        leafCycle: leafCycleFromTags(tags),
        kind: 'tree',
      });
      continue;
    }

    if (el.type === 'way' && el.geometry && tags.natural === 'tree_row') {
      const ring = lineToStrip(el.geometry.map((p) => [p.lon, p.lat]), D.rowHalfWidth);
      if (!ring) continue;
      const height = treeHeightFromTags(tags, D.rowHeight);
      trees.push({
        id,
        rings: [ring],
        height,
        minHeight: height * D.crownBaseFraction,
        leafCycle: leafCycleFromTags(tags),
        kind: 'tree_row',
      });
      continue;
    }

    if (el.type === 'way' && el.geometry && tags.barrier === 'hedge') {
      const ring = lineToStrip(el.geometry.map((p) => [p.lon, p.lat]), D.hedgeHalfWidth);
      if (!ring) continue;
      trees.push({
        id,
        rings: [ring],
        height: treeHeightFromTags(tags, D.hedgeHeight),
        minHeight: 0,
        leafCycle: leafCycleFromTags(tags, 'evergreen'),
        kind: 'hedge',
      });
      continue;
    }

    // Closed canopy: woods, forests, tree-covered land.
    for (const [i, poly] of polygonsFromElement(el).entries()) {
      trees.push({
        id: `${id}${i ? `/${i}` : ''}`,
        rings: poly.rings,
        height: treeHeightFromTags(tags, D.woodHeight),
        minHeight: 0,
        leafCycle: leafCycleFromTags(tags),
        kind: 'wood',
      });
    }
  }
  return trees;
}
