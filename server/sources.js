// Remote data source fetching with disk caching.
import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
const UA = 'orbital-tracker/1.0 (local research app)';

async function ensureDirs() {
  await fs.mkdir(RAW_DIR, { recursive: true });
}

async function readIfFresh(file, maxAgeMs) {
  try {
    const st = await fs.stat(file);
    const age = Date.now() - st.mtimeMs;
    if (maxAgeMs === Infinity || age < maxAgeMs) return await fs.readFile(file, 'utf8');
  } catch {}
  return null;
}

async function readAny(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

export async function fetchText(url, { timeoutMs = 120000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...headers } });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJSON(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

/**
 * Fetch a text resource, caching on disk. Uses the cached copy when it is
 * younger than maxAgeMs, and falls back to a stale copy if the fetch fails.
 */
export async function cachedText(name, url, maxAgeMs, log = console.log) {
  await ensureDirs();
  const file = path.join(RAW_DIR, name);
  const fresh = await readIfFresh(file, maxAgeMs);
  if (fresh !== null) return { text: fresh, fromCache: true };
  try {
    log(`[fetch] ${url}`);
    const text = await fetchText(url);
    await fs.writeFile(file, text);
    return { text, fromCache: false };
  } catch (e) {
    const stale = await readAny(file);
    if (stale !== null) {
      log(`[fetch] failed (${e.message.slice(0, 120)}); using stale cache for ${name}`);
      return { text: stale, fromCache: true, stale: true };
    }
    throw e;
  }
}

const DAY = 24 * 3600 * 1000;

export const GCAT = {
  satcat: 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv',
  launch: 'https://planet4589.org/space/gcat/tsv/launch/launch.tsv',
  orgs: 'https://planet4589.org/space/gcat/tsv/tables/orgs.tsv',
  lv: 'https://planet4589.org/space/gcat/tsv/tables/lv.tsv',
  sites: 'https://planet4589.org/space/gcat/tsv/tables/sites.tsv',
};

export async function loadGcat(log) {
  const out = {};
  for (const [k, url] of Object.entries(GCAT)) {
    const { text } = await cachedText(`gcat_${k}.tsv`, url, DAY, log);
    out[k] = text;
  }
  return out;
}

export async function loadCelestrakSatcat(log) {
  const { text } = await cachedText('celestrak_satcat.csv', 'https://celestrak.org/pub/satcat.csv', DAY, log);
  return text;
}

// CelesTrak GP groups used as a fallback when the "active" group download is throttled.
const GP_GROUPS = ['starlink', 'oneweb', 'kuiper', 'qianfan', 'hulianwang', 'gps-ops', 'glo-ops', 'galileo', 'beidou',
  'sbas', 'nnss', 'musson', 'iridium', 'orbcomm', 'globalstar', 'planet', 'spire', 'weather', 'noaa', 'goes', 'resource',
  'sarsat', 'dmc', 'tdrss', 'argos', 'stations', 'science', 'geodetic', 'engineering', 'education', 'cubesat', 'other',
  'military', 'radar', 'intelsat', 'ses', 'amateur', 'x-comm', 'other-comm', 'gorizont', 'raduga', 'molniya', 'geo',
  'gpz', 'gpz-plus', 'visual', 'last-30-days'];

/**
 * Load general perturbations (OMM/TLE) data for all active satellites.
 * CelesTrak only allows one download of a group per update cycle (2 h), so
 * the result is cached in data/gp.json and reused until it is older than 2 h.
 */
export async function loadGP(log = console.log) {
  await ensureDirs();
  const file = path.join(DATA_DIR, 'gp.json');
  const TWO_H = 2 * 3600 * 1000 + 5 * 60 * 1000;
  const metaFile = path.join(DATA_DIR, 'gp-meta.json');
  const readMeta = async () => { try { return JSON.parse(await fs.readFile(metaFile, 'utf8')); } catch { return { source: 'groups' }; } };
  const writeMeta = (m) => fs.writeFile(metaFile, JSON.stringify(m));
  const fresh = await readIfFresh(file, TWO_H);
  // A complete "active" download is reused for 2 h; an assembled-from-groups set is retried against the active group every call.
  if (fresh && (await readMeta()).source === 'active') return { gp: JSON.parse(fresh), fromCache: true, updated: (await fs.stat(file)).mtime, source: 'active' };

  const parseGP = (text) => {
    const d = JSON.parse(text);
    if (!Array.isArray(d)) throw new Error('GP response is not an array');
    return d;
  };

  try {
    log('[fetch] CelesTrak GROUP=active');
    const text = await fetchText('https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json');
    const gp = parseGP(text);
    if (gp.length > 1000) {
      // Merge in anything from the previous set that the active group lacks (e.g. analyst or special-interest objects).
      const prev = await readAny(file);
      if (prev) { const have = new Set(gp.map((r) => r.NORAD_CAT_ID)); for (const r of JSON.parse(prev)) if (!have.has(r.NORAD_CAT_ID)) gp.push(r); }
      await fs.writeFile(file, JSON.stringify(gp));
      await writeMeta({ source: 'active', fetched: new Date().toISOString() });
      return { gp, fromCache: false, updated: new Date(), source: 'active' };
    }
  } catch (e) {
    log(`[fetch] active group unavailable: ${e.message.slice(0, 160)}`);
  }

  // Throttled or failed: if we have any cached copy, keep using it (bump mtime so we retry later, not constantly).
  const stale = await readAny(file);
  if (stale) {
    const st = await fs.stat(file);
    const meta = await readMeta();
    log(`[gp] using cached GP data (${meta.source}) from ${st.mtime.toISOString()}`);
    return { gp: JSON.parse(stale), fromCache: true, stale: Date.now() - st.mtimeMs > TWO_H, updated: st.mtime, source: meta.source };
  }

  // No cache at all: assemble from individual groups.
  log('[fetch] assembling GP data from CelesTrak groups');
  const byId = new Map();
  for (const g of GP_GROUPS) {
    try {
      const text = await fetchText(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`);
      for (const r of parseGP(text)) byId.set(r.NORAD_CAT_ID, r);
    } catch (e) {
      log(`[fetch] group ${g} failed: ${e.message.slice(0, 100)}`);
    }
  }
  const gp = [...byId.values()];
  if (gp.length) { await fs.writeFile(file, JSON.stringify(gp)); await writeMeta({ source: 'groups', fetched: new Date().toISOString() }); }
  return { gp, fromCache: false, updated: new Date(), source: 'groups' };
}
