import test from 'node:test';
import assert from 'node:assert/strict';

import { leafCycleFromTags, leafActive, lineToStrip, TREE_DEFAULTS } from '../src/trees.js';
import { M_PER_DEG_LAT } from '../src/geometry.js';

test('leafCycleFromTags maps OSM tags to deciduous/evergreen', () => {
  assert.equal(leafCycleFromTags({ leaf_cycle: 'deciduous' }), 'deciduous');
  assert.equal(leafCycleFromTags({ leaf_cycle: 'semi_deciduous' }), 'deciduous');
  assert.equal(leafCycleFromTags({ leaf_cycle: 'evergreen' }), 'evergreen');
  assert.equal(leafCycleFromTags({ leaf_type: 'needleleaved' }), 'evergreen');
  assert.equal(leafCycleFromTags({ leaf_type: 'broadleaved' }), 'deciduous');
  assert.equal(leafCycleFromTags({}), 'deciduous');
  assert.equal(leafCycleFromTags({}, 'evergreen'), 'evergreen');
});

test('leafActive: deciduous trees are bare in winter, by hemisphere', () => {
  assert.equal(leafActive('deciduous', 6, 45), true); // July, north
  assert.equal(leafActive('deciduous', 0, 45), false); // January, north
  assert.equal(leafActive('deciduous', 0, -34), true); // January, south
  assert.equal(leafActive('deciduous', 6, -34), false); // July, south
  assert.equal(leafActive('evergreen', 0, 45), true); // pines don't care
});

test('lineToStrip buffers a straight line into a closed rectangle', () => {
  const len = 20 / M_PER_DEG_LAT; // 20 m of northing
  const ring = lineToStrip([[0, 0], [0, len]], 3);
  assert.equal(ring.length, 5); // 4 corners + closing point
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  // Corners sit 3 m east/west of the line.
  const lonsM = ring.slice(0, 4).map((p) => Math.abs(p[0]) * M_PER_DEG_LAT);
  for (const x of lonsM) assert.ok(Math.abs(x - 3) < 1e-6, `offset ${x}`);
});

test('lineToStrip rejects degenerate input', () => {
  assert.equal(lineToStrip([[0, 0]], 3), null);
});

test('TREE_DEFAULTS keeps canopies above eye level', () => {
  const base = TREE_DEFAULTS.treeHeight * TREE_DEFAULTS.crownBaseFraction;
  assert.ok(base > 2, 'default crown base should clear a person');
});
