import {
  sunDirections,
  sunShadowParams,
  buildingShadowPolygons,
  prepareObstacles,
  isSunBlocked,
  litWindows,
} from './geometry.js';
import { fetchBuildings } from './buildings.js';

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
  buildings: new Map(), // id -> {id, rings, height, heightSource}
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
    return;
  }
  const features = [];
  for (const b of state.buildings.values()) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: buildingShadowPolygons(b.rings, b.height, params),
      },
    });
  }
  map.getSource('shadows').setData({ type: 'FeatureCollection', features });
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
  setStatus('Loading buildings from OpenStreetMap…', 'busy');
  try {
    const fetched = await fetchBuildings(bbox, { signal: controller.signal });
    if (state.buildings.size > MAX_BUILDINGS) {
      state.buildings.clear();
      state.coveredBboxes = [];
    }
    for (const b of fetched) state.buildings.set(b.id, b);
    state.coveredBboxes.push(bbox);
    refreshBuildingsSource();
    updateSun();
    if (state.reportPoint) runReport(state.reportPoint);
    const measured = [...state.buildings.values()].filter(
      (b) => b.heightSource !== 'default'
    ).length;
    const pct = state.buildings.size
      ? Math.round((measured / state.buildings.size) * 100)
      : 0;
    setStatus(
      `${state.buildings.size.toLocaleString()} buildings · ${pct}% with height data`,
      'ok'
    );
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setStatus('Failed to load buildings — try again shortly', 'error');
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

function computeDay(y, m, d, point, obstacles, step) {
  const samples = [];
  let possible = 0;
  let lit = 0;
  for (let t = 0; t < 1440; t += step) {
    const dt = new Date(y, m, d, 0, t);
    const pos = SunCalc.getPosition(dt, point.lat, point.lng);
    if (pos.altitude <= 0) continue;
    possible += step;
    const dirs = sunDirections(pos.azimuth);
    const blocked = isSunBlocked(obstacles, dirs.sunBearing, pos.altitude);
    if (!blocked) lit += step;
    samples.push({ minutes: t, lit: !blocked });
  }
  return { samples, possible, lit, windows: litWindows(samples, step) };
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

  // Let the panel paint before the (sync) number crunching.
  setTimeout(() => {
    const obstacles = prepareObstacles(point, [...state.buildings.values()]);
    const { y, m, d } = state.date;
    const day = computeDay(y, m, d, point, obstacles, DAY_STEP_MIN);

    const months = [];
    for (let mm = 0; mm < 12; mm++) {
      const r = computeDay(y, mm, 21, point, obstacles, MONTH_STEP_MIN);
      months.push({ month: mm, lit: r.lit, possible: r.possible });
    }
    renderReport(point, day, months, obstacles.length);
  }, 30);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hoursStr(min) {
  return `${(min / 60).toFixed(1)} h`;
}

function renderReport(point, day, months, obstacleCount) {
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
      const possH = ((mo.possible / maxPossible) * 100).toFixed(1);
      const cur = mo.month === state.date.m ? ' current' : '';
      const title = `${MONTH_NAMES[mo.month]} 21: ${hoursStr(mo.lit)} direct sun of ${hoursStr(mo.possible)} daylight`;
      return `<div class="bar-col${cur}" title="${title}">
        <div class="bar-stack">
          <div class="bar possible" style="height:${possH}%"></div>
          <div class="bar lit" style="height:${litH}%"></div>
        </div>
        <div class="bar-value">${(mo.lit / 60).toFixed(1)}</div>
        <div class="bar-label">${MONTH_NAMES[mo.month][0]}</div>
      </div>`;
    })
    .join('');

  $('report-body').innerHTML = `
    <div class="report-coords muted">${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}</div>
    <div class="report-day">
      <div class="report-big">${hoursStr(day.lit)}</div>
      <div>direct sun on ${dateStr}<br><span class="muted">of ${hoursStr(day.possible)} possible daylight</span></div>
    </div>
    <div class="report-windows"><strong>Sun windows:</strong> ${windows}</div>
    <h3>Direct sun through the year</h3>
    <div class="bar-chart">${bars}</div>
    <div class="legend">
      <span><i class="swatch lit"></i> direct sun (h/day)</span>
      <span><i class="swatch possible"></i> daylight</span>
    </div>
    <p class="muted small">Based on ${obstacleCount.toLocaleString()} nearby OSM buildings.
    Ignores terrain, trees and balconies above; heights without OSM data are estimated.
    Times use your device's timezone.</p>`;
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
  map.easeTo({ pitch: on ? 50 : 0, duration: 600 });
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
