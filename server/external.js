// Wrappers around external APIs (Launch Library 2, Wikipedia, Wikidata, Spaceflight News) with caching and quota tracking.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchJSON, DATA_DIR } from './sources.js';

const CACHE_FILE = path.join(DATA_DIR, 'ext-cache.json');
const cache = new Map(); // key -> { t, v }
let dirty = false;

export async function loadExtCache() {
  try {
    const raw = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) cache.set(k, v);
  } catch {}
  setInterval(async () => {
    if (!dirty) return;
    dirty = false;
    try { await fs.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cache))); } catch {}
  }, 15000).unref();
}

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  try {
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    dirty = true;
    return v;
  } catch (e) {
    if (hit) return hit.v; // stale fallback
    throw e;
  }
}

const H = 3600 * 1000;
const D = 24 * H;

// ---- Launch Library 2 ------------------------------------------------------
// ll.thespacedevs.com is limited to 15 requests/hour; lldev has a higher limit but incomplete history.
const LL_PROD = 'https://ll.thespacedevs.com/2.3.0';
const LL_DEV = 'https://lldev.thespacedevs.com/2.3.0';
const prodCalls = [];
// Keep a few production calls per hour in reserve for the launch schedule (high priority).
function prodQuotaOk(priority = 'normal') {
  const now = Date.now();
  while (prodCalls.length && now - prodCalls[0] > H) prodCalls.shift();
  return prodCalls.length < (priority === 'high' ? 14 : 9);
}
// The dev mirror's media bucket is incomplete; the same files exist on the production bucket.
const DEV_MEDIA = /thespacedevs-dev\.nyc3\.digitaloceanspaces\.com/g;
function fixMedia(obj) {
  return JSON.parse(JSON.stringify(obj).replace(DEV_MEDIA, 'thespacedevs-prod.nyc3.digitaloceanspaces.com'));
}
async function llFetch(pathAndQuery, { preferProd = false, priority = 'normal' } = {}) {
  if (preferProd && prodQuotaOk(priority)) {
    try {
      prodCalls.push(Date.now());
      const d = await fetchJSON(`${LL_PROD}${pathAndQuery}`, { timeoutMs: 30000 });
      d._source = 'prod';
      return d;
    } catch (e) {
      if (e.status !== 429) throw e;
    }
  }
  const d = fixMedia(await fetchJSON(`${LL_DEV}${pathAndQuery}`, { timeoutMs: 30000 }));
  d._source = 'dev';
  return d;
}

// Stale-while-revalidate for the launch schedule: always answer from memory/disk immediately and refresh in the
// background when the copy is older than its TTL, so a page load never waits on Launch Library.
const swr = new Map(); // key -> { t, v, refreshing }
async function swrFetch(key, pathAndQuery, ttlProd, ttlDev) {
  let entry = swr.get(key);
  if (!entry && cache.get(key)) { entry = { t: cache.get(key).t, v: cache.get(key).v }; swr.set(key, entry); }
  const ttl = entry?.v.source === 'prod' ? ttlProd : ttlDev;
  const stale = !entry || Date.now() - entry.t > ttl;
  const refresh = async () => {
    try {
      const data = await llFetch(pathAndQuery, { preferProd: true, priority: 'high' });
      const v = { fetched: new Date().toISOString(), source: data._source, results: data.results, count: data.count };
      swr.set(key, { t: Date.now(), v });
      cache.set(key, { t: Date.now(), v }); dirty = true;
      return v;
    } finally { const e = swr.get(key); if (e) e.refreshing = false; }
  };
  if (entry) {
    if (stale && !entry.refreshing) { entry.refreshing = true; refresh().catch(() => {}); }
    return entry.v;
  }
  return refresh();
}
export const upcomingLaunches = () => swrFetch('ll:upcoming', '/launches/upcoming/?limit=100&mode=detailed&hide_recent_previous=true', 30 * 60 * 1000, 5 * 60 * 1000);
export const recentLaunches = () => swrFetch('ll:recent', '/launches/previous/?limit=60&mode=detailed', 60 * 60 * 1000, 10 * 60 * 1000);

export function launchByDesignator(tag) {
  return cached(`ll:launch:${tag}`, 30 * D, async () => {
    const data = await llFetch(`/launches/?launch_designator=${encodeURIComponent(tag)}&mode=detailed&limit=1`, { preferProd: true });
    return data.results?.[0] || null;
  });
}

// Map GCAT launch-vehicle names onto Launch Library naming.
const LV_ALIASES = [
  [/^Chang Zheng (\d\w*)/i, 'Long March $1'],
  [/^Soyuz-2-1(\w)/i, 'Soyuz 2.1$1'],
  [/^Soyuz-2\.1(\w)/i, 'Soyuz 2.1$1'],
  [/^Soyuz-FG/i, 'Soyuz FG'],
  [/^Soyuz-U/i, 'Soyuz U'],
  [/^Proton-M/i, 'Proton-M'],
  [/^GSLV Mk III/i, 'LVM3'],
  [/^Delta 4H/i, 'Delta IV Heavy'],
  [/^Delta 4M/i, 'Delta IV'],
  [/^Delta 7\d+/i, 'Delta II'],
  [/^Shian Quxian/i, 'Hyperbola'],
  [/^Gushenxing/i, 'Ceres'],
  [/^Kuaizhou-?1A/i, 'Kuaizhou'],
  [/^Jielong/i, 'Jielong'],
  [/^Zhuque/i, 'Zhuque'],
  [/^Tianlong/i, 'Tianlong'],
  [/^Lijian/i, 'Kinetica'],
  [/^Ariane 6/i, 'Ariane 6'],
  [/^Vega-C/i, 'Vega C'],
  [/^H-IIA/i, 'H-IIA'],
  [/^H3/i, 'H3'],
  [/^Epsilon/i, 'Epsilon'],
  [/^Nuri|^KSLV/i, 'Nuri'],
  [/^Vulcan/i, 'Vulcan'],
  [/^Antares/i, 'Antares'],
  [/^Minotaur/i, 'Minotaur'],
  [/^Pegasus/i, 'Pegasus'],
  [/^Firefly Alpha|^Alpha/i, 'Firefly Alpha'],
  [/^Qased/i, 'Qased'],
  [/^Simorgh/i, 'Simorgh'],
  [/^Shavit/i, 'Shavit'],
  [/^Angara/i, 'Angara'],
  [/^Rokot/i, 'Rokot'],
];
export function llRocketSearchName(gcatName) {
  for (const [re, rep] of LV_ALIASES) if (re.test(gcatName)) return gcatName.replace(re, rep);
  return gcatName;
}

function similarity(a, b) {
  a = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  b = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (a === b) return 1;
  if (a.startsWith(b) || b.startsWith(a)) return 0.8;
  if (a.includes(b) || b.includes(a)) return 0.6;
  return 0;
}

export function launcherConfigs(gcatName) {
  const q = llRocketSearchName(gcatName);
  return cached(`ll:lc:${q}`, 7 * D, async () => {
    const tryQ = async (s) => {
      const data = await llFetch(`/launcher_configurations/?search=${encodeURIComponent(s)}&mode=detailed&limit=15`);
      return data.results || [];
    };
    let results = await tryQ(q);
    if (!results.length && q.includes(' ')) results = await tryQ(q.split(' ').slice(0, 2).join(' '));
    if (!results.length && q.includes(' ')) results = await tryQ(q.split(' ')[0]);
    results.sort((a, b) => similarity(b.name, q) + (b.full_name ? similarity(b.full_name, q) * 0.5 : 0) - (similarity(a.name, q) + (a.full_name ? similarity(a.full_name, q) * 0.5 : 0)));
    return { query: q, results };
  });
}

export function agencySearch(name) {
  return cached(`ll:agency:${name}`, 7 * D, async () => {
    const data = await llFetch(`/agencies/?search=${encodeURIComponent(name)}&mode=detailed&limit=10`);
    const results = (data.results || []).sort((a, b) => Math.max(similarity(b.name, name), similarity(b.abbrev || '', name)) - Math.max(similarity(a.name, name), similarity(a.abbrev || '', name)));
    return results;
  });
}

export function launchesForRocket(lcId) {
  return cached(`ll:lc-launches:${lcId}`, 12 * H, async () => {
    const data = await llFetch(`/launches/?rocket__configuration__id=${lcId}&mode=list&limit=20&ordering=-net`);
    return data.results || [];
  });
}

// ---- Wikipedia / Wikidata -------------------------------------------------
const WIKI_HEADERS = { 'Api-User-Agent': 'orbital-tracker/1.0 (local research app)' };
const SOCIAL_PROPS = {
  P856: { name: 'Official website', fmt: (v) => v },
  P2002: { name: 'X (Twitter)', fmt: (v) => `https://x.com/${v}` },
  P2003: { name: 'Instagram', fmt: (v) => `https://www.instagram.com/${v}/` },
  P2013: { name: 'Facebook', fmt: (v) => `https://www.facebook.com/${v}` },
  P2397: { name: 'YouTube', fmt: (v) => `https://www.youtube.com/channel/${v}` },
  P4264: { name: 'LinkedIn', fmt: (v) => `https://www.linkedin.com/company/${v}/` },
  P4033: { name: 'Mastodon', fmt: (v) => { const [u, h] = v.split('@'); return `https://${h}/@${u}`; } },
  P11245: { name: 'Bluesky', fmt: (v) => `https://bsky.app/profile/${v}` },
  P7085: { name: 'TikTok', fmt: (v) => `https://www.tiktok.com/@${v}` },
  P3789: { name: 'Telegram', fmt: (v) => `https://t.me/${v}` },
  P2397: { name: 'YouTube', fmt: (v) => `https://www.youtube.com/channel/${v}` },
};

export function wikiSummary(title) {
  return cached(`wiki:sum:${title}`, 7 * D, async () => {
    const enc = encodeURIComponent(title.replace(/ /g, '_'));
    try {
      const s = await fetchJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc}?redirect=true`, { headers: WIKI_HEADERS, timeoutMs: 20000 });
      if (s.type === 'disambiguation') return { disambiguation: true, title: s.title, url: s.content_urls?.desktop?.page };
      return {
        title: s.title,
        description: s.description,
        extract: s.extract,
        extractHtml: s.extract_html,
        thumbnail: s.thumbnail?.source,
        image: s.originalimage?.source,
        url: s.content_urls?.desktop?.page,
        wikidata: s.wikibase_item,
      };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  });
}

export function wikiSearch(query) {
  return cached(`wiki:search:${query}`, 7 * D, async () => {
    const d = await fetchJSON(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`, { headers: WIKI_HEADERS, timeoutMs: 20000 });
    return (d.query?.search || []).map((r) => ({ title: r.title, snippet: r.snippet.replace(/<[^>]+>/g, ''), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}` }));
  });
}

export function wikiExtract(title) {
  return cached(`wiki:extract:${title}`, 7 * D, async () => {
    const d = await fetchJSON(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(title)}&format=json&redirects=1`, { headers: WIKI_HEADERS, timeoutMs: 30000 });
    const pages = d.query?.pages || {};
    const p = Object.values(pages)[0];
    return p?.extract ? p.extract.slice(0, 12000) : null;
  });
}

export function wikidataLinks(qid) {
  return cached(`wd:${qid}`, 30 * D, async () => {
    const props = Object.keys(SOCIAL_PROPS).join('|');
    const d = await fetchJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims|sitelinks&format=json`, { headers: WIKI_HEADERS, timeoutMs: 20000 });
    const ent = d.entities?.[qid];
    if (!ent) return { links: [] };
    const links = [];
    for (const [p, meta] of Object.entries(SOCIAL_PROPS)) {
      const claims = ent.claims?.[p];
      if (!claims) continue;
      for (const c of claims.slice(0, 2)) {
        const v = c.mainsnak?.datavalue?.value;
        if (typeof v === 'string') links.push({ name: meta.name, url: meta.fmt(v), handle: v });
      }
    }
    return { links, props: undefined };
  });
}

// ---- Spaceflight News API -------------------------------------------------
export function news(query, limit = 12) {
  return cached(`news:${query}:${limit}`, 45 * 60 * 1000, async () => {
    const d = await fetchJSON(`https://api.spaceflightnewsapi.net/v4/articles/?search=${encodeURIComponent(query)}&limit=${limit}&ordering=-published_at`, { timeoutMs: 20000 });
    return (d.results || []).map((a) => ({
      id: a.id, title: a.title, url: a.url, image: a.image_url, site: a.news_site, summary: a.summary, published: a.published_at,
      authors: (a.authors || []).map((x) => x.name),
    }));
  });
}
