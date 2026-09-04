# Orbital Tracker

Real-time 3D tracker of every actively tracked LEO / MEO / GEO / HEO satellite, with defense-satellite
filtering, per-satellite launch and manufacturing details, rocket / manufacturer / bus profile pages, and a
worldwide upcoming-launch schedule.

## Run

```bash
npm install
npm start          # http://localhost:3000  (set PORT=… to change)
```

The first start downloads ~40 MB of catalog data (GCAT + CelesTrak) into `data/` and builds the catalog in about a
second. Subsequent starts reuse the cache; orbital elements refresh every 2 hours, catalog tables daily.

## Pages

| Page | What it shows |
| --- | --- |
| `index.html` | Rotatable, slowly auto-rotating Three.js globe with all ~16,500 tracked payloads and rocket bodies propagated live with SGP4 (in a Web Worker). Filter by orbit class (LEO / MEO / GEO / HEO), defense / military, country, operator, launch vehicle, object type, or search. Click any dot or list row for the detail panel: live lat / lon / altitude / speed, launch date, rocket, flight, mission, site & pad, manufacturer, bus / model, mass, dimensions, orbit elements, and the Launch Library launch record with webcasts. |
| `detail.html?type=rocket&name=…` | Rocket profile: Launch Library specs (height, mass, payload capacities, thrust, launch counts, landings, cost), GCAT variant table, Wikipedia background, official links and manufacturer social media, upcoming and recent launches, every tracked satellite it launched, and recent news. |
| `detail.html?type=maker&code=…` | Organisation profile (manufacturer or operator): facts, launch record, rockets built, buses built, satellites built / operated, Wikipedia background, official website and social media (Launch Library + Wikidata), upcoming launches, news. |
| `detail.html?type=bus&name=…` | Satellite bus / model profile with the satellites using it. |
| `detail.html?type=rockets|makers|owners|buses` | Browsable indexes. |
| `insights.html` | Analytics: hero stats plus 14 interactive charts (payloads by country, orbit class, launch year, rockets, manufacturers, operators, military by country, constellations, LEO altitude histogram, inclination × altitude heatmap, fleet age, and GCAT launch history since 1957 by outcome, country and rocket family). Every bar/cell deep-links to the globe or a profile; a Hide Starlink toggle recomputes everything. |
| `detail.html?type=untracked` | Active SATCAT payloads that cannot be plotted (classified, deep-space, no public elements) and why. |
| `launches.html` | Upcoming launches worldwide (and a Recent view cross-referenced with the catalog so each launch lists the payloads now on the globe) with countdowns, local + UTC times, windows, status, provider, rocket (linked), pad and map, mission description, target orbit, customers, weather odds, attempt counts, updates, webcasts and info links, mission patches. Filter by provider, country, status, rocket, defense-related. |

## Data sources

- **CelesTrak** GP (OMM) elements for the `active` group, refreshed every 2 h (falls back to per-group downloads when throttled). SATCAT for object type / launch site.
- **GCAT** (Jonathan McDowell's General Catalog of Artificial Space Objects): satellite catalog, launch list, organisations, launch vehicles and sites. Provides owner, manufacturer, bus, mass, dimensions, launch vehicle / variant, flight ID, mission, site and pad.
- **Launch Library 2** (The Space Devs): upcoming launches, launcher configurations, agencies (with social media links), historical launch records by international designator. Production API is limited to 15 calls / hour, so results are cached on disk and the dev mirror is used for reference data.
- **Wikipedia / Wikidata**: summaries, full extracts, official websites and social media handles.
- **Spaceflight News API**: recent articles.

### Military / defense classification

An object is flagged as defense-related when its GCAT owner organisation is class `D` (defense) or when its name
matches a curated list of defense programme patterns (USA-nnn, NROL, Kosmos, Yaogan, TJS, Skynet, WGS, AEHF, MUOS,
GPS/Navstar, GLONASS, etc.). Navigation constellations operated by armed forces count as military (dual-use).

## Layout

```
server/index.js     Express API + static hosting
server/catalog.js   Joins CelesTrak elements with GCAT metadata, classifies orbits and military use
server/sources.js   Remote downloads with disk caching / throttling fallbacks
server/external.js  Launch Library, Wikipedia, Wikidata and news wrappers with cache
public/js/app.js    Globe, filters, picking, detail panel
public/js/worker.js SGP4 propagation worker (satellite.js)
public/js/detail.js Rocket / organisation / bus profile pages
public/js/launches.js Upcoming / recent launch schedule
public/js/insights.js Insights charts (SVG, no chart library)
```
