import { esc, fmtDate, fmtDateLocal, fmtNum, countdown, rocketUrl, makerUrl, startClock, satUrl, ORBIT_COLORS } from './common.js';

startClock(document.getElementById('clock'));
const $ = (id) => document.getElementById(id);
let launches = [];
let view = new URLSearchParams(location.search).get('view') === 'recent' ? 'recent' : 'upcoming';
const tileState = { next7: false, outcome: '' };
const MIL_RE = /\b(military|defense|defence|space force|ussf|nro|nrol|reconnaissance|missile|sda|tranche|sbirs|gps|wgs|classified|navy|army|air force|pla|mod\b|ministry of defen)/i;

function isMil(l) {
  const text = [l.name, l.mission?.name, l.mission?.description, l.mission?.type, l.launch_service_provider?.name, ...(l.mission?.agencies || []).map((a) => a.name + ' ' + (a.type?.name || ''))].join(' ');
  return MIL_RE.test(text) || (l.mission?.agencies || []).some((a) => /military|government/i.test(a.type?.name || '') && /defen|force|army|navy|nro|reconnaissance/i.test(a.name));
}
function isoDur(d) {
  if (!d) return null;
  const m = String(d).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return d;
  const parts = []; if (m[1]) parts.push(`${m[1]}d`); if (m[2]) parts.push(`${m[2]}h`); if (m[3]) parts.push(`${m[3]}m`);
  return parts.join(' ') || d;
}
const statusClass = (s) => ({ Go: 'go', TBD: 'tbd', TBC: 'tbc', Hold: 'hold', Failure: 'failure', Success: 'success', 'In Flight': 'flying', 'Partial Failure': 'failure' }[s?.abbrev] || 'tbd');

function fill(id, values, label) {
  const m = new Map(); values.forEach((v) => { if (v) m.set(v, (m.get(v) || 0) + 1); });
  $(id).innerHTML = `<option value="">${label}</option>` + [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `<option value="${esc(k)}">${esc(k)} (${v})</option>`).join('');
}

function render() {
  const q = $('q').value.trim().toLowerCase();
  const fp = $('f-provider').value, fc = $('f-country').value, fs = $('f-status').value, fr = $('f-rocket').value, fm = $('f-mil').checked;
  const rows = launches.filter((l) => {
    if (fp && l.launch_service_provider?.name !== fp) return false;
    if (fc && l.pad?.country?.name !== fc) return false;
    if (fs && l.status?.name !== fs) return false;
    if (fr && l.rocket?.configuration?.name !== fr) return false;
    if (fm && !isMil(l)) return false;
    if (tileState.next7 && Math.abs(new Date(l.net) - Date.now()) >= 7 * 86400e3) return false;
    if (tileState.outcome === 'success' && l.status?.abbrev !== 'Success') return false;
    if (tileState.outcome === 'failure' && !/Failure/.test(l.status?.abbrev || '')) return false;
    if (tileState.outcome === 'objects' && !l.objectCount) return false;
    if (q) { const t = [l.name, l.mission?.name, l.mission?.description, l.rocket?.configuration?.full_name, l.launch_service_provider?.name, l.pad?.name, l.pad?.location?.name, l.pad?.country?.name].join(' ').toLowerCase(); if (!t.includes(q)) return false; }
    return true;
  });
  if (view === 'recent') rows.sort((a, b) => new Date(b.net) - new Date(a.net));
  const days = new Map();
  for (const l of rows) { const k = new Date(l.net).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); if (!days.has(k)) days.set(k, []); days.get(k).push(l); }
  $('list').innerHTML = rows.length ? [...days.entries()].map(([day, ls]) => `<div class="day-hd">${esc(day)} · ${ls.length} launch${ls.length > 1 ? 'es' : ''}</div>${ls.map(renderLaunch).join('')}`).join('') : '<div class="empty">No launches match the current filters.</div>';
  const goOn = fs === 'Go for Launch';
  const anyFilter = q || fp || fc || fs || fr || fm || tileState.next7 || tileState.outcome;
  if (view === 'recent') {
    const objs = rows.reduce((a, l) => a + (l.objectCount || 0), 0);
    $('summary').innerHTML = `<div class="stat ${anyFilter ? '' : 'on'}" data-tile="all" title="Show every recent launch (clear filters)"><div class="n">${rows.length}</div><div class="l">${anyFilter ? 'Matching' : 'Recent launches'}</div></div>
      <div class="stat ${tileState.next7 ? 'on' : ''}" data-tile="next7" title="Only the last 7 days"><div class="n">${rows.filter((l) => Date.now() - new Date(l.net) < 7 * 86400e3).length}</div><div class="l">Last 7 days</div></div>
      <div class="stat ${tileState.outcome === 'success' ? 'on' : ''}" data-tile="success" title="Only successful launches"><div class="n" style="color:var(--ok)">${rows.filter((l) => l.status?.abbrev === 'Success').length}</div><div class="l">Successes</div></div>
      <div class="stat ${tileState.outcome === 'failure' ? 'on' : ''}" data-tile="failure" title="Only failures and partial failures"><div class="n" style="color:var(--bad)">${rows.filter((l) => /Failure/.test(l.status?.abbrev || '')).length}</div><div class="l">Failures</div></div>
      <div class="stat mil ${fm ? 'on' : ''}" data-tile="mil" title="Only defense-related missions"><div class="n">${rows.filter(isMil).length}</div><div class="l">Defense-related</div></div>
      <div class="stat ${tileState.outcome === 'objects' ? 'on' : ''}" data-tile="objects" title="Only launches whose payloads are tracked on the globe"><div class="n" style="color:var(--accent)">${objs.toLocaleString()}</div><div class="l">Payloads now tracked</div></div>
      <div class="stat ${fp ? 'on' : ''}" data-tile="provider" title="Pick a provider"><div class="n">${new Set(rows.map((l) => l.launch_service_provider?.name)).size}</div><div class="l">Providers</div></div>`;
  } else {
    $('summary').innerHTML = `<div class="stat ${anyFilter ? '' : 'on'}" data-tile="all" title="Show every launch (clear filters)"><div class="n">${rows.length}</div><div class="l">${anyFilter ? 'Matching' : 'Launches listed'}</div></div>
    <div class="stat ${tileState.next7 ? 'on' : ''}" data-tile="next7" title="Only launches in the next 7 days"><div class="n">${rows.filter((l) => new Date(l.net) - Date.now() < 7 * 86400e3).length}</div><div class="l">Next 7 days</div></div>
    <div class="stat ${goOn ? 'on' : ''}" data-tile="go" title="Only launches confirmed Go"><div class="n">${rows.filter((l) => l.status?.abbrev === 'Go').length}</div><div class="l">Go for launch</div></div>
    <div class="stat mil ${fm ? 'on' : ''}" data-tile="mil" title="Only defense-related missions"><div class="n">${rows.filter(isMil).length}</div><div class="l">Defense-related</div></div>
    <div class="stat ${fp ? 'on' : ''}" data-tile="provider" title="Pick a provider"><div class="n">${new Set(rows.map((l) => l.launch_service_provider?.name)).size}</div><div class="l">Providers</div></div>
    <div class="stat ${fc ? 'on' : ''}" data-tile="country" title="Pick a launch country"><div class="n">${new Set(rows.map((l) => l.pad?.country?.name)).size}</div><div class="l">Countries</div></div>`;
  }
  // Deep link (#id) scroll
  const hash = location.hash.slice(1);
  if (hash) { const el = document.getElementById('l-' + hash); if (el) { el.scrollIntoView({ block: 'start' }); el.style.borderColor = 'var(--accent)'; } }
}

function renderLaunch(l) {
  const cfg = l.rocket?.configuration || {};
  const prov = l.launch_service_provider || {};
  const m = l.mission || {};
  const pad = l.pad || {};
  const mfr = cfg.families?.[0]?.manufacturer?.[0] || cfg.manufacturer;
  const facts = [
    ['Launch time (local)', fmtDateLocal(l.net)],
    ['Launch time (UTC)', `${fmtDate(l.net, { time: true })}${l.net_precision?.name && l.net_precision.name !== 'Minute' && l.net_precision.name !== 'Second' ? ` <span class="muted">(${esc(l.net_precision.name)} precision)</span>` : ''}`],
    l.window_start && l.window_end && l.window_start !== l.window_end ? ['Launch window', `${new Date(l.window_start).toISOString().slice(11, 16)}–${new Date(l.window_end).toISOString().slice(11, 16)} UTC`] : null,
    ['Rocket', `<a href="${rocketUrl(cfg.name || '')}">${esc(cfg.full_name || cfg.name || '—')}</a>${cfg.families?.length ? ` <span class="muted">· ${esc(cfg.families.map((f) => f.name).join(', '))} family</span>` : ''}`],
    ['Provider', `<a href="${makerUrl(null, prov.name)}">${esc(prov.name || '—')}</a>${prov.type?.name ? ` <span class="muted">· ${esc(prov.type.name)}</span>` : ''}`],
    mfr && mfr.name !== prov.name ? ['Rocket manufacturer', `<a href="${makerUrl(null, mfr.name)}">${esc(mfr.name)}</a>`] : null,
    ['Pad', `${pad.map_url ? `<a href="${esc(pad.map_url)}" target="_blank" rel="noopener">${esc(pad.name || '—')}</a>` : esc(pad.name || '—')}`],
    ['Location', `${esc(pad.location?.name || '—')}${pad.country?.name ? ` <span class="muted">· ${esc(pad.country.name)}</span>` : ''}`],
    m.type ? ['Mission type', esc(m.type)] : null,
    m.orbit?.name ? ['Target orbit', `${esc(m.orbit.name)}${m.orbit.abbrev ? ` (${esc(m.orbit.abbrev)})` : ''}`] : null,
    m.agencies?.length ? ['Customer / agencies', m.agencies.map((a) => `<a href="${makerUrl(null, a.name)}">${esc(a.name)}</a>`).join(', ')] : null,
    l.probability !== null && l.probability !== undefined ? ['Weather probability', `${l.probability}% go`] : null,
    l.weather_concerns ? ['Weather concerns', esc(l.weather_concerns)] : null,
    l.holdreason ? ['Hold reason', esc(l.holdreason)] : null,
    l.failreason ? ['Fail reason', esc(l.failreason)] : null,
    l.program?.length ? ['Program', l.program.map((p) => p.wiki_url || p.info_url ? `<a href="${esc(p.wiki_url || p.info_url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)).join(', ')] : null,
    l.orbital_launch_attempt_count_year ? ['Orbital attempt', `#${l.orbital_launch_attempt_count_year} of ${new Date(l.net).getUTCFullYear()} · #${l.orbital_launch_attempt_count} overall`] : null,
    l.agency_launch_attempt_count ? ['Provider launch', `#${l.agency_launch_attempt_count}${l.agency_launch_attempt_count_year ? ` (#${l.agency_launch_attempt_count_year} this year)` : ''}`] : null,
    l.pad_launch_attempt_count ? ['Pad launch', `#${l.pad_launch_attempt_count}${l.pad_turnaround ? ` · turnaround ${esc(isoDur(l.pad_turnaround))}` : ''}`] : null,
    l.launch_designator ? ['Designator', `<span class="mono">${esc(l.launch_designator)}</span>`] : null,
    l.hashtag ? ['Hashtag', esc(l.hashtag)] : null,
    cfg.leo_capacity ? ['Vehicle LEO capacity', `${fmtNum(cfg.leo_capacity)} kg`] : null,
    cfg.total_launch_count ? ['Vehicle record', `${fmtNum(cfg.successful_launches)} successes / ${fmtNum(cfg.failed_launches)} failures${cfg.consecutive_successful_launches ? `, ${cfg.consecutive_successful_launches} consecutive` : ''}`] : null,
    l.last_updated ? ['Schedule updated', fmtDate(l.last_updated, { time: true })] : null,
  ].filter(Boolean);
  const links = [
    ...(l.vid_urls || []).map((v) => ({ t: `▶ ${v.title || v.publisher || 'Webcast'}`, u: v.url })),
    ...(l.info_urls || []).map((v) => ({ t: v.title || 'Info', u: v.url })),
    ...(cfg.info_url ? [{ t: 'Rocket info', u: cfg.info_url }] : []),
    ...(cfg.wiki_url ? [{ t: 'Rocket on Wikipedia', u: cfg.wiki_url }] : []),
    ...(prov.info_url ? [{ t: `${prov.abbrev || prov.name} website`, u: prov.info_url }] : []),
    ...(prov.social_media_links || []).map((s) => ({ t: s.social_media?.name || 'Social', u: s.url })),
    ...(pad.wiki_url ? [{ t: 'Pad on Wikipedia', u: pad.wiki_url }] : []),
    ...(l.flightclub_url ? [{ t: 'Flight Club sim', u: l.flightclub_url }] : []),
    { t: 'Launch Library page', u: `https://spacelaunchnow.me/launch/${l.slug || l.id}` },
  ];
  const mil = isMil(l);
  const updates = (l.updates || []).slice(0, 3);
  return `<article class="launch" id="l-${esc(l.id)}">
    <div class="media">${l.image?.image_url ? `<img src="${esc(l.image.thumbnail_url || l.image.image_url)}" alt="" loading="lazy" decoding="async" data-fallback="${esc(l.image.thumbnail_url ? l.image.image_url : '')}" onerror="if(this.dataset.fallback&&this.src!==this.dataset.fallback){this.src=this.dataset.fallback;}else{this.remove();}">` : ''}<div class="cd ${new Date(l.net) < Date.now() ? 'past' : ''}" data-net="${esc(l.net)}">${countdown(l.net)}</div></div>
    <div class="body">
      <div class="title"><div><h3>${esc(l.name)}</h3><div class="meta">${m.name ? esc(m.name) + ' · ' : ''}<a href="${rocketUrl(cfg.name || '')}">${esc(cfg.name || '')}</a> · <a href="${makerUrl(null, prov.name)}">${esc(prov.abbrev || prov.name || '')}</a>${mil ? ' <span class="pill-mil">DEFENSE</span>' : ''}</div></div><span class="status ${statusClass(l.status)}" title="${esc(l.status?.description || '')}">${esc(l.status?.name || 'TBD')}</span></div>
      ${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
      <div class="facts">${facts.map(([k, v]) => `<div><div class="l">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
      ${l.mission_patches?.length ? `<div class="patches">${l.mission_patches.map((p) => `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" title="${esc(p.name)}" onerror="this.remove()">`).join('')}</div>` : ''}
      ${updates.length ? `<div class="note" style="margin-top:8px">${updates.map((u) => `<div>• ${fmtDate(u.created_on, { time: true })} — ${esc(u.comment)}${u.info_url ? ` <a href="${esc(u.info_url)}" target="_blank" rel="noopener">source</a>` : ''}</div>`).join('')}</div>` : ''}
      ${view === 'recent' ? deployed(l) : ''}
      <div class="links">${links.filter((x) => x.u).map((x) => `<a href="${esc(x.u)}" target="_blank" rel="noopener">${esc(x.t)}</a>`).join('')}</div>
    </div></article>`;
}

$('summary').addEventListener('click', (e) => {
  const tile = e.target.closest('[data-tile]'); if (!tile) return;
  const t = tile.dataset.tile;
  if (t === 'all') { $('q').value = ''; ['f-provider', 'f-country', 'f-status', 'f-rocket'].forEach((id) => { $(id).value = ''; }); $('f-mil').checked = false; tileState.next7 = false; tileState.outcome = ''; }
  else if (t === 'success' || t === 'failure' || t === 'objects') tileState.outcome = tileState.outcome === t ? '' : t;
  else if (t === 'next7') tileState.next7 = !tileState.next7;
  else if (t === 'go') $('f-status').value = $('f-status').value === 'Go for Launch' ? '' : 'Go for Launch';
  else if (t === 'mil') $('f-mil').checked = !$('f-mil').checked;
  else if (t === 'provider') { if ($('f-provider').value) $('f-provider').value = ''; else { $('f-provider').focus(); $('f-provider').showPicker?.(); return; } }
  else if (t === 'country') { if ($('f-country').value) $('f-country').value = ''; else { $('f-country').focus(); $('f-country').showPicker?.(); return; } }
  render();
});

function deployed(l) {
  if (!l.objectCount) {
    const failed = /Failure/.test(l.status?.abbrev || '');
    return `<div class="deployed none"><div class="hd">Payloads on the globe</div><div class="small muted">${failed ? 'Launch failed — no payloads reached a tracked orbit.' : new Date(l.net) > Date.now() - 3 * 86400e3 ? 'No public orbital elements yet — new objects usually appear in the CelesTrak feed within a few days of launch.' : 'No tracked objects are linked to this launch (payload may be classified, deep-space, or not yet catalogued).'}</div></div>`;
  }
  const orb = Object.entries(l.objectOrbits || {}).map(([k, v]) => `${v} ${k}`).join(' · ');
  return `<div class="deployed"><div class="hd"><span>Payloads now on the globe · ${l.objectCount}</span><span class="muted">${orb}${l.objectMil ? ` · <span style="color:var(--mil)">${l.objectMil} defense</span>` : ''}</span></div>
    <div class="objs">${l.objects.map((o) => `<a href="${satUrl(o.id)}" title="${esc(o.orbit)} · ${esc(o.owner || o.country || '')}${o.type !== 'PAY' ? ' · rocket body' : ''}"><span class="sw" style="background:${o.mil ? ORBIT_COLORS.MIL : ORBIT_COLORS[o.orbit]}"></span>${esc(o.name)}</a>`).join('')}${l.objectCount > l.objects.length ? `<span class="muted small">+${l.objectCount - l.objects.length} more</span>` : ''}</div></div>`;
}

setInterval(() => { document.querySelectorAll('.cd[data-net]').forEach((el) => { el.textContent = countdown(el.dataset.net); }); }, 1000);

async function loadView() {
  view = view === 'recent' ? 'recent' : 'upcoming';
  document.querySelectorAll('#view-switch button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('page-title').textContent = view === 'recent' ? 'Recent rocket launches worldwide' : 'Upcoming rocket launches worldwide';
  $('page-sub').textContent = view === 'recent'
    ? 'The latest launches from The Space Devs Launch Library, cross-referenced with live CelesTrak elements so you can see which payloads reached orbit and jump to them on the globe.'
    : 'Schedule from The Space Devs Launch Library. Times are shown in your local time zone with UTC alongside. Click a rocket or provider for its full profile.';
  $('list').innerHTML = '<div class="loading" style="position:static;background:transparent;padding:60px 0"><div class="spinner"></div><div>Loading launches…</div></div>';
  tileState.next7 = false; tileState.outcome = '';
  const url = new URL(location.href); if (view === 'recent') url.searchParams.set('view', 'recent'); else url.searchParams.delete('view'); history.replaceState(null, '', url);
  try {
    const r = await fetch(view === 'recent' ? '/api/launches/recent' : '/api/launches/upcoming');
    if (!r.ok) throw new Error((await r.json()).detail || 'unavailable');
    const d = await r.json();
    launches = d.results.sort((a, b) => new Date(a.net) - new Date(b.net));
    $('src').textContent = `Launch Library${d.source === 'dev' ? ' (dev mirror)' : ''} · ${view === 'recent' ? `${launches.length} recent` : `${d.count} upcoming`} · fetched ${fmtDate(d.fetched, { time: true })}`;
    fill('f-provider', launches.map((l) => l.launch_service_provider?.name), 'All providers');
    fill('f-country', launches.map((l) => l.pad?.country?.name), 'All launch countries');
    fill('f-status', launches.map((l) => l.status?.name), 'All statuses');
    fill('f-rocket', launches.map((l) => l.rocket?.configuration?.name), 'All rockets');
    render();
  } catch (e) {
    $('list').innerHTML = `<div class="card"><h2>Launch data unavailable</h2><div class="err">${esc(e.message)}</div></div>`;
  }
}
$('view-switch').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (!b || b.dataset.view === view) return; view = b.dataset.view; loadView(); });
['q', 'f-provider', 'f-country', 'f-status', 'f-rocket', 'f-mil'].forEach((id) => $(id).addEventListener('input', render));
loadView();
