/* Blockwise -- app logic. No build step: this fetches data/*.json at
 * runtime. (The single-file Artifact demo embeds the same JSON inline
 * via window.__EMBEDDED_DATA__ -- see scripts/build_artifact.py.) */

const REF_LAT = 40.7831;
const M_PER_DEG_LAT = 111132.0;
const M_PER_DEG_LON = 111320.0 * Math.cos(REF_LAT * Math.PI / 180);

const BAND_STOPS = [
  { min: 80, label: 'Prime whitespace', tone: 'hi' },
  { min: 65, label: 'Strong fit', tone: 'hi' },
  { min: 50, label: 'Worth a look', tone: 'mid' },
  { min: 35, label: 'Crowded', tone: 'lo' },
  { min: 0, label: 'Saturated / poor fit', tone: 'lo' },
];

const state = {
  businessTypeId: null,
  weights: { signal: 45, competition: 35, foot: 20 },
  pins: [],          // up to 2: { cellIndex, marker }
  selectedCellIndex: null,
  data: null,
  cellLayers: [],
  compositeCache: null, // Float64Array parallel to cells, for current business type + weights
};

function distMeters(lon1, lat1, lon2, lat2) {
  const dx = (lon2 - lon1) * M_PER_DEG_LON;
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

function humanizeCategory(cat) {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function loadData() {
  if (window.__EMBEDDED_DATA__) return window.__EMBEDDED_DATA__;
  const [grid, points, businessTypes, meta] = await Promise.all([
    fetch('data/grid.json').then(r => r.json()),
    fetch('data/points.json').then(r => r.json()),
    fetch('data/business_types.json').then(r => r.json()),
    fetch('data/meta.json').then(r => r.json()),
  ]);
  return { grid, points, businessTypes, meta };
}

// ---- color ramp, read from the live CSS custom properties so it tracks theme ----
function readRampColors() {
  const cs = getComputedStyle(document.documentElement);
  const parse = (v) => {
    const probe = document.createElement('div');
    probe.style.color = v.trim();
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = rgb.match(/\d+(\.\d+)?/g).map(Number);
    return m;
  };
  return {
    lo: parse(cs.getPropertyValue('--accent-lo')),
    mid: parse(cs.getPropertyValue('--accent-mid')),
    hi: parse(cs.getPropertyValue('--accent-hi')),
  };
}
let RAMP = null;

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function scoreToColor(score) {
  const t = Math.max(0, Math.min(100, score)) / 100;
  let rgb;
  if (t < 0.5) rgb = lerpColor(RAMP.lo, RAMP.mid, t / 0.5);
  else rgb = lerpColor(RAMP.mid, RAMP.hi, (t - 0.5) / 0.5);
  return `rgb(${rgb[0].toFixed(0)}, ${rgb[1].toFixed(0)}, ${rgb[2].toFixed(0)})`;
}

function bandFor(score) {
  for (const b of BAND_STOPS) if (score >= b.min) return b;
  return BAND_STOPS[BAND_STOPS.length - 1];
}

// ---- composite scoring ----
function computeComposite() {
  const { grid } = state.data;
  const n = grid.cells.length;
  if (!state.businessTypeId) {
    // No business type picked yet -- fall back to plain foot traffic
    // (a general density read, not tied to any one business type).
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = grid.foot_traffic[i];
    state.compositeCache = out;
    return out;
  }
  const p = grid.business_types[state.businessTypeId];
  const w = state.weights;
  const wSum = w.signal + w.competition + w.foot || 1;
  const wSig = w.signal / wSum, wComp = w.competition / wSum, wFoot = w.foot / wSum;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = wSig * p.signal[i] + wComp * (100 - p.competition[i]) + wFoot * grid.foot_traffic[i];
  }
  state.compositeCache = out;
  return out;
}

// ---- map + grid rendering ----
let map, canvasRenderer;

function cellBounds(lon, lat, cellSizeM) {
  const halfLat = (cellSizeM / 2) / M_PER_DEG_LAT;
  const halfLon = (cellSizeM / 2) / M_PER_DEG_LON;
  return [[lat - halfLat, lon - halfLon], [lat + halfLat, lon + halfLon]];
}

function buildGrid() {
  const { grid } = state.data;
  canvasRenderer = L.canvas({ padding: 0.3 });
  const scores = computeComposite();
  state.cellLayers = grid.cells.map((c, i) => {
    const [lon, lat] = c;
    const rect = L.rectangle(cellBounds(lon, lat, grid.cell_size_m), {
      renderer: canvasRenderer,
      color: 'transparent',
      weight: 0,
      fillColor: scoreToColor(scores[i]),
      fillOpacity: 0.62,
      interactive: true,
    });
    rect.on('click', () => selectCell(i));
    rect.on('mouseover', () => rect.setStyle({ weight: 1.4, color: 'rgba(255,255,255,0.55)' }));
    rect.on('mouseout', () => {
      if (state.selectedCellIndex !== i) rect.setStyle({ weight: 0, color: 'transparent' });
    });
    rect.addTo(map);
    return rect;
  });
}

function recolorGrid() {
  const scores = computeComposite();
  state.cellLayers.forEach((rect, i) => rect.setStyle({ fillColor: scoreToColor(scores[i]) }));
}

let recolorQueued = false;
function queueRecolor() {
  if (recolorQueued) return;
  recolorQueued = true;
  requestAnimationFrame(() => { recolorQueued = false; recolorGrid(); });
}

// ---- nearby lists ----
function nearbyFor(cellIndex, categorySet, limit) {
  const { grid, points } = state.data;
  const [lon, lat] = grid.cells[cellIndex];
  const catNames = points.categories;
  const out = [];
  for (const row of points.points) {
    const [plon, plat, name, catIdx] = row;
    const cat = catNames[catIdx];
    if (!categorySet.has(cat)) continue;
    const d = distMeters(lon, lat, plon, plat);
    if (d > grid.radius_m) continue;
    out.push({ name: name || humanizeCategory(cat), cat, dist: d });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, limit);
}

function renderNearbyList(el, items) {
  if (!items.length) {
    el.innerHTML = '<div class="nearby-empty">None within a 6-7 minute walk.</div>';
    return;
  }
  el.innerHTML = items.map(it => `
    <li>
      <span>${escapeHtml(it.name)} <span class="cat" style="color:var(--ink-faint); font-size:10.5px;">&middot; ${escapeHtml(humanizeCategory(it.cat))}</span></span>
      <span class="dist">${Math.round(it.dist)}m</span>
    </li>
  `).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- detail panel ----
function selectCell(i) {
  // clear old highlight
  if (state.selectedCellIndex !== null && state.cellLayers[state.selectedCellIndex]) {
    state.cellLayers[state.selectedCellIndex].setStyle({ weight: 0, color: 'transparent' });
  }
  state.selectedCellIndex = i;
  state.cellLayers[i].setStyle({ weight: 2.5, color: cssVar('--ink') });
  renderDetail();
}

function scoreBandColorVar(tone) {
  return tone === 'hi' ? 'var(--accent-hi)' : tone === 'lo' ? 'var(--competitor)' : 'var(--accent-mid)';
}

function renderDetail() {
  const panel = document.getElementById('detail-panel');
  if (state.pins.length === 2) return renderCompare();

  const i = state.selectedCellIndex;
  if (i === null) {
    panel.classList.remove('open');
    return;
  }
  const { grid, businessTypes } = state.data;

  if (!state.businessTypeId) {
    const foot = grid.foot_traffic[i];
    panel.innerHTML = `
      <div class="detail-head">
        <div class="detail-title">General foot traffic</div>
        <button id="detail-close" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="score-hero">
        <div class="score-num" style="color:${scoreToColor(foot)}">${Math.round(foot)}</div>
      </div>
      <div class="bar-row">
        <div class="bar-top"><span>Foot traffic proxy</span><b>${foot}</b></div>
        <div class="bar-track"><div class="bar-fill" style="width:${foot}%; background:var(--ink-muted);"></div></div>
      </div>
      <div class="detail-empty">Pick what you're opening above to see signal fit, competition, and nearby places for this block.</div>
    `;
    panel.classList.add('open');
    document.getElementById('detail-close').onclick = () => {
      if (state.selectedCellIndex !== null && state.cellLayers[state.selectedCellIndex]) {
        state.cellLayers[state.selectedCellIndex].setStyle({ weight: 0, color: 'transparent' });
      }
      state.selectedCellIndex = null;
      panel.classList.remove('open');
    };
    return;
  }

  const businessType = businessTypes[state.businessTypeId];
  const scores = state.compositeCache || computeComposite();
  const score = scores[i];
  const band = bandFor(score);
  const sig = grid.business_types[state.businessTypeId].signal[i];
  const comp = grid.business_types[state.businessTypeId].competition[i];
  const foot = grid.foot_traffic[i];

  const compSet = new Set(businessType.competitor_categories);
  const sigSet = new Set(businessType.signal_categories);
  const nearbySignal = nearbyFor(i, sigSet, 6);
  const nearbyComp = nearbyFor(i, compSet, 6);

  const pinIdx = state.pins.findIndex(p => p.cellIndex === i);
  const canPin = state.pins.length < 2 && pinIdx === -1;

  panel.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="detail-title">${businessType.icon} ${escapeHtml(businessType.label)}</div>
      </div>
      <button id="detail-close" title="Close" aria-label="Close">&times;</button>
    </div>
    <div class="score-hero">
      <div class="score-num" style="color:${scoreToColor(score)}">${Math.round(score)}</div>
      <div class="score-band" style="background:color-mix(in srgb, ${scoreBandColorVar(band.tone)} 22%, transparent); color:${scoreBandColorVar(band.tone)};">${band.label}</div>
    </div>

    <div class="bar-row">
      <div class="bar-top"><span>Signal fit</span><b>${sig}</b></div>
      <div class="bar-track"><div class="bar-fill" style="width:${sig}%; background:var(--signal);"></div></div>
    </div>
    <div class="bar-row">
      <div class="bar-top"><span>Headroom (low competition)</span><b>${100 - comp}</b></div>
      <div class="bar-track"><div class="bar-fill" style="width:${100 - comp}%; background:var(--competitor);"></div></div>
    </div>
    <div class="bar-row">
      <div class="bar-top"><span>Foot traffic proxy</span><b>${foot}</b></div>
      <div class="bar-track"><div class="bar-fill" style="width:${foot}%; background:var(--ink-muted);"></div></div>
    </div>

    <button class="compare-btn" id="pin-btn" ${canPin ? '' : 'disabled'}>${pinIdx !== -1 ? 'Already pinned' : (state.pins.length >= 2 ? 'Clear comparison to pin a new spot' : '+ Pin this spot to compare')}</button>

    <div class="nearby-section">
      <div class="nearby-head"><span class="dot" style="background:var(--signal);"></span>Nearby signals (walk &le; 6-7 min)</div>
      <ul class="nearby-list">${''}</ul>
    </div>
    <div class="nearby-section">
      <div class="nearby-head"><span class="dot" style="background:var(--competitor);"></span>Nearby competitors</div>
      <ul class="nearby-list" id="comp-list"></ul>
    </div>
  `;

  const lists = panel.querySelectorAll('.nearby-list');
  renderNearbyList(lists[0], nearbySignal);
  renderNearbyList(lists[1], nearbyComp);

  panel.classList.add('open');
  document.getElementById('detail-close').onclick = () => {
    if (state.selectedCellIndex !== null && state.cellLayers[state.selectedCellIndex]) {
      state.cellLayers[state.selectedCellIndex].setStyle({ weight: 0, color: 'transparent' });
    }
    state.selectedCellIndex = null;
    panel.classList.remove('open');
  };
  const pinBtn = document.getElementById('pin-btn');
  if (pinBtn && canPin) {
    pinBtn.onclick = () => addPin(i);
  }
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function pinColor(idx) { return idx === 0 ? cssVar('--accent-hi') : cssVar('--accent-lo'); }

function addPin(cellIndex) {
  const { grid } = state.data;
  const [lon, lat] = grid.cells[cellIndex];
  const label = state.pins.length === 0 ? 'A' : 'B';
  const color = pinColor(state.pins.length);
  const icon = L.divIcon({
    className: '',
    html: `<div style="width:22px;height:22px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-family:'IBM Plex Mono',monospace;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,0.4); border: 2px solid rgba(255,255,255,0.85);">${label}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  const marker = L.marker([lat, lon], { icon }).addTo(map);
  state.pins.push({ cellIndex, marker });
  renderDetail();
}

function clearPins() {
  state.pins.forEach(p => map.removeLayer(p.marker));
  state.pins = [];
  renderDetail();
}

function renderCompare() {
  const panel = document.getElementById('detail-panel');
  const { grid, businessTypes } = state.data;
  const businessType = businessTypes[state.businessTypeId];
  const scores = state.compositeCache || computeComposite();
  const gp = grid.business_types[state.businessTypeId];

  const rows = [
    ['Opportunity score', i => Math.round(scores[i])],
    ['Signal fit', i => gp.signal[i]],
    ['Headroom', i => 100 - gp.competition[i]],
    ['Foot traffic', i => grid.foot_traffic[i]],
  ];

  const [a, b] = state.pins;
  panel.innerHTML = `
    <div class="detail-head">
      <div class="detail-title">${businessType.icon} Comparing two spots</div>
      <button id="compare-clear" title="Clear comparison">&times;</button>
    </div>
    <div class="compare-table" style="margin-top:12px;">
      <div></div>
      <div class="ct-head" style="color:${cssVar('--accent-hi')}">Spot A</div>
      <div class="ct-head" style="color:${cssVar('--accent-lo')}">Spot B</div>
      ${rows.map(([label, fn]) => `
        <div class="ct-metric">${label}</div>
        <div class="ct-val">${fn(a.cellIndex)}</div>
        <div class="ct-val">${fn(b.cellIndex)}</div>
      `).join('')}
    </div>
  `;
  panel.classList.add('open');
  document.getElementById('compare-clear').onclick = clearPins;
}

// ---- business-type picker ----
function buildBusinessTypePicker() {
  const { businessTypes } = state.data;
  const row = document.getElementById('business-type-row');
  row.innerHTML = `
    <select id="business-type-select">
      <option value="">Search by category&hellip;</option>
      ${Object.entries(businessTypes).map(([id, p]) => `
        <option value="${id}">${p.icon} ${escapeHtml(p.label)}</option>
      `).join('')}
    </select>
  `;
  document.getElementById('business-type-select').addEventListener('change', (e) => setBusinessType(e.target.value));
}

function setBusinessType(id) {
  state.businessTypeId = id || null;
  document.getElementById('business-type-select').value = id;
  document.getElementById('business-type-blurb').textContent = id
    ? state.data.businessTypes[id].blurb
    : 'Pick what you\'re opening to see the opportunity score for every block in Manhattan.';
  recolorGrid();
  if (state.pins.length === 2) renderCompare();
  else if (state.selectedCellIndex !== null) renderDetail();
  updateHowPanel();
}

// ---- weight tuner ----
function wireTuner() {
  const ids = { signal: 'w-signal', competition: 'w-competition', foot: 'w-foot' };
  const els = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, document.getElementById(v)]));
  function reflect() {
    document.getElementById('w-signal-val').textContent = Math.round(state.weights.signal);
    document.getElementById('w-competition-val').textContent = Math.round(state.weights.competition);
    document.getElementById('w-foot-val').textContent = Math.round(state.weights.foot);
    els.signal.value = state.weights.signal;
    els.competition.value = state.weights.competition;
    els.foot.value = state.weights.foot;
  }
  function onChange(key, val) {
    val = Math.max(0, Math.min(100, val));
    const others = Object.keys(state.weights).filter(k => k !== key);
    const remaining = 100 - val;
    const otherSum = others.reduce((s, k) => s + state.weights[k], 0);
    if (otherSum <= 0) {
      others.forEach(k => state.weights[k] = remaining / others.length);
    } else {
      others.forEach(k => state.weights[k] = state.weights[k] / otherSum * remaining);
    }
    state.weights[key] = val;
    reflect();
    queueRecolor();
    if (state.pins.length === 2) renderCompare();
    else if (state.selectedCellIndex !== null) renderDetail();
  }
  els.signal.addEventListener('input', () => onChange('signal', +els.signal.value));
  els.competition.addEventListener('input', () => onChange('competition', +els.competition.value));
  els.foot.addEventListener('input', () => onChange('foot', +els.foot.value));
  reflect();
}

// ---- search ----
function wireSearch() {
  const input = document.getElementById('search');
  const results = document.getElementById('search-results');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { results.style.display = 'none'; results.innerHTML = ''; return; }
    const { points } = state.data;
    const matches = [];
    for (const row of points.points) {
      const [lon, lat, name, catIdx] = row;
      if (name && name.toLowerCase().includes(q)) {
        matches.push({ lon, lat, name, cat: points.categories[catIdx] });
        if (matches.length >= 8) break;
      }
    }
    if (!matches.length) { results.style.display = 'block'; results.innerHTML = '<div class="search-result"><span>No matches</span></div>'; return; }
    results.style.display = 'block';
    results.innerHTML = matches.map((m, idx) => `
      <div class="search-result" data-idx="${idx}">
        <span>${escapeHtml(m.name)}</span>
        <span class="cat">${escapeHtml(humanizeCategory(m.cat))}</span>
      </div>
    `).join('');
    results.querySelectorAll('.search-result').forEach((el, idx) => {
      el.addEventListener('click', () => {
        const m = matches[idx];
        map.flyTo([m.lat, m.lon], 16.2, { duration: 0.6 });
        const cellIdx = nearestCell(m.lon, m.lat);
        if (cellIdx !== -1) setTimeout(() => selectCell(cellIdx), 300);
        results.style.display = 'none';
        input.value = m.name;
      });
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) results.style.display = 'none';
  });
}

function nearestCell(lon, lat) {
  const { grid } = state.data;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < grid.cells.length; i++) {
    const [clon, clat] = grid.cells[i];
    const d = distMeters(lon, lat, clon, clat);
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD < grid.radius_m * 1.5 ? best : -1;
}

// ---- methodology panel ----
function updateHowPanel() {
  const { businessTypes, meta, grid } = state.data;
  const p = state.businessTypeId ? businessTypes[state.businessTypeId] : null;
  const el = document.getElementById('how-content');
  const forWhom = p ? `the right kind of neighborhood for ${escapeHtml(p.label)}` : `the right kind of neighborhood for whatever you pick`;
  el.innerHTML = `
    <p>Blockwise scores every ~${grid.cell_size_m}m block in Manhattan on how good a spot it is for a given business: is it near the right kind of neighborhood, is it already saturated with direct competitors, and is there enough general foot traffic to support a shop. Click any block to see the score broken down and the nearby businesses driving it, and pin two blocks to compare them side by side.</p>
    <p>For each block, Blockwise looks at every Overture place within a ${grid.radius_m}m (~6-7 minute walk) radius, weighting closer places more heavily, and blends three signals into one 0-100 <b>Opportunity Score</b>: how many <b style="color:var(--signal)">complementary</b> businesses are nearby (${forWhom}), how few <b style="color:var(--competitor)">direct competitors</b> already occupy the space, and overall place density as a rough stand-in for foot traffic. Each component is converted to a percentile rank across all of Manhattan before blending, so the score reflects relative position, not raw counts.</p>
    ${p ? `<p><b>${escapeHtml(p.label)}</b> competitors: ${p.competitor_categories.map(humanizeCategory).join(', ')}.<br>Signals: ${p.signal_categories.map(humanizeCategory).join(', ')}.</p>` : ''}
  `;
}

function wireHow() {
  const toggle = document.getElementById('how-toggle');
  const panel = document.getElementById('how-panel');
  const close = document.getElementById('how-close');
  toggle.addEventListener('click', () => panel.classList.toggle('open'));
  close.addEventListener('click', () => panel.classList.remove('open'));
}

// ---- boot ----
async function boot() {
  state.data = await loadData();

  map = L.map('map', { zoomControl: true, minZoom: 11, maxZoom: 18, attributionControl: true })
    .setView([40.7420, -73.9840], 12.4);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Places: <a href="https://overturemaps.org">Overture Maps</a>',
    subdomains: 'abc',
    maxZoom: 19,
  }).addTo(map);

  RAMP = readRampColors();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    RAMP = readRampColors();
    recolorGrid();
  });

  // No business type picked yet -- dropdown shows a "search by category"
  // placeholder, the map colors by plain foot traffic, and the blurb is
  // generic until the user actually chooses one.
  state.businessTypeId = null;
  buildBusinessTypePicker();
  document.getElementById('business-type-blurb').textContent =
    'Pick what you\'re opening to see the opportunity score for every block in Manhattan.';

  buildGrid();
  wireTuner();
  wireSearch();
  wireHow();
  updateHowPanel();

  // open on a representative default cell (near Union Square) so the page
  // shows real content at rest, not an empty shell
  const startCell = nearestCell(-73.9903, 40.7359);
  if (startCell !== -1) selectCell(startCell);
}

boot();
