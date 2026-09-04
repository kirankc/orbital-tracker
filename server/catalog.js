// Builds the satellite catalog by joining CelesTrak GP elements with GCAT metadata.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadGcat, loadCelestrakSatcat, loadGP, DATA_DIR } from './sources.js';

const MU = 398600.4418; // km^3/s^2
const RE = 6378.137;

export function parseTSV(text) {
  const lines = text.split('\n');
  let header = null;
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!header) header = line.slice(1).split('\t').map((s) => s.trim());
      continue;
    }
    const cells = line.split('\t');
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = (cells[i] ?? '').trim();
    rows.push(row);
  }
  return rows;
}

export function parseCSV(text) {
  const lines = text.split('\n').filter(Boolean);
  const header = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = [];
    let cur = '';
    let q = false;
    const s = lines[i];
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (q) {
        if (c === '"' && s[j + 1] === '"') { cur += '"'; j++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    const row = {};
    header.forEach((h, k) => { row[h.trim()] = (cells[k] ?? '').trim(); });
    out.push(row);
  }
  return out;
}

const clean = (v) => (v === undefined || v === null || v === '-' || v === '' ? null : v);
const stripQ = (v) => (v ? v.replace(/\?/g, '').trim() : v);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// GCAT dates look like "2019 Nov 11 1557" or "2020 May 28?" -> ISO (UTC).
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function gcatDate(s) {
  if (!s || s === '-') return null;
  const m = s.match(/^(\d{4})(?:\s+([A-Z][a-z]{2}))?(?:\s+(\d{1,2}))?(?:\s+(\d{2})(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/);
  if (!m) return null;
  const y = +m[1];
  const mo = m[2] ? MONTHS[m[2]] : 0;
  const d = m[3] ? +m[3] : 1;
  const h = m[4] ? +m[4] : 0;
  const mi = m[5] ? +m[5] : 0;
  const sec = m[6] ? Math.floor(+m[6]) : 0;
  const dt = new Date(Date.UTC(y, mo ?? 0, d, h, mi, sec));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

export function classifyOrbit(gp) {
  const mm = +gp.MEAN_MOTION; // rev/day
  const ecc = +gp.ECCENTRICITY;
  const inc = +gp.INCLINATION;
  const n = (mm * 2 * Math.PI) / 86400; // rad/s
  const a = Math.cbrt(MU / (n * n));
  const apogee = a * (1 + ecc) - RE;
  const perigee = a * (1 - ecc) - RE;
  const period = 1440 / mm;
  let orbit;
  if (ecc > 0.25) orbit = 'HEO';
  else if (mm > 0.93 && mm < 1.07 && ecc < 0.15) orbit = 'GEO';
  else if (apogee < 2000) orbit = 'LEO';
  else if (perigee > 2000 && apogee < 33000) orbit = 'MEO';
  else orbit = 'OTHER';
  let sub = orbit;
  if (orbit === 'GEO') sub = inc < 7 ? 'GEO' : 'GSO (inclined)';
  else if (orbit === 'LEO') sub = inc > 80 && inc < 105 ? 'LEO (polar/SSO)' : 'LEO';
  return { orbit, sub, apogee: Math.round(apogee), perigee: Math.round(perigee), period: +period.toFixed(1), inc: +inc.toFixed(2), ecc };
}

const MIL_NAME_RE = /^(USA[ -]\d+|NROL|COSMOS \d|KOSMOS \d|YAOGAN|TJS-|OFEQ|GSSAP|WGS|AEHF|MUOS|SBIRS|DSP|MILSTAR|SKYNET|SICRAL|SYRACUSE|STARSHIELD|OTV|X-37|NAVSTAR|GPS |GLONASS|LUDI TANCE|CERES \d|HELIOS|CSO-|SAR-LUPE|SARAH-|SPAINSAT|XTAR|GOKTURK|KL-|IGS |MENTOR|TRUMPET|KH-|LACROSSE|TOPAZ|ONYX|MISTY|PAN \(|CLIO|NEMESIS|SDS |UFO \d|FLTSAT|DSCS|SBSS|STSS|TACSAT|ORS-|PARUS|STRELA|RODNIK|MERIDIAN|GARPUN|BLAGOVEST|LOTOS|PION|BARS-M|PERSONA|TUNDRA|LIANA|OKO|TSELINA|TSIKADA|YUNHAI|COMSATBW|ATHENA-FIDUS|SPIRALE|ELISA|QUASAR|INTRUDER|NOSS|TIANHUI|SICH|SATCOM-\d|OPTUS C1|ZIRCON|EROS C|PAZ)/i;

function orgLookup(orgs, code) {
  if (!code) return null;
  const c = stripQ(code);
  return orgs.get(c) || orgs.get(c.toUpperCase()) || null;
}

function orgDisplay(o) {
  if (!o) return null;
  return {
    code: o.Code,
    name: clean(o.EName) || clean(o.Name) || o.Code,
    shortName: clean(o.ShortEName) || clean(o.ShortName) || o.Code,
    localName: clean(o.Name),
    class: o.Class, // A academic, B business, C civil government, D defense
    type: o.Type,
    state: o.StateCode,
    location: clean(o.Location),
    parent: clean(o.Parent),
    start: clean(o.TStart),
    stop: clean(o.TStop),
  };
}

// CelesTrak SATCAT owner codes -> the country names used by GCAT (fallback for objects without a GCAT record).
const CT_OWNER = { US: 'USA', PRC: 'China', CIS: 'Russia', UK: 'UK', FR: 'France', JPN: 'Japan', IND: 'India', GER: 'Germany', IT: 'Italy', SKOR: 'South Korea', CA: 'Canada', SPN: 'Spain', TURK: 'Turkey', ISRA: 'Israel', SAUD: 'Saudi Arabia', AUS: 'Australia', ESA: 'ESA', EUME: 'EUMETSAT', LUXE: 'Luxembourg', NETH: 'Netherlands', SWED: 'Sweden', NOR: 'Norway', ARGN: 'Argentina', BRAZ: 'Brazil', MEX: 'Mexico', INDO: 'Indonesia', THAI: 'Thailand', MALA: 'Malaysia', SING: 'Singapore', UAE: 'UAE', IRAN: 'Iran', PAKI: 'Pakistan', EGYP: 'Egypt', ALG: 'Algeria', NIG: 'Nigeria', SAFR: 'South Africa', KAZ: 'Kazakhstan', UKR: 'Ukraine', BELA: 'Belarus', POL: 'Poland', CZCH: 'Czech Republic', AUST: 'Austria', SWTZ: 'Switzerland', BEL: 'Belgium', DEN: 'Denmark', FIN: 'Finland', GREC: 'Greece', HUN: 'Hungary', POR: 'Portugal', IRL: 'Ireland', NZ: 'New Zealand', TWN: 'Taiwan', HKG: 'China(Hong Kong)', VTNM: 'Vietnam', PHL: 'Phillipines', BGD: 'Bangladesh', QAT: 'Qatar', KWT: 'Kuwait', MA: 'Morocco', PER: 'Peru', CHLE: 'Chile', COL: 'Colombia', VENZ: 'Venezuela', BOL: 'Bolivia', ECU: 'Ecuador', URY: 'Uruguay', AB: 'ARABSAT', EUTE: 'EUTELSAT', IM: 'INMARSAT', ITSO: 'Intelsat', O3B: 'Luxembourg', SES: 'Luxembourg', GLOB: 'USA', ORB: 'USA', IRID: 'USA', TBD: 'Unknown' };

const CLASS_LABEL = { A: 'Academic / research', B: 'Business / commercial', C: 'Civil government', D: 'Defense / military' };

export function rocketDisplayName(lvType, variant) {
  const v = clean(variant);
  if (!v || lvType.includes(v)) return lvType;
  return `${lvType} ${v}`;
}

export async function buildCatalog(log = console.log) {
  const t0 = Date.now();
  const [gcat, ctSatcatText, gpRes] = await Promise.all([loadGcat(log), loadCelestrakSatcat(log), loadGP(log)]);

  const orgs = new Map();
  for (const o of parseTSV(gcat.orgs)) orgs.set(o.Code, o);
  const sites = new Map();
  for (const s of parseTSV(gcat.sites)) sites.set(s.Site, s);
  const lvs = new Map();
  for (const l of parseTSV(gcat.lv)) {
    lvs.set(`${l.LV_Name}|${l.LV_Variant}`, l);
    if (!lvs.has(l.LV_Name)) lvs.set(l.LV_Name, l);
  }
  const launches = new Map();
  const lvStats = new Map(); // all-time launch history per vehicle type, from the GCAT launch list
  const launchYears = new Map(); // year -> { orbital, success, failure, byState: {}, byFamily: {} }
  for (const l of parseTSV(gcat.launch)) {
    launches.set(l.Launch_Tag, l);
    const lv = clean(l.LV_Type);
    const code = (l.LaunchCode || '').trim();
    if (!lv || !code || !/^[OMSDAY]/.test(code)) continue;
    const date = gcatDate(l.Launch_Date);
    const st = lvStats.get(lv) || { name: lv, total: 0, orbital: 0, success: 0, failure: 0, first: null, last: null, agencies: {} };
    st.total++;
    if (code[0] === 'O') { st.orbital++; if (code[1] === 'S') st.success++; else if (code[1] === 'F') st.failure++; }
    if (date) { if (!st.first || date < st.first) st.first = date; if (!st.last || date > st.last) st.last = date; }
    if (clean(l.Agency)) st.agencies[l.Agency] = (st.agencies[l.Agency] || 0) + 1;
    lvStats.set(lv, st);
    if (code[0] === 'O' && date) {
      const y = +date.slice(0, 4);
      const yr = launchYears.get(y) || { year: y, orbital: 0, success: 0, failure: 0, byState: {}, byFamily: {} };
      yr.orbital++;
      if (code[1] === 'S') yr.success++; else if (code[1] === 'F') yr.failure++;
      const ag = clean(l.Agency) ? orgLookup(orgs, l.Agency.split('/')[0]) : null;
      const site = sites.get(l.Launch_Site);
      const stateCode = (ag && clean(ag.StateCode)) || (site && clean(site.StateCode)) || 'Unknown';
      yr.byState[stateCode] = (yr.byState[stateCode] || 0) + 1;
      const lvRow = lvs.get(`${l.LV_Type}|${l.Variant}`) || lvs.get(l.LV_Type);
      const fam = (lvRow && clean(lvRow.LV_Family)) || lv;
      yr.byFamily[fam] = (yr.byFamily[fam] || 0) + 1;
      launchYears.set(y, yr);
    }
  }
  const satcat = new Map();
  for (const s of parseTSV(gcat.satcat)) {
    const id = parseInt(s.Satcat, 10);
    if (!Number.isFinite(id)) continue;
    if (!satcat.has(id) || s.JCAT.startsWith('S')) satcat.set(id, s);
  }
  const ct = new Map();
  for (const r of parseCSV(ctSatcatText)) ct.set(parseInt(r.NORAD_CAT_ID, 10), r);

  const countryName = (code) => {
    if (!code) return null;
    return code.split('/').map((c) => {
      const o = orgs.get(stripQ(c));
      return o ? clean(o.ShortEName) || clean(o.EName) || clean(o.Name) || c : c;
    }).join(' / ');
  };

  const list = [];
  const details = new Map();
  const rockets = new Map();
  const makers = new Map();
  const buses = new Map();
  const owners = new Map();

  for (const gp of gpRes.gp) {
    const id = +gp.NORAD_CAT_ID;
    if (!Number.isFinite(id) || (id >= 80000 && id < 100000)) continue; // skip CelesTrak analyst objects (80000-99999); real IDs continue at 100000+
    const s = satcat.get(id);
    const c = ct.get(id);
    const objType = c?.OBJECT_TYPE || (s ? { P: 'PAY', R: 'R/B', D: 'DEB', C: 'DEB' }[s.Type[0]] || 'UNK' : 'UNK');
    if (objType === 'DEB') continue;

    const orb = classifyOrbit(gp);
    const launchTag = s ? s.Launch_Tag : null;
    const launch = launchTag ? launches.get(launchTag) : null;
    const ownerCodes = s && clean(s.Owner) ? stripQ(s.Owner).split('/') : [];
    const ownerOrgs = ownerCodes.map((k) => orgLookup(orgs, k)).filter(Boolean);
    const mfCodes = s && clean(s.Manufacturer) ? stripQ(s.Manufacturer).split('/') : [];
    const mfOrgs = mfCodes.map((k) => orgLookup(orgs, k)).filter(Boolean);
    const name = gp.OBJECT_NAME;
    const milByOwner = ownerOrgs.some((o) => o.Class === 'D');
    const milByName = MIL_NAME_RE.test(name) || (s && MIL_NAME_RE.test(s.Name));
    const mil = milByOwner || milByName;
    const lvType = launch ? clean(launch.LV_Type) : null;
    const lvName = lvType ? rocketDisplayName(lvType, launch.Variant) : null;
    const lvRow = launch ? lvs.get(`${launch.LV_Type}|${launch.Variant}`) || lvs.get(launch.LV_Type) : null;
    const lvMaker = lvRow ? orgLookup(orgs, lvRow.LV_Manufacturer) : null;
    const state = s ? stripQ(s.State) : null;
    const country = countryName(state) || (c ? CT_OWNER[c.OWNER] || c.OWNER : null);
    const launchDate = (s && gcatDate(s.LDate)) || (launch && gcatDate(launch.Launch_Date)) || (c?.LAUNCH_DATE ? `${c.LAUNCH_DATE}T00:00:00.000Z` : null);
    const bus = s ? clean(stripQ(s.Bus)) : null;
    const mfName = mfOrgs.length ? mfOrgs.map((o) => clean(o.ShortEName) || clean(o.EName) || clean(o.Name) || o.Code).join(' / ') : (mfCodes.length ? mfCodes.join(' / ') : null);
    const ownerName = ownerOrgs.length ? ownerOrgs.map((o) => clean(o.ShortEName) || clean(o.EName) || clean(o.Name) || o.Code).join(' / ') : (ownerCodes.length ? ownerCodes.join(' / ') : null);

    const entry = {
      id,
      name,
      gname: s ? clean(s.Name) : null,
      cospar: gp.OBJECT_ID,
      type: objType,
      orbit: orb.orbit,
      sub: orb.sub,
      mil,
      milReason: mil ? (milByOwner ? 'owner' : 'name') : null,
      country,
      state,
      owner: ownerName,
      ownerCode: ownerCodes[0] || null,
      mf: mfName,
      mfCode: mfCodes[0] || null,
      bus,
      lv: lvName,
      lvType,
      lvMaker: lvMaker ? clean(lvMaker.ShortEName) || clean(lvMaker.EName) || clean(lvMaker.Name) : null,
      launched: launchDate,
      apogee: orb.apogee,
      perigee: orb.perigee,
      period: orb.period,
      inc: orb.inc,
      ecc: orb.ecc,
      gp: {
        EPOCH: gp.EPOCH,
        MEAN_MOTION: gp.MEAN_MOTION,
        ECCENTRICITY: gp.ECCENTRICITY,
        INCLINATION: gp.INCLINATION,
        RA_OF_ASC_NODE: gp.RA_OF_ASC_NODE,
        ARG_OF_PERICENTER: gp.ARG_OF_PERICENTER,
        MEAN_ANOMALY: gp.MEAN_ANOMALY,
        NORAD_CAT_ID: gp.NORAD_CAT_ID,
        BSTAR: gp.BSTAR,
        MEAN_MOTION_DOT: gp.MEAN_MOTION_DOT,
        MEAN_MOTION_DDOT: gp.MEAN_MOTION_DDOT,
        ELEMENT_SET_NO: gp.ELEMENT_SET_NO,
        REV_AT_EPOCH: gp.REV_AT_EPOCH,
        CLASSIFICATION_TYPE: gp.CLASSIFICATION_TYPE,
        EPHEMERIS_TYPE: gp.EPHEMERIS_TYPE,
      },
    };
    list.push(entry);

    const site = launch ? sites.get(launch.Launch_Site) : null;
    const agency = launch ? orgLookup(orgs, launch.Agency) : null;
    details.set(id, {
      ...entry,
      plname: s ? clean(s.PLName) : null,
      altNames: s ? clean(s.AltNames) : null,
      status: s ? s.Status : null,
      gcatType: s ? s.Type : null,
      mass: s ? num(s.Mass) : null,
      dryMass: s ? num(s.DryMass) : null,
      length: s ? num(s.Length) : null,
      diameter: s ? num(s.Diameter) : null,
      span: s ? num(s.Span) : null,
      shape: s ? clean(s.Shape) : null,
      motor: s ? clean(s.Motor) : null,
      opOrbit: s ? clean(s.OpOrbit) : null,
      separated: s ? gcatDate(s.SDate) : null,
      owners: ownerOrgs.map(orgDisplay).map((o) => ({ ...o, classLabel: CLASS_LABEL[o.class] || o.class, stateName: countryName(o.state) })),
      manufacturers: mfOrgs.map(orgDisplay).map((o) => ({ ...o, classLabel: CLASS_LABEL[o.class] || o.class, stateName: countryName(o.state) })),
      launch: launch ? {
        tag: launch.Launch_Tag,
        date: gcatDate(launch.Launch_Date),
        lvType,
        variant: clean(launch.Variant),
        lvName,
        flightId: clean(launch.Flight_ID),
        flight: clean(launch.Flight),
        mission: clean(launch.Mission),
        flightCode: clean(launch.FlightCode),
        siteCode: launch.Launch_Site,
        site: site ? clean(site.EName) || clean(site.Name) : launch.Launch_Site,
        siteLocation: site ? clean(site.Location) : null,
        siteLat: site ? num(site.Latitude) : null,
        siteLon: site ? num(site.Longitude) : null,
        pad: clean(launch.Launch_Pad),
        agencyCode: clean(launch.Agency),
        agency: agency ? clean(agency.EName) || clean(agency.Name) : clean(launch.Agency),
        category: clean(launch.Category),
        group: clean(launch.Group),
        success: launch.LaunchCode ? launch.LaunchCode.trim().endsWith('S') : null,
        orbMass: num(launch.OrbMass),
        orbPay: num(launch.OrbPay),
      } : null,
      lvSpec: lvRow ? {
        name: lvRow.LV_Name,
        family: clean(lvRow.LV_Family),
        variant: clean(lvRow.LV_Variant),
        manufacturerCode: clean(lvRow.LV_Manufacturer),
        manufacturer: lvMaker ? clean(lvMaker.EName) || clean(lvMaker.Name) : clean(lvRow.LV_Manufacturer),
        stages: num(lvRow.LV_Max_Stage),
        length: num(lvRow.Length),
        diameter: num(lvRow.Diameter),
        launchMass: num(lvRow.Launch_Mass),
        leoCapacity: num(lvRow.LEO_Capacity),
        gtoCapacity: num(lvRow.GTO_Capacity),
        thrust: num(lvRow.TO_Thrust),
      } : null,
      celestrak: c ? {
        objectType: c.OBJECT_TYPE,
        opsStatus: c.OPS_STATUS_CODE,
        owner: c.OWNER,
        launchDate: c.LAUNCH_DATE,
        launchSite: c.LAUNCH_SITE,
        rcs: num(c.RCS),
        period: num(c.PERIOD),
        inclination: num(c.INCLINATION),
        apogee: num(c.APOGEE),
        perigee: num(c.PERIGEE),
        orbitType: c.ORBIT_TYPE,
      } : null,
      gpMeta: { epoch: gp.EPOCH, elsetNo: gp.ELEMENT_SET_NO, revAtEpoch: gp.REV_AT_EPOCH },
    });

    if (lvType) {
      const r = rockets.get(lvType) || { name: lvType, family: null, manufacturer: null, manufacturerCode: null, count: 0, mil: 0, variants: {}, sats: [], first: null, last: null };
      r.count++;
      if (mil) r.mil++;
      r.variants[lvName] = (r.variants[lvName] || 0) + 1;
      r.sats.push(id);
      if (lvRow) {
        r.family = r.family || clean(lvRow.LV_Family);
        r.manufacturer = r.manufacturer || (lvMaker ? clean(lvMaker.EName) || clean(lvMaker.Name) : clean(lvRow.LV_Manufacturer));
        r.manufacturerCode = r.manufacturerCode || clean(lvRow.LV_Manufacturer);
      }
      if (launchDate) {
        if (!r.first || launchDate < r.first) r.first = launchDate;
        if (!r.last || launchDate > r.last) r.last = launchDate;
      }
      rockets.set(lvType, r);
    }
    for (const o of mfOrgs) {
      const m = makers.get(o.Code) || { ...orgDisplay(o), classLabel: CLASS_LABEL[o.Class] || o.Class, stateName: countryName(o.StateCode), count: 0, mil: 0, sats: [], buses: {} };
      m.count++;
      if (mil) m.mil++;
      m.sats.push(id);
      if (bus) m.buses[bus] = (m.buses[bus] || 0) + 1;
      makers.set(o.Code, m);
    }
    for (const o of ownerOrgs) {
      const m = owners.get(o.Code) || { ...orgDisplay(o), classLabel: CLASS_LABEL[o.Class] || o.Class, stateName: countryName(o.StateCode), count: 0, mil: 0, sats: [] };
      m.count++;
      if (mil) m.mil++;
      m.sats.push(id);
      owners.set(o.Code, m);
    }
    if (bus) {
      const b = buses.get(bus) || { name: bus, count: 0, mil: 0, manufacturers: {}, sats: [] };
      b.count++;
      if (mil) b.mil++;
      if (mfName) b.manufacturers[mfName] = (b.manufacturers[mfName] || 0) + 1;
      b.sats.push(id);
      buses.set(bus, b);
    }
  }

  // Rocket index: vehicles with objects in orbit plus any vehicle that has flown since 2015 (e.g. Starship, whose payloads have not stayed in orbit).
  const lvMakerName = (lvName) => { const row = lvs.get(lvName); const o = row ? orgLookup(orgs, row.LV_Manufacturer) : null; return { family: row ? clean(row.LV_Family) : null, manufacturer: o ? clean(o.ShortEName) || clean(o.EName) || clean(o.Name) : (row ? clean(row.LV_Manufacturer) : null), manufacturerCode: row ? clean(row.LV_Manufacturer) : null }; };
  for (const [lv, st] of lvStats) {
    if (!rockets.has(lv) && st.orbital > 0 && st.last && st.last >= '2015-01-01') {
      rockets.set(lv, { name: lv, ...lvMakerName(lv), count: 0, mil: 0, variants: {}, sats: [], first: null, last: null });
    }
  }
  for (const r of rockets.values()) {
    const st = lvStats.get(r.name);
    r.launches = st ? { total: st.total, orbital: st.orbital, success: st.success, failure: st.failure, first: st.first, last: st.last } : null;
    if (!r.family || !r.manufacturer) Object.assign(r, Object.fromEntries(Object.entries(lvMakerName(r.name)).filter(([k, v]) => v && !r[k])));
  }
  const rocketLvs = [...rockets.values()].sort((a, b) => b.count - a.count || ((b.launches?.last || '').localeCompare(a.launches?.last || '')));
  const makerList = [...makers.values()].sort((a, b) => b.count - a.count);
  const ownerList = [...owners.values()].sort((a, b) => b.count - a.count);
  const busList = [...buses.values()].sort((a, b) => b.count - a.count);

  // Coverage versus the CelesTrak SATCAT: active payloads that have no public orbital elements cannot be plotted.
  const trackedIds = new Set(list.map((s) => s.id));
  const activePayloads = [...ct.values()].filter((r) => !r.DECAY_DATE && r.OBJECT_TYPE === 'PAY' && ['+', 'P', 'B', 'S', 'X'].includes(r.OPS_STATUS_CODE));
  const untracked = activePayloads.filter((r) => !trackedIds.has(parseInt(r.NORAD_CAT_ID, 10)));
  const coverage = {
    satcatActivePayloads: activePayloads.length,
    satcatOnOrbitPayloads: [...ct.values()].filter((r) => !r.DECAY_DATE && r.OBJECT_TYPE === 'PAY').length,
    shownActivePayloads: activePayloads.length - untracked.length,
    untracked: untracked.length,
    untrackedDeepSpace: untracked.filter((r) => r.ORBIT_CENTER !== 'EA').length,
    untrackedClassified: untracked.filter((r) => r.ORBIT_CENTER === 'EA' && /^USA \d|^NROL|^OPS \d/.test(r.OBJECT_NAME)).length,
  };
  coverage.untrackedOther = coverage.untracked - coverage.untrackedDeepSpace - coverage.untrackedClassified;
  const untrackedList = untracked.map((r) => ({ id: +r.NORAD_CAT_ID, name: r.OBJECT_NAME, cospar: r.OBJECT_ID, owner: r.OWNER, launched: r.LAUNCH_DATE, site: r.LAUNCH_SITE, orbitCenter: r.ORBIT_CENTER, period: num(r.PERIOD), inclination: num(r.INCLINATION), apogee: num(r.APOGEE), perigee: num(r.PERIGEE), reason: r.ORBIT_CENTER !== 'EA' ? 'Deep space / not Earth orbit' : /^USA \d|^NROL|^OPS \d/.test(r.OBJECT_NAME) ? 'Classified (no public elements)' : 'No public elements' }));

  const stats = {
    coverage,
    total: list.length,
    byOrbit: list.reduce((acc, s) => ((acc[s.orbit] = (acc[s.orbit] || 0) + 1), acc), {}),
    military: list.filter((s) => s.mil).length,
    payloads: list.filter((s) => s.type === 'PAY').length,
    gpUpdated: gpRes.updated,
    gpStale: !!gpRes.stale,
    gpSource: gpRes.source || 'groups',
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - t0,
  };
  log(`[catalog] ${list.length} objects (${stats.military} military, ${Object.entries(stats.byOrbit).map(([k, v]) => `${k}=${v}`).join(' ')}) in ${stats.buildMs} ms`);

  // Launch-history series for the Insights page.
  const stateName = (code) => { const o = orgs.get(code); return o ? clean(o.ShortEName) || clean(o.EName) || clean(o.Name) || code : code; };
  const years = [...launchYears.values()].sort((a, b) => a.year - b.year);
  const totalsBy = (key) => { const t = {}; for (const y of years) for (const [k, v] of Object.entries(y[key])) t[k] = (t[k] || 0) + v; return Object.entries(t).sort((a, b) => b[1] - a[1]); };
  const recentBy = (key, since) => { const t = {}; for (const y of years) if (y.year >= since) for (const [k, v] of Object.entries(y[key])) t[k] = (t[k] || 0) + v; return Object.entries(t).sort((a, b) => b[1] - a[1]); };
  const topStates = recentBy('byState', 2000).slice(0, 7).map(([k]) => k);
  const topFamilies = recentBy('byFamily', 2015).slice(0, 7).map(([k]) => k);
  const launchHistory = {
    years: years.map((y) => ({ year: y.year, orbital: y.orbital, success: y.success, failure: y.failure })),
    states: topStates.map((code) => ({ code, name: stateName(code), values: years.map((y) => y.byState[code] || 0) })),
    statesOther: years.map((y) => Object.entries(y.byState).filter(([k]) => !topStates.includes(k)).reduce((a, [, v]) => a + v, 0)),
    families: topFamilies.map((fam) => ({ name: fam, values: years.map((y) => y.byFamily[fam] || 0), vehicles: [...lvs.values()].filter((l) => l.LV_Family === fam).map((l) => l.LV_Name).filter((n, i, a) => a.indexOf(n) === i && rockets.has(n)).sort((a, b) => (rockets.get(b).count - rockets.get(a).count) || ((rockets.get(b).launches?.last || '').localeCompare(rockets.get(a).launches?.last || ''))) })),
    familiesOther: years.map((y) => Object.entries(y.byFamily).filter(([k]) => !topFamilies.includes(k)).reduce((a, [, v]) => a + v, 0)),
    allTimeStates: totalsBy('byState').slice(0, 12).map(([code, n]) => ({ code, name: stateName(code), n })),
  };

  const catalog = { list, details, rockets, makers, owners, buses, rocketList: rocketLvs, makerList, ownerList, busList, stats, orgs, lvs, lvStats, untracked: untrackedList, launchHistory };
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, 'catalog-stats.json'), JSON.stringify(stats, null, 2));
  } catch {}
  return catalog;
}
