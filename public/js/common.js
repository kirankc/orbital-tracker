// Shared helpers for all pages.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ORBIT_COLORS = { LEO: '#4cc9f0', MEO: '#80ed99', GEO: '#ffb703', HEO: '#c77dff', OTHER: '#adb5bd', MIL: '#ff4d6d' };
export const ORBIT_LABEL = { LEO: 'Low Earth orbit', MEO: 'Medium Earth orbit', GEO: 'Geosynchronous orbit', HEO: 'Highly elliptical orbit', OTHER: 'Other orbit' };

export function fmtDate(iso, { time = false, utc = true } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const opts = { year: 'numeric', month: 'short', day: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}), ...(utc ? { timeZone: 'UTC' } : {}) };
  return d.toLocaleString(undefined, opts) + (time && utc ? ' UTC' : '');
}
export function fmtDateLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}
export const fmtNum = (n, digits = 0) => (n === null || n === undefined || Number.isNaN(+n) ? '—' : (+n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }));
export function yearsSince(iso) {
  if (!iso) return null;
  const y = (Date.now() - new Date(iso).getTime()) / (365.25 * 86400e3);
  return y < 1 ? `${Math.round(y * 12)} months` : `${y.toFixed(1)} years`;
}
export function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  const sign = ms < 0 ? '+' : '-';
  const a = Math.abs(ms) / 1000;
  const d = Math.floor(a / 86400), h = Math.floor((a % 86400) / 3600), m = Math.floor((a % 3600) / 60), s = Math.floor(a % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return `T${sign} ${d > 0 ? d + 'd ' : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}

export const rocketUrl = (name) => `detail.html?type=rocket&name=${encodeURIComponent(name)}`;
export const makerUrl = (code, name) => code ? `detail.html?type=maker&code=${encodeURIComponent(code)}` : `detail.html?type=maker&name=${encodeURIComponent(name || '')}`;
export const busUrl = (name) => `detail.html?type=bus&name=${encodeURIComponent(name)}`;
export const satUrl = (id) => `index.html?sat=${id}`;
export const launchUrl = (id) => `launches.html#${id}`;

export function linkRocket(name, cls = '') { return name ? `<a class="${cls}" href="${rocketUrl(name)}" title="Open rocket profile">${esc(name)}</a>` : '—'; }
export function linkMaker(code, name, cls = '') { return name ? `<a class="${cls}" href="${makerUrl(code, name)}" title="Open organisation profile">${esc(name)}</a>` : '—'; }
export function linkBus(name, cls = '') { return name ? `<a class="${cls}" href="${busUrl(name)}" title="Open bus / model profile">${esc(name)}</a>` : '—'; }

export function orbitPill(o) { return `<span class="pill-orbit ${esc(o)}">${esc(o)}</span>`; }
export function milPill(s) { return s.mil ? `<span class="pill-mil" title="Defense / military (${s.milReason === 'owner' ? 'operator is a defense organisation' : 'name pattern'})">MIL</span>` : ''; }

export function satTable(rows, { limit = 100, showRocket = true, showMaker = true, showRole = false, total = null } = {}) {
  if (!rows?.length) return '<div class="empty">No matching objects currently tracked.</div>';
  const sorted = rows.slice().sort((a, b) => (b.launched || '').localeCompare(a.launched || '') || a.name.localeCompare(b.name));
  const shown = sorted.slice(0, limit);
  const all = total ?? rows.length;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Object</th>${showRole ? '<th>Role</th>' : ''}<th>Orbit</th><th>Country</th><th>Owner</th>${showMaker ? '<th>Manufacturer</th><th>Bus</th>' : ''}${showRocket ? '<th>Rocket</th>' : ''}<th>Launched ↓</th></tr></thead><tbody>
  ${shown.map((s) => `<tr><td><a href="${satUrl(s.id)}"><strong>${esc(s.name)}</strong></a>${milPill(s)}<div class="muted mono small">${esc(s.cospar)} · ${s.id}</div></td>${showRole ? `<td class="nowrap muted">${esc(s.role || '')}</td>` : ''}<td>${orbitPill(s.orbit)}</td><td>${esc(s.country || '—')}</td><td>${linkMaker(s.ownerCode, s.owner)}</td>${showMaker ? `<td>${linkMaker(s.mfCode, s.mf)}</td><td>${linkBus(s.bus)}</td>` : ''}${showRocket ? `<td>${linkRocket(s.lvType)}</td>` : ''}<td class="nowrap">${fmtDate(s.launched)}</td></tr>`).join('')}
  </tbody></table></div>${all > shown.length ? `<div class="note" style="margin-top:8px">Showing the ${shown.length} most recent of ${all.toLocaleString()}.</div>` : ''}`;
}

export function newsList(items) {
  if (!items?.length) return '<div class="empty">No recent articles found.</div>';
  return `<div class="news">${items.map((a) => `<a class="item" href="${esc(a.url)}" target="_blank" rel="noopener">${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" onerror="this.replaceWith(document.createElement('div'))">` : '<div></div>'}<div><div class="t">${esc(a.title)}</div><div class="m">${esc(a.site)} · ${fmtDate(a.published, { time: true })}${a.authors?.length ? ' · ' + esc(a.authors.join(', ')) : ''}</div><div class="s">${esc(a.summary)}</div></div></a>`).join('')}</div>`;
}

const SOCIAL_ICON = { X: '𝕏', 'X (Twitter)': '𝕏', Twitter: '𝕏', Youtube: '▶', YouTube: '▶', LinkedIn: 'in', Instagram: '◎', Facebook: 'f', Homepage: '⌂', 'Official website': '⌂', Mastodon: 'M', Bluesky: '☁', TikTok: '♪', Telegram: '✈', Wikipedia: 'W', Website: '⌂' };
export function socialLinks(links) {
  if (!links?.length) return '<div class="empty">No official links found.</div>';
  const seen = new Set();
  return `<div class="socials">${links.filter((l) => l.url && !seen.has(l.url) && seen.add(l.url)).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener"><span class="ico">${SOCIAL_ICON[l.name] || '↗'}</span>${esc(l.name)}${l.handle && !/^https?:/.test(l.handle) ? ` <span class="muted">@${esc(l.handle.replace(/^@/, ''))}</span>` : ''}</a>`).join('')}</div>`;
}

export function startClock(el) {
  const tick = () => { el.innerHTML = `<strong>${new Date().toISOString().replace('T', ' ').slice(0, 19)}</strong> UTC`; };
  tick(); setInterval(tick, 1000);
}

export function qs(name) { return new URLSearchParams(location.search).get(name); }
