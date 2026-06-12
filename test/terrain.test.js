import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TerrainGrid,
  decodeTerrarium,
  lonLatToTile,
  tileXToLon,
  tileYToLat,
  EFFECTIVE_EARTH_RADIUS_M,
} from '../src/terrain.js';

// Inverse of the terrarium encoding: elevation -> [R, G, B]. Exact for
// elevations quantized to 1/256 m, which is all the format can store.
function encodeTerrarium(elev) {
  const v = elev + 32768;
  const whole = Math.floor(v);
  return [whole >> 8, whole & 0xff, Math.round((v - whole) * 256)];
}

// Build a TerrainGrid from an elevation function of (lng, lat).
function makeGrid({ west, north, lonStep, latStep, cols, rows, rowLats = null, elev }) {
  const data = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const lat = rowLats ? rowLats[r] : north - r * latStep;
    for (let c = 0; c < cols; c++) {
      data[r * cols + c] = elev(west + c * lonStep, lat);
    }
  }
  return new TerrainGrid({ data, cols, rows, west, north, lonStep, latStep, rowLats });
}

test('decodeTerrarium round-trips known elevations through RGB', () => {
  const elevations = [0, 1500.25, -32, 8848.5]; // incl. Death Valley & Everest-ish
  const rgba = new Uint8ClampedArray(elevations.length * 4);
  elevations.forEach((e, i) => {
    const [r, g, b] = encodeTerrarium(e);
    rgba.set([r, g, b, 255], i * 4);
  });
  // Spot-check the documented encoding: 0 m is exactly R=128, G=0, B=0.
  assert.deepEqual(encodeTerrarium(0), [128, 0, 0]);

  const decoded = decodeTerrarium(rgba, elevations.length, 1);
  assert.equal(decoded.length, elevations.length);
  elevations.forEach((e, i) => {
    assert.ok(Math.abs(decoded[i] - e) < 1e-4, `elevation ${e} -> ${decoded[i]}`);
  });
});

test('lonLatToTile: Chamonix lands on the right z11 tile', () => {
  assert.deepEqual(lonLatToTile(6.8694, 45.9237, 11), { x: 1063, y: 729 });
  assert.deepEqual(lonLatToTile(0, 0, 11), { x: 1024, y: 1024 });

  // The inverse functions bracket the input coordinate (tile y grows south).
  assert.ok(tileXToLon(1063, 11) <= 6.8694 && 6.8694 < tileXToLon(1064, 11));
  assert.ok(tileYToLat(730, 11) <= 45.9237 && 45.9237 <= tileYToLat(729, 11));
});

test('elevationAt: bilinear interpolation on a uniform 2x2 grid', () => {
  // Corners: NW=0, NE=10, SW=20, SE=30 over a 1-degree cell.
  const vals = { '0,1': 0, '1,1': 10, '0,0': 20, '1,0': 30 };
  const grid = makeGrid({
    west: 0, north: 1, lonStep: 1, latStep: 1, cols: 2, rows: 2,
    elev: (lng, lat) => vals[`${lng},${lat}`],
  });
  assert.equal(grid.elevationAt(0, 1), 0); // exact corners
  assert.equal(grid.elevationAt(1, 0), 30);
  assert.equal(grid.elevationAt(0.5, 0.5), 15); // dead center
  assert.equal(grid.elevationAt(0.25, 1), 2.5); // along the north edge
  assert.equal(grid.elevationAt(-0.1, 0.5), null); // outside coverage
  assert.equal(grid.elevationAt(0.5, 1.5), null);
  assert.deepEqual(grid.center, { lng: 0.5, lat: 0.5 });
});

test('elevationAt: per-row latitude table and no-data cells', () => {
  // Non-uniform row spacing (the mercator case): rows at lat 2, 1, 0.5.
  const grid = makeGrid({
    west: 0, north: 2, lonStep: 1, latStep: 0.75, cols: 2, rows: 3,
    rowLats: [2, 1, 0.5],
    elev: (lng, lat) => (lat === 2 ? 0 : lat === 1 ? 10 : 20),
  });
  assert.equal(grid.elevationAt(0.5, 1.5), 5); // midway rows 0-1
  assert.equal(grid.elevationAt(0.5, 0.75), 15); // midway rows 1-2 (lat 0.75!)
  assert.equal(grid.elevationAt(0.5, 2.1), null); // north of the table
  assert.equal(grid.elevationAt(0.5, 0.4), null); // south of it

  grid.data[0] = NaN; // failed-tile no-data must poison lookups touching it
  assert.equal(grid.elevationAt(0.5, 1.5), null);
  assert.equal(grid.elevationAt(0.5, 0.75), 15); // unaffected rows still work
});

// Equatorial test grid: flat sea level with a 500 m north-south ridge whose
// crest band sits ~2 km east of the origin (lon 0.016..0.020 deg ~ 1.78-2.23 km).
function ridgeGrid() {
  return makeGrid({
    west: -0.05, north: 0.05, lonStep: 0.001, latStep: 0.001, cols: 101, rows: 101,
    elev: (lng) => (Math.abs(lng - 0.018) <= 0.002 ? 500 : 0),
  });
}

test('sunBlockedByTerrain: a 500 m ridge 2 km east blocks low eastern sun only', () => {
  const grid = ridgeGrid();
  const eye = grid.elevationAt(0, 0) + 1.5;
  assert.equal(eye, 1.5);
  const east = Math.PI / 2;
  const west = (3 * Math.PI) / 2;
  const deg = (d) => (d * Math.PI) / 180;

  assert.equal(grid.sunBlockedByTerrain(0, 0, eye, east, deg(5)), true); // ray ~176 m at crest
  assert.equal(grid.sunBlockedByTerrain(0, 0, eye, east, deg(45)), false); // ray ~2 km up there
  assert.equal(grid.sunBlockedByTerrain(0, 0, eye, west, deg(5)), false); // open sea westward
  assert.equal(grid.sunBlockedByTerrain(0, 0, eye, west, -0.01), true); // below horizon
});

test('sunBlockedByTerrain: earth curvature decides a borderline far hill', () => {
  // A flat-topped hill 19.5-21 km east of the origin, sun due east at 0.4 deg.
  // Hand-computed sun-ray height at d = 20 km with our formula
  // (eye 1.5 m, effective R = 6371 km * 1.17):
  //   flat earth: 1.5 + 20000 * tan(0.4 deg)            ~ 141.1 m
  //   curvature drop: 20000^2 / (2 * 7.454e6)           ~  26.8 m
  //   with curvature: ~ 114.3 m
  // So a 100 m hill clears the ray either way (NOT blocked), while a 130 m
  // hill is cleared by the flat-earth ray but BLOCKS the curved one —
  // curvature alone flips that verdict.
  const alt = (0.4 * Math.PI) / 180;
  const eye = 1.5;
  const d = 20000;
  const flatRay = eye + d * Math.tan(alt);
  const curvedRay = flatRay - (d * d) / (2 * EFFECTIVE_EARTH_RADIUS_M);
  assert.ok(flatRay > 130, `flat ray ${flatRay.toFixed(1)} m clears 130 m`);
  assert.ok(curvedRay > 100 && curvedRay < 130, `curved ray ${curvedRay.toFixed(1)} m`);

  const hillGrid = (h) =>
    makeGrid({
      west: -0.01, north: 0.001, lonStep: 0.001, latStep: 0.001, cols: 250, rows: 3,
      // 0.1752..0.1886 deg east at the equator = 19.5..21.0 km.
      elev: (lng) => (lng >= 0.1752 && lng <= 0.1886 ? h : 0),
    });
  const east = Math.PI / 2;
  assert.equal(hillGrid(100).sunBlockedByTerrain(0, 0, eye, east, alt), false);
  assert.equal(hillGrid(130).sunBlockedByTerrain(0, 0, eye, east, alt), true);
});

test('sunBlockedByTerrain: marching off the grid never blocks', () => {
  // Tiny grid (covers ~ +-111 m): the ray leaves coverage after ~100 m; null
  // samples beyond must be treated as not blocking even at grazing altitude.
  const flat = makeGrid({
    west: -0.001, north: 0.001, lonStep: 0.001, latStep: 0.001, cols: 3, rows: 3,
    elev: () => 0,
  });
  assert.equal(flat.sunBlockedByTerrain(0, 0, 1.5, Math.PI / 2, 0.001), false);

  // Sanity: with a 50 m rise on the east column of the same tiny grid the
  // grazing ray (1.5 m + ~0.1 m over 100 m) is blocked before leaving it.
  const mound = makeGrid({
    west: -0.001, north: 0.001, lonStep: 0.001, latStep: 0.001, cols: 3, rows: 3,
    elev: (lng) => (lng > 0.0005 ? 50 : 0),
  });
  assert.equal(mound.sunBlockedByTerrain(0, 0, 1.5, Math.PI / 2, 0.001), true);
});
