import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from './catalog.js';
import * as ext from './external.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(compression());
app.disable('x-powered-by');

let catalog = null;
let building = null;
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function refresh() {
  if (building) return building;
  building = buildCatalog(log).then((c) => { catalog = c; building = null; return c; }).catch((e) => { building = null; log('[catalog] build failed', e); throw e; });
  return building;
}

// Check for fresh GP data every 15 min. A complete 'active' set is only re-fetched after 2 h (CelesTrak cadence);
// a set assembled from thematic groups keeps retrying the throttled 'active' group until it succeeds.
setInterval(() => { if (!building) refresh().catch(() => {}); }, 15 * 60 * 1000).unref();

function ready(req, res, next) {
  if (catalog) return next();
  refresh().then(() => next()).catch((e) => res.status(503).json({ error: 'catalog not ready', detail: e.message }));
}

// Static assets: app + vendored libraries served from node_modules.
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules/three'), { maxAge: '7d', immutable: true }));
app.use('/vendor/satellite.js', express.static(path.join(ROOT, 'node_modules/satellite.js/dist'), { maxAge: '7d', immutable: true }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], etag: true, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

const strip = (o) => { const { gp, ...rest } = o; return rest; };

app.get('/api/status', ready, (req, res) => res.json(catalog.stats));

// Compact list of every tracked object with elements for client-side propagation.
app.get('/api/satellites', ready, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ stats: catalog.stats, satellites: catalog.list });
});

app.get('/api/satellite/:id', ready, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d = catalog.details.get(id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const out = { ...d };
  if (req.query.ll !== '0' && d.launch?.tag) {
    try {
      const l = await ext.launchByDesignator(d.launch.tag);
      if (l) {
        out.ll2 = {
          id: l.id, name: l.name, slug: l.slug, net: l.net, status: l.status?.name, image: l.image?.image_url,
          provider: l.launch_service_provider ? { id: l.launch_service_provider.id, name: l.launch_service_provider.name, abbrev: l.launch_service_provider.abbrev } : null,
          rocket: l.rocket?.configuration ? { id: l.rocket.configuration.id, name: l.rocket.configuration.name, fullName: l.rocket.configuration.full_name } : null,
          mission: l.mission ? { name: l.mission.name, description: l.mission.description, type: l.mission.type, orbit: l.mission.orbit?.name, agencies: (l.mission.agencies || []).map((a) => ({ id: a.id, name: a.name, type: a.type?.name })) } : null,
          pad: l.pad ? { name: l.pad.name, location: l.pad.location?.name, mapUrl: l.pad.map_url, wiki: l.pad.wiki_url } : null,
          videos: (l.vid_urls || []).map((v) => ({ title: v.title, url: v.url, source: v.source, publisher: v.publisher })),
          infoUrls: (l.info_urls || []).map((v) => ({ title: v.title, url: v.url })),
          patches: (l.mission_patches || []).map((p) => ({ name: p.name, image: p.image_url })),
          programs: (l.program || []).map((p) => ({ name: p.name, url: p.info_url, wiki: p.wiki_url })),
        };
      }
    } catch (e) {
      out.ll2Error = e.message.slice(0, 200);
    }
  }
  res.json(out);
});

// Indexes ---------------------------------------------------------------------
const noSats = ({ sats, ...r }) => r;
app.get('/api/rockets', ready, (req, res) => res.json(catalog.rocketList.map(noSats)));
app.get('/api/makers', ready, (req, res) => res.json(catalog.makerList.map(noSats)));
app.get('/api/owners', ready, (req, res) => res.json(catalog.ownerList.map(noSats)));
app.get('/api/buses', ready, (req, res) => res.json(catalog.busList.map(noSats)));
app.get('/api/insights/launches', ready, (req, res) => { res.set('Cache-Control', 'no-cache'); res.json(catalog.launchHistory); });
app.get('/api/untracked', ready, (req, res) => res.json({ coverage: catalog.stats.coverage, objects: catalog.untracked }));

const byId = () => { if (!catalog._byId) { catalog._byId = new Map(catalog.list.map((s) => [s.id, s])); } return catalog._byId; };
const satRows = (ids) => ids.map((id) => byId().get(id)).filter(Boolean).map(strip).sort((a, b) => (b.launched || '').localeCompare(a.launched || '') || a.name.localeCompare(b.name));

function satsBy(pred) {
  return catalog.list.filter(pred).map(strip);
}

function settle(promises) {
  return Promise.all(promises.map((p) => Promise.resolve(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.message }))));
}

// Rocket detail: GCAT + Launch Library + Wikipedia + news.
app.get('/api/rocket', ready, async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  let r = catalog.rockets.get(name);
  let resolvedName = name;
  if (!r) {
    // Accept Launch Library style names (e.g. "Falcon 9 Block 5", "Long March 2D") and map them onto GCAT vehicle names.
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(name);
    const lcp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
    let best = null;
    let bestScore = 0;
    for (const cand of catalog.rocketList) {
      for (const variant of [cand.name, ext.llRocketSearchName(cand.name), cand.family || '']) {
        if (!variant) continue;
        const v = norm(variant);
        // Exact match wins; otherwise score by shared prefix relative to the longer name, so "Starship" prefers
        // "Starship V3" (8/10) over "STARS" (5/8). Ties go to the most recently flown vehicle.
        let score = v === target ? 3 : lcp(v, target) / Math.max(v.length, target.length);
        if (score < 0.5) continue;
        if (variant === cand.family && score < 3) score *= 0.98; // family-name match slightly below a type-name match
        const tie = best && Math.abs(score - bestScore) < 1e-9 && ((cand.launches?.last || '') > (best.launches?.last || ''));
        if (score > bestScore || tie) { bestScore = score; best = cand; }
      }
    }
    if (best) { r = best; resolvedName = best.name; }
  }
  const lvVariants = [...catalog.lvs.values()].filter((l) => l.LV_Name === resolvedName).map((l) => ({
    variant: l.LV_Variant === '-' ? null : l.LV_Variant, family: l.LV_Family, manufacturerCode: l.LV_Manufacturer,
    stages: parseFloat(l.LV_Max_Stage) || null, length: parseFloat(l.Length) || null, diameter: parseFloat(l.Diameter) || null,
    launchMass: parseFloat(l.Launch_Mass) || null, leoCapacity: parseFloat(l.LEO_Capacity) || null, gtoCapacity: parseFloat(l.GTO_Capacity) || null, thrust: parseFloat(l.TO_Thrust) || null,
  }));
  const mfCode = r?.manufacturerCode || lvVariants[0]?.manufacturerCode;
  const mfOrg = mfCode ? catalog.orgs.get(mfCode) : null;
  const searchName = ext.llRocketSearchName(name);
  const [lc, wiki, newsR] = await settle([ext.launcherConfigs(name), ext.wikiSummary(searchName), ext.news(searchName)]);
  let ll2 = null;
  let ll2Launches = [];
  if (lc.ok && lc.v.results.length) {
    const best = lc.v.results[0];
    ll2 = best;
    const l = await settle([ext.launchesForRocket(best.id)]);
    if (l[0].ok) ll2Launches = l[0].v;
  }
  // Prefer the Launch Library's curated Wikipedia link (e.g. "SpaceX Starship", not the sci-fi "Starship" article).
  const ROCKETY = /rocket|launch|vehicle|booster|spaceflight|orbital|missile|space/i;
  let wikiRes = null;
  if (ll2?.wiki_url) {
    const t = decodeURIComponent(ll2.wiki_url.split('/wiki/')[1] || '').replace(/_/g, ' ');
    const w2 = await settle([ext.wikiSummary(t)]);
    if (w2[0].ok && w2[0].v && !w2[0].v.disambiguation) wikiRes = w2[0].v;
  }
  if (!wikiRes && wiki.ok && wiki.v && !wiki.v.disambiguation && ROCKETY.test(`${wiki.v.description || ''} ${(wiki.v.extract || '').slice(0, 300)}`)) wikiRes = wiki.v;
  if (!wikiRes) {
    const ws = await settle([ext.wikiSearch(`${searchName} rocket`)]);
    if (ws[0].ok && ws[0].v.length) {
      const w3 = await settle([ext.wikiSummary(ws[0].v[0].title)]);
      if (w3[0].ok && w3[0].v && !w3[0].v.disambiguation) wikiRes = w3[0].v;
    }
  }
  const [extract, wd] = await settle([wikiRes?.title ? ext.wikiExtract(wikiRes.title) : null, wikiRes?.wikidata ? ext.wikidataLinks(wikiRes.wikidata) : null]);
  let upcoming = [];
  try {
    const up = await ext.upcomingLaunches();
    const key = searchName.toLowerCase().split(' ')[0];
    upcoming = up.results.filter((l) => (l.rocket?.configuration?.name || '').toLowerCase().includes(key) || (ll2 && l.rocket?.configuration?.id === ll2.id) || (ll2 && (l.rocket?.configuration?.families || []).some((f) => (ll2.families || []).some((g) => g.id === f.id)))).slice(0, 12)
      .map((l) => ({ id: l.id, name: l.name, net: l.net, status: l.status?.name, provider: l.launch_service_provider?.name, pad: l.pad?.name, location: l.pad?.location?.name, image: l.image?.image_url, rocket: l.rocket?.configuration?.name }));
  } catch {}
  res.json({
    name: resolvedName,
    requestedName: name,
    searchName,
    history: catalog.lvStats.get(resolvedName) || null,
    familyHistory: (() => { const fam = r?.family || lvVariants[0]?.family; if (!fam) return []; return [...catalog.lvs.values()].filter((l) => l.LV_Family === fam).map((l) => l.LV_Name).filter((n, i, a) => a.indexOf(n) === i && n !== resolvedName).map((n) => ({ name: n, ...(catalog.lvStats.get(n) || {}) })).filter((x) => x.total).sort((a, b) => (b.last || '').localeCompare(a.last || '')); })(),
    gcat: r ? { ...noSats(r), manufacturerOrg: mfOrg ? { code: mfOrg.Code, name: mfOrg.EName !== '-' ? mfOrg.EName : mfOrg.Name, state: mfOrg.StateCode, location: mfOrg.Location } : null, variants: r.variants } : null,
    lvVariants,
    satellites: r ? satRows(r.sats).slice(0, 400) : [],
    satelliteCount: r?.count || 0,
    ll2,
    ll2Candidates: lc.ok ? lc.v.results.slice(0, 5).map((c) => ({ id: c.id, name: c.name, full_name: c.full_name })) : [],
    ll2Launches: ll2Launches.map((l) => ({ id: l.id, name: l.name, net: l.net, status: l.status?.name, image: l.image?.image_url, pad: l.pad?.name, location: l.pad?.location?.name, provider: l.launch_service_provider?.name })),
    upcoming,
    wiki: wikiRes,
    wikiExtract: extract.ok ? extract.v : null,
    links: wd.ok && wd.v ? wd.v.links : [],
    news: newsR.ok ? newsR.v : [],
    errors: [lc, wiki, newsR].filter((x) => !x.ok).map((x) => x.e),
  });
});

// Manufacturer / agency detail.
app.get('/api/maker', ready, async (req, res) => {
  const code = (req.query.code || '').trim();
  const nameQ = (req.query.name || '').trim();
  let org = code ? catalog.orgs.get(code) : null;
  if (!org && nameQ) org = [...catalog.orgs.values()].find((o) => o.EName === nameQ || o.Name === nameQ || o.ShortEName === nameQ || o.ShortName === nameQ) || null;
  if (!org && !nameQ) return res.status(404).json({ error: 'unknown organisation' });
  const display = org ? (org.EName !== '-' ? org.EName : org.Name) : nameQ;
  const short = org ? (org.ShortEName !== '-' ? org.ShortEName : org.ShortName) : nameQ;
  const maker = org ? catalog.makers.get(org.Code) : null;
  const owner = org ? catalog.owners.get(org.Code) : null;
  const rockets = org ? catalog.rocketList.filter((r) => r.manufacturerCode === org.Code).map(noSats) : [];
  // Organisation names in GCAT carry site qualifiers ("Lockheed Martin Space Systems (Denver), Astronautics Operations").
  // Build a cascade of progressively shorter candidate names for encyclopedia / Launch Library lookups.
  const cleanName = (n) => n.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').split(/[,:/]/)[0].replace(/\s+/g, ' ').trim();
  const searchName = cleanName(display);
  const parentOrg = org?.Parent && org.Parent !== '-' ? catalog.orgs.get(org.Parent) : null;
  const parentName = parentOrg ? cleanName(parentOrg.EName !== '-' ? parentOrg.EName : parentOrg.Name) : null;
  const candidates = [];
  const pushC = (n) => { if (n && n.length >= 3 && !candidates.includes(n)) candidates.push(n); };
  pushC(searchName);
  if (short && short.length >= 4 && !/^[A-Z0-9]+$/.test(short)) pushC(cleanName(short));
  const words = searchName.split(' ');
  for (let k = words.length - 1; k >= 2; k--) pushC(words.slice(0, k).join(' '));
  if (short && short.length >= 3) pushC(short);
  pushC(parentName);
  const RELEVANT = /space|aero|satellit|rocket|launch|defen|agency|compan|corporation|manufactur|research|institute|universit|air force|navy|army|ministry|military|telecom|communications|government|bureau|laborator|academy|observator|forces|consortium|operator|enterprise|design/i;
  const [agencies, newsR] = await settle([ext.agencySearch(short.length >= 3 ? short : searchName), ext.news(candidates[0] || searchName)]);
  let ll2 = agencies.ok && agencies.v.length ? agencies.v[0] : null;
  const llMatches = (a, n) => a && n && [a.name, a.abbrev].some((x) => x && (x.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(x.toLowerCase())));
  if (ll2 && !candidates.some((n) => llMatches(ll2, n))) ll2 = null;
  if (!ll2) {
    for (const n of candidates.slice(0, 4)) {
      const r = await settle([ext.agencySearch(n)]);
      const hit = r[0].ok ? r[0].v.find((a) => llMatches(a, n)) : null;
      if (hit) { ll2 = hit; break; }
    }
  }
  let wikiRes = null;
  const wikiOk = (w) => w && !w.disambiguation && RELEVANT.test(`${w.description || ''} ${(w.extract || '').slice(0, 400)}`);
  for (const n of candidates) {
    const w = await settle([ext.wikiSummary(n)]);
    if (w[0].ok && wikiOk(w[0].v)) { wikiRes = w[0].v; break; }
  }
  if (!wikiRes && ll2?.wiki_url) {
    const t = decodeURIComponent(ll2.wiki_url.split('/wiki/')[1] || '').replace(/_/g, ' ');
    const w2 = await settle([ext.wikiSummary(t)]);
    if (w2[0].ok && w2[0].v && !w2[0].v.disambiguation) wikiRes = w2[0].v;
  }
  if (!wikiRes) {
    for (const n of candidates.slice(0, 3)) {
      const ws = await settle([ext.wikiSearch(`${n} space`)]);
      if (ws[0].ok && ws[0].v.length) {
        const w3 = await settle([ext.wikiSummary(ws[0].v[0].title)]);
        if (w3[0].ok && wikiOk(w3[0].v)) { wikiRes = w3[0].v; break; }
      }
    }
  }
  let newsItems = newsR.ok ? newsR.v : [];
  if (!newsItems.length) {
    for (const n of candidates.slice(1, 5)) {
      const r = await settle([ext.news(n)]);
      if (r[0].ok && r[0].v.length) { newsItems = r[0].v; break; }
    }
  }
  const [extract, wd] = await settle([wikiRes?.title ? ext.wikiExtract(wikiRes.title) : null, wikiRes?.wikidata ? ext.wikidataLinks(wikiRes.wikidata) : null]);
  let upcoming = [];
  try {
    const up = await ext.upcomingLaunches();
    upcoming = up.results.filter((l) => (ll2 && l.launch_service_provider?.id === ll2.id) || (l.mission?.agencies || []).some((a) => ll2 && a.id === ll2.id) || (l.rocket?.configuration?.families || []).some((f) => (f.manufacturer || []).some((m) => ll2 && m.id === ll2.id)))
      .slice(0, 12).map((l) => ({ id: l.id, name: l.name, net: l.net, status: l.status?.name, provider: l.launch_service_provider?.name, pad: l.pad?.name, location: l.pad?.location?.name, image: l.image?.image_url, rocket: l.rocket?.configuration?.name }));
  } catch {}
  const built = maker ? satRows(maker.sats) : [];
  const operated = owner ? satRows(owner.sats) : [];
  const builtIds = new Set(built.map((x) => x.id));
  const operatedIds = new Set(operated.map((x) => x.id));
  const combined = [...built, ...operated.filter((x) => !builtIds.has(x.id))]
    .map((x) => ({ ...x, role: builtIds.has(x.id) && operatedIds.has(x.id) ? 'Built & operated' : builtIds.has(x.id) ? 'Built' : 'Operated' }))
    .sort((a, b) => (b.launched || '').localeCompare(a.launched || '') || a.name.localeCompare(b.name));
  res.json({
    code: org?.Code || null,
    name: display,
    shortName: short,
    org: org ? { code: org.Code, name: display, shortName: short, localName: org.Name !== display ? org.Name : null, class: org.Class, classLabel: { A: 'Academic / research', B: 'Business / commercial', C: 'Civil government', D: 'Defense / military' }[org.Class] || org.Class, type: org.Type, state: org.StateCode, stateName: catalog.orgs.get(org.StateCode)?.ShortEName || org.StateCode, location: org.Location !== '-' ? org.Location : null, parent: org.Parent !== '-' ? org.Parent : null, parentName: catalog.orgs.get(org.Parent)?.EName || null, start: org.TStart !== '-' ? org.TStart : null, stop: org.TStop !== '-' ? org.TStop : null, lat: parseFloat(org.Latitude) || null, lon: parseFloat(org.Longitude) || null } : null,
    builtCount: maker?.count || 0,
    operatedCount: owner?.count || 0,
    buses: maker ? Object.entries(maker.buses).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) : [],
    satellites: combined.slice(0, 500),
    satelliteCount: combined.length,
    rockets,
    ll2,
    upcoming,
    wiki: wikiRes,
    wikiExtract: extract.ok ? extract.v : null,
    links: wd.ok && wd.v ? wd.v.links : [],
    news: newsItems,
    candidates,
    errors: [agencies, newsR].filter((x) => !x.ok).map((x) => x.e),
  });
});

// Satellite bus / model detail.
app.get('/api/bus', ready, async (req, res) => {
  const name = (req.query.name || '').trim();
  const b = catalog.buses.get(name);
  if (!b) return res.status(404).json({ error: 'unknown bus' });
  const mfName = Object.entries(b.manufacturers).sort((x, y) => y[1] - x[1])[0]?.[0];
  const q = /^(starlink|oneweb|kuiper|iridium|globalstar|orbcomm|planet|dove|flock|lemur)/i.test(name) ? name : `${name} satellite bus`;
  const [ws, newsR] = await settle([ext.wikiSearch(q), ext.news(name)]);
  let wikiRes = null;
  if (ws.ok && ws.v.length) {
    const w = await settle([ext.wikiSummary(ws.v[0].title)]);
    if (w[0].ok && w[0].v && !w[0].v.disambiguation) wikiRes = w[0].v;
  }
  const [extract] = await settle([wikiRes?.title ? ext.wikiExtract(wikiRes.title) : null]);
  const sats = satRows(b.sats).slice(0, 400);
  const makerCodes = [...new Set(sats.map((s) => s.mfCode).filter(Boolean))];
  res.json({
    name,
    count: b.count,
    mil: b.mil,
    manufacturers: Object.entries(b.manufacturers).sort((x, y) => y[1] - x[1]).map(([n, c]) => ({ name: n, count: c, code: catalog.list.find((s) => s.mf === n)?.mfCode || null })),
    primaryManufacturer: mfName,
    makerCodes,
    satellites: sats,
    orbits: sats.reduce((a, s) => ((a[s.orbit] = (a[s.orbit] || 0) + 1), a), {}),
    firstLaunch: sats.map((s) => s.launched).filter(Boolean).sort()[0] || null,
    lastLaunch: sats.map((s) => s.launched).filter(Boolean).sort().at(-1) || null,
    wiki: wikiRes,
    wikiSearch: ws.ok ? ws.v : [],
    wikiExtract: extract.ok ? extract.v : null,
    news: newsR.ok ? newsR.v : [],
  });
});

// Trim Launch Library launch objects to what the launches page renders (cuts the payload ~8x).
const pickImg = (im) => (im ? { image_url: im.image_url, thumbnail_url: im.thumbnail_url } : null);
const pickAgency = (a) => (a ? { id: a.id, name: a.name, abbrev: a.abbrev, type: a.type ? { name: a.type.name } : null, info_url: a.info_url, social_media_links: (a.social_media_links || []).map((l) => ({ url: l.url, social_media: { name: l.social_media?.name } })) } : null);
function trimLaunch(l) {
  const cfg = l.rocket?.configuration;
  const mfr = cfg?.manufacturer || cfg?.families?.[0]?.manufacturer?.[0];
  return {
    id: l.id, slug: l.slug, name: l.name, net: l.net, net_precision: l.net_precision ? { name: l.net_precision.name } : null, window_start: l.window_start, window_end: l.window_end,
    status: l.status ? { name: l.status.name, abbrev: l.status.abbrev, description: l.status.description } : null, last_updated: l.last_updated, image: pickImg(l.image),
    probability: l.probability, weather_concerns: l.weather_concerns, holdreason: l.holdreason, failreason: l.failreason, hashtag: l.hashtag, launch_designator: l.launch_designator, flightclub_url: l.flightclub_url,
    launch_service_provider: pickAgency(l.launch_service_provider),
    rocket: { configuration: cfg ? { id: cfg.id, name: cfg.name, full_name: cfg.full_name, families: (cfg.families || []).map((f) => ({ id: f.id, name: f.name })), manufacturer: mfr ? { id: mfr.id, name: mfr.name } : null, info_url: cfg.info_url, wiki_url: cfg.wiki_url, leo_capacity: cfg.leo_capacity, total_launch_count: cfg.total_launch_count, successful_launches: cfg.successful_launches, failed_launches: cfg.failed_launches, consecutive_successful_launches: cfg.consecutive_successful_launches } : null },
    mission: l.mission ? { name: l.mission.name, description: l.mission.description, type: l.mission.type, orbit: l.mission.orbit ? { name: l.mission.orbit.name, abbrev: l.mission.orbit.abbrev } : null, agencies: (l.mission.agencies || []).map((a) => ({ id: a.id, name: a.name, type: a.type ? { name: a.type.name } : null })) } : null,
    pad: l.pad ? { name: l.pad.name, map_url: l.pad.map_url, wiki_url: l.pad.wiki_url, location: l.pad.location ? { name: l.pad.location.name } : null, country: l.pad.country ? { name: l.pad.country.name } : null } : null,
    program: (l.program || []).map((p) => ({ name: p.name, wiki_url: p.wiki_url, info_url: p.info_url })),
    orbital_launch_attempt_count: l.orbital_launch_attempt_count, orbital_launch_attempt_count_year: l.orbital_launch_attempt_count_year, agency_launch_attempt_count: l.agency_launch_attempt_count, agency_launch_attempt_count_year: l.agency_launch_attempt_count_year, pad_launch_attempt_count: l.pad_launch_attempt_count, pad_turnaround: l.pad_turnaround,
    vid_urls: (l.vid_urls || []).map((v) => ({ title: v.title, url: v.url, source: v.source, publisher: v.publisher })), info_urls: (l.info_urls || []).map((v) => ({ title: v.title, url: v.url })),
    mission_patches: (l.mission_patches || []).map((p) => ({ name: p.name, image_url: p.image_url })), updates: (l.updates || []).slice(0, 3).map((u) => ({ created_on: u.created_on, comment: u.comment, info_url: u.info_url })),
    objects: l.objects, objectCount: l.objectCount, objectOrbits: l.objectOrbits, objectMil: l.objectMil,
  };
}

app.get('/api/launches/upcoming', async (req, res) => {
  try {
    const up = await ext.upcomingLaunches();
    res.set('Cache-Control', 'no-cache');
    res.json({ ...up, results: up.results.map(trimLaunch) });
  } catch (e) {
    res.status(502).json({ error: 'Launch Library unavailable', detail: e.message.slice(0, 200) });
  }
});

// Recent launches, cross-referenced with the live catalog: which payloads from each launch are in orbit now.
app.get('/api/launches/recent', ready, async (req, res) => {
  try {
    const rec = await ext.recentLaunches();
    const byTag = new Map();
    for (const s of catalog.list) { const tag = s.cospar.replace(/[A-Z]+$/, ''); if (!byTag.has(tag)) byTag.set(tag, []); byTag.get(tag).push(s); }
    const results = rec.results.map((l) => {
      let objects = l.launch_designator ? (byTag.get(l.launch_designator) || []) : [];
      if (!objects.length && l.net) {
        // No designator yet: match catalog objects launched the same day from the same GCAT launch record.
        const day = l.net.slice(0, 10);
        objects = catalog.list.filter((s) => s.launched && s.launched.slice(0, 10) === day && (!l.launch_designator || s.cospar.startsWith(l.launch_designator)));
        if (objects.length > 200) objects = [];
      }
      const compact = objects.sort((a, b) => a.name.localeCompare(b.name)).map(strip);
      return { ...l, objects: compact.slice(0, 120), objectCount: compact.length, objectOrbits: compact.reduce((a, o) => ((a[o.orbit] = (a[o.orbit] || 0) + 1), a), {}), objectMil: compact.filter((o) => o.mil).length };
    });
    res.set('Cache-Control', 'no-cache');
    res.json({ ...rec, results: results.map(trimLaunch) });
  } catch (e) {
    res.status(502).json({ error: 'Launch Library unavailable', detail: e.message.slice(0, 200) });
  }
});

app.get('/api/news', async (req, res) => {
  try { res.json(await ext.news(req.query.q || 'satellite', Math.min(+req.query.limit || 12, 40))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/search', ready, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  res.json(catalog.list.filter((s) => s.name.toLowerCase().includes(q) || (s.gname || '').toLowerCase().includes(q) || s.cospar.toLowerCase().includes(q) || String(s.id) === q).slice(0, 50).map(strip));
});

app.use((err, req, res, next) => {
  log('[error]', err);
  res.status(500).json({ error: err.message });
});

ext.loadExtCache().then(() => refresh()).then(() => {
  app.listen(PORT, () => log(`Orbital tracker listening on http://localhost:${PORT}`));
  // Keep the launch schedule warm so page loads never wait on Launch Library.
  const warm = () => { ext.upcomingLaunches().catch(() => {}); ext.recentLaunches().catch(() => {}); };
  warm();
  setInterval(warm, 10 * 60 * 1000).unref();
}).catch((e) => {
  log('Startup failed:', e);
  process.exit(1);
});
