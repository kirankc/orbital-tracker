// Browser-side profile enrichment for the static (GitHub Pages) build: Launch Library, Wikipedia, Wikidata and
// Spaceflight News are queried directly from the viewer's browser (all four allow cross-origin requests).
const LL = 'https://lldev.thespacedevs.com/2.3.0';
const fixMedia = (s) => s.replaceAll('thespacedevs-dev.nyc3.digitaloceanspaces.com', 'thespacedevs-prod.nyc3.digitaloceanspaces.com');
async function j(url) { const r = await fetch(url); if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }); return JSON.parse(fixMedia(await r.text())); }
const settle = (ps) => Promise.all(ps.map((p) => Promise.resolve(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.message }))));

const LV_ALIASES = [[/^Chang Zheng (\d\w*)/i, 'Long March $1'], [/^Soyuz-2-1(\w)/i, 'Soyuz 2.1$1'], [/^Soyuz-2\.1(\w)/i, 'Soyuz 2.1$1'], [/^Soyuz-FG/i, 'Soyuz FG'], [/^Soyuz-U/i, 'Soyuz U'], [/^GSLV Mk III/i, 'LVM3'], [/^Delta 4H/i, 'Delta IV Heavy'], [/^Delta 4M/i, 'Delta IV'], [/^Delta 7\d+/i, 'Delta II'], [/^Shian Quxian/i, 'Hyperbola'], [/^Gushenxing/i, 'Ceres'], [/^Kuaizhou-?1A/i, 'Kuaizhou'], [/^Jielong/i, 'Jielong'], [/^Zhuque/i, 'Zhuque'], [/^Tianlong/i, 'Tianlong'], [/^Lijian/i, 'Kinetica'], [/^Ariane 6/i, 'Ariane 6'], [/^Vega-C/i, 'Vega C'], [/^Nuri|^KSLV/i, 'Nuri'], [/^Vulcan/i, 'Vulcan'], [/^Antares/i, 'Antares'], [/^Minotaur/i, 'Minotaur'], [/^Pegasus/i, 'Pegasus'], [/^Firefly Alpha|^Alpha/i, 'Firefly Alpha'], [/^Angara/i, 'Angara'], [/^Rokot/i, 'Rokot']];
export function llRocketSearchName(n) { for (const [re, rep] of LV_ALIASES) if (re.test(n)) return n.replace(re, rep); return n; }
const sim = (a, b) => { a = a.toLowerCase().replace(/[^a-z0-9]/g, ''); b = b.toLowerCase().replace(/[^a-z0-9]/g, ''); return a === b ? 1 : a.startsWith(b) || b.startsWith(a) ? 0.8 : a.includes(b) || b.includes(a) ? 0.6 : 0; };

// ---- Wikipedia / Wikidata
const SOCIAL = { P856: ['Official website', (v) => v], P2002: ['X (Twitter)', (v) => `https://x.com/${v}`], P2003: ['Instagram', (v) => `https://www.instagram.com/${v}/`], P2013: ['Facebook', (v) => `https://www.facebook.com/${v}`], P2397: ['YouTube', (v) => `https://www.youtube.com/channel/${v}`], P4264: ['LinkedIn', (v) => `https://www.linkedin.com/company/${v}/`], P11245: ['Bluesky', (v) => `https://bsky.app/profile/${v}`], P7085: ['TikTok', (v) => `https://www.tiktok.com/@${v}`], P3789: ['Telegram', (v) => `https://t.me/${v}`] };
export async function wikiSummary(title) {
  try {
    const s = await j(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`);
    if (s.type === 'disambiguation') return { disambiguation: true, title: s.title, url: s.content_urls?.desktop?.page };
    return { title: s.title, description: s.description, extract: s.extract, thumbnail: s.thumbnail?.source, image: s.originalimage?.source, url: s.content_urls?.desktop?.page, wikidata: s.wikibase_item };
  } catch (e) { if (e.status === 404) return null; throw e; }
}
export async function wikiSearch(q) { const d = await j(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=5&origin=*`); return (d.query?.search || []).map((r) => ({ title: r.title, snippet: r.snippet.replace(/<[^>]+>/g, ''), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}` })); }
export async function wikiExtract(title) { const d = await j(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(title)}&format=json&redirects=1&origin=*`); const p = Object.values(d.query?.pages || {})[0]; return p?.extract ? p.extract.slice(0, 12000) : null; }
export async function wikidataLinks(qid) { const d = await j(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json&origin=*`); const ent = d.entities?.[qid]; const links = []; for (const [p, [name, fmt]] of Object.entries(SOCIAL)) for (const c of (ent?.claims?.[p] || []).slice(0, 2)) { const v = c.mainsnak?.datavalue?.value; if (typeof v === 'string') links.push({ name, url: fmt(v), handle: v }); } return links; }
export async function news(q, limit = 12) { const d = await j(`https://api.spaceflightnewsapi.net/v4/articles/?search=${encodeURIComponent(q)}&limit=${limit}&ordering=-published_at`); return (d.results || []).map((a) => ({ id: a.id, title: a.title, url: a.url, image: a.image_url, site: a.news_site, summary: a.summary, published: a.published_at, authors: (a.authors || []).map((x) => x.name) })); }
const wikiTitleFromUrl = (u) => decodeURIComponent((u || '').split('/wiki/')[1] || '').replace(/_/g, ' ');
async function wikiFull(w) { if (!w?.title) return { wiki: w, wikiExtract: null, links: [] }; const [ex, wd] = await settle([wikiExtract(w.title), w.wikidata ? wikidataLinks(w.wikidata) : []]); return { wiki: w, wikiExtract: ex.ok ? ex.v : null, links: wd.ok ? wd.v : [] }; }

// ---- Launch Library
export async function launcherConfigs(q) {
  const tryQ = async (s) => (await j(`${LL}/launcher_configurations/?search=${encodeURIComponent(s)}&mode=detailed&limit=15`)).results || [];
  let results = await tryQ(q);
  if (!results.length && q.includes(' ')) results = await tryQ(q.split(' ').slice(0, 2).join(' '));
  if (!results.length && q.includes(' ')) results = await tryQ(q.split(' ')[0]);
  results.sort((a, b) => sim(b.name, q) + (b.full_name ? sim(b.full_name, q) * 0.5 : 0) - (sim(a.name, q) + (a.full_name ? sim(a.full_name, q) * 0.5 : 0)));
  return results;
}
export async function agencySearch(name) { const d = await j(`${LL}/agencies/?search=${encodeURIComponent(name)}&mode=detailed&limit=10`); return (d.results || []).sort((a, b) => Math.max(sim(b.name, name), sim(b.abbrev || '', name)) - Math.max(sim(a.name, name), sim(a.abbrev || '', name))); }
export async function launchesForRocket(id) { const d = await j(`${LL}/launches/?rocket__configuration__id=${id}&mode=list&limit=20&ordering=-net`); return (d.results || []).map((l) => ({ id: l.id, name: l.name, net: l.net, status: l.status?.name, image: l.image?.image_url, pad: l.pad?.name, location: l.pad?.location?.name, provider: l.launch_service_provider?.name })); }
const miniLaunch = (l) => ({ id: l.id, name: l.name, net: l.net, status: l.status?.name, provider: l.launch_service_provider?.name, pad: l.pad?.name, location: l.pad?.location?.name, image: l.image?.image_url, rocket: l.rocket?.configuration?.name });

// ---- Rocket enrichment: takes the GCAT core and returns the full profile shape the page renders.
export async function enrichRocket(core, upcomingAll) {
  const searchName = core.searchName || llRocketSearchName(core.requestedName || core.name);
  const [lc, wiki, nw] = await settle([launcherConfigs(searchName), wikiSummary(searchName), news(searchName)]);
  const ll2 = lc.ok && lc.v.length ? lc.v[0] : null;
  const ll2Launches = ll2 ? (await settle([launchesForRocket(ll2.id)]))[0].v || [] : [];
  let w = null;
  if (ll2?.wiki_url) { const r = await settle([wikiSummary(wikiTitleFromUrl(ll2.wiki_url))]); if (r[0].ok && r[0].v && !r[0].v.disambiguation) w = r[0].v; }
  if (!w && wiki.ok && wiki.v && !wiki.v.disambiguation && /rocket|launch|vehicle|space|booster|missile/i.test(`${wiki.v.description || ''} ${(wiki.v.extract || '').slice(0, 300)}`)) w = wiki.v;
  if (!w) { const ws = await settle([wikiSearch(`${searchName} rocket`)]); if (ws[0].ok && ws[0].v.length) { const r = await settle([wikiSummary(ws[0].v[0].title)]); if (r[0].ok && r[0].v && !r[0].v.disambiguation) w = r[0].v; } }
  const wf = await wikiFull(w);
  const key = searchName.toLowerCase().split(' ')[0];
  const upcoming = (upcomingAll || []).filter((l) => (l.rocket?.configuration?.name || '').toLowerCase().includes(key) || (ll2 && l.rocket?.configuration?.id === ll2.id) || (ll2 && (l.rocket?.configuration?.families || []).some((f) => (ll2.families || []).some((g) => g.id === f.id)))).slice(0, 12).map(miniLaunch);
  return { ...core, ll2, ll2Candidates: lc.ok ? lc.v.slice(0, 5).map((c) => ({ id: c.id, name: c.name, full_name: c.full_name })) : [], ll2Launches, upcoming, ...wf, news: nw.ok ? nw.v : [], errors: [lc, wiki, nw].filter((x) => !x.ok).map((x) => x.e) };
}

// ---- Organisation enrichment.
const RELEVANT = /space|aero|satellit|rocket|launch|defen|agency|compan|corporation|manufactur|research|institute|universit|air force|navy|army|ministry|military|telecom|communications|government|bureau|laborator|academy|observator|forces|consortium|operator|enterprise|design/i;
export async function enrichMaker(core, upcomingAll) {
  const candidates = core.candidates?.length ? core.candidates : [core.name];
  const short = core.shortName || core.name;
  const llMatches = (a, n) => a && n && [a.name, a.abbrev].some((x) => x && (x.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(x.toLowerCase())));
  const [ag, nw] = await settle([agencySearch(short.length >= 3 ? short : candidates[0]), news(candidates[0])]);
  let ll2 = ag.ok && ag.v.length ? ag.v[0] : null;
  if (ll2 && !candidates.some((n) => llMatches(ll2, n))) ll2 = null;
  if (!ll2) for (const n of candidates.slice(0, 4)) { const r = await settle([agencySearch(n)]); const hit = r[0].ok ? r[0].v.find((a) => llMatches(a, n)) : null; if (hit) { ll2 = hit; break; } }
  const ok = (w) => w && !w.disambiguation && RELEVANT.test(`${w.description || ''} ${(w.extract || '').slice(0, 400)}`);
  let w = null;
  for (const n of candidates) { const r = await settle([wikiSummary(n)]); if (r[0].ok && ok(r[0].v)) { w = r[0].v; break; } }
  if (!w && ll2?.wiki_url) { const r = await settle([wikiSummary(wikiTitleFromUrl(ll2.wiki_url))]); if (r[0].ok && r[0].v && !r[0].v.disambiguation) w = r[0].v; }
  if (!w) for (const n of candidates.slice(0, 3)) { const ws = await settle([wikiSearch(`${n} space`)]); if (ws[0].ok && ws[0].v.length) { const r = await settle([wikiSummary(ws[0].v[0].title)]); if (r[0].ok && ok(r[0].v)) { w = r[0].v; break; } } }
  const wf = await wikiFull(w);
  let newsItems = nw.ok ? nw.v : [];
  if (!newsItems.length) for (const n of candidates.slice(1, 5)) { const r = await settle([news(n)]); if (r[0].ok && r[0].v.length) { newsItems = r[0].v; break; } }
  const upcoming = (upcomingAll || []).filter((l) => (ll2 && l.launch_service_provider?.id === ll2.id) || (l.mission?.agencies || []).some((a) => ll2 && a.id === ll2.id) || (ll2 && l.rocket?.configuration?.manufacturer?.id === ll2.id)).slice(0, 12).map(miniLaunch);
  return { ...core, ll2, upcoming, ...wf, news: newsItems, errors: [ag, nw].filter((x) => !x.ok).map((x) => x.e) };
}

// ---- Bus enrichment.
export async function enrichBus(core) {
  const [ws, nw] = await settle([wikiSearch(core.wikiQuery || `${core.name} satellite bus`), news(core.name)]);
  let w = null;
  if (ws.ok && ws.v.length) { const r = await settle([wikiSummary(ws.v[0].title)]); if (r[0].ok && r[0].v && !r[0].v.disambiguation) w = r[0].v; }
  const wf = await wikiFull(w);
  return { ...core, ...wf, wikiSearch: ws.ok ? ws.v : [], news: nw.ok ? nw.v : [] };
}

// ---- Resolve a requested rocket name onto the GCAT catalog list (mirrors the server's scoring).
export function resolveRocket(name, rockets) {
  if (rockets.some((r) => r.name === name)) return name;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(name);
  const lcp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  let best = null, bestScore = 0;
  for (const cand of rockets) for (const variant of [cand.name, llRocketSearchName(cand.name), cand.family || '']) {
    if (!variant) continue; const v = norm(variant);
    let score = v === target ? 3 : lcp(v, target) / Math.max(v.length, target.length);
    if (score < 0.5) continue;
    if (variant === cand.family && score < 3) score *= 0.98;
    const tie = best && Math.abs(score - bestScore) < 1e-9 && ((cand.launches?.last || '') > (best.launches?.last || ''));
    if (score > bestScore || tie) { bestScore = score; best = cand; }
  }
  return best ? best.name : null;
}
