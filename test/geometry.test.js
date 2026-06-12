import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  M_PER_DEG_LAT,
  mPerDegLon,
  sunDirections,
  sunShadowParams,
  shadowPolygons,
  prepareObstacles,
  isSunBlocked,
  litWindows,
} from '../src/geometry.js';
import { parseLength, heightFromTags } from '../src/buildings.js';

const require = createRequire(import.meta.url);
const SunCalc = require('../vendor/suncalc.js');

const D = 10 / M_PER_DEG_LAT; // ~10 m in degrees at the equator

// Square footprint 10x10 m at the equator, counterclockwise.
function square() {
  return [[[0, 0], [D, 0], [D, D], [0, D], [0, 0]]];
}

test('sunDirections: sun due south means shadow points north', () => {
  const { sunBearing, shadowBearing } = sunDirections(0);
  assert.ok(Math.abs(sunBearing - Math.PI) < 1e-9);
  assert.ok(Math.abs(shadowBearing) < 1e-9);
});

test('sunShadowParams: 45 degree sun casts shadow equal to height', () => {
  const p = sunShadowParams(Math.PI / 4, 0);
  assert.ok(Math.abs(p.perMeter - 1) < 1e-9);
  assert.ok(Math.abs(p.ux) < 1e-9);
  assert.ok(Math.abs(p.uy - 1) < 1e-9);
});

test('sunShadowParams: below horizon yields null, near horizon is clamped', () => {
  assert.equal(sunShadowParams(0, 0), null);
  assert.equal(sunShadowParams(-0.1, 0), null);
  assert.equal(sunShadowParams(0.001, 0).perMeter, 60);
});

test('shadowPolygons: sun-facing north edge sweeps one strip', () => {
  const params = sunShadowParams(Math.PI / 4, 0); // shadow straight north, 1:1
  const polys = shadowPolygons(square(), 10, params);
  assert.equal(polys.length, 2); // footprint + single strip

  const strip = polys[1][0];
  const lats = strip.map((p) => p[1]);
  // Strip spans from the north edge (~10 m) to ~20 m north.
  assert.ok(Math.abs(Math.min(...lats) - D) < 1e-9);
  assert.ok(Math.abs(Math.max(...lats) - 2 * D) < 1e-7);
});

test('shadowPolygons: diagonal sun merges adjacent facing edges into one strip', () => {
  const params = sunShadowParams(Math.PI / 4, Math.PI / 4); // shadow to the northeast
  const polys = shadowPolygons(square(), 10, params);
  assert.equal(polys.length, 2); // east+north edges form one contiguous run
  const strip = polys[1][0];
  assert.equal(strip.length, 7); // 3 base vertices + 3 swept + closing point
});

test('shadowPolygons: concave footprint does not crash and emits strips', () => {
  const lShape = [
    [[0, 0], [3 * D, 0], [3 * D, D], [D, D], [D, 3 * D], [0, 3 * D], [0, 0]],
  ];
  const params = sunShadowParams(Math.PI / 6, Math.PI / 3);
  const polys = shadowPolygons(lShape, 12, params);
  assert.ok(polys.length >= 2);
  for (const poly of polys) {
    for (const ring of poly) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      assert.deepEqual(first, last, 'rings must be closed');
    }
  }
});

test('shadowPolygons: elevated canopy shadow starts away from the footprint', () => {
  const params = sunShadowParams(Math.PI / 4, 0); // shadow straight north, 1:1
  // Crown slab from 5 m to 10 m: shadow spans 5 m..10 m north of each point.
  const polys = shadowPolygons(square(), 10, params, 5);
  assert.equal(polys.length, 2);
  const allLats = polys.flatMap((poly) => poly.flatMap((ring) => ring.map((p) => p[1])));
  assert.ok(Math.abs(Math.min(...allLats) - D / 2) < 1e-9, 'base shifted 5 m north');
  assert.ok(Math.abs(Math.max(...allLats) - 2 * D) < 1e-7, 'tip lands 20 m north');
});

// A 40 m wide, 2 m deep, 10 m tall wall whose center is 10 m north of origin.
function wall(height = 10) {
  const m = (x) => x / M_PER_DEG_LAT;
  return {
    rings: [
      [[m(-20), m(9)], [m(20), m(9)], [m(20), m(11)], [m(-20), m(11)], [m(-20), m(9)]],
    ],
    height,
  };
}

test('isSunBlocked: wall blocks low sun but not high sun', () => {
  const obstacles = prepareObstacles({ lng: 0, lat: 0 }, [wall()]);
  assert.equal(obstacles.length, 1);
  const north = 0;
  assert.equal(isSunBlocked(obstacles, north, (30 * Math.PI) / 180), true); // needs 5.8 m
  assert.equal(isSunBlocked(obstacles, north, (50 * Math.PI) / 180), false); // needs 11.9 m
});

test('isSunBlocked: sun on the far side of the sky is unobstructed', () => {
  const obstacles = prepareObstacles({ lng: 0, lat: 0 }, [wall()]);
  assert.equal(isSunBlocked(obstacles, Math.PI, (10 * Math.PI) / 180), false);
});

test('isSunBlocked: below the horizon counts as blocked', () => {
  assert.equal(isSunBlocked([], 0, -0.01), true);
});

test('isSunBlocked: a point inside a building never gets direct sun', () => {
  const inside = prepareObstacles({ lng: D / 2, lat: D / 2 }, [
    { rings: square(), height: 10 },
  ]);
  assert.equal(isSunBlocked(inside, 0, Math.PI / 3), true);
});

test('isSunBlocked: sun passes under an elevated canopy', () => {
  // Same wall but only its 8 m..10 m slab is solid (a raised crown).
  const crown = { ...wall(10), minHeight: 8 };
  const obstacles = prepareObstacles({ lng: 0, lat: 0 }, [crown]);
  // At 30 degrees the sun line is at 5.2..6.4 m crossing the slab: under it.
  assert.equal(isSunBlocked(obstacles, 0, (30 * Math.PI) / 180), false);
  // At 40 degrees it is at 7.6..9.2 m: intersects the 8..10 m slab.
  assert.equal(isSunBlocked(obstacles, 0, (40 * Math.PI) / 180), true);
});

test('isSunBlocked: under a canopy, high sun is blocked but low sun slips beneath', () => {
  // 10 m half-width crown centered on the viewpoint, slab 4..10 m.
  const m = (x) => x / M_PER_DEG_LAT;
  const crown = {
    rings: [
      [[m(-10), m(-10)], [m(10), m(-10)], [m(10), m(10)], [m(-10), m(10)], [m(-10), m(-10)]],
    ],
    height: 10,
    minHeight: 4,
  };
  const obstacles = prepareObstacles({ lng: 0, lat: 0 }, [crown]);
  assert.equal(obstacles[0].inside, true);
  assert.equal(isSunBlocked(obstacles, 0, (60 * Math.PI) / 180), true); // overhead crown
  assert.equal(isSunBlocked(obstacles, 0, (15 * Math.PI) / 180), false); // under the crown edge
});

test('prepareObstacles: far-away buildings are dropped', () => {
  const far = {
    rings: [[[0.05, 0.05], [0.051, 0.05], [0.051, 0.051], [0.05, 0.051], [0.05, 0.05]]],
    height: 100,
  }; // ~7.8 km away
  const obstacles = prepareObstacles({ lng: 0, lat: 0 }, [far]);
  assert.equal(obstacles.length, 0);
});

test('litWindows merges contiguous samples and splits on gaps', () => {
  const samples = [
    { minutes: 420, lit: true },
    { minutes: 430, lit: true },
    { minutes: 440, lit: false },
    { minutes: 450, lit: true },
  ];
  assert.deepEqual(litWindows(samples, 10), [
    { start: 420, end: 440 },
    { start: 450, end: 460 },
  ]);
});

test('SunCalc convention check: noon UTC in London on the June solstice', () => {
  // Solar noon in London is ~12:02 UTC, sun almost due south and ~62 degrees up.
  const date = new Date(Date.UTC(2026, 5, 21, 12, 2));
  const pos = SunCalc.getPosition(date, 51.5, 0);
  const altDeg = (pos.altitude * 180) / Math.PI;
  assert.ok(altDeg > 59 && altDeg < 65, `altitude ${altDeg}`);
  const { shadowBearing } = sunDirections(pos.azimuth);
  // Shadow should point roughly north.
  assert.ok(Math.cos(shadowBearing) > 0.95, `shadow bearing ${shadowBearing}`);
});

test('parseLength handles meters, feet and feet-inches', () => {
  assert.equal(parseLength('12'), 12);
  assert.equal(parseLength('12.5 m'), 12.5);
  assert.ok(Math.abs(parseLength('40 ft') - 12.192) < 1e-9);
  assert.ok(Math.abs(parseLength(`30'6"`) - 9.2964) < 1e-9);
  assert.equal(parseLength('tall'), null);
});

test('heightFromTags prefers explicit height, then levels, then default', () => {
  assert.deepEqual(heightFromTags({ height: '25 m' }), { height: 25, source: 'measured' });
  const levels = heightFromTags({ 'building:levels': '3' });
  assert.ok(Math.abs(levels.height - 9.6) < 1e-9);
  assert.equal(levels.source, 'levels');
  assert.deepEqual(heightFromTags({}), { height: 8, source: 'default' });
});

test('mPerDegLon shrinks with latitude', () => {
  assert.ok(Math.abs(mPerDegLon(0) - M_PER_DEG_LAT) < 1e-9);
  assert.ok(mPerDegLon(60) < M_PER_DEG_LAT * 0.51);
});
