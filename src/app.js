import {
  sunDirections,
  sunShadowParams,
  shadowPolygons,
  prepareObstacles,
  isSunBlocked,
  litWindows,
  mPerDegLon,
  M_PER_DEG_LAT,
} from './geometry.js';
import { fetchBuildings } from './buildings.js';
import { fetchTrees, leafActive } from './trees.js';
import { loadTerrainAround, TERRAIN_RESOLUTION_M } from './terrain.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const DEFAULT_CENTER = [-73.5674, 45.5019]; // Montreal; geolocate to move
const DEFAULT_ZOOM = 15.5;
const MIN_FETCH_ZOOM = 14.5;
const MAX_FETCH_AREA_KM2 = 8;
const MAX_BUILDINGS = 25000;
const DAY_STEP_MIN = 10; // sampling step for the daily sun report
const MONTH_STEP_MIN = 15; // sampling step for the monthly chart

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const now = new Date();
const state = {
  date: { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() },
  minutes: now.getHours() * 60 + Math.round(now.getMinutes() / 5) * 5,
  buildings: new Map(), // id -> {id, rings, height, minHeight, heightSource}
  trees: new Map(), // id -> {id, rings, height, minHeight, leafCycle, kind}
  treesEnabled: true,
  viewpointHeight: 0, // meters above ground for sun reports (0 = ground)
  terrain: null, // TerrainGrid (src/terrain.js), loaded lazily on first report
  terrainEnabled: true,
  terrainLoading: false,
  coveredBboxes: [],
  reportPoint: null,
  reportMarker: null,
  playing: false,
  fetchController: null,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: BASEMAP_STYLE,
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  hash: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(
  new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }),
  'bottom-right'
);

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

map.on('load', () => {
  // Keep place labels above our overlays.
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  map.addSource('tree-shadows', { type: 'geojson', data: EMPTY_FC });
  map.addLayer(
    {
      id: 'tree-shadows',
      type: 'fill',
      source: 'tree-shadows',
      paint: { 'fill-color': '#06300f', 'fill-opacity': 0.28, 'fill-antialias': false },
    },
    firstSymbol
  );

  map.addSource('shadows', { type: 'geojson', data: EMPTY_FC });
  map.addLayer(
    {
      id: 'shadows',
      type: 'fill',
      source: 'shadows',
      paint: { 'fill-color': '#001033', 'fill-opacity': 0.32, 'fill-antialias': false },
    },
    firstSymbol
  );

  map.addSource('trees', { type: 'geojson', data: EMPTY_FC });
  map.addLayer(
    {
      id: 'trees-fill',
      type: 'fill',
      source: 'trees',
      paint: { 'fill-color': '#5a9c4e', 'fill-opacity': 0.3 },
    },
    firstSymbol
  );
  map.addLayer({
    id: 'trees-3d',
    type: 'fill-extrusion',
    source: 'trees',
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': '#5a9c4e',
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-base': ['get', 'minHeight'],
      'fill-extrusion-opacity': 0.7,
    },
  });

  map.addSource('buildings', { type: 'geojson', data: EMPTY_FC });
  map.addLayer(
    {
      id: 'buildings-fill',
      type: 'fill',
      source: 'buildings',
      paint: { 'fill-color': '#c9b896', 'fill-opacity': 0.25 },
    },
    firstSymbol
  );
  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: 'buildings',
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': '#d9d0c1',
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-opacity': 0.85,
    },
  });

  updateSun();
  loadBuildingsInView();
});

map.on('moveend', () => {
  scheduleSunUpdate(); // sunrise/sunset and sun angles depend on map center
  debouncedLoad();
});
const debouncedLoad = debounce(loadBuildingsInView, 600);
map.on('click', (e) => runReport({ lng: e.lngLat.lng, lat: e.lngLat.lat }));

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function currentTime() {
  return new Date(state.date.y, state.date.m, state.date.d, 0, state.minutes);
}

function fmtMinutes(min) {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtClock(date) {
  return date && !isNaN(date)
    ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : '—';
}

function minutesOf(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

// ---------------------------------------------------------------------------
// Sun + shadows
// ---------------------------------------------------------------------------

let shadowFrame = null;
function scheduleSunUpdate() {
  if (shadowFrame) return;
  shadowFrame = requestAnimationFrame(() => {
    shadowFrame = null;
    updateSun();
  });
}

function updateSun() {
  if (!map.getSource('shadows')) return;
  const c = map.getCenter();
  const t = currentTime();
  const pos = SunCalc.getPosition(t, c.lat, c.lng);
  const dirs = sunDirections(pos.azimuth);
  const altDeg = (pos.altitude * 180) / Math.PI;
  const azDeg = (dirs.sunBearing * 180) / Math.PI;

  $('sun-alt').textContent = `${altDeg.toFixed(1)}°`;
  $('sun-az').textContent = `${azDeg.toFixed(0)}°`;
  $('sun-arrow').style.transform = `rotate(${azDeg}deg)`;
  $('time-label').textContent = fmtMinutes(state.minutes);

  const times = SunCalc.getTimes(new Date(state.date.y, state.date.m, state.date.d, 12), c.lat, c.lng);
  $('sunrise').textContent = fmtClock(times.sunrise);
  $('sunset').textContent = fmtClock(times.sunset);
  paintSliderTrack(times);

  const night = pos.altitude <= 0;
  $('night-overlay').classList.toggle('visible', night);

  const params = night ? null : sunShadowParams(pos.altitude, dirs.shadowBearing);
  if (!params) {
    map.getSource('shadows').setData(EMPTY_FC);
    map.getSource('tree-shadows').setData(EMPTY_FC);
    return;
  }

  const shadowFC = (obstacles) => ({
    type: 'FeatureCollection',
    features: obstacles.map((o) => ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: shadowPolygons(o.rings, o.height, params, o.minHeight),
      },
    })),
  });

  map.getSource('shadows').setData(shadowFC([...state.buildings.values()]));
  map.getSource('tree-shadows').setData(shadowFC(activeTrees(state.date.m, c.lat)));
}

// Trees currently in leaf (deciduous ones drop out of the shadow simulation
// in the leafless season), or none if tree shading is toggled off.
function activeTrees(month, lat) {
  if (!state.treesEnabled) return [];
  return [...state.trees.values()].filter((t) => leafActive(t.leafCycle, month, lat));
}

function paintSliderTrack(times) {
  const slider = $('time');
  const rise = times.sunrise && !isNaN(times.sunrise) ? (minutesOf(times.sunrise) / 1440) * 100 : 0;
  const set = times.sunset && !isNaN(times.sunset) ? (minutesOf(times.sunset) / 1440) * 100 : 100;
  const night = '#27304f';
  const day = '#ffd166';
  slider.style.background = `linear-gradient(to right, ${night} 0%, ${night} ${rise}%, ${day} ${Math.min(rise + 2, 100)}%, ${day} ${Math.max(set - 2, 0)}%, ${night} ${set}%, ${night} 100%)`;
}

// ---------------------------------------------------------------------------
// Building loading
// ---------------------------------------------------------------------------

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function viewBbox(padFraction = 0.2) {
  const b = map.getBounds();
  const padLat = (b.getNorth() - b.getSouth()) * padFraction;
  const padLon = (b.getEast() - b.getWest()) * padFraction;
  return {
    south: b.getSouth() - padLat,
    west: b.getWest() - padLon,
    north: b.getNorth() + padLat,
    east: b.getEast() + padLon,
  };
}

function bboxAreaKm2(b) {
  const latMid = (b.north + b.south) / 2;
  const h = (b.north - b.south) * 111.32;
  const w = (b.east - b.west) * 111.32 * Math.cos((latMid * Math.PI) / 180);
  return h * w;
}

function bboxContains(outer, inner) {
  return (
    inner.south >= outer.south &&
    inner.north <= outer.north &&
    inner.west >= outer.west &&
    inner.east <= outer.east
  );
}

async function loadBuildingsInView() {
  if (map.getZoom() < MIN_FETCH_ZOOM) {
    setStatus(`Zoom in to load buildings (zoom ≥ ${MIN_FETCH_ZOOM})`, 'hint');
    return;
  }
  const bbox = viewBbox();
  if (bboxAreaKm2(bbox) > MAX_FETCH_AREA_KM2) {
    setStatus('View too large — zoom in to load buildings', 'hint');
    return;
  }
  const visible = viewBbox(0);
  if (state.coveredBboxes.some((c) => bboxContains(c, visible))) return;

  state.fetchController?.abort();
  const controller = new AbortController();
  state.fetchController = controller;
  setStatus('Loading buildings & trees from OpenStreetMap…', 'busy');
  try {
    const [fetchedBuildings, fetchedTrees] = await Promise.all([
      fetchBuildings(bbox, { signal: controller.signal }),
      fetchTrees(bbox, { signal: controller.signal }),
    ]);
    if (state.buildings.size > MAX_BUILDINGS) {
      state.buildings.clear();
      state.trees.clear();
      state.coveredBboxes = [];
    }
    for (const b of fetchedBuildings) state.buildings.set(b.id, b);
    for (const t of fetchedTrees) state.trees.set(t.id, t);
    state.coveredBboxes.push(bbox);
    refreshBuildingsSource();
    refreshTreesSource();
    updateSun();
    if (state.reportPoint) runReport(state.reportPoint);
    const measured = [...state.buildings.values()].filter(
      (b) => b.heightSource !== 'default'
    ).length;
    const pct = state.buildings.size
      ? Math.round((measured / state.buildings.size) * 100)
      : 0;
    setStatus(
      `${state.buildings.size.toLocaleString()} buildings (${pct}% with height data) · ${state.trees.size.toLocaleString()} trees`,
      'ok'
    );
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setStatus('Failed to load OpenStreetMap data — try again shortly', 'error');
  }
}

function refreshBuildingsSource() {
  const features = [];
  for (const b of state.buildings.values()) {
    features.push({
      type: 'Feature',
      properties: { height: b.height, heightSource: b.heightSource },
      geometry: { type: 'Polygon', coordinates: b.rings.map(closeRing) },
    });
  }
  map.getSource('buildings')?.setData({ type: 'FeatureCollection', features });
}

function refreshTreesSource() {
  const features = [];
  for (const t of state.trees.values()) {
    features.push({
      type: 'Feature',
      properties: { height: t.height, minHeight: t.minHeight, kind: t.kind },
      geometry: { type: 'Polygon', coordinates: t.rings.map(closeRing) },
    });
  }
  map.getSource('trees')?.setData({ type: 'FeatureCollection', features });
}

function closeRing(ring) {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
}

function setStatus(text, kind = 'ok') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

// ---------------------------------------------------------------------------
// Sun report (click a point)
// ---------------------------------------------------------------------------

// Terrain occlusion: lazily fetch the elevation grid around the map center
// the first time it's needed (first report, or terrain toggled back on with a
// report open). Cached; reloaded only when a report point strays more than
// 15 km from the cached grid's center. Re-runs the open report once loaded.
const TERRAIN_RELOAD_DIST_M = 15000;

async function ensureTerrain(point) {
  if (!state.terrainEnabled || state.terrainLoading) return;
  if (state.terrain) {
    const c = state.terrain.center;
    const dist = Math.hypot(
      (point.lng - c.lng) * mPerDegLon(point.lat),
      (point.lat - c.lat) * M_PER_DEG_LAT
    );
    if (dist <= TERRAIN_RELOAD_DIST_M) return;
  }
  state.terrainLoading = true;
  setStatus('Loading terrain elevation tiles…', 'busy');
  try {
    state.terrain = await loadTerrainAround(map.getCenter());
    setStatus('Terrain elevation loaded', 'ok');
    if (state.reportPoint) runReport(state.reportPoint); // refine open report
  } catch (err) {
    console.error(err);
    setStatus('Terrain failed to load — reports ignore hills for now', 'error');
  } finally {
    state.terrainLoading = false;
  }
}

function computeDay(y, m, d, point, buildingObs, treeObs, step, observerHeight = 0, terrain = null) {
  // Deciduous trees only obstruct in their leaf-on season for this month.
  const activeTreeObs = treeObs.filter((o) => leafActive(o.leafCycle, m, point.lat));
  // Terrain check: building/tree heights are relative to local ground, so
  // those tests stay as-is — terrain only adds a far-field horizon test from
  // the eye's absolute elevation (ground + 1.5 m + any balcony/floor offset).
  // terrain is non-null only when enabled, loaded and covering the point.
  const eyeElevation = terrain
    ? terrain.elevationAt(point.lng, point.lat) + 1.5 + observerHeight
    : 0;
  const samples = [];
  let possible = 0;
  let lit = 0;
  let treeFiltered = 0;
  for (let t = 0; t < 1440; t += step) {
    const dt = new Date(y, m, d, 0, t);
    const pos = SunCalc.getPosition(dt, point.lat, point.lng);
    if (pos.altitude <= 0) continue;
    possible += step;
    const dirs = sunDirections(pos.azimuth);
    // Terrain first: if a hill hides the sun, the sample is fully blocked.
    if (
      terrain &&
      terrain.sunBlockedByTerrain(point.lng, point.lat, eyeElevation, dirs.sunBearing, pos.altitude)
    ) {
      samples.push({ minutes: t, lit: false });
    } else if (isSunBlocked(buildingObs, dirs.sunBearing, pos.altitude, observerHeight)) {
      samples.push({ minutes: t, lit: false });
    } else if (isSunBlocked(activeTreeObs, dirs.sunBearing, pos.altitude, observerHeight)) {
      treeFiltered += step;
      samples.push({ minutes: t, lit: false });
    } else {
      lit += step;
      samples.push({ minutes: t, lit: true });
    }
  }
  return { samples, possible, lit, treeFiltered, windows: litWindows(samples, step) };
}

function runReport(point) {
  state.reportPoint = point;
  if (!state.reportMarker) {
    state.reportMarker = new maplibregl.Marker({ color: '#e8590c' })
      .setLngLat(point)
      .addTo(map);
  } else {
    state.reportMarker.setLngLat(point);
  }

  const panel = $('report');
  panel.classList.add('visible');
  $('report-body').innerHTML = '<p class="muted">Computing sun exposure…</p>';

  // Terrain loads async; ensureTerrain re-runs this report when it lands.
  ensureTerrain(point);

  // Let the panel paint before the (sync) number crunching.
  setTimeout(() => {
    const buildingObs = prepareObstacles(point, [...state.buildings.values()]);
    const treeObs = state.treesEnabled
      ? prepareObstacles(point, [...state.trees.values()])
      : [];
    // Terrain participates only when enabled, loaded and covering the point.
    const terrain =
      state.terrainEnabled &&
      state.terrain &&
      state.terrain.elevationAt(point.lng, point.lat) != null
        ? state.terrain
        : null;
    const { y, m, d } = state.date;
    const vh = state.viewpointHeight;
    const day = computeDay(y, m, d, point, buildingObs, treeObs, DAY_STEP_MIN, vh, terrain);

    const months = [];
    for (let mm = 0; mm < 12; mm++) {
      const r = computeDay(y, mm, 21, point, buildingObs, treeObs, MONTH_STEP_MIN, vh, terrain);
      months.push({ month: mm, lit: r.lit, treeFiltered: r.treeFiltered, possible: r.possible });
    }
    renderReport(point, day, months, buildingObs.length, treeObs.length, !!terrain);
  }, 30);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hoursStr(min) {
  return `${(min / 60).toFixed(1)} h`;
}

// Viewpoint height options: ground plus floors 1-10 at 3 m per floor + 1 m
// standing eye / balcony-rail height.
function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

function viewpointOptions() {
  const opts = [{ h: 0, label: 'Ground (0 m)' }];
  for (let n = 1; n <= 10; n++) {
    const h = n * 3 + 1;
    opts.push({ h, label: `${ordinal(n)} floor (~${h} m)` });
  }
  return opts
    .map(
      (o) =>
        `<option value="${o.h}"${o.h === state.viewpointHeight ? ' selected' : ''}>${o.label}</option>`
    )
    .join('');
}

function renderReport(point, day, months, buildingCount, treeCount, terrainUsed) {
  const dateStr = currentTime().toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const windows = day.windows.length
    ? day.windows.map((w) => `${fmtMinutes(w.start)}–${fmtMinutes(w.end)}`).join(', ')
    : 'No direct sun';
  const maxPossible = Math.max(...months.map((mo) => mo.possible), 1);

  const bars = months
    .map((mo) => {
      const litH = ((mo.lit / maxPossible) * 100).toFixed(1);
      const treeH = (((mo.lit + mo.treeFiltered) / maxPossible) * 100).toFixed(1);
      const possH = ((mo.possible / maxPossible) * 100).toFixed(1);
      const cur = mo.month === state.date.m ? ' current' : '';
      const title = `${MONTH_NAMES[mo.month]} 21: ${hoursStr(mo.lit)} direct sun + ${hoursStr(mo.treeFiltered)} under trees, of ${hoursStr(mo.possible)} daylight`;
      return `<div class="bar-col${cur}" title="${title}">
        <div class="bar-stack">
          <div class="bar possible" style="height:${possH}%"></div>
          <div class="bar tree" style="height:${treeH}%"></div>
          <div class="bar lit" style="height:${litH}%"></div>
        </div>
        <div class="bar-value">${(mo.lit / 60).toFixed(1)}</div>
        <div class="bar-label">${MONTH_NAMES[mo.month][0]}</div>
      </div>`;
    })
    .join('');

  const treeLine = day.treeFiltered
    ? `<div class="report-tree">🌳 + ${hoursStr(day.treeFiltered)} more shaded only by trees</div>`
    : '';

  const vh = state.viewpointHeight;
  const viewpointNote = vh
    ? ` Viewpoint elevated to ${vh} m; the building you clicked on is excluded as an
    obstacle; walls of your own building behind the viewpoint are not modeled.`
    : '';
  // Fine-print note on whether the terrain horizon was part of this report.
  const terrainNote = terrainUsed
    ? `Terrain occlusion is included (AWS Terrain Tiles, ~${TERRAIN_RESOLUTION_M} m grid).`
    : 'Ignores terrain.';

  $('report-body').innerHTML = `
    <div class="report-coords muted">${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}</div>
    <div class="report-viewpoint">
      <label for="viewpoint-height">Viewpoint:</label>
      <select id="viewpoint-height">${viewpointOptions()}</select>
    </div>
    <div class="report-day">
      <div class="report-big">${hoursStr(day.lit)}</div>
      <div>direct sun on ${dateStr}<br><span class="muted">of ${hoursStr(day.possible)} possible daylight</span></div>
    </div>
    ${treeLine}
    <div class="report-windows"><strong>Sun windows:</strong> ${windows}</div>
    <h3>Direct sun through the year</h3>
    <div class="bar-chart">${bars}</div>
    <div class="legend">
      <span><i class="swatch lit"></i> direct sun (h/day)</span>
      <span><i class="swatch tree"></i> under trees</span>
      <span><i class="swatch possible"></i> daylight</span>
    </div>
    <p class="muted small">Based on ${buildingCount.toLocaleString()} buildings and
    ${treeCount.toLocaleString()} trees/woods nearby in OSM. Deciduous (and untagged)
    trees are treated as leafless in winter; tree sizes without OSM data are estimated.
    ${terrainNote} Times use your device's timezone.${viewpointNote}</p>`;

  $('viewpoint-height').addEventListener('change', (e) => {
    state.viewpointHeight = Number(e.target.value);
    if (state.reportPoint) runReport(state.reportPoint);
  });
}

$('report-close').addEventListener('click', () => {
  $('report').classList.remove('visible');
  state.reportMarker?.remove();
  state.reportMarker = null;
  state.reportPoint = null;
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const dateInput = $('date');
dateInput.value = `${state.date.y}-${String(state.date.m + 1).padStart(2, '0')}-${String(state.date.d).padStart(2, '0')}`;
dateInput.addEventListener('change', () => {
  const [y, m, d] = dateInput.value.split('-').map(Number);
  if (!y) return;
  state.date = { y, m: m - 1, d };
  scheduleSunUpdate();
  if (state.reportPoint) runReport(state.reportPoint);
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    if (preset === 'today') {
      const t = new Date();
      dateInput.value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    } else {
      const [m, d] = preset.split('-').map(Number);
      dateInput.value = `${state.date.y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    dateInput.dispatchEvent(new Event('change'));
  });
});

const timeSlider = $('time');
timeSlider.value = state.minutes;
timeSlider.addEventListener('input', () => {
  state.minutes = Number(timeSlider.value);
  scheduleSunUpdate();
});

$('now').addEventListener('click', () => {
  const t = new Date();
  state.minutes = t.getHours() * 60 + t.getMinutes();
  timeSlider.value = state.minutes;
  scheduleSunUpdate();
});

const playBtn = $('play');
let playTimer = null;
playBtn.addEventListener('click', () => {
  state.playing = !state.playing;
  playBtn.textContent = state.playing ? '⏸' : '▶';
  playBtn.title = state.playing ? 'Pause' : 'Animate the day';
  if (state.playing) {
    playTimer = setInterval(() => {
      state.minutes = (state.minutes + 5) % 1440;
      timeSlider.value = state.minutes;
      scheduleSunUpdate();
    }, 80);
  } else {
    clearInterval(playTimer);
  }
});

$('toggle-3d').addEventListener('change', (e) => {
  const on = e.target.checked;
  map.setLayoutProperty('buildings-3d', 'visibility', on ? 'visible' : 'none');
  map.setLayoutProperty('buildings-fill', 'visibility', on ? 'none' : 'visible');
  map.setLayoutProperty('trees-3d', 'visibility', on && state.treesEnabled ? 'visible' : 'none');
  map.setLayoutProperty(
    'trees-fill',
    'visibility',
    !on && state.treesEnabled ? 'visible' : 'none'
  );
  map.easeTo({ pitch: on ? 50 : 0, duration: 600 });
});

$('toggle-trees').addEventListener('change', (e) => {
  state.treesEnabled = e.target.checked;
  const threeD = $('toggle-3d').checked;
  map.setLayoutProperty(
    'trees-3d',
    'visibility',
    threeD && state.treesEnabled ? 'visible' : 'none'
  );
  map.setLayoutProperty(
    'trees-fill',
    'visibility',
    !threeD && state.treesEnabled ? 'visible' : 'none'
  );
  scheduleSunUpdate();
  if (state.reportPoint) runReport(state.reportPoint);
});

// Terrain toggle: re-running the report both applies the new setting and (via
// ensureTerrain inside runReport) lazily loads the grid when switched on.
$('toggle-terrain').addEventListener('change', (e) => {
  state.terrainEnabled = e.target.checked;
  if (state.reportPoint) runReport(state.reportPoint);
});

$('reload').addEventListener('click', () => {
  state.coveredBboxes = [];
  loadBuildingsInView();
});

async function search() {
  const q = $('q').value.trim();
  if (!q) return;
  setStatus(`Searching “${q}”…`, 'busy');
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
    );
    const results = await res.json();
    if (!results.length) {
      setStatus('No results found', 'error');
      return;
    }
    const r = results[0];
    setStatus(r.display_name, 'ok');
    map.flyTo({ center: [Number(r.lon), Number(r.lat)], zoom: 16.5 });
  } catch (err) {
    console.error(err);
    setStatus('Search failed', 'error');
  }
}
$('search-btn').addEventListener('click', search);
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') search();
});

$('panel-toggle').addEventListener('click', () => {
  $('panel').classList.toggle('collapsed');
});
