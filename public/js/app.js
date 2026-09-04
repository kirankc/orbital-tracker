import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { gstime } from 'satellite.js';
import { esc, ORBIT_COLORS, fmtDate, fmtNum, yearsSince, linkRocket, linkMaker, linkBus, startClock, qs } from './common.js';

// ---------------------------------------------------------------------------
// State
const state = {
  sats: [], // catalog entries
  index: new Map(), // id -> array index
  flags: null, // Uint8Array per sat: 0 hidden, 1 visible, 2 selected
  colors: null,
  segments: [], ok: null, // position segments from the worker: {time, delta, posA, posB}
  simBase: Date.now(), realBase: performance.now(),
  filters: { orbits: new Set(['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']), milOnly: false, milHighlight: true, country: '', objtype: 'PAY', owner: '', rocket: '', search: '', year: '', bus: '', mf: '', altMin: null, altMax: null, incMin: null, incMax: null },
  selected: -1,
  hover: -1,
  listLimit: 250,
  speed: 1, simTime: Date.now(),
  autorotate: true,
};

const $ = (id) => document.getElementById(id);
let flyTarget = null; // camera fly-to destination
startClock($('clock'));

// ---------------------------------------------------------------------------
// Three.js scene
const container = $('globe');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.01, 200);
camera.position.set(2.2, 1.4, 3.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.rotateSpeed = 0.55; controls.zoomSpeed = 0.8;
controls.minDistance = 1.15; controls.maxDistance = 30; controls.enablePan = false; controls.autoRotateSpeed = 0.35;

// Lights: sun + faint ambient so the night side stays readable.
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x8899bb, 0.6));

const loader = new THREE.TextureLoader();
const tex = (f) => { const t = loader.load(f); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
const earthMat = new THREE.MeshPhongMaterial({
  map: tex('textures/earth_atmos_2048.jpg'),
  specularMap: loader.load('textures/earth_specular_2048.jpg'),
  normalMap: loader.load('textures/earth_normal_2048.jpg'),
  normalScale: new THREE.Vector2(0.6, 0.6),
  specular: new THREE.Color(0x333333),
  shininess: 12,
  emissiveMap: tex('textures/earth_lights_2048.png'),
  emissive: new THREE.Color(0xffe9b0),
  emissiveIntensity: 0.9,
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), earthMat);
scene.add(earth);

// Atmosphere glow (back-facing shell with fresnel falloff).
const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.035, 64, 64), new THREE.ShaderMaterial({
  uniforms: { c: { value: 0.6 }, p: { value: 4.5 }, glowColor: { value: new THREE.Color(0x4cc9f0) } },
  vertexShader: `varying vec3 vNormal; varying vec3 vPos; void main(){ vNormal = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vPos = mv.xyz; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float c; uniform float p; uniform vec3 glowColor; varying vec3 vNormal; varying vec3 vPos; void main(){ float intensity = pow(c - dot(vNormal, normalize(-vPos)), p); gl_FragColor = vec4(glowColor, 1.0) * intensity * 0.9; }`,
  side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
}));
scene.add(atmo);

// Star field.
{
  const N = 4000; const arr = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(80 + Math.random() * 40); arr.set([v.x, v.y, v.z], i * 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9fb3d9, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.7 })));
}

// Equator / GEO belt reference rings.
function ring(r, color, opacity) {
  const pts = []; for (let i = 0; i <= 256; i++) { const a = (i / 256) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  scene.add(l); return l;
}
ring(6.6107, 0xffb703, 0.12); // geostationary radius (42164 km / 6371)

// Satellite points: custom shader so we can hide/highlight per point.
let points, posAttr, colAttr, flagAttr, drawPos;
const pointMat = new THREE.ShaderMaterial({
  uniforms: { uPR: { value: renderer.getPixelRatio() } },
  vertexShader: `attribute vec3 aColor; attribute float aFlag; uniform float uPR; varying vec3 vColor; varying float vFlag;
    void main(){ vColor = aColor; vFlag = aFlag; if (aFlag < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
      float base = aFlag > 2.5 ? 16.0 : (aFlag > 1.5 ? 7.0 : 3.6);
      gl_PointSize = base * uPR; }`,
  fragmentShader: `varying vec3 vColor; varying float vFlag; void main(){ vec2 d = gl_PointCoord - vec2(0.5); float r = length(d);
      if (r > 0.5) discard;
      if (vFlag > 2.5) { if (r < 0.28 || r > 0.42) { if (r > 0.42) discard; gl_FragColor = vec4(1.0,1.0,1.0,1.0); } else discard; return; }
      float a = vFlag > 1.5 ? 1.0 : smoothstep(0.5, 0.25, r);
      gl_FragColor = vec4(vColor, a); }`,
  transparent: true, depthWrite: false,
});

// Orbit path of selected satellite.
const orbitLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
orbitLine.visible = false; scene.add(orbitLine);
// Ground track marker (sub-satellite point) line from satellite to surface.
const nadirLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
nadirLine.visible = false; scene.add(nadirLine);

function sunDirection(date) {
  // Approximate solar position -> Earth-fixed direction (subsolar point).
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400e3;
  const g = ((357.529 + 0.98560028 * d) % 360) * Math.PI / 180;
  const q = 280.459 + 0.98564736 * d;
  const L = ((q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) % 360) * Math.PI / 180;
  const e = (23.439 - 0.00000036 * d) * Math.PI / 180;
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const lon = ra - gstime(date);
  const x = Math.cos(decl) * Math.cos(lon), y = Math.cos(decl) * Math.sin(lon), z = Math.sin(decl);
  return new THREE.Vector3(x, z, -y);
}

// ---------------------------------------------------------------------------
// Worker
const worker = new Worker('js/worker.js', { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'loaded') {
    $('loadmsg').textContent = `Propagating ${m.n.toLocaleString()} objects…`;
    requestTick();
  } else if (m.type === 'positions') {
    state.segments.push({ time: m.time, delta: m.delta, posA: m.posA, posB: m.posB, ok: m.ok });
    state.segments.sort((a, b) => a.time - b.time);
    while (state.segments.length > 4) state.segments.shift();
    state.ok = m.ok;
    lastTickMs = m.ms;
    if (!points) initPoints();
    if (!$('loading').classList.contains('hide')) { $('loading').classList.add('hide'); }
    if (state.selected >= 0 && state.speed > 1) worker.postMessage({ type: 'orbit', index: state.selected, time: state.simTime });
  } else if (m.type === 'orbit') {
    if (m.index !== state.selected || !m.path) return;
    const pts = []; for (let i = 0; i < m.path.length / 3; i++) { if (Number.isNaN(m.path[i * 3])) continue; pts.push(new THREE.Vector3(m.path[i * 3], m.path[i * 3 + 1], m.path[i * 3 + 2])); }
    orbitLine.geometry.dispose(); orbitLine.geometry = new THREE.BufferGeometry().setFromPoints(pts); orbitLine.visible = true;
  } else if (m.type === 'geodetic') {
    if (m.index !== state.selected) return;
    const s = state.sats[m.index];
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('live-lat', `${Math.abs(m.lat).toFixed(2)}° ${m.lat >= 0 ? 'N' : 'S'}`);
    set('live-lon', `${Math.abs(m.lon).toFixed(2)}° ${m.lon >= 0 ? 'E' : 'W'}`);
    set('live-alt', `${fmtNum(m.alt)} km`);
    set('live-vel', `${m.speed.toFixed(2)} km/s`);
    if (s) s._live = m;
  }
};
// ---------------------------------------------------------------------------
// Simulation clock & tick scheduling. The worker returns position segments
// [T, T+delta]; the render loop interpolates inside the segment, so playback is
// smooth at any speed. Requests are issued one interval ahead of need.
let lastTickMs = 0;
let tickTimer = null;
let nextTickTime = null;
function simNow() { return state.simBase + (performance.now() - state.realBase) * state.speed; }
function tickInterval() { return state.speed <= 1 ? 1000 : state.speed <= 60 ? 500 : 250; } // real ms between requests
function tickDelta() { return Math.max(1, state.speed) * tickInterval(); } // sim ms covered per segment
function tickLoop() {
  clearTimeout(tickTimer);
  if (state.sats.length) {
    const now = simNow();
    const covered = state.segments.some((g) => g.time <= now && now < g.time + g.delta);
    if (!(state.speed === 0 && covered)) {
      const delta = tickDelta();
      if (nextTickTime === null || Math.abs(nextTickTime - now) > delta * 1.5) nextTickTime = now;
      worker.postMessage({ type: 'tick', time: nextTickTime, delta });
      nextTickTime += delta;
    }
  }
  tickTimer = setTimeout(tickLoop, Math.max(tickInterval(), Math.min(lastTickMs * 1.5, 2000)));
}
function requestTick() { nextTickTime = null; tickLoop(); }
function setSpeed(sp) {
  state.simBase = simNow(); state.realBase = performance.now(); state.speed = sp;
  state.segments = []; requestTick();
  if (state.selected >= 0) worker.postMessage({ type: 'orbit', index: state.selected, time: simNow() });
}
setInterval(() => { if (state.selected >= 0 && state.speed <= 1) { worker.postMessage({ type: 'orbit', index: state.selected, time: state.simTime }); } }, 8000);
setInterval(() => { if (state.selected >= 0) worker.postMessage({ type: 'geodetic', index: state.selected, time: state.simTime }); }, 500);

function initPoints() {
  const n = state.sats.length;
  drawPos = new Float32Array(n * 3);
  const g = new THREE.BufferGeometry();
  posAttr = new THREE.BufferAttribute(drawPos, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr = new THREE.BufferAttribute(state.colors, 3);
  flagAttr = new THREE.BufferAttribute(new Float32Array(state.flags), 1); flagAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', posAttr); g.setAttribute('aColor', colAttr); g.setAttribute('aFlag', flagAttr);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);
  points = new THREE.Points(g, pointMat); points.frustumCulled = false;
  scene.add(points);
  applyFilters();
}

// ---------------------------------------------------------------------------
// Data
async function load() {
  const res = await fetch('/api/satellites');
  if (!res.ok) throw new Error('catalog unavailable');
  const data = await res.json();
  state.sats = data.satellites;
  state.sats.forEach((s, i) => state.index.set(s.id, i));
  state.flags = new Uint8Array(state.sats.length).fill(1);
  state.colors = new Float32Array(state.sats.length * 3);
  recolor();
  const st = data.stats;
  $('n-leo').textContent = (st.byOrbit.LEO || 0).toLocaleString();
  $('n-meo').textContent = (st.byOrbit.MEO || 0).toLocaleString();
  $('n-geo').textContent = (st.byOrbit.GEO || 0).toLocaleString();
  $('n-heo').textContent = (st.byOrbit.HEO || 0).toLocaleString();
  $('n-mil').textContent = st.military.toLocaleString();
  $('datapill').textContent = `CelesTrak GP · ${fmtDate(st.gpUpdated, { time: true })}${st.gpStale ? ' (cached)' : ''} · ${st.total.toLocaleString()} objects`;
  const cv = st.coverage;
  if (cv) {
    $('coverage').innerHTML = `<strong>${cv.shownActivePayloads.toLocaleString()}</strong> of <strong>${cv.satcatActivePayloads.toLocaleString()}</strong> active payloads in the CelesTrak SATCAT have public orbital elements and are plotted. `
      + `<a href="detail.html?type=untracked">${cv.untracked.toLocaleString()} cannot be plotted</a>: ${cv.untrackedClassified.toLocaleString()} classified, ${cv.untrackedDeepSpace.toLocaleString()} deep-space, ${cv.untrackedOther.toLocaleString()} without published elements`
      + (st.gpSource !== 'active' ? ` <span class="warn" title="CelesTrak limits the full 'active' download to once per 2-hour update cycle; the server retries every 15 minutes and will fill the gap automatically.">· element set assembled from CelesTrak groups, full catalog pending</span>` : '') + '.';
  }
  fillSelect('country', countBy((s) => s.country), 'All countries');
  fillSelect('owner', countBy((s) => s.owner), 'All operators', 60);
  fillSelect('rocket', countBy((s) => s.lvType), 'All launch vehicles', 60);
  $('loadmsg').textContent = 'Initialising SGP4 propagators…';
  worker.postMessage({ type: 'load', gps: state.sats.map((s) => s.gp) });
  renderList();
  // Filters handed over from profile pages.
  const rf = sessionStorage.getItem('rocketFilter'); const of = sessionStorage.getItem('ownerFilter');
  if (rf) { sessionStorage.removeItem('rocketFilter'); if ([...$('rocket').options].some((o) => o.value === rf)) { $('rocket').value = rf; state.filters.rocket = rf; } else { $('search').value = rf; state.filters.search = rf.toLowerCase(); } }
  if (of) { sessionStorage.removeItem('ownerFilter'); $('search').value = of; state.filters.search = of.toLowerCase(); }
  // Deep-link filters from the Insights page and profile pages.
  const p = new URLSearchParams(location.search);
  const extra = [];
  if (p.get('country')) { state.filters.country = p.get('country'); if ([...$('country').options].some((o) => o.value === state.filters.country)) $('country').value = state.filters.country; extra.push(`country: ${state.filters.country}`); }
  if (p.get('owner')) { state.filters.owner = p.get('owner'); if ([...$('owner').options].some((o) => o.value === state.filters.owner)) $('owner').value = state.filters.owner; extra.push(`operator: ${state.filters.owner}`); }
  if (p.get('rocket')) { state.filters.rocket = p.get('rocket'); if ([...$('rocket').options].some((o) => o.value === state.filters.rocket)) $('rocket').value = state.filters.rocket; extra.push(`rocket: ${state.filters.rocket}`); }
  if (p.get('orbit')) { state.filters.orbits = new Set(p.get('orbit').split(',')); document.querySelectorAll('#orbit-chips .chip').forEach((c) => c.classList.toggle('on', state.filters.orbits.has(c.dataset.orbit))); syncStatChips(); }
  if (p.get('mil') === '1') { state.filters.milOnly = true; $('mil-only').checked = true; }
  if (p.get('type')) { state.filters.objtype = p.get('type') === 'all' ? '' : p.get('type'); $('objtype').value = state.filters.objtype; }
  if (p.get('q')) { state.filters.search = p.get('q').toLowerCase(); $('search').value = p.get('q'); }
  if (p.get('year')) { state.filters.year = p.get('year'); extra.push(`launched in ${p.get('year')}`); }
  if (p.get('bus')) { state.filters.bus = p.get('bus'); extra.push(`bus: ${p.get('bus')}`); }
  if (p.get('mf')) { state.filters.mf = p.get('mf'); extra.push(`manufacturer: ${p.get('mf')}`); }
  if (p.get('alt')) { const [a, b] = p.get('alt').split('-').map(Number); state.filters.altMin = a; state.filters.altMax = b; extra.push(`perigee ${a}–${b} km`); }
  if (p.get('inc')) { const [a, b] = p.get('inc').split('-').map(Number); state.filters.incMin = a; state.filters.incMax = b; extra.push(`inclination ${a}–${b}°`); }
  if (extra.length) { const el = document.createElement('div'); el.className = 'extra-filter'; el.innerHTML = `<span>Filtered from Insights · ${esc(extra.join(' · '))}</span><button class="chip" id="clear-extra">✕ clear</button>`; $('satlist').parentElement.insertBefore(el, $('coverage')); el.querySelector('#clear-extra').onclick = () => { Object.assign(state.filters, { year: '', bus: '', mf: '', altMin: null, altMax: null, incMin: null, incMax: null }); el.remove(); history.replaceState(null, '', location.pathname); applyFilters(); }; }
  const pre = qs('sat');
  if (pre && state.index.has(+pre)) { setTimeout(() => select(state.index.get(+pre), true), 800); }
}
function countBy(fn) { const m = new Map(); for (const s of state.sats) { const k = fn(s); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); }
function fillSelect(id, entries, label, limit = 80) {
  const sel = $(id); sel.innerHTML = `<option value="">${label}</option>` + entries.slice(0, limit).map(([k, v]) => `<option value="${esc(k)}">${esc(k)} (${v.toLocaleString()})</option>`).join('');
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
const RGB = Object.fromEntries(Object.entries(ORBIT_COLORS).map(([k, v]) => [k, hexToRgb(v)]));
function recolor() {
  for (let i = 0; i < state.sats.length; i++) {
    const s = state.sats[i];
    const c = state.filters.milHighlight && s.mil ? RGB.MIL : (RGB[s.orbit] || RGB.OTHER);
    state.colors[i * 3] = c[0]; state.colors[i * 3 + 1] = c[1]; state.colors[i * 3 + 2] = c[2];
  }
  if (colAttr) colAttr.needsUpdate = true;
}

function matches(s) {
  const f = state.filters;
  if (!f.orbits.has(s.orbit)) return false;
  if (f.milOnly && !s.mil) return false;
  if (f.objtype && s.type !== f.objtype) return false;
  if (f.country && s.country !== f.country) return false;
  if (f.owner && s.owner !== f.owner) return false;
  if (f.rocket && s.lvType !== f.rocket) return false;
  if (f.year && (s.launched || '').slice(0, 4) !== f.year) return false;
  if (f.bus && s.bus !== f.bus) return false;
  if (f.mf && s.mf !== f.mf) return false;
  if (f.altMin !== null && s.perigee < f.altMin) return false;
  if (f.altMax !== null && s.perigee >= f.altMax) return false;
  if (f.incMin !== null && s.inc < f.incMin) return false;
  if (f.incMax !== null && s.inc >= f.incMax) return false;
  if (f.search) {
    const q = f.search;
    if (!(s.name.toLowerCase().includes(q) || (s.gname || '').toLowerCase().includes(q) || s.cospar.toLowerCase().includes(q) || String(s.id) === q || (s.owner || '').toLowerCase().includes(q) || (s.bus || '').toLowerCase().includes(q))) return false;
  }
  return true;
}
let visibleList = [];
function applyFilters() {
  visibleList = [];
  const counts = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0, mil: 0 };
  for (let i = 0; i < state.sats.length; i++) {
    const s = state.sats[i];
    const on = matches(s);
    state.flags[i] = on ? (i === state.selected ? 3 : 1) : (i === state.selected ? 3 : 0);
    if (on) { visibleList.push(i); counts[s.orbit]++; if (s.mil) counts.mil++; }
  }
  if (flagAttr) { flagAttr.array.set(state.flags); flagAttr.needsUpdate = true; }
  $('visible-count').textContent = `${visibleList.length.toLocaleString()} shown`;
  $('n-leo').textContent = counts.LEO.toLocaleString(); $('n-meo').textContent = counts.MEO.toLocaleString(); $('n-geo').textContent = counts.GEO.toLocaleString(); $('n-heo').textContent = counts.HEO.toLocaleString(); $('n-mil').textContent = counts.mil.toLocaleString();
  state.listLimit = 250;
  renderList();
}

function renderList() {
  const list = $('satlist');
  // Named objects first, then CelesTrak placeholder designations (which start with a digit).
  const dig = (i) => (/^\d/.test(state.sats[i].name) ? 1 : 0);
  const sorted = visibleList.slice().sort((a, b) => dig(a) - dig(b) || state.sats[a].name.localeCompare(state.sats[b].name));
  const shown = sorted.slice(0, state.listLimit);
  $('list-count').textContent = `${shown.length.toLocaleString()} of ${sorted.length.toLocaleString()} objects`;
  list.innerHTML = shown.map((i) => { const s = state.sats[i]; return `<div class="sat ${i === state.selected ? 'sel' : ''}" data-i="${i}"><span class="sw" style="background:${s.mil && state.filters.milHighlight ? ORBIT_COLORS.MIL : ORBIT_COLORS[s.orbit]}"></span><div><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.owner || s.country || '—')}${s.lvType ? ' · ' + esc(s.lvType) : ''}</div></div><span class="tag ${s.mil ? 'mil' : ''}">${s.mil ? 'MIL · ' : ''}${s.orbit}</span></div>`; }).join('');
  $('more').hidden = sorted.length <= state.listLimit;
}
$('more').onclick = () => { state.listLimit += 500; renderList(); };
$('satlist').addEventListener('click', (e) => { const row = e.target.closest('.sat'); if (row) select(+row.dataset.i, true); });

// Filter UI wiring
$('orbit-chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; const o = b.dataset.orbit; if (state.filters.orbits.has(o)) { state.filters.orbits.delete(o); b.classList.remove('on'); } else { state.filters.orbits.add(o); b.classList.add('on'); } syncStatChips(); applyFilters(); });
$('stats').addEventListener('click', (e) => { const st = e.target.closest('.stat'); if (!st) return; if (st.id === 'stat-mil') { $('mil-only').checked = !$('mil-only').checked; state.filters.milOnly = $('mil-only').checked; applyFilters(); return; } const o = st.dataset.orbit; const only = !(state.filters.orbits.size === 1 && state.filters.orbits.has(o)); state.filters.orbits = only ? new Set([o]) : new Set(['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']); document.querySelectorAll('#orbit-chips .chip').forEach((c) => c.classList.toggle('on', state.filters.orbits.has(c.dataset.orbit))); syncStatChips(); applyFilters(); });
function syncStatChips() { document.querySelectorAll('.stat[data-orbit]').forEach((c) => c.classList.toggle('off', !state.filters.orbits.has(c.dataset.orbit))); }
$('mil-only').onchange = (e) => { state.filters.milOnly = e.target.checked; applyFilters(); };
$('mil-highlight').onchange = (e) => { state.filters.milHighlight = e.target.checked; recolor(); renderList(); };
$('country').onchange = (e) => { state.filters.country = e.target.value; applyFilters(); };
$('objtype').onchange = (e) => { state.filters.objtype = e.target.value; applyFilters(); };
$('owner').onchange = (e) => { state.filters.owner = e.target.value; applyFilters(); };
$('rocket').onchange = (e) => { state.filters.rocket = e.target.value; applyFilters(); };
let searchT; $('search').oninput = (e) => { clearTimeout(searchT); searchT = setTimeout(() => { state.filters.search = e.target.value.trim().toLowerCase(); applyFilters(); }, 150); };

// Time controls
document.querySelectorAll('.controls [data-speed]').forEach((b) => b.onclick = () => { setSpeed(+b.dataset.speed); document.querySelectorAll('.controls button[data-speed], #btn-now').forEach((x) => x.classList.remove('on')); b.classList.add('on'); });
$('btn-now').onclick = () => { state.speed = 1; state.simBase = Date.now(); state.realBase = performance.now(); state.segments = []; document.querySelectorAll('.controls button[data-speed]').forEach((x) => x.classList.remove('on')); $('btn-now').classList.add('on'); requestTick(); };
$('view-leo').onclick = () => flyTo(2.6);
$('view-geo').onclick = () => flyTo(15);
function syncAutorotate() { controls.autoRotate = state.autorotate && state.selected < 0 && !flyTarget; $('autorotate').classList.toggle('on', state.autorotate); }
$('autorotate').onclick = () => { state.autorotate = !state.autorotate; syncAutorotate(); };
controls.autoRotateSpeed = 0.22; syncAutorotate();
function flyTo(dist, dir) { const d = dir ? dir.clone().normalize() : camera.position.clone().normalize(); flyTarget = d.multiplyScalar(dist); controls.autoRotate = false; }

// ---------------------------------------------------------------------------
// Selection & picking
const tooltip = $('tooltip');
const selLabel = $('sel-label');
const ndc = new THREE.Vector3();
function projectAll(px, py, radiusPx) {
  // Return index of nearest visible, unoccluded point within radiusPx of screen position.
  if (!drawPos) return -1;
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  const cam = camera.position;
  let best = -1, bestD = radiusPx * radiusPx;
  for (const i of visibleList) {
    if (!state.ok[i]) continue;
    const x = drawPos[i * 3], y = drawPos[i * 3 + 1], z = drawPos[i * 3 + 2];
    // Occlusion by the globe: does segment camera->point cross the unit sphere?
    const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
    const a = dx * dx + dy * dy + dz * dz, b = 2 * (cam.x * dx + cam.y * dy + cam.z * dz), c = cam.lengthSq() - 1;
    const disc = b * b - 4 * a * c;
    if (disc > 0) { const t = (-b - Math.sqrt(disc)) / (2 * a); if (t > 0 && t < 1) continue; }
    ndc.set(x, y, z).project(camera);
    if (ndc.z > 1) continue;
    const sx = (ndc.x + 1) / 2 * w, sy = (1 - ndc.y) / 2 * h;
    const d = (sx - px) ** 2 + (sy - py) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return; const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]); downPos = null; if (moved > 4) return;
  const i = projectAll(e.clientX, e.clientY, 12);
  if (i >= 0) select(i, false); else if (state.selected >= 0 && e.target === renderer.domElement) { /* keep selection */ }
});
let hoverT = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  const now = performance.now(); if (now - hoverT < 40) return; hoverT = now;
  const i = projectAll(e.clientX, e.clientY, 10);
  state.hover = i;
  if (i >= 0) { const s = state.sats[i]; tooltip.style.display = 'block'; tooltip.style.left = e.clientX + 'px'; tooltip.style.top = e.clientY + 'px'; tooltip.innerHTML = `<strong>${esc(s.name)}</strong><span class="o">${s.orbit}${s.mil ? ' · MIL' : ''} · ${esc(s.owner || s.country || '')}</span>`; renderer.domElement.style.cursor = 'pointer'; }
  else { tooltip.style.display = 'none'; renderer.domElement.style.cursor = ''; }
});

function select(i, fly) {
  const prev = state.selected;
  state.selected = i;
  if (prev >= 0) state.flags[prev] = matches(state.sats[prev]) ? 1 : 0;
  state.flags[i] = 3;
  if (flagAttr) { flagAttr.array.set(state.flags); flagAttr.needsUpdate = true; }
  document.querySelectorAll('.sat.sel').forEach((r) => r.classList.remove('sel'));
  const row = document.querySelector(`.sat[data-i="${i}"]`); if (row) { row.classList.add('sel'); row.scrollIntoView({ block: 'nearest' }); }
  worker.postMessage({ type: 'orbit', index: i, time: state.simTime });
  worker.postMessage({ type: 'geodetic', index: i, time: state.simTime });
  orbitLine.visible = false; nadirLine.visible = true;
  history.replaceState(null, '', `?sat=${state.sats[i].id}`);
  syncAutorotate();
  if (fly && drawPos) { const p = new THREE.Vector3(drawPos[i * 3], drawPos[i * 3 + 1], drawPos[i * 3 + 2]); const dist = Math.max(camera.position.length(), p.length() * 1.6); flyTo(Math.min(dist, 28), p); }
  showDetail(i);
}
$('close-detail').onclick = () => { $('detail-panel').classList.remove('open'); setTimeout(layoutCamera, 260); if (state.selected >= 0) { const i = state.selected; state.selected = -1; state.flags[i] = matches(state.sats[i]) ? 1 : 0; flagAttr.array.set(state.flags); flagAttr.needsUpdate = true; orbitLine.visible = false; nadirLine.visible = false; selLabel.style.display = 'none'; document.querySelectorAll('.sat.sel').forEach((r) => r.classList.remove('sel')); history.replaceState(null, '', location.pathname); } syncAutorotate(); };

async function showDetail(i) {
  const s = state.sats[i];
  const panel = $('detail-panel'); panel.classList.add('open'); setTimeout(layoutCamera, 260);
  const el = $('detail');
  el.innerHTML = renderDetail(s, null);
  try {
    const res = await fetch(`/api/satellite/${s.id}`);
    const d = await res.json();
    if (state.selected === i) el.innerHTML = renderDetail(s, d);
  } catch { /* keep basic info */ }
}
const kv = (rows) => `<dl class="kv">${rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '' && r[1] !== '—').map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
function renderDetail(s, d) {
  const live = `<div class="live"><div><div class="l">Lat</div><div class="v" id="live-lat">…</div></div><div><div class="l">Lon</div><div class="v" id="live-lon">…</div></div><div><div class="l">Altitude</div><div class="v" id="live-alt">…</div></div><div><div class="l">Speed</div><div class="v" id="live-vel">…</div></div></div>`;
  const badges = `<div class="badges"><span class="badge ${s.orbit.toLowerCase()}">${esc(s.sub)}</span>${s.mil ? `<span class="badge mil" title="${s.milReason === 'owner' ? 'Operator is a defense organisation' : 'Matched a defense naming pattern'}">Defense / military</span>` : ''}<span class="badge">${s.type === 'PAY' ? 'Payload' : s.type === 'R/B' ? 'Rocket body' : s.type}</span>${d?.status ? `<span class="badge ${d.status === 'O' ? 'ok' : ''}">${{ O: 'In orbit', AO: 'Attached', DK: 'Docked', R: 'Reentered', L: 'Landed' }[d.status] || esc(d.status)}</span>` : ''}</div>`;
  let html = `<h3>${esc(s.name)}</h3><div class="cospar">${esc(s.cospar)} · NORAD ${s.id}${s.gname && s.gname !== s.name ? ` · ${esc(s.gname)}` : ''}</div>${badges}
  <div class="section"><h4>Live position</h4>${live}</div>
  <div class="section"><h4>Identity & ownership</h4>${kv([
    ['Country', esc(s.country || '—')],
    ['Operator', s.owner ? linkMaker(s.ownerCode, s.owner) : null],
    d?.owners?.[0] ? ['Operator type', `${esc(d.owners[0].classLabel)}${d.owners[0].location ? ' · ' + esc(d.owners[0].location) : ''}`] : null,
    ['Manufacturer', s.mf ? linkMaker(s.mfCode, s.mf) : null],
    d?.manufacturers?.[0]?.location ? ['Built in', esc(d.manufacturers[0].location)] : null,
    ['Bus / model', s.bus ? linkBus(s.bus) : null],
    d?.plname && d.plname !== s.name ? ['Payload name', esc(d.plname)] : null,
    d?.altNames ? ['Other names', esc(d.altNames.replace(/:U/g, ''))] : null,
  ])}</div>
  <div class="section"><h4>Launch</h4>${kv([
    ['Launch date', d?.launch?.date ? fmtDate(d.launch.date, { time: true }) : fmtDate(s.launched)],
    ['In orbit for', yearsSince(d?.launch?.date || s.launched)],
    ['Rocket', s.lvType ? `${linkRocket(s.lvType)}${d?.launch?.variant ? ` <span class="muted">(${esc(d.launch.variant)})</span>` : ''}` : null],
    s.lvMaker ? ['Rocket builder', linkMaker(d?.lvSpec?.manufacturerCode, s.lvMaker)] : null,
    d?.launch?.flightId ? ['Flight', esc(d.launch.flightId)] : null,
    d?.launch?.mission ? ['Mission', esc(d.launch.mission)] : null,
    d?.launch?.site ? ['Launch site', `${esc(d.launch.site)}${d.launch.pad ? ' · ' + esc(d.launch.pad) : ''}`] : null,
    d?.launch?.agency ? ['Launch agency', esc(d.launch.agency)] : null,
    d?.launch?.success !== null && d?.launch?.success !== undefined ? ['Outcome', d.launch.success ? 'Success' : 'Failure'] : null,
    ['International designator', `<span class="mono">${esc(s.cospar)}</span>`],
  ])}</div>`;
  if (d) {
    html += `<div class="section"><h4>Spacecraft</h4>${kv([
      ['Mass', d.mass ? `${fmtNum(d.mass)} kg${d.dryMass && d.dryMass !== d.mass ? ` <span class="muted">(dry ${fmtNum(d.dryMass)} kg)</span>` : ''}` : null],
      ['Dimensions', d.length || d.diameter ? `${d.length ? d.length + ' m long' : ''}${d.diameter ? ` × ${d.diameter} m dia` : ''}${d.span ? `, span ${d.span} m` : ''}` : null],
      ['Shape', d.shape ? esc(d.shape) : null],
      ['Propulsion', d.motor ? esc(d.motor) : null],
      ['Radar cross-section', d.celestrak?.rcs ? `${d.celestrak.rcs} m²` : null],
    ])}</div>`;
    html += `<div class="section"><h4>Orbit</h4>${kv([
      ['Class', `${esc(s.sub)}${d.opOrbit ? ` <span class="muted">(GCAT ${esc(d.opOrbit)})</span>` : ''}`],
      ['Perigee × apogee', `${fmtNum(s.perigee)} × ${fmtNum(s.apogee)} km`],
      ['Period', `${s.period} min`],
      ['Inclination', `${s.inc}°`],
      ['Eccentricity', s.ecc.toFixed(5)],
      ['Elements epoch', fmtDate(d.gpMeta.epoch, { time: true })],
    ])}</div>`;
    if (d.ll2) {
      const l = d.ll2;
      html += `<div class="section"><h4>Launch record (Launch Library)</h4>${l.image ? `<img class="mission-img" src="${esc(l.image)}" alt="" onerror="this.remove()">` : ''}${kv([
        ['Launch', esc(l.name)],
        ['Status', esc(l.status)],
        ['Provider', l.provider ? linkMaker(null, l.provider.name) : null],
        ['Vehicle', l.rocket ? linkRocket(l.rocket.name) : null],
        ['Mission type', l.mission?.type ? esc(l.mission.type) : null],
        ['Target orbit', l.mission?.orbit ? esc(l.mission.orbit) : null],
        ['Pad', l.pad ? `${esc(l.pad.name)}${l.pad.location ? ', ' + esc(l.pad.location) : ''}${l.pad.mapUrl ? ` <a href="${esc(l.pad.mapUrl)}" target="_blank" rel="noopener">map</a>` : ''}` : null],
      ])}${l.mission?.description ? `<p class="note" style="margin-top:8px">${esc(l.mission.description)}</p>` : ''}
      ${l.videos?.length || l.infoUrls?.length ? `<div class="linkrow" style="margin-top:8px">${l.videos.map((v) => `<a href="${esc(v.url)}" target="_blank" rel="noopener">▶ ${esc(v.title || v.publisher || 'Webcast')}</a>`).join('')}${l.infoUrls.map((v) => `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title || 'Info')}</a>`).join('')}</div>` : ''}</div>`;
    }
  }
  html += `<div class="section"><h4>Explore</h4><div class="linkrow">
    ${s.lvType ? `<a class="btn primary" href="detail.html?type=rocket&name=${encodeURIComponent(s.lvType)}">🚀 ${esc(s.lvType)} profile</a>` : ''}
    ${s.mf ? `<a class="btn" href="detail.html?type=maker&code=${encodeURIComponent(s.mfCode || '')}&name=${encodeURIComponent(s.mf)}">🏭 ${esc(s.mf)}</a>` : ''}
    ${s.bus ? `<a class="btn" href="detail.html?type=bus&name=${encodeURIComponent(s.bus)}">🛰 ${esc(s.bus)} bus</a>` : ''}
    <a class="btn" href="https://celestrak.org/satcat/table-satcat.php?CATNR=${s.id}" target="_blank" rel="noopener">CelesTrak SATCAT</a>
    <a class="btn" href="https://www.n2yo.com/satellite/?s=${s.id}" target="_blank" rel="noopener">N2YO</a>
    <a class="btn" href="https://planet4589.org/space/gcat/web/cat/${Math.floor(s.id / 1000) * 1000}.html" target="_blank" rel="noopener">GCAT</a>
    <a class="btn" href="https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(s.gname || s.name)}" target="_blank" rel="noopener">Wikipedia</a>
  </div></div>`;
  return html;
}

// ---------------------------------------------------------------------------
// Render loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  clock.getDelta();
  // Simulation clock (real time when speed is 1)
  state.simTime = state.speed === 1 ? Date.now() : simNow();
  $('simtime').textContent = new Date(state.simTime).toISOString().replace('T', ' ').slice(0, 19) + (state.speed === 1 ? ' UTC' : ` UTC ×${state.speed}`);
  sun.position.copy(sunDirection(new Date(state.simTime)).multiplyScalar(10));

  if (drawPos && state.segments.length) {
    // Pick the segment containing simTime (else the latest one) and interpolate linearly inside it.
    let seg = state.segments[state.segments.length - 1];
    for (const g of state.segments) if (g.time <= state.simTime && state.simTime < g.time + g.delta) { seg = g; break; }
    const f = Math.max(0, Math.min((state.simTime - seg.time) / seg.delta, 1.5));
    const a = seg.posA, b = seg.posB, n3 = state.sats.length * 3;
    for (let i = 0; i < n3; i++) drawPos[i] = a[i] + (b[i] - a[i]) * f;
    state.ok = seg.ok;
    posAttr.needsUpdate = true;
    if (state.selected >= 0) {
      const i = state.selected; const x = drawPos[i * 3], y = drawPos[i * 3 + 1], z = drawPos[i * 3 + 2];
      const pa = nadirLine.geometry.attributes.position; const len = Math.hypot(x, y, z); pa.setXYZ(0, x, y, z); pa.setXYZ(1, x / len, y / len, z / len); pa.needsUpdate = true;
      ndc.set(x, y, z).project(camera);
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      const cam = camera.position; const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z; const a = dx * dx + dy * dy + dz * dz, b = 2 * (cam.x * dx + cam.y * dy + cam.z * dz), c = cam.lengthSq() - 1; const disc = b * b - 4 * a * c; let occluded = false; if (disc > 0) { const t = (-b - Math.sqrt(disc)) / (2 * a); occluded = t > 0 && t < 1; }
      if (!occluded && ndc.z < 1) { selLabel.style.display = 'block'; selLabel.style.left = (ndc.x + 1) / 2 * w + 'px'; selLabel.style.top = (1 - ndc.y) / 2 * h + 'px'; selLabel.textContent = state.sats[i].name; } else selLabel.style.display = 'none';
    }
  }
  if (flyTarget) { camera.position.lerp(flyTarget, 0.08); if (camera.position.distanceTo(flyTarget) < 0.01) { flyTarget = null; syncAutorotate(); } }
  controls.update();
  renderer.render(scene, camera);
}
animate();
// Keep the globe centred in the space not covered by the side panels.
function layoutCamera() {
  const W = window.innerWidth, H = window.innerHeight;
  const left = document.querySelector('.side.left'); const right = $('detail-panel');
  const leftW = left && getComputedStyle(left).display !== 'none' ? left.getBoundingClientRect().right : 0;
  const rightW = right && right.classList.contains('open') ? W - right.getBoundingClientRect().left : 0;
  const shift = Math.round((leftW - rightW) / 2); // positive = free area is to the right
  camera.aspect = W / H;
  if (Math.abs(shift) > 2) camera.setViewOffset(W, H, -shift, 0, W, H); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight); layoutCamera(); });
layoutCamera();

window.tracker = { state, get lastTickMs() { return lastTickMs; } }; // debugging handle
load().catch((e) => { $('loadmsg').textContent = `Failed to load catalog: ${e.message}`; });
