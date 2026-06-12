import test from 'node:test';
import assert from 'node:assert/strict';

import { M_PER_DEG_LAT, prepareObstacles, isSunBlocked } from '../src/geometry.js';
import {
  OBSTACLE_DIST_CAP,
  bucketObstacles,
  gatherNearby,
  pointInRings,
  cellCenter,
  localObstacle,
  computeSunHoursGrid,
} from '../src/heatmap-worker.js';
import { heatColor, gridSize, HEATMAP_MAX_CELLS } from '../src/heatmap.js';

const DEG = (m) => m / M_PER_DEG_LAT; // meters → degrees at the equator

// ---------------------------------------------------------------------------
// Spatial bucketing
// ---------------------------------------------------------------------------

function box(minX, minY, maxX, maxY) {
  return { minX, minY, maxX, maxY };
}

test('gatherNearby finds obstacles within the cap and drops far ones', () => {
  const near = box(-5, -5, 5, 5);
  const edge = box(580, -10, 600, 10); // bbox touches 580 m: inside the cap
  const far = box(640, -10, 5000, 10); // nearest bbox point at 640 m: outside
  const buckets = bucketObstacles([near, edge, far], 200);
  const found = gatherNearby(buckets, 0, 0, OBSTACLE_DIST_CAP);
  assert.ok(found.includes(near));
  assert.ok(found.includes(edge));
  assert.ok(!found.includes(far));
});

test('gatherNearby finds a large footprint from a cell far from its centroid', () => {
  // A 2 km-long wood whose centroid is 1 km from the cell but whose bbox
  // reaches within 100 m — bucketing by bbox coverage must still find it.
  const wood = box(100, -50, 2100, 50);
  const buckets = bucketObstacles([wood], 200);
  assert.deepEqual(gatherNearby(buckets, 0, 0, 600), [wood]);
});

test('gatherNearby dedupes obstacles spanning several bins', () => {
  const wide = box(-300, -10, 300, 10); // spans 4 bins of 200 m
  const buckets = bucketObstacles([wide], 200);
  assert.equal(gatherNearby(buckets, 0, 0, 600).length, 1);
  // Stamp-based dedup must also survive repeated gathers.
  assert.equal(gatherNearby(buckets, 50, 0, 600).length, 1);
});

// ---------------------------------------------------------------------------
// Colormap
// ---------------------------------------------------------------------------

test('heatColor endpoints: navy at 0, warm yellow at 1, clamped outside', () => {
  assert.deepEqual(heatColor(0), [12, 16, 64]);
  assert.deepEqual(heatColor(1), [255, 220, 80]);
  assert.deepEqual(heatColor(-3), heatColor(0));
  assert.deepEqual(heatColor(7), heatColor(1));
});

test('heatColor interpolates between stops and brightens monotonically', () => {
  const mid = heatColor(0.5); // between teal (0.35) and green (0.65)
  assert.ok(mid[1] > 110 && mid[1] < 170, `green channel ${mid[1]}`);
  const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const l = luma(heatColor(t));
    assert.ok(l >= prev, `luma not increasing at t=${t}`);
    prev = l;
  }
});

// ---------------------------------------------------------------------------
// Grid math
// ---------------------------------------------------------------------------

test('gridSize: 96 columns, rows follow the aspect ratio, clamped to 96', () => {
  const square = { south: 0, west: 0, north: 0.01, east: 0.01 };
  assert.deepEqual(gridSize(square), { cols: HEATMAP_MAX_CELLS, rows: 96 });
  const wide = { south: 0, west: 0, north: 0.01, east: 0.02 };
  assert.deepEqual(gridSize(wide), { cols: 96, rows: 48 });
  const tall = { south: 0, west: 0, north: 0.05, east: 0.01 };
  assert.deepEqual(gridSize(tall), { cols: 96, rows: 96 }); // clamped
});

test('cellCenter: row 0 is the north edge, centers sit mid-cell', () => {
  const bbox = { south: 0, west: 0, north: 0.01, east: 0.01 };
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  const nw = cellCenter(bbox, 2, 2, 0, 0);
  close(nw.lng, 0.0025);
  close(nw.lat, 0.0075);
  const se = cellCenter(bbox, 2, 2, 1, 1);
  close(se.lng, 0.0075);
  close(se.lat, 0.0025);
});

test('pointInRings: even-odd test against a square', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInRings([ring], 5, 5), true);
  assert.equal(pointInRings([ring], 15, 5), false);
});

test('localObstacle converts rings to meters and tracks the bbox', () => {
  const center = { lng: 0, lat: 0 };
  const item = {
    rings: [[[DEG(-20), DEG(9)], [DEG(20), DEG(9)], [DEG(20), DEG(11)], [DEG(-20), DEG(11)], [DEG(-20), DEG(9)]]],
    height: 10,
  };
  const ob = localObstacle(center, item, M_PER_DEG_LAT);
  assert.equal(ob.edges.length, 4); // closing point dropped
  assert.ok(Math.abs(ob.minX - -20) < 1e-6 && Math.abs(ob.maxX - 20) < 1e-6);
  assert.ok(Math.abs(ob.minY - 9) < 1e-6 && Math.abs(ob.maxY - 11) < 1e-6);
});

// ---------------------------------------------------------------------------
// Hours accumulation against a synthetic wall
// ---------------------------------------------------------------------------

// A 200x200 m bbox at the equator with a long east-west wall across its
// middle: y = 95..105 m, 30 m tall. 2x2 grid → cell centers at y=150 (row 0,
// north) and y=50 (row 1, south), x=50 and x=150.
const BBOX = { south: 0, west: 0, north: DEG(200), east: DEG(200) };
const WALL = {
  rings: [[[DEG(-100), DEG(95)], [DEG(300), DEG(95)], [DEG(300), DEG(105)], [DEG(-100), DEG(105)], [DEG(-100), DEG(95)]]],
  height: 30,
};
const SOUTH_SUN_30 = { sunBearing: Math.PI, altitude: (30 * Math.PI) / 180 };
const NORTH_SUN_60 = { sunBearing: 0, altitude: (60 * Math.PI) / 180 };

function grid(overrides = {}) {
  return computeSunHoursGrid({
    bbox: BBOX,
    date: { y: 2026, m: 5, d: 21 },
    samples: [SOUTH_SUN_30],
    buildings: [WALL],
    trees: [],
    treesEnabled: true,
    cols: 2,
    rows: 2,
    stepMinutes: 20,
    ...overrides,
  });
}

test('computeSunHoursGrid: wall shades north cells from a low southern sun', () => {
  const r = grid();
  assert.equal(r.cols, 2);
  assert.equal(r.rows, 2);
  assert.ok(Math.abs(r.maxHours - 1 / 3) < 1e-9); // 1 sample × 20 min
  // Row 0 (north of the wall): sun ray to the south crosses the wall 45 m
  // away, where 30 m clears 45·tan(30°) ≈ 26 m → blocked.
  assert.equal(r.hours[0], 0);
  assert.equal(r.hours[1], 0);
  // Row 1 (south of the wall): nothing between the cells and the sun.
  assert.ok(Math.abs(r.hours[2] - 1 / 3) < 1e-6);
  assert.ok(Math.abs(r.hours[3] - 1 / 3) < 1e-6);
});

test('computeSunHoursGrid: accumulates across samples and skips night ones', () => {
  const r = grid({
    samples: [
      SOUTH_SUN_30, // lights the south row only
      NORTH_SUN_60, // high northern sun clears the wall: lights everything
      { sunBearing: 0, altitude: -0.1 }, // below horizon: ignored entirely
    ],
  });
  assert.ok(Math.abs(r.maxHours - 2 / 3) < 1e-9);
  assert.ok(Math.abs(r.hours[0] - 1 / 3) < 1e-6); // north row: 1 of 2 samples
  assert.ok(Math.abs(r.hours[2] - 2 / 3) < 1e-6); // south row: both samples
});

test('computeSunHoursGrid: a cell inside a building never gets sun', () => {
  // 50 m square covering only the south-west cell center (50, 50).
  const hut = {
    rings: [[[DEG(25), DEG(25)], [DEG(75), DEG(25)], [DEG(75), DEG(75)], [DEG(25), DEG(75)], [DEG(25), DEG(25)]]],
    height: 5,
  };
  const r = grid({ buildings: [hut], samples: [NORTH_SUN_60] });
  assert.equal(r.hours[2], 0); // inside the hut
  assert.ok(r.hours[0] > 0 && r.hours[1] > 0 && r.hours[3] > 0);
});

test('computeSunHoursGrid: deciduous tree wall only blocks in leaf season', () => {
  const treeWall = { ...WALL, leafCycle: 'deciduous' };
  const june = grid({ buildings: [], trees: [treeWall], date: { y: 2026, m: 5, d: 21 } });
  assert.equal(june.hours[0], 0, 'in leaf: north row shaded');
  const january = grid({ buildings: [], trees: [treeWall], date: { y: 2026, m: 0, d: 21 } });
  assert.ok(january.hours[0] > 0, 'leafless: sun passes through');
  const off = grid({ buildings: [], trees: [treeWall], treesEnabled: false });
  assert.ok(off.hours[0] > 0, 'trees toggled off never block');
});

test('computeSunHoursGrid: obstacles beyond the 600 m cap are ignored', () => {
  // A 1000 m tower 700 m north would geometrically shade the whole bbox from
  // a 60° northern sun, but it sits beyond OBSTACLE_DIST_CAP — the deliberate
  // accuracy/speed tradeoff.
  const tower = {
    rings: [[[DEG(90), DEG(850)], [DEG(110), DEG(850)], [DEG(110), DEG(870)], [DEG(90), DEG(870)], [DEG(90), DEG(850)]]],
    height: 1000,
  };
  const r = grid({ buildings: [tower], samples: [NORTH_SUN_60] });
  for (const h of r.hours) assert.ok(Math.abs(h - 1 / 3) < 1e-6);
});

test('computeSunHoursGrid matches prepareObstacles + isSunBlocked cell by cell', () => {
  // The worker kernel (flat edges, spatial buckets, height/distance culling)
  // must agree exactly with the reference path used by the click report.
  let seed = 42;
  const rand = () => {
    // mulberry32: deterministic across runs
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const items = [];
  for (let i = 0; i < 40; i++) {
    const x = -250 + rand() * 800; // meters; some beyond the 600 m cap
    const y = -250 + rand() * 800;
    const w = 4 + rand() * 30;
    const h = 4 + rand() * 30;
    const height = 3 + rand() * 35;
    items.push({
      rings: [[[DEG(x), DEG(y)], [DEG(x + w), DEG(y)], [DEG(x + w), DEG(y + h)], [DEG(x), DEG(y + h)], [DEG(x), DEG(y)]]],
      height,
      minHeight: rand() < 0.3 ? height * 0.4 : 0, // some elevated canopies
    });
  }
  const samples = [];
  for (let i = 0; i < 12; i++) {
    samples.push({ sunBearing: rand() * 2 * Math.PI, altitude: 0.04 + rand() * 1.2 });
  }
  const bbox = { south: 0, west: 0, north: DEG(300), east: DEG(300) };
  const cols = 5, rows = 5, stepMinutes = 20;
  const r = computeSunHoursGrid({
    bbox, date: { y: 2026, m: 5, d: 21 }, samples,
    buildings: items, trees: [], treesEnabled: true, cols, rows, stepMinutes,
  });
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const point = cellCenter(bbox, cols, rows, col, row);
      const obs = prepareObstacles(point, items, 600);
      let expected = 0;
      for (const s of samples) {
        if (!isSunBlocked(obs, s.sunBearing, s.altitude)) expected += stepMinutes / 60;
      }
      const got = r.hours[row * cols + col];
      assert.ok(Math.abs(got - expected) < 1e-4, `cell ${col},${row}: ${got} != ${expected}`);
    }
  }
});

test('computeSunHoursGrid reports progress in rows and finishes at the end', () => {
  const calls = [];
  computeSunHoursGrid(
    {
      bbox: BBOX,
      date: { y: 2026, m: 5, d: 21 },
      samples: [SOUTH_SUN_30],
      buildings: [WALL],
      trees: [],
      treesEnabled: true,
      cols: 4,
      rows: 10,
      stepMinutes: 20,
    },
    (done, total) => calls.push([done, total])
  );
  assert.deepEqual(calls, [[4, 10], [8, 10], [10, 10]]);
});
