import { esc, fmtDate, fmtNum, linkRocket, linkMaker, linkBus, satTable, newsList, socialLinks, startClock, qs, launchUrl, rocketUrl, makerUrl, busUrl, countdown } from './common.js';

startClock(document.getElementById('clock'));
const main = document.getElementById('main');
const type = qs('type') || 'rockets';
const navKey = { rocket: 'rockets', maker: 'makers', bus: 'buses', owner: 'owners' }[type] || type;
document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));

function isoDur(d) {
  if (!d) return null;
  const m = String(d).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return d;
  const parts = []; if (m[1]) parts.push(`${m[1]}d`); if (m[2]) parts.push(`${m[2]}h`); if (m[3]) parts.push(`${m[3]}m`); if (m[4] && !m[1]) parts.push(`${Math.round(+m[4])}s`);
  return parts.join(' ') || d;
}
const spec = (l, v, unit = '') => (v === null || v === undefined || v === '' || v === 0 ? '' : `<div class="spec"><div class="l">${l}</div><div class="v">${v}${unit ? `<small>${unit}</small>` : ''}</div></div>`);
const card = (title, body, extra = '') => `<div class="card"><h2>${title}</h2>${body}${extra}</div>`;
const prose = (text, id) => text ? `<div class="prose" id="${id}">${esc(text)}</div><button class="expand" data-expand="${id}">Read more</button>` : '';
const upcomingList = (items) => items?.length ? items.map((l) => `<a class="launch-mini" href="${launchUrl(l.id)}">${l.image ? `<img src="${esc(l.image)}" alt="" onerror="this.remove()">` : '<div></div>'}<div><div class="t">${esc(l.name)}</div><div class="m">${fmtDate(l.net, { time: true })} · ${esc(l.status || '')}</div><div class="m">${esc(l.provider || '')}${l.location ? ' · ' + esc(l.location) : ''}</div></div></a>`).join('') : '<div class="empty">No launches in the current upcoming window.</div>';
const pastList = (items) => items?.length ? items.map((l) => `<a class="launch-mini" href="https://spacelaunchnow.me/launch/${esc(l.id)}" target="_blank" rel="noopener">${l.image ? `<img src="${esc(l.image)}" alt="" onerror="this.remove()">` : '<div></div>'}<div><div class="t">${esc(l.name)}</div><div class="m">${fmtDate(l.net, { time: true })} · ${esc(l.status || '')}</div><div class="m">${esc(l.provider || '')}${l.location ? ' · ' + esc(l.location) : ''}</div></div></a>`).join('') : '<div class="empty">No launch history available.</div>';

function wireExpand() { main.querySelectorAll('[data-expand]').forEach((b) => { const p = document.getElementById(b.dataset.expand); if (p.scrollHeight <= 330) { p.classList.add('open'); b.remove(); return; } b.onclick = () => { p.classList.toggle('open'); b.textContent = p.classList.contains('open') ? 'Show less' : 'Read more'; }; }); }

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); }

function ll2Socials(agency) {
  if (!agency) return [];
  const out = [];
  if (agency.info_url) out.push({ name: 'Official website', url: agency.info_url });
  if (agency.wiki_url) out.push({ name: 'Wikipedia', url: agency.wiki_url });
  for (const l of agency.social_media_links || []) out.push({ name: l.social_media?.name || 'Link', url: l.url });
  return out;
}

// ---------------------------------------------------------------------------
async function renderRocket(name) {
  const d = await getJSON(`/api/rocket?name=${encodeURIComponent(name)}`);
  document.title = `${d.name} — rocket profile`;
  const ll = d.ll2;
  const mf = ll?.manufacturer || ll?.families?.[0]?.manufacturer?.[0] || null;
  const mfName = mf?.name || d.gcat?.manufacturerOrg?.name || d.gcat?.manufacturer;
  const mfCode = d.gcat?.manufacturerOrg?.code || d.gcat?.manufacturerCode;
  const img = ll?.image?.image_url || d.wiki?.image || d.wiki?.thumbnail;
  const hero = `<div class="hero">${img ? `<img class="img" src="${esc(img)}" alt="${esc(d.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'img'}))">` : '<div class="img"></div>'}<div>
    <div class="crumbs"><a href="detail.html?type=rockets">Rockets</a> / ${esc(d.name)}</div>
    <h1>${esc(ll?.full_name || d.name)}</h1>
    <div class="sub">${[ll?.families?.map((f) => f.name).join(', ') || d.gcat?.family ? `Family: ${esc(ll?.families?.map((f) => f.name).join(', ') || d.gcat?.family)}` : '', mfName ? `Manufacturer: ${linkMaker(mfCode, mfName)}` : '', ll ? (ll.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Retired</span>') : '', ll?.reusable ? '<span class="badge">Reusable</span>' : ''].filter(Boolean).join(' · ')}</div>
    ${ll?.description && ll.description.length > 80 ? `<p>${esc(ll.description)}</p>` : d.wiki?.extract ? `<p>${esc(d.wiki.extract)}</p>` : ll?.description ? `<p>${esc(ll.description)}</p>` : ''}
    ${d.requestedName && d.requestedName !== d.name ? `<p class="note">Matched “${esc(d.requestedName)}” to catalog vehicle “${esc(d.name)}”.</p>` : ''}
    <div class="linkrow" style="margin-top:10px">${ll?.info_url ? `<a href="${esc(ll.info_url)}" target="_blank" rel="noopener">Official page ↗</a>` : ''}${(ll?.wiki_url || d.wiki?.url) ? `<a href="${esc(ll?.wiki_url || d.wiki.url)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}<a href="index.html" onclick="sessionStorage.setItem('rocketFilter', ${JSON.stringify(d.name)})">Show its satellites on the globe</a></div>
  </div></div>`;

  const specs = `<div class="specs">
    ${spec('Height', ll?.length, 'm')}${spec('Diameter', ll?.diameter, 'm')}${spec('Launch mass', ll?.launch_mass ? fmtNum(ll.launch_mass) : null, 't')}
    ${spec('Payload to LEO', ll?.leo_capacity ? fmtNum(ll.leo_capacity) : null, 'kg')}${spec('Payload to GTO', ll?.gto_capacity ? fmtNum(ll.gto_capacity) : null, 'kg')}${spec('Payload to GEO', ll?.geo_capacity ? fmtNum(ll.geo_capacity) : null, 'kg')}${spec('Payload to SSO', ll?.sso_capacity ? fmtNum(ll.sso_capacity) : null, 'kg')}
    ${spec('Liftoff thrust', ll?.to_thrust ? fmtNum(ll.to_thrust) : null, 'kN')}${spec('Stages', ll ? (ll.min_stage === ll.max_stage ? ll.max_stage : `${ll.min_stage}–${ll.max_stage}`) : null)}${spec('Maiden flight', ll?.maiden_flight ? fmtDate(ll.maiden_flight) : null)}
    ${spec('Launch cost', ll?.launch_cost ? '$' + fmtNum(ll.launch_cost / 1e6, 0) + 'M' : null)}${spec('Total launches', ll?.total_launch_count)}${spec('Successful', ll?.successful_launches)}${spec('Failed', ll?.failed_launches)}${spec('Consecutive successes', ll?.consecutive_successful_launches)}${spec('Pending', ll?.pending_launches)}
    ${spec('Landings attempted', ll?.attempted_landings)}${spec('Landings succeeded', ll?.successful_landings)}${spec('Fastest turnaround', ll?.fastest_turnaround ? esc(isoDur(ll.fastest_turnaround)) : null)}
  </div>${!ll ? '<div class="empty">No Launch Library record matched this vehicle name; specifications below come from the GCAT vehicle table.</div>' : ''}`;

  const seenV = new Set(); d.lvVariants = (d.lvVariants || []).filter((v) => { const k = JSON.stringify(v); if (seenV.has(k)) return false; seenV.add(k); return true; });
  const variants = d.lvVariants?.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Variant</th><th>Family</th><th>Stages</th><th>Length</th><th>Diameter</th><th>Launch mass</th><th>LEO</th><th>GTO</th><th>Liftoff thrust</th><th>Objects tracked</th></tr></thead><tbody>${d.lvVariants.map((v) => { const key = v.variant ? `${d.name} ${v.variant}` : d.name; return `<tr><td>${esc(v.variant || 'baseline')}</td><td>${esc(v.family || '—')}</td><td>${v.stages ?? '—'}</td><td>${v.length ? v.length + ' m' : '—'}</td><td>${v.diameter ? v.diameter + ' m' : '—'}</td><td>${v.launchMass ? fmtNum(v.launchMass) + ' t' : '—'}</td><td>${v.leoCapacity ? fmtNum(v.leoCapacity) + ' kg' : '—'}</td><td>${v.gtoCapacity ? fmtNum(v.gtoCapacity) + ' kg' : '—'}</td><td>${v.thrust ? fmtNum(v.thrust) + ' kN' : '—'}</td><td>${fmtNum(d.gcat?.variants?.[key] || 0)}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty">No variant table available.</div>';

  const socials = [...ll2Socials(mf), ...(d.links || [])];
  const stats = d.gcat ? `<div class="specs">${spec('Objects in orbit from this rocket', fmtNum(d.satelliteCount))}${spec('Of which defense / military', fmtNum(d.gcat.mil))}${spec('Earliest tracked launch', d.gcat.first ? fmtDate(d.gcat.first) : null)}${spec('Latest tracked launch', d.gcat.last ? fmtDate(d.gcat.last) : null)}</div>` : '';

  main.innerHTML = hero + `<div class="grid"><div>
    ${card('Specifications', specs)}
    ${d.history ? card('Launch history (GCAT launch list)', `<div class="specs">${spec('Launches recorded', fmtNum(d.history.total))}${spec('Orbital attempts', fmtNum(d.history.orbital))}${spec('Orbital successes', fmtNum(d.history.success))}${spec('Orbital failures', fmtNum(d.history.failure))}${spec('Success rate', d.history.orbital ? Math.round(100 * d.history.success / d.history.orbital) + '%' : null)}${spec('First launch', d.history.first ? fmtDate(d.history.first) : null)}${spec('Latest launch', d.history.last ? fmtDate(d.history.last) : null)}</div>${d.familyHistory?.length ? `<div class="note" style="margin-top:10px">Other vehicles in this family: ${d.familyHistory.map((f) => `${linkRocket(f.name)} <span class="muted">(${fmtNum(f.total)} launches${f.last ? ', last ' + fmtDate(f.last) : ''})</span>`).join(' · ')}</div>` : ''}`) : ''}
    ${card('Variants (GCAT vehicle table)', variants)}
    ${d.wikiExtract ? card('Background (Wikipedia)', prose(d.wikiExtract, 'wx'), `<div class="note" style="margin-top:8px">Source: <a href="${esc(d.wiki?.url || '#')}" target="_blank" rel="noopener">Wikipedia</a>, CC BY-SA.</div>`) : ''}
    ${card(`Satellites in orbit launched by ${esc(d.name)} (${d.satelliteCount.toLocaleString()})`, stats + satTable(d.satellites, { limit: 150, showRocket: false, total: d.satelliteCount }))}
    ${card('News & articles', newsList(d.news))}
  </div><div>
    ${card('Upcoming launches', upcomingList(d.upcoming))}
    ${card('Recent launches', pastList(d.ll2Launches))}
    ${card('Official links & social media', socialLinks(socials))}
    ${mf ? card('Manufacturer', `<div class="kv-wrap"><dl class="kv"><dt>Name</dt><dd>${linkMaker(mfCode, mf.name)}${mf.abbrev ? ` (${esc(mf.abbrev)})` : ''}</dd><dt>Type</dt><dd>${esc(mf.type?.name || '—')}</dd><dt>Country</dt><dd>${esc((mf.country || []).map((c) => c.name).join(', ') || '—')}</dd><dt>Founded</dt><dd>${esc(mf.founding_year || '—')}</dd><dt>Leadership</dt><dd>${esc(mf.administrator || '—')}</dd><dt>Launchers</dt><dd>${esc(mf.launchers || '—')}</dd><dt>Spacecraft</dt><dd>${esc(mf.spacecraft || '—')}</dd><dt>Launches</dt><dd>${fmtNum(mf.total_launch_count)} total · ${fmtNum(mf.successful_launches)} ok · ${fmtNum(mf.failed_launches)} failed</dd></dl></div>`) : ''}
    ${d.ll2Candidates?.length > 1 ? card('Other Launch Library matches', `<div class="linkrow">${d.ll2Candidates.slice(1).map((c) => `<a href="${rocketUrl(c.name)}">${esc(c.full_name || c.name)}</a>`).join('')}</div>`) : ''}
    ${d.errors?.length ? card('Data notes', `<div class="note">${d.errors.map(esc).join('<br>')}</div>`) : ''}
  </div></div>`;
  wireExpand();
}

// ---------------------------------------------------------------------------
async function renderMaker(code, name) {
  const d = await getJSON(`/api/maker?${code ? 'code=' + encodeURIComponent(code) : ''}${name ? '&name=' + encodeURIComponent(name) : ''}`);
  document.title = `${d.name} — organisation profile`;
  const ll = d.ll2;
  const img = ll?.image?.image_url || d.wiki?.image || d.wiki?.thumbnail || ll?.logo?.image_url;
  const isLogo = !ll?.image?.image_url && !d.wiki?.image && !!ll?.logo?.image_url;
  const hero = `<div class="hero">${img ? `<img class="img ${isLogo ? 'logo' : ''}" src="${esc(img)}" alt="${esc(d.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'img'}))">` : '<div class="img"></div>'}<div>
    <div class="crumbs"><a href="detail.html?type=makers">Manufacturers & operators</a> / ${esc(d.shortName)}</div>
    <h1>${esc(d.name)}</h1>
    <div class="sub">${[d.org?.classLabel ? `<span class="badge ${d.org.class === 'D' ? 'mil' : ''}">${esc(d.org.classLabel)}</span>` : '', ll?.type?.name ? `<span class="badge">${esc(ll.type.name)}</span>` : '', d.org?.stateName || ll?.country?.[0]?.name ? esc(d.org?.stateName || ll.country[0].name) : '', d.org?.location ? esc(d.org.location) : '', d.org?.localName ? `<span class="muted">${esc(d.org.localName)}</span>` : ''].filter(Boolean).join(' · ')}</div>
    ${ll?.description ? `<p>${esc(ll.description)}</p>` : d.wiki?.extract ? `<p>${esc(d.wiki.extract)}</p>` : ''}
    ${!ll && !d.wiki ? `<p class="muted">No encyclopedia or Launch Library record matched this organisation automatically. Catalog data from GCAT is shown below.</p>` : ''}
    <div class="linkrow" style="margin-top:10px">${ll?.info_url ? `<a href="${esc(ll.info_url)}" target="_blank" rel="noopener">Official website ↗</a>` : ''}${(ll?.wiki_url || d.wiki?.url) ? `<a href="${esc(ll?.wiki_url || d.wiki.url)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}${d.code ? `<a href="index.html" onclick="sessionStorage.setItem('ownerFilter', ${JSON.stringify(d.shortName)})">Show on globe</a>` : ''}</div>
  </div></div>`;

  const facts = `<div class="specs">
    ${spec('Founded', ll?.founding_year || d.org?.start)}${spec('Leadership', ll?.administrator ? esc(ll.administrator) : null)}${spec('Country', esc(d.org?.stateName || ll?.country?.map((c) => c.name).join(', ') || ''))}
    ${spec('Parent', d.org?.parentName ? linkMaker(d.org.parent, d.org.parentName) : null)}${spec('Active until', d.org?.stop && d.org.stop !== '-' ? esc(d.org.stop) : null)}${spec('GCAT roles', d.org?.type ? esc(d.org.type.split('/').map((t) => ({ O: 'operator', PL: 'payload maker', LA: 'launch agency', LV: 'vehicle maker', E: 'engine maker', LS: 'launch site', S: 'state', CY: 'country' }[t] || t)).join(', ')) : null)}
    ${spec('Satellites built (tracked)', fmtNum(d.builtCount))}${spec('Satellites operated (tracked)', fmtNum(d.operatedCount))}${spec('Rockets built', d.rockets?.length || null)}
    ${spec('Launches (LL2)', ll?.total_launch_count)}${spec('Successful launches', ll?.successful_launches)}${spec('Failed launches', ll?.failed_launches)}${spec('Consecutive successes', ll?.consecutive_successful_launches)}${spec('Pending launches', ll?.pending_launches)}${spec('Landings', ll?.attempted_landings ? `${ll.successful_landings}/${ll.attempted_landings}` : null)}
    ${spec('Launchers', ll?.launchers ? esc(ll.launchers) : null)}${spec('Spacecraft', ll?.spacecraft ? esc(ll.spacecraft) : null)}
  </div>`;
  const rockets = d.rockets?.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Rocket</th><th>Family</th><th>Objects in orbit</th><th>Military</th><th>First</th><th>Latest</th></tr></thead><tbody>${d.rockets.map((r) => `<tr><td>${linkRocket(r.name)}</td><td>${esc(r.family || '—')}</td><td>${fmtNum(r.count)}</td><td>${fmtNum(r.mil)}</td><td>${fmtDate(r.first)}</td><td>${fmtDate(r.last)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const buses = d.buses?.length ? `<div class="linkrow">${d.buses.map((b) => `<a href="${busUrl(b.name)}">${esc(b.name)} <span class="muted">×${b.count}</span></a>`).join('')}</div>` : '';
  const socials = [...ll2Socials(ll), ...(d.links || [])];

  main.innerHTML = hero + `<div class="grid"><div>
    ${card('At a glance', facts)}
    ${rockets ? card('Launch vehicles built', rockets) : ''}
    ${buses ? card('Satellite buses / models built', buses) : ''}
    ${d.wikiExtract ? card('Background (Wikipedia)', prose(d.wikiExtract, 'wx'), `<div class="note" style="margin-top:8px">Source: <a href="${esc(d.wiki?.url || '#')}" target="_blank" rel="noopener">Wikipedia</a>, CC BY-SA.</div>`) : ''}
    ${d.satellites?.length ? card(`Satellites in orbit built or operated by ${esc(d.shortName)} (${d.satelliteCount.toLocaleString()})`, satTable(d.satellites, { limit: 150, showRole: true, total: d.satelliteCount })) : ''}
    ${card('News & articles', newsList(d.news))}
  </div><div>
    ${card('Official links & social media', socialLinks(socials))}
    ${card('Upcoming launches', upcomingList(d.upcoming))}
    ${ll?.logo?.image_url && img !== ll.logo.image_url ? card('Logo', `<img src="${esc(ll.logo.image_url)}" alt="logo" style="max-width:100%;background:#fff;border-radius:8px;padding:12px">`) : ''}
    ${d.errors?.length ? card('Data notes', `<div class="note">${d.errors.map(esc).join('<br>')}</div>`) : ''}
  </div></div>`;
  wireExpand();
}

// ---------------------------------------------------------------------------
async function renderBus(name) {
  const d = await getJSON(`/api/bus?name=${encodeURIComponent(name)}`);
  document.title = `${d.name} — satellite bus profile`;
  const img = d.wiki?.image || d.wiki?.thumbnail;
  const hero = `<div class="hero">${img ? `<img class="img" src="${esc(img)}" alt="${esc(d.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'img'}))">` : '<div class="img"></div>'}<div>
    <div class="crumbs"><a href="detail.html?type=buses">Buses / models</a> / ${esc(d.name)}</div>
    <h1>${esc(d.name)}</h1>
    <div class="sub">Satellite bus / platform · ${d.manufacturers.map((m) => linkMaker(m.code, m.name) + ` <span class="muted">×${m.count}</span>`).join(', ')}</div>
    ${d.wiki?.extract ? `<p>${esc(d.wiki.extract)}</p><p class="note">Closest encyclopedia match: <a href="${esc(d.wiki.url)}" target="_blank" rel="noopener">${esc(d.wiki.title)}</a>. Bus names in GCAT are terse, so verify the match.</p>` : '<p class="muted">No encyclopedia article matched this bus name automatically.</p>'}
    <div class="linkrow" style="margin-top:10px">${d.wiki?.url ? `<a href="${esc(d.wiki.url)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}<a href="https://www.google.com/search?q=${encodeURIComponent(`"${d.name}" satellite bus`)}" target="_blank" rel="noopener">Web search ↗</a></div>
  </div></div>`;
  const facts = `<div class="specs">${spec('Objects in orbit', fmtNum(d.count))}${spec('Defense / military', fmtNum(d.mil))}${spec('First tracked launch', d.firstLaunch ? fmtDate(d.firstLaunch) : null)}${spec('Latest tracked launch', d.lastLaunch ? fmtDate(d.lastLaunch) : null)}${Object.entries(d.orbits).map(([k, v]) => spec(`In ${k}`, fmtNum(v))).join('')}</div>`;
  main.innerHTML = hero + `<div class="grid"><div>
    ${card('At a glance', facts)}
    ${d.wikiExtract ? card('Background (Wikipedia)', prose(d.wikiExtract, 'wx'), `<div class="note" style="margin-top:8px">Source: <a href="${esc(d.wiki?.url || '#')}" target="_blank" rel="noopener">Wikipedia</a>, CC BY-SA.</div>`) : ''}
    ${card(`Satellites using the ${esc(d.name)} bus (${d.count.toLocaleString()})`, satTable(d.satellites, { limit: 200, total: d.count }))}
    ${card('News & articles', newsList(d.news))}
  </div><div>
    ${card('Manufacturers', `<div class="linkrow">${d.manufacturers.map((m) => `<a href="${makerUrl(m.code, m.name)}">${esc(m.name)} <span class="muted">×${m.count}</span></a>`).join('')}</div>`)}
    ${d.wikiSearch?.length > 1 ? card('Other possible articles', `<div class="linkrow">${d.wikiSearch.slice(1).map((w) => `<a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a>`).join('')}</div>`) : ''}
  </div></div>`;
  wireExpand();
}

// ---------------------------------------------------------------------------
async function renderIndex(kind) {
  const titles = { rockets: 'Launch vehicles', makers: 'Satellite manufacturers', owners: 'Satellite operators', buses: 'Satellite buses / models' };
  const subs = { rockets: 'Every vehicle with payloads currently in orbit, plus any vehicle that has attempted an orbital launch since 2015. Launch history from the GCAT launch list; objects in orbit from live CelesTrak elements.', makers: 'Organisations that built satellites currently in orbit.', owners: 'Organisations operating satellites currently in orbit.', buses: 'Spacecraft buses / platforms with objects currently in orbit.' };
  const data = await getJSON(`/api/${kind}`);
  document.title = `${titles[kind]} — Orbital Tracker`;
  let rows;
  const pct = (r) => r.launches?.orbital ? Math.round((r.launches.success / r.launches.orbital) * 100) + '%' : '—';
  if (kind === 'rockets') rows = `<thead><tr><th>Rocket</th><th>Family</th><th>Manufacturer</th><th title="Objects currently in orbit launched by this vehicle">Objects in orbit</th><th>Military</th><th title="All-time orbital launch attempts recorded in GCAT">Orbital launches</th><th title="Orbital attempts that succeeded">Success rate</th><th>First launch</th><th>Latest launch</th></tr></thead><tbody>${data.map((r) => `<tr><td>${linkRocket(r.name)}</td><td>${esc(r.family || '—')}</td><td>${r.manufacturer ? linkMaker(r.manufacturerCode, r.manufacturer) : '—'}</td><td>${fmtNum(r.count)}</td><td>${fmtNum(r.mil)}</td><td>${r.launches?.orbital ? `${fmtNum(r.launches.orbital)} <span class="muted small">(${fmtNum(r.launches.success)} ok / ${fmtNum(r.launches.failure)} failed)</span>` : '—'}</td><td>${pct(r)}</td><td class="nowrap">${fmtDate(r.launches?.first || r.first)}</td><td class="nowrap">${fmtDate(r.launches?.last || r.last)}</td></tr>`).join('')}</tbody>`;
  else if (kind === 'buses') rows = `<thead><tr><th>Bus / model</th><th>Manufacturers</th><th>Objects in orbit</th><th>Military</th></tr></thead><tbody>${data.map((b) => `<tr><td>${linkBus(b.name)}</td><td>${esc(Object.keys(b.manufacturers).slice(0, 3).join(', '))}</td><td>${fmtNum(b.count)}</td><td>${fmtNum(b.mil)}</td></tr>`).join('')}</tbody>`;
  else rows = `<thead><tr><th>Organisation</th><th>Type</th><th>Country</th><th>Location</th><th>Objects in orbit</th><th>Military</th></tr></thead><tbody>${data.map((m) => `<tr><td>${linkMaker(m.code, m.name)}</td><td>${m.class === 'D' ? '<span class="pill-mil">' + esc(m.classLabel) + '</span>' : esc(m.classLabel || '—')}</td><td>${esc(m.stateName || m.state || '—')}</td><td>${esc(m.location || '—')}</td><td>${fmtNum(m.count)}</td><td>${fmtNum(m.mil)}</td></tr>`).join('')}</tbody>`;
  main.innerHTML = `<h1 style="font-size:26px;margin-bottom:6px">${titles[kind]}</h1><p class="muted" style="margin:0 0 16px">${data.length.toLocaleString()} entries. ${subs[kind]} Click any name for a full profile.</p><input class="search" id="idx-search" placeholder="Filter… (e.g. Starship, Ariane, Lockheed)" style="max-width:360px;margin-bottom:14px"><div class="card tbl-wrap"><table class="tbl" id="idx">${rows}</table></div>`;
  const tbl = document.getElementById('idx');
  document.getElementById('idx-search').oninput = (e) => { const q = e.target.value.toLowerCase(); tbl.querySelectorAll('tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; }); };
}

async function renderUntracked() {
  const d = await getJSON('/api/untracked');
  document.title = 'Active payloads without public elements — Orbital Tracker';
  const cv = d.coverage;
  const rows = d.objects.sort((a, b) => (b.launched || '').localeCompare(a.launched || ''));
  main.innerHTML = `<h1 style="font-size:26px;margin-bottom:6px">Active payloads that cannot be plotted</h1>
    <p class="muted" style="margin:0 0 16px;max-width:90ch">The CelesTrak SATCAT lists <strong>${cv.satcatActivePayloads.toLocaleString()}</strong> operational payloads on orbit. <strong>${cv.shownActivePayloads.toLocaleString()}</strong> have public orbital elements and appear on the globe. The <strong>${cv.untracked.toLocaleString()}</strong> below do not: ${cv.untrackedClassified.toLocaleString()} are classified US payloads whose elements are withheld, ${cv.untrackedDeepSpace.toLocaleString()} are beyond Earth orbit (lunar, heliocentric, Lagrange points), and ${cv.untrackedOther.toLocaleString()} have no published element set in the current CelesTrak feed.</p>
    <div class="specs" style="margin-bottom:16px">${spec('Active payloads (SATCAT)', fmtNum(cv.satcatActivePayloads))}${spec('Plotted on globe', fmtNum(cv.shownActivePayloads))}${spec('Classified', fmtNum(cv.untrackedClassified))}${spec('Deep space', fmtNum(cv.untrackedDeepSpace))}${spec('No public elements', fmtNum(cv.untrackedOther))}</div>
    <input class="search" id="idx-search" placeholder="Filter…" style="max-width:360px;margin-bottom:14px">
    <div class="card tbl-wrap"><table class="tbl" id="idx"><thead><tr><th>Object</th><th>Designator</th><th>Owner</th><th>Launched</th><th>Site</th><th>Orbit (SATCAT)</th><th>Reason</th></tr></thead><tbody>
    ${rows.map((o) => `<tr><td><strong>${esc(o.name)}</strong> <span class="muted mono small">${o.id}</span></td><td class="mono">${esc(o.cospar)}</td><td>${esc(o.owner)}</td><td class="nowrap">${fmtDate(o.launched)}</td><td>${esc(o.site)}</td><td class="small">${o.orbitCenter !== 'EA' ? esc(o.orbitCenter) : o.period ? `${fmtNum(o.perigee)}×${fmtNum(o.apogee)} km · ${o.inclination}°` : '—'}</td><td class="small muted">${esc(o.reason)}</td></tr>`).join('')}
    </tbody></table></div>`;
  const tbl = document.getElementById('idx');
  document.getElementById('idx-search').oninput = (e) => { const q = e.target.value.toLowerCase(); tbl.querySelectorAll('tbody tr').forEach((tr) => { tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; }); };
}

(async () => {
  try {
    if (type === 'untracked') await renderUntracked();
    else if (type === 'rocket') await renderRocket(qs('name'));
    else if (type === 'maker') await renderMaker(qs('code'), qs('name'));
    else if (type === 'bus') await renderBus(qs('name'));
    else await renderIndex(['rockets', 'makers', 'owners', 'buses'].includes(type) ? type : 'rockets');
  } catch (e) {
    main.innerHTML = `<div class="card"><h2>Could not load profile</h2><div class="err">${esc(e.message)}</div><p><a href="index.html">← Back to the globe</a></p></div>`;
  }
})();
