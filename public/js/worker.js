// SGP4 propagation worker: converts CelesTrak OMM elements into Earth-fixed positions for the globe.
import { json2satrec, propagate, gstime, eciToEcf } from '../vendor/satellite.js/index.js';

const R = 6371; // km per globe unit
const OMEGA = 7.2921159e-5; // Earth rotation rad/s
let recs = [];
let n = 0;

function eciToThree(ecf, out, i) {
  // ECEF (x,y,z; z = pole) -> three.js (x, y=up, z) with Greenwich at +X.
  out[i * 3] = ecf.x / R;
  out[i * 3 + 1] = ecf.z / R;
  out[i * 3 + 2] = -ecf.y / R;
}

let cache = null; // { time, pos, ok } for the end of the last segment

function computeAt(timeMs) {
  const date = new Date(timeMs);
  const gmst = gstime(date);
  const pos = new Float32Array(n * 3);
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const rec = recs[i];
    if (!rec) continue;
    let pv;
    try { pv = propagate(rec, date); } catch { continue; }
    if (!pv || !pv.position || Number.isNaN(pv.position.x)) continue;
    eciToThree(eciToEcf(pv.position, gmst), pos, i);
    ok[i] = 1;
  }
  return { pos, ok };
}

// Compute a segment [time, time + delta]; the client interpolates linearly between the two endpoints.
function tick(timeMs, deltaMs) {
  const t0 = performance.now();
  let a;
  if (cache && cache.time === timeMs) a = { pos: cache.pos, ok: cache.ok }; else a = computeAt(timeMs);
  const b = computeAt(timeMs + deltaMs);
  cache = { time: timeMs + deltaMs, pos: b.pos.slice(), ok: b.ok.slice() };
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) ok[i] = a.ok[i] & b.ok[i];
  postMessage({ type: 'positions', time: timeMs, delta: deltaMs, posA: a.pos, posB: b.pos, ok, ms: performance.now() - t0 }, [a.pos.buffer, b.pos.buffer, ok.buffer]);
}

function orbit(index, timeMs, samples = 256) {
  const rec = recs[index];
  if (!rec) return postMessage({ type: 'orbit', index, path: null });
  const periodMin = (2 * Math.PI) / rec.no; // minutes
  const gmst = gstime(new Date(timeMs)); // draw the instantaneous orbit in the Earth-fixed frame
  const path = new Float32Array((samples + 1) * 3);
  for (let k = 0; k <= samples; k++) {
    const t = new Date(timeMs + (k / samples) * periodMin * 60000);
    let pv;
    try { pv = propagate(rec, t); } catch { pv = null; }
    if (!pv || !pv.position) { path[k * 3] = NaN; continue; }
    eciToThree(eciToEcf(pv.position, gmst), path, k);
  }
  postMessage({ type: 'orbit', index, path, periodMin }, [path.buffer]);
}

function geodetic(index, timeMs) {
  const rec = recs[index];
  if (!rec) return;
  const date = new Date(timeMs);
  const gmst = gstime(date);
  let pv;
  try { pv = propagate(rec, date); } catch { return; }
  if (!pv?.position) return;
  const p = eciToEcf(pv.position, gmst);
  const r = Math.hypot(p.x, p.y, p.z);
  const lat = Math.asin(p.z / r) * 180 / Math.PI;
  const lon = Math.atan2(p.y, p.x) * 180 / Math.PI;
  const speed = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
  postMessage({ type: 'geodetic', index, lat, lon, alt: r - 6378.137, speed });
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    recs = m.gps.map((gp) => { try { return json2satrec(gp); } catch { return null; } });
    n = recs.length;
    postMessage({ type: 'loaded', n, failed: recs.filter((r) => !r).length });
  } else if (m.type === 'tick') tick(m.time, m.delta || 1000);
  else if (m.type === 'orbit') orbit(m.index, m.time);
  else if (m.type === 'geodetic') geodetic(m.index, m.time);
};
