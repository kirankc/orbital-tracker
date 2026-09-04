// Builds a fully static copy of the app (for GitHub Pages) by running the server locally and crawling its API.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DIST = path.join(ROOT, 'dist');
const PORT = 3123;
const BASE = `http://localhost:${PORT}`;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const slug = (s) => encodeURIComponent(s).replace(/%/g, '_');
async function get(p) { const r = await fetch(BASE + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); }
async function write(rel, data) { const f = path.join(DIST, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, typeof data === 'string' ? data : JSON.stringify(data)); }
async function copyDir(src, dst) { await fs.mkdir(dst, { recursive: true }); for (const e of await fs.readdir(src, { withFileTypes: true })) { const s = path.join(src, e.name), d = path.join(dst, e.name); if (e.isDirectory()) await copyDir(s, d); else await fs.copyFile(s, d); } }

async function waitReady(proc) {
  for (let i = 0; i < 600; i++) {
    if (proc.exitCode !== null) throw new Error('server exited early');
    try { const r = await fetch(`${BASE}/api/status`); if (r.ok) return r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not become ready');
}

const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'inherit', 'inherit'] });
try {
  const status = await waitReady(server);
  log('server ready', JSON.stringify(status.byOrbit));
  await fs.rm(DIST, { recursive: true, force: true });
  await copyDir(path.join(ROOT, 'public'), DIST);
  // Vendored libraries (same paths the dev server exposes under /vendor).
  await copyDir(path.join(ROOT, 'node_modules/three/build'), path.join(DIST, 'vendor/three/build')); // three.module.js + three.core.js
  await fs.mkdir(path.join(DIST, 'vendor/three/examples/jsm/controls'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'node_modules/three/examples/jsm/controls/OrbitControls.js'), path.join(DIST, 'vendor/three/examples/jsm/controls/OrbitControls.js'));
  await copyDir(path.join(ROOT, 'node_modules/satellite.js/dist'), path.join(DIST, 'vendor/satellite.js'));
  await write('.nojekyll', '');

  // Static data files mirroring the API.
  const sats = await get('/api/satellites');
  await write('data/satellites.json', sats);
  for (const [route, file] of [['/api/rockets', 'rockets.json'], ['/api/makers', 'makers.json'], ['/api/owners', 'owners.json'], ['/api/buses', 'buses.json'], ['/api/untracked', 'untracked.json'], ['/api/insights/launches', 'insights-launches.json'], ['/api/launches/upcoming', 'launches-upcoming.json'], ['/api/launches/recent', 'launches-recent.json']]) {
    try { await write(`data/${file}`, await get(route)); log('wrote', file); } catch (e) { log('WARN', route, e.message); }
  }
  const shards = await get('/api/details-shards');
  for (const sh of shards) await write(`data/details/${sh}.json`, await get(`/api/details-shard/${sh}`));
  log('wrote', shards.length, 'detail shards');

  // Profile cores (GCAT-derived); Launch Library / Wikipedia / news enrichment happens in the browser.
  const rockets = await get('/api/rockets');
  for (const r of rockets) { try { await write(`data/profiles/rocket/${slug(r.name)}.json`, await get(`/api/rocket?core=1&name=${encodeURIComponent(r.name)}`)); } catch (e) { log('WARN rocket', r.name, e.message); } }
  log('wrote', rockets.length, 'rocket profiles');
  const orgs = new Map();
  for (const m of [...await get('/api/makers'), ...await get('/api/owners')]) orgs.set(m.code, m);
  const rocketMakers = new Set(rockets.map((r) => r.manufacturerCode).filter(Boolean));
  for (const code of rocketMakers) if (!orgs.has(code)) orgs.set(code, { code });
  const nameIndex = {};
  let orgOk = 0;
  for (const [code] of orgs) {
    try {
      const core = await get(`/api/maker?core=1&code=${encodeURIComponent(code)}`);
      await write(`data/profiles/maker/${slug(code)}.json`, core);
      for (const n of [core.name, core.shortName, core.org?.localName]) if (n) nameIndex[n.toLowerCase()] = code;
      orgOk++;
    } catch (e) { log('WARN organisation', code, e.message); }
  }
  await write('data/profiles/maker-index.json', nameIndex);
  log('wrote', orgOk, 'organisation profiles');
  const buses = await get('/api/buses');
  for (const b of buses) { try { await write(`data/profiles/bus/${slug(b.name)}.json`, await get(`/api/bus?core=1&name=${encodeURIComponent(b.name)}`)); } catch (e) { log('WARN bus', b.name, e.message); } }
  log('wrote', buses.length, 'bus profiles');

  await write('js/config.js', `window.STATIC_BASE = 'data/';\nwindow.BUILT_AT = ${JSON.stringify(new Date().toISOString())};\n`);
  log('static build complete:', DIST);
} finally {
  server.kill();
}
