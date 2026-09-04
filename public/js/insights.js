// Insights page: aggregations over the live catalog + GCAT launch history, rendered as SVG charts.
import { esc, fmtDate, fmtNum, startClock, rocketUrl, makerUrl, busUrl } from './common.js';

startClock(document.getElementById('clock'));
const $ = (id) => document.getElementById(id);
const tip = $('tip');
const css = (v) => getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(v).trim();
const ORBIT = { LEO: { c: css('--c-leo'), l: 'LEO' }, MEO: { c: css('--c-meo'), l: 'MEO' }, GEO: { c: css('--c-geo'), l: 'GEO' }, HEO: { c: css('--c-heo'), l: 'HEO / other' }, OTHER: { c: css('--c-heo'), l: 'HEO / other' } };
const SLOTS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'].map(css);
const SEQ = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'].map(css);
const GOOD = css('--good'), BAD = css('--critical'), MIL = css('--c-mil');

let sats = [], stats = null, history = null;
const isStarlink = (s) => /^STARLINK/i.test(s.name) || s.bus?.startsWith('Starlink');

// ---------------------------------------------------------------------------
// Tooltip
function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; moveTip(e); }
function moveTip(e) { const w = tip.offsetWidth, h = tip.offsetHeight; let x = e.clientX + 14, y = e.clientY + 14; if (x + w > innerWidth - 8) x = e.clientX - w - 14; if (y + h > innerHeight - 8) y = e.clientY - h - 14; tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
function hideTip() { tip.hidden = true; }
const row = (k, v, color) => `<div class="r"><span>${color ? `<i style="background:${color}"></i>` : ''}${esc(k)}</span><b>${v}</b></div>`;

// ---------------------------------------------------------------------------
// Chart primitives (SVG). Bars <= 24px, 4px rounded data-end, 2px surface gaps, recessive grid, text in text tokens.
const SVG = (w, h, inner) => `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>`;
function barPath(x, y, w, h, r, dir) {
  // Rounded on the data end only: dir 'right' (horizontal bar) or 'up' (column).
  if (w <= 0 || h <= 0) return '';
  r = Math.min(r, dir === 'right' ? w : h, (dir === 'right' ? h : w) / 2);
  if (dir === 'right') return `M${x},${y} H${x + w - r} a${r},${r} 0 0 1 ${r},${r} V${y + h - r} a${r},${r} 0 0 1 -${r},${r} H${x} Z`;
  return `M${x},${y + h} V${y + r} a${r},${r} 0 0 1 ${r},-${r} H${x + w - r} a${r},${r} 0 0 1 ${r},${r} V${y + h} Z`;
}

// Horizontal bars: rows [{label, value, color, href, sub, extra}]
function hbar(rows, { fmt = fmtNum, width = 520, labelW = 150, maxRows = 12, unit = '' } = {}) {
  rows = rows.slice(0, maxRows);
  const max = Math.max(...rows.map((r) => r.value), 1);
  const rowH = 30, barH = 18, top = 4;
  const plotW = width - labelW - 64;
  const h = top + rows.length * rowH + 4;
  const inner = rows.map((r, i) => {
    const y = top + i * rowH;
    const w = Math.max(2, (r.value / max) * plotW);
    const label = r.label.length > 24 ? r.label.slice(0, 23) + '…' : r.label;
    const g = `<g class="row" data-i="${i}"><rect class="hit" x="0" y="${y}" width="${width}" height="${rowH}" rx="6"></rect>
      <text class="lbl" x="${labelW - 10}" y="${y + barH / 2 + 4}" text-anchor="end">${esc(label)}</text>
      <path class="bar" d="${barPath(labelW, y + (rowH - barH) / 2 - 2, w, barH, 4, 'right')}" fill="${r.color}"></path>
      ${r.segments ? r.segments.map((sg) => sg.w > 0 ? `<path class="bar" d="${barPath(labelW + sg.x * plotW / max, y + (rowH - barH) / 2 - 2, Math.max(0, sg.w * plotW / max - 2), barH, sg.last ? 4 : 0, 'right')}" fill="${sg.color}"></path>` : '').join('') : ''}
      <text class="val" x="${labelW + w + 8}" y="${y + barH / 2 + 4}">${fmt(r.value)}${unit}</text></g>`;
    return r.href ? `<a href="${esc(r.href)}">${g}</a>` : g;
  }).join('');
  return { svg: SVG(width, h, inner), rows };
}

// Columns (optionally stacked): categories x[], series [{name, color, values, pattern}]
function columns(x, series, { width = 1080, height = 260, stacked = true, labelEvery = 5, fmt = fmtNum, xLabel = (v) => v } = {}) {
  const padL = 48, padR = 12, padT = 12, padB = 26;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const n = x.length;
  const totals = x.map((_, i) => stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(...series.map((s) => s.values[i] || 0)));
  const max = Math.max(1, ...totals);
  const nice = niceMax(max);
  const slot = plotW / n, colW = Math.min(24, Math.max(2, slot - 2));
  const y = (v) => padT + plotH - (v / nice) * plotH;
  const ticks = 4;
  let inner = `<g class="grid">${Array.from({ length: ticks + 1 }, (_, k) => { const v = (nice / ticks) * k; return `<line x1="${padL}" x2="${width - padR}" y1="${y(v)}" y2="${y(v)}"></line><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`; }).join('')}</g>`;
  inner += `<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="${BAD}"></rect><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(0,0,0,0.45)" stroke-width="3"></line></pattern></defs>`;
  for (let i = 0; i < n; i++) {
    const cx = padL + i * slot + (slot - colW) / 2;
    let acc = 0;
    let bars = '';
    series.forEach((s, k) => {
      const v = s.values[i] || 0; if (!v) return;
      const y0 = stacked ? y(acc + v) : y(v), y1 = stacked ? y(acc) : y(0);
      const isTop = stacked ? series.slice(k + 1).every((t) => !(t.values[i] || 0)) : true;
      const hgt = Math.max(0, y1 - y0 - (stacked && acc > 0 ? 2 : 0));
      bars += `<path class="bar" d="${barPath(cx, y0, colW, hgt, isTop ? 4 : 0, 'up')}" fill="${s.pattern ? 'url(#hatch)' : s.color}"></path>`;
      if (stacked) acc += v;
    });
    inner += `<g class="col" data-i="${i}"><rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}"></rect>${bars}</g>`;
    if (i % labelEvery === 0 || (i === n - 1 && (n - 1) % labelEvery >= Math.max(2, labelEvery / 2))) inner += `<text x="${cx + colW / 2}" y="${height - 8}" text-anchor="middle">${esc(xLabel(x[i]))}</text>`;
  }
  inner += `<g class="axis"><line x1="${padL}" x2="${width - padR}" y1="${y(0)}" y2="${y(0)}"></line></g>`;
  return SVG(width, height, inner);
}

// Multi-series lines with crosshair tooltip
function lines(x, series, { width = 1080, height = 260, fmt = fmtNum, labelEvery = 5 } = {}) {
  const padL = 48, padR = 110, padT = 12, padB = 26;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const n = x.length;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const nice = niceMax(max);
  const xs = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - (v / nice) * plotH;
  const ticks = 4;
  let inner = `<g class="grid">${Array.from({ length: ticks + 1 }, (_, k) => { const v = (nice / ticks) * k; return `<line x1="${padL}" x2="${width - padR}" y1="${y(v)}" y2="${y(v)}"></line><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`; }).join('')}</g>`;
  // end labels, de-collided
  const ends = series.map((s, k) => ({ k, y: y(s.values[n - 1] || 0), name: s.name })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  series.forEach((s, k) => {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    inner += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>`;
    inner += `<circle cx="${xs(n - 1)}" cy="${y(s.values[n - 1] || 0)}" r="4" fill="${s.color}" stroke="var(--surface-1)" stroke-width="2"></circle>`;
    const e = ends.find((q) => q.k === k);
    inner += `<text class="lbl" x="${xs(n - 1) + 10}" y="${e.y + 4}">${esc(s.name.length > 14 ? s.name.slice(0, 13) + '…' : s.name)}</text>`;
  });
  for (let i = 0; i < n; i++) if (i % labelEvery === 0 || (i === n - 1 && (n - 1) % labelEvery >= Math.max(2, labelEvery / 2))) inner += `<text x="${xs(i)}" y="${height - 8}" text-anchor="middle">${esc(String(x[i]))}</text>`;
  inner += `<line class="xh" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" stroke="rgba(255,255,255,0.25)" stroke-width="1" visibility="hidden"></line>`;
  inner += `<rect class="hover-zone" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"></rect>`;
  return { svg: SVG(width, height, inner), xs, padL, plotW };
}

function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10; return m * p; }
function legend(items) { return `<div class="legend">${items.map((s) => `<span><i style="background:${s.color}"></i>${s.href ? `<a href="${esc(s.href)}">${esc(s.name)}</a>` : esc(s.name)}</span>`).join('')}</div>`; }

// Card with chart + table toggle
function card({ id, title, sub, wide = false, chart, table, extra = '' }) {
  return `<section class="card ${wide ? 'wide' : ''}" id="${id}"><div class="card-hd"><h2>${title}</h2><div class="tools"><button data-view="chart" class="on">Chart</button><button data-view="table">Table</button></div></div>${sub ? `<div class="sub">${sub}</div>` : ''}<div class="chart" data-mode="chart">${chart}${extra}</div><div class="tblview" hidden>${table}</div></section>`;
}
const table = (cols, rows) => `<div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

// ---------------------------------------------------------------------------
// Aggregations
const countBy = (arr, fn) => { const m = new Map(); for (const s of arr) { const k = fn(s); if (k == null || k === '') continue; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const CONSTELLATIONS = [
  ['Starlink', /^STARLINK/i], ['OneWeb', /^ONEWEB/i], ['Kuiper', /^KUIPER/i], ['Qianfan', /^QIANFAN|^SPACESAIL/i], ['Guowang', /^HULIANWANG|^GUOWANG|^SATNET|^XW-/i], ['Planet', /^FLOCK|^SKYSAT|^PELICAN|^TANAGER|^DOVE/i], ['Spire Lemur', /^LEMUR/i], ['Iridium', /^IRIDIUM/i], ['Globalstar', /^GLOBALSTAR/i], ['Orbcomm', /^ORBCOMM/i], ['GPS', /^GPS|^NAVSTAR/i], ['GLONASS', /GLONASS/i], ['Galileo', /^GSAT|^GALILEO/i], ['BeiDou', /^BEIDOU/i], ['Swarm', /^SPACEBEE/i], ['Jilin-1', /^JILIN/i], ['Yaogan', /^YAOGAN/i], ['ICEYE', /^ICEYE/i], ['Capella', /^CAPELLA/i], ['BlackSky', /^BLACKSKY|^GLOBAL-\d/i], ['HawkEye 360', /^HAWK-/i], ['Kinéis', /^KINEIS/i], ['Tianqi', /^TIANQI/i], ['Geely', /^GEELY|^GEESAT/i], ['Lynk', /^LYNK/i], ['Tracking Layer (SDA)', /^TRANCHE|^T1TL|^T1TR|^T0TL/i], ['Starshield', /^STARSHIELD/i], ['AST SpaceMobile', /^BLUEBIRD|^SPACEMOBILE/i], ['SES O3b', /^O3B/i], ['Intelsat', /^INTELSAT|^IS-\d|^GALAXY/i], ['SES', /^SES-|^ASTRA/i], ['Eutelsat', /^EUTELSAT|^HOTBIRD/i],
];
function constellation(s) { for (const [n, re] of CONSTELLATIONS) if (re.test(s.name)) return n; return null; }

function build() {
  const hide = $('hide-starlink').checked;
  const data = hide ? sats.filter((s) => !isStarlink(s)) : sats;
  const pay = data.filter((s) => s.type === 'PAY');
  const q = (o) => 'index.html?' + new URLSearchParams(o).toString();
  const orbitLabel = (o) => ORBIT[o]?.l || o;
  const orbitKey = (o) => (o === 'OTHER' ? 'HEO' : o);

  // Hero tiles
  const yr = new Date().getUTCFullYear();
  const hy = history?.years.find((y) => y.year === yr);
  const countries = countBy(pay, (s) => s.country);
  const operators = countBy(pay, (s) => s.owner);
  const mil = pay.filter((s) => s.mil).length;
  const newest = pay.filter((s) => s.launched && Date.now() - new Date(s.launched) < 365 * 86400e3).length;
  $('hero').innerHTML = [
    { n: fmtNum(pay.length), l: 'Payloads tracked', d: hide ? 'Starlink hidden' : `${fmtNum(sats.filter(isStarlink).length)} are Starlink`, href: 'index.html' },
    { n: fmtNum(countries.length), l: 'Countries & agencies', d: `${esc(countries[0]?.[0] || '')} leads with ${fmtNum(countries[0]?.[1] || 0)}`, href: q({ country: countries[0]?.[0] || '' }) },
    { n: fmtNum(operators.length), l: 'Operators', d: `top: ${esc(operators[0]?.[0] || '')}`, href: 'detail.html?type=owners' },
    { n: fmtNum(mil), l: 'Defense / military', d: `${(100 * mil / Math.max(1, pay.length)).toFixed(1)}% of payloads`, href: q({ mil: 1 }) },
    { n: fmtNum(newest), l: 'Launched in last 12 months', d: `${(100 * newest / Math.max(1, pay.length)).toFixed(0)}% of everything up there`, href: q({ year: String(yr) }) },
    hy ? { n: fmtNum(hy.orbital), l: `Orbital launches in ${yr}`, d: `${hy.success} succeeded · ${hy.failure} failed · ${(100 * hy.success / Math.max(1, hy.orbital)).toFixed(1)}% success`, href: 'launches.html?view=recent' } : null,
    stats?.coverage ? { n: `${(100 * stats.coverage.shownActivePayloads / stats.coverage.satcatActivePayloads).toFixed(0)}%`, l: 'Of active payloads plotted', d: `${fmtNum(stats.coverage.untracked)} lack public elements`, href: 'detail.html?type=untracked' } : null,
  ].filter(Boolean).map((t) => `<a class="tile" href="${esc(t.href)}"><div class="n">${t.n}</div><div class="l">${t.l}</div><div class="d">${t.d}</div></a>`).join('');

  const cards = [];

  // 1. Countries (stacked by orbit class)
  {
    const top = countries.slice(0, 12);
    const rows = top.map(([c, n]) => {
      const subset = pay.filter((s) => s.country === c);
      const byO = ['LEO', 'MEO', 'GEO', 'HEO'].map((o) => [o, subset.filter((s) => orbitKey(s.orbit) === o).length]);
      let x = 0; const segments = byO.filter(([, v]) => v).map(([o, v], i, a) => { const seg = { x, w: v, color: ORBIT[o].c, last: i === a.length - 1 }; x += v; return seg; });
      return { label: c, value: n, color: 'transparent', segments, href: q({ country: c }), byO, milN: subset.filter((s) => s.mil).length };
    });
    const other = countries.slice(12).reduce((a, [, n]) => a + n, 0);
    const { svg } = hbar(rows, { labelW: 150 });
    cards.push(card({ id: 'countries', title: 'Payloads in orbit by country', sub: `Top 12 of ${countries.length}; ${fmtNum(other)} payloads belong to the remaining ${countries.length - 12}. Colour shows orbit class. Click a bar to open that country on the globe.`, chart: svg, extra: legend(['LEO', 'MEO', 'GEO', 'HEO'].map((o) => ({ name: ORBIT[o].l, color: ORBIT[o].c }))), table: table(['Country', 'Payloads', 'LEO', 'MEO', 'GEO', 'HEO / other', 'Military'], countries.map(([c, n]) => { const r = rows.find((x) => x.label === c); return [`<a href="${q({ country: c })}">${esc(c)}</a>`, fmtNum(n), ...(r ? r.byO.map(([, v]) => fmtNum(v)) : ['', '', '', '']), r ? fmtNum(r.milN) : '']; })) }));
    attachRowTip('countries', rows, (r) => `<div class="t">${esc(r.label)}</div>${row('Payloads', fmtNum(r.value))}${r.byO.map(([o, v]) => row(ORBIT[o].l, fmtNum(v), ORBIT[o].c)).join('')}${row('Defense / military', fmtNum(r.milN), MIL)}<div class="muted small" style="margin-top:4px">Click to view on the globe</div>`);
  }

  // 2. Orbit classes with military overlay
  {
    const classes = ['LEO', 'MEO', 'GEO', 'HEO'];
    const rows = classes.map((o) => { const subset = pay.filter((s) => orbitKey(s.orbit) === o); const m = subset.filter((s) => s.mil).length; return { label: ORBIT[o].l, value: subset.length, color: ORBIT[o].c, href: q({ orbit: o === 'HEO' ? 'HEO,OTHER' : o }), milN: m, segments: m ? [{ x: subset.length - m, w: m, color: MIL, last: true }] : null }; });
    const { svg } = hbar(rows, { labelW: 110 });
    cards.push(card({ id: 'orbits', title: 'Where everything flies', sub: 'Payloads by orbit class; the red tail is the defense / military share. Click to filter the globe.', chart: svg, extra: legend([...classes.map((o) => ({ name: ORBIT[o].l, color: ORBIT[o].c })), { name: 'Defense / military', color: MIL }]), table: table(['Orbit', 'Payloads', 'Military', 'Military %'], rows.map((r) => [esc(r.label), fmtNum(r.value), fmtNum(r.milN), (100 * r.milN / Math.max(1, r.value)).toFixed(1) + '%'])) }));
    attachRowTip('orbits', rows, (r) => `<div class="t">${esc(r.label)}</div>${row('Payloads', fmtNum(r.value))}${row('Defense / military', fmtNum(r.milN), MIL)}`);
  }

  // 3. Launch year (stacked by orbit) 1990 → now
  {
    const y0 = 1990, years = Array.from({ length: yr - y0 + 1 }, (_, i) => y0 + i);
    const series = ['LEO', 'MEO', 'GEO', 'HEO'].map((o) => ({ name: ORBIT[o].l, color: ORBIT[o].c, key: o, values: years.map((y) => pay.filter((s) => (s.launched || '').slice(0, 4) === String(y) && orbitKey(s.orbit) === o).length) }));
    const svg = columns(years, series, { labelEvery: 5 });
    cards.push(card({ id: 'years', title: 'Still-in-orbit payloads by launch year', wide: true, sub: 'Survivorship view: what is up there today, by the year it launched. The post-2019 wall is the megaconstellation era. Click a year to see those objects on the globe.', chart: svg, extra: legend(series), table: table(['Year', 'Total', ...series.map((s) => s.name)], years.map((y, i) => [`<a href="${q({ year: String(y) })}">${y}</a>`, fmtNum(series.reduce((a, s) => a + s.values[i], 0)), ...series.map((s) => fmtNum(s.values[i]))]).reverse()) }));
    attachColTip('years', years, series, (i) => q({ year: String(years[i]) }));
  }

  // 4. Top rockets
  {
    const rockets = countBy(pay, (s) => s.lvType).slice(0, 12);
    const rows = rockets.map(([r, n], i) => ({ label: r, value: n, color: SLOTS[0], href: rocketUrl(r), milN: pay.filter((s) => s.lvType === r && s.mil).length }));
    const { svg } = hbar(rows, { labelW: 150 });
    cards.push(card({ id: 'rockets', title: 'Rockets that put the most in orbit', sub: 'Payloads currently in orbit by launch vehicle type. Click for the rocket profile.', chart: svg, table: table(['Rocket', 'Payloads in orbit', 'Military'], rows.map((r) => [`<a href="${r.href}">${esc(r.label)}</a>`, fmtNum(r.value), fmtNum(r.milN)])) }));
    attachRowTip('rockets', rows, (r) => `<div class="t">${esc(r.label)}</div>${row('Payloads in orbit', fmtNum(r.value))}${row('Defense / military', fmtNum(r.milN), MIL)}<div class="muted small" style="margin-top:4px">Click for the rocket profile</div>`);
  }

  // 5. Manufacturers & 6. Operators
  for (const [id, title, key, codeKey] of [['makers', 'Top satellite manufacturers', 'mf', 'mfCode'], ['operators', 'Top operators', 'owner', 'ownerCode']]) {
    const top = countBy(pay, (s) => s[key]).slice(0, 12);
    const rows = top.map(([name, n]) => { const s0 = pay.find((s) => s[key] === name); return { label: name, value: n, color: SLOTS[id === 'makers' ? 2 : 6], href: makerUrl(s0?.[codeKey], name), country: s0?.country, milN: pay.filter((s) => s[key] === name && s.mil).length }; });
    const { svg } = hbar(rows, { labelW: 170 });
    cards.push(card({ id, title, sub: `Payloads in orbit by ${id === 'makers' ? 'builder' : 'operating organisation'}. Click for the organisation profile.`, chart: svg, table: table(['Organisation', 'Country', 'Payloads', 'Military'], rows.map((r) => [`<a href="${r.href}">${esc(r.label)}</a>`, esc(r.country || ''), fmtNum(r.value), fmtNum(r.milN)])) }));
    attachRowTip(id, rows, (r) => `<div class="t">${esc(r.label)}</div>${row('Country', esc(r.country || '—'))}${row('Payloads in orbit', fmtNum(r.value))}${row('Defense / military', fmtNum(r.milN), MIL)}`);
  }

  // 7. Military by country
  {
    const m = countBy(pay.filter((s) => s.mil), (s) => s.country).slice(0, 12);
    const rows = m.map(([c, n]) => ({ label: c, value: n, color: MIL, href: q({ country: c, mil: 1 }), total: pay.filter((s) => s.country === c).length }));
    const { svg } = hbar(rows, { labelW: 150 });
    cards.push(card({ id: 'mil', title: 'Defense & military payloads by country', sub: 'Operator is a defense organisation, or the name matches a known defense programme. Navigation constellations run by armed forces count. Click to show them on the globe.', chart: svg, table: table(['Country', 'Military payloads', 'All payloads', 'Share'], rows.map((r) => [`<a href="${r.href}">${esc(r.label)}</a>`, fmtNum(r.value), fmtNum(r.total), (100 * r.value / Math.max(1, r.total)).toFixed(0) + '%'])) }));
    attachRowTip('mil', rows, (r) => `<div class="t">${esc(r.label)}</div>${row('Military payloads', fmtNum(r.value), MIL)}${row('All payloads', fmtNum(r.total))}${row('Share', (100 * r.value / Math.max(1, r.total)).toFixed(0) + '%')}`);
  }

  // 8. Constellations
  {
    const c = countBy(pay, constellation).slice(0, 14);
    const rows = c.map(([name, n]) => { const first = pay.find((s) => constellation(s) === name); return { label: name, value: n, color: SLOTS[0], href: q({ q: name === 'Guowang' ? 'HULIANWANG' : name === 'Planet' ? 'FLOCK' : name === 'Spire Lemur' ? 'LEMUR' : name === 'Tracking Layer (SDA)' ? 'TRANCHE' : name === 'AST SpaceMobile' ? 'BLUEBIRD' : name === 'Swarm' ? 'SPACEBEE' : name === 'HawkEye 360' ? 'HAWK-' : name.split(' ')[0] }), owner: first?.owner, orbit: first?.orbit }; });
    const { svg } = hbar(rows, { labelW: 150, maxRows: 14 });
    cards.push(card({ id: 'constellations', title: 'Largest constellations', sub: 'Grouped by satellite naming. Click to search the globe for that constellation.', chart: svg, table: table(['Constellation', 'Operator', 'Orbit', 'Payloads'], rows.map((r) => [`<a href="${r.href}">${esc(r.label)}</a>`, esc(r.owner || ''), esc(r.orbit || ''), fmtNum(r.value)])) }));
    attachRowTip('constellations', rows, (r) => `<div class="t">${esc(r.label)}</div>${row('Payloads', fmtNum(r.value))}${row('Operator', esc(r.owner || '—'))}`);
  }

  // 9. Altitude histogram (LEO perigee)
  {
    const bin = 50, lo = 150, hi = 2000;
    const bins = Array.from({ length: (hi - lo) / bin }, (_, i) => lo + i * bin);
    const leo = pay.filter((s) => orbitKey(s.orbit) === 'LEO' && s.perigee >= lo && s.perigee < hi);
    const series = [{ name: 'Civil / commercial', color: ORBIT.LEO.c, values: bins.map((b) => leo.filter((s) => !s.mil && s.perigee >= b && s.perigee < b + bin).length) }, { name: 'Defense / military', color: MIL, values: bins.map((b) => leo.filter((s) => s.mil && s.perigee >= b && s.perigee < b + bin).length) }];
    const svg = columns(bins, series, { labelEvery: 4, xLabel: (b) => `${b}` });
    cards.push(card({ id: 'alt', title: 'Low Earth orbit by altitude', wide: true, sub: 'Payloads by perigee altitude in 50 km bins. The spikes are constellation shells (Starlink ~540–570 km, OneWeb ~1,200 km). Click a bin to see who lives there.', chart: svg, extra: legend(series), table: table(['Perigee (km)', 'Payloads', 'Military'], bins.map((b, i) => [`<a href="${q({ alt: `${b}-${b + bin}` })}">${b}–${b + bin}</a>`, fmtNum(series[0].values[i] + series[1].values[i]), fmtNum(series[1].values[i])])) }));
    attachColTip('alt', bins, series, (i) => q({ alt: `${bins[i]}-${bins[i] + bin}`, orbit: 'LEO' }), (b) => `${b}–${b + bin} km perigee`);
  }

  // 10. Heatmap: inclination × altitude for LEO
  {
    const incBin = 5, altBin = 100, altLo = 200, altHi = 2000;
    const incs = Array.from({ length: 120 / incBin }, (_, i) => i * incBin);
    const alts = Array.from({ length: (altHi - altLo) / altBin }, (_, i) => altLo + i * altBin);
    const leo = pay.filter((s) => orbitKey(s.orbit) === 'LEO');
    const grid = alts.map((a) => incs.map((inc) => leo.filter((s) => s.perigee >= a && s.perigee < a + altBin && s.inc >= inc && s.inc < inc + incBin)));
    const max = Math.max(1, ...grid.flat().map((c) => c.length));
    const W = 1080, H = 300, padL = 60, padB = 30, padT = 10, padR = 10;
    const cw = (W - padL - padR) / incs.length, ch = (H - padT - padB) / alts.length;
    const shade = (n) => n === 0 ? 'transparent' : SEQ[Math.min(6, Math.floor(Math.log(n + 1) / Math.log(max + 1) * 6.999))];
    let inner = '';
    grid.forEach((rowCells, ai) => rowCells.forEach((cells, ii) => { inner += `<rect class="cell" data-a="${ai}" data-i="${ii}" x="${padL + ii * cw + 1}" y="${padT + (alts.length - 1 - ai) * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="2" fill="${shade(cells.length)}" ${cells.length ? '' : 'stroke="rgba(120,140,190,0.08)"'}></rect>`; }));
    incs.forEach((inc, i) => { if (i % 2 === 0) inner += `<text x="${padL + i * cw + cw / 2}" y="${H - 10}" text-anchor="middle">${inc}°</text>`; });
    alts.forEach((a, i) => { if (i % 3 === 0) inner += `<text x="${padL - 8}" y="${padT + (alts.length - 1 - i) * ch + ch / 2 + 4}" text-anchor="end">${a} km</text>`; });
    const svg = SVG(W, H, inner);
    cards.push(card({ id: 'heat', title: 'Orbital shells: inclination × altitude (LEO)', wide: true, sub: 'Each cell counts payloads with that perigee and inclination. Bright bands are constellation shells; ~97° is the sun-synchronous corridor used by imaging satellites; 53° is Starlink. Click a cell to view its residents.', chart: svg, extra: `<div class="heat-scale">1 <span class="ramp"></span> ${fmtNum(max)} payloads (log scale)</div>`, table: table(['Altitude', ...incs.filter((_, i) => i % 2 === 0).map((i) => `${i}–${i + 2 * incBin}°`)], alts.map((a, ai) => [`${a}–${a + altBin} km`, ...incs.filter((_, i) => i % 2 === 0).map((_, k) => fmtNum(grid[ai][2 * k].length + (grid[ai][2 * k + 1]?.length || 0)))]).reverse()) }));
    setTimeout(() => {
      const el = document.querySelector('#heat svg');
      el.addEventListener('mousemove', (e) => { const c = e.target.closest('.cell'); if (!c) return hideTip(); const cells = grid[+c.dataset.a][+c.dataset.i]; const a = alts[+c.dataset.a], inc = incs[+c.dataset.i]; const top = countBy(cells, constellation).slice(0, 3); showTip(e, `<div class="t">${a}–${a + altBin} km · ${inc}–${inc + incBin}°</div>${row('Payloads', fmtNum(cells.length))}${top.map(([n, v]) => row(n, fmtNum(v))).join('')}${cells.some((s) => s.mil) ? row('Defense / military', fmtNum(cells.filter((s) => s.mil).length), MIL) : ''}${cells.length ? '<div class="muted small" style="margin-top:4px">Click to view on the globe</div>' : ''}`); });
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('click', (e) => { const c = e.target.closest('.cell'); if (!c) return; const cells = grid[+c.dataset.a][+c.dataset.i]; if (!cells.length) return; const a = alts[+c.dataset.a], inc = incs[+c.dataset.i]; location.href = q({ alt: `${a}-${a + altBin}`, inc: `${inc}-${inc + incBin}`, orbit: 'LEO' }); });
      el.querySelectorAll('.cell').forEach((c) => { if (c.getAttribute('fill') !== 'transparent') c.style.cursor = 'pointer'; });
    });
  }

  // 11. Age distribution
  {
    const buckets = [['< 1 year', 0, 1], ['1–3 years', 1, 3], ['3–5 years', 3, 5], ['5–10 years', 5, 10], ['10–20 years', 10, 20], ['20+ years', 20, 200]];
    const age = (s) => (Date.now() - new Date(s.launched).getTime()) / (365.25 * 86400e3);
    const withDate = pay.filter((s) => s.launched);
    const rows = buckets.map(([label, a, b]) => { const subset = withDate.filter((s) => age(s) >= a && age(s) < b); return { label, value: subset.length, color: SLOTS[3], milN: subset.filter((s) => s.mil).length, geo: subset.filter((s) => s.orbit === 'GEO').length }; });
    const { svg } = hbar(rows, { labelW: 110 });
    cards.push(card({ id: 'age', title: 'How old is the fleet?', sub: 'Payloads in orbit by time since launch. Old survivors are mostly GEO communications satellites and navigation constellations.', chart: svg, table: table(['Age', 'Payloads', 'Of which GEO', 'Military'], rows.map((r) => [esc(r.label), fmtNum(r.value), fmtNum(r.geo), fmtNum(r.milN)])) }));
    attachRowTip('age', rows, (r) => `<div class="t">${esc(r.label)}</div>${row('Payloads', fmtNum(r.value))}${row('In GEO', fmtNum(r.geo), ORBIT.GEO.c)}${row('Defense / military', fmtNum(r.milN), MIL)}`);
  }

  // 12–14. Launch history (server, unaffected by Starlink toggle)
  if (history) {
    const years = history.years.map((y) => y.year);
    const from = years.indexOf(1957) >= 0 ? years.indexOf(1957) : 0;
    const ys = years.slice(from), hs = history.years.slice(from);
    const series = [{ name: 'Successful', color: GOOD, values: hs.map((y) => y.success) }, { name: 'Failed', color: BAD, pattern: true, values: hs.map((y) => y.failure) }];
    cards.push(card({ id: 'lh', title: 'Orbital launch attempts per year, 1957 → today', wide: true, sub: 'Every orbital launch attempt worldwide (GCAT). Hatched red is failures. The Cold War peak of the 1960s–80s was only surpassed in 2021; the curve is now steeper than at any point in history. The final column is the current year to date.', chart: columns(ys, series, { labelEvery: 5 }), extra: legend(series), table: table(['Year', 'Attempts', 'Successful', 'Failed', 'Success rate'], hs.map((y) => [y.year, fmtNum(y.orbital), fmtNum(y.success), fmtNum(y.failure), (100 * y.success / Math.max(1, y.orbital)).toFixed(1) + '%']).reverse()) }));
    attachColTip('lh', ys, series, null, (y) => String(y), (i) => row('Success rate', (100 * hs[i].success / Math.max(1, hs[i].orbital)).toFixed(1) + '%'));

    const since = years.indexOf(1990);
    const st = history.states.map((s, k) => ({ name: s.name, color: SLOTS[k % 8], values: s.values.slice(since), href: q({ country: s.name }) }));
    const stOther = { name: 'Other', color: css('--muted'), values: history.statesOther.slice(since) };
    const L1 = lines(years.slice(since), [...st, stOther], { labelEvery: 5 });
    cards.push(card({ id: 'lstates', title: 'Launch race: orbital launches per year by country', wide: true, sub: 'Launching state of the operating agency, since 1990. The US line is dominated by SpaceX from 2017; China\'s climb starts around 2010. The last point is the current year to date, so every line dips.', chart: L1.svg, extra: legend([...st, stOther]), table: table(['Year', ...st.map((s) => s.name), 'Other'], years.slice(since).map((y, i) => [y, ...st.map((s) => fmtNum(s.values[i])), fmtNum(stOther.values[i])]).reverse()) }));
    attachLineTip('lstates', years.slice(since), [...st, stOther], L1);

    const since15 = years.indexOf(2015);
    const fam = history.families.map((f, k) => ({ name: f.name, color: SLOTS[k % 8], values: f.values.slice(since15), href: f.vehicles?.[0] ? rocketUrl(f.vehicles[0]) : null, vehicles: f.vehicles }));
    const famOther = { name: 'Other', color: css('--muted'), values: history.familiesOther.slice(since15) };
    const L2 = lines(years.slice(since15), [...fam, famOther], { labelEvery: 1 });
    cards.push(card({ id: 'lfam', title: 'Busiest rocket families since 2015', wide: true, sub: 'Orbital launch attempts per year by launch-vehicle family. Click a family in the legend for its leading vehicle\'s profile. The last point is the current year to date.', chart: L2.svg, extra: legend([...fam, famOther]), table: table(['Year', ...fam.map((s) => s.name), 'Other'], years.slice(since15).map((y, i) => [y, ...fam.map((s) => fmtNum(s.values[i])), fmtNum(famOther.values[i])]).reverse()) }));
    attachLineTip('lfam', years.slice(since15), [...fam, famOther], L2);
  }

  $('charts').innerHTML = cards.join('');
  // chart/table toggles
  document.querySelectorAll('.card .tools button').forEach((b) => b.onclick = () => { const c = b.closest('.card'); c.querySelectorAll('.tools button').forEach((x) => x.classList.toggle('on', x === b)); c.querySelector('.chart').hidden = b.dataset.view !== 'chart'; c.querySelector('.tblview').hidden = b.dataset.view !== 'table'; });
}

// Hover wiring -----------------------------------------------------------------
function attachRowTip(id, rows, html) {
  setTimeout(() => { const el = document.querySelector(`#${id} svg`); if (!el) return;
    el.addEventListener('mousemove', (e) => { const g = e.target.closest('g.row'); if (!g) return hideTip(); showTip(e, html(rows[+g.dataset.i])); });
    el.addEventListener('mouseleave', hideTip); });
}
function attachColTip(id, x, series, hrefFn, xLabel = (v) => String(v), extraRow = null) {
  setTimeout(() => { const el = document.querySelector(`#${id} svg`); if (!el) return;
    el.addEventListener('mousemove', (e) => { const g = e.target.closest('g.col'); if (!g) return hideTip(); const i = +g.dataset.i; const total = series.reduce((a, s) => a + (s.values[i] || 0), 0); showTip(e, `<div class="t">${esc(xLabel(x[i]))}</div>${row('Total', fmtNum(total))}${series.map((s) => row(s.name, fmtNum(s.values[i] || 0), s.color)).join('')}${extraRow ? extraRow(i) : ''}${hrefFn && total ? '<div class="muted small" style="margin-top:4px">Click to view on the globe</div>' : ''}`); });
    el.addEventListener('mouseleave', hideTip);
    if (hrefFn) { el.style.cursor = 'pointer'; el.addEventListener('click', (e) => { const g = e.target.closest('g.col'); if (!g) return; const i = +g.dataset.i; if (series.reduce((a, s) => a + (s.values[i] || 0), 0)) location.href = hrefFn(i); }); } });
}
function attachLineTip(id, x, series, L) {
  setTimeout(() => { const el = document.querySelector(`#${id} svg`); if (!el) return; const xh = el.querySelector('.xh');
    el.addEventListener('mousemove', (e) => { const r = el.getBoundingClientRect(); const vbW = el.viewBox.baseVal.width; const px = (e.clientX - r.left) / r.width * vbW; if (px < L.padL || px > L.padL + L.plotW) { xh.setAttribute('visibility', 'hidden'); return hideTip(); } const i = Math.round((px - L.padL) / L.plotW * (x.length - 1)); xh.setAttribute('x1', L.xs(i)); xh.setAttribute('x2', L.xs(i)); xh.setAttribute('visibility', 'visible'); const sorted = series.map((s) => ({ s, v: s.values[i] || 0 })).sort((a, b) => b.v - a.v); showTip(e, `<div class="t">${esc(String(x[i]))}</div>${sorted.map(({ s, v }) => row(s.name, fmtNum(v), s.color)).join('')}`); });
    el.addEventListener('mouseleave', () => { xh.setAttribute('visibility', 'hidden'); hideTip(); }); });
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const [satsR, histR] = await Promise.all([fetch('/api/satellites'), fetch('/api/insights/launches')]);
    const d = await satsR.json(); sats = d.satellites; stats = d.stats;
    history = histR.ok ? await histR.json() : null;
    $('src').textContent = `CelesTrak GP ${fmtDate(stats.gpUpdated, { time: true })} · GCAT launch list · ${fmtNum(sats.length)} objects`;
    build();
    $('hide-starlink').onchange = build;
  } catch (e) {
    $('charts').innerHTML = `<div class="card wide"><h2>Could not load data</h2><div class="err">${esc(e.message)}</div></div>`;
  }
})();
