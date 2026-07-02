/**
 * Disaster data — fetches and normalizes events from USGS, NOAA, and NASA EONET.
 */

/** USGS minimum magnitude — was 4.5; 3.0 surfaces more felt quakes without flooding the globe. */
const EARTHQUAKE_MIN_MAGNITUDE = 2.5;

export const DISASTER_TYPES = {
  earthquake: { label: "Earthquake", color: "#ff9f0a" },
  volcano: { label: "Volcano", color: "#bf5af2" },
  hurricane: { label: "Hurricane", color: "#0a84ff" },
  fire: { label: "Wildfire", color: "#ff2d55" },
  flood: { label: "Flood", color: "#30d158" },
  tornado: { label: "Tornado", color: "#d1d5db" },
  tsunami: { label: "Tsunami", color: "#5ac8fa" },
};

const TSUNAMI_NWS_EVENTS = [
  "Tsunami Warning",
  "Tsunami Advisory",
  "Tsunami Watch",
];

const NWS_HEADERS = {
  Accept: "application/geo+json",
  "User-Agent": "disaster-globe",
};

const EONET_CATEGORY_MAP = {
  wildfires: "fire",
  volcanoes: "volcano",
  floods: "flood",
};

/** Active volcanoes under elevated watch (curated supplement when feeds are sparse). */
const CURATED_VOLCANOES = [
  {
    id: "curated-kilauea",
    type: "volcano",
    title: "Kīlauea",
    lat: 19.421,
    lon: -155.287,
    time: null,
    description:
      "Hawaiʻi's most active volcano. USGS Hawaiian Volcano Observatory monitors ongoing summit and rift activity.",
    source: "USGS HVO (curated)",
    url: "https://www.usgs.gov/volcanoes/kilauea",
  },
  {
    id: "curated-etna",
    type: "volcano",
    title: "Mount Etna",
    lat: 37.751,
    lon: 14.993,
    time: null,
    description:
      "Europe's tallest active volcano. Frequent Strombolian eruptions and lava flows from summit craters.",
    source: "INGV monitoring (curated)",
    url: "https://www.ct.ingv.it/index.php/monitoraggio-e-sorveglianza/prodotti-del-monitoraggio/bollettini-settimanali-multidisciplinari",
  },
  {
    id: "curated-popocatepetl",
    type: "volcano",
    title: "Popocatépetl",
    lat: 19.023,
    lon: -98.622,
    time: null,
    description:
      "Mexico's second-highest peak. Persistent ash emissions and intermittent explosions near Mexico City.",
    source: "CENAPRED (curated)",
    url: "https://www.gob.mx/cenapred",
  },
  {
    id: "curated-sakurajima",
    type: "volcano",
    title: "Sakurajima",
    lat: 31.593,
    lon: 130.657,
    time: null,
    description:
      "One of Japan's most active volcanoes. Regular vulcanian explosions from the Minamidake crater.",
    source: "JMA (curated)",
    url: "https://www.data.jma.go.jp/svd/vois/data/tokyo/STOCK/souran_eng/menu.htm",
  },
];

const FETCH_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function windowStartMs(hours) {
  return Date.now() - hours * 3600000;
}

function isoStart(hours) {
  return new Date(windowStartMs(hours)).toISOString().slice(0, 19);
}

function inWindow(timeMs, hours) {
  if (!timeMs) return true;
  return timeMs >= windowStartMs(hours);
}

function latestGeometry(geometries, hours) {
  if (!geometries) return null;
  const list = Array.isArray(geometries) ? geometries : [geometries];
  if (!list.length) return null;

  const cutoff = windowStartMs(hours);
  let best = null;
  let fallback = null;

  for (const g of list) {
    if (g.type !== "Point" || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
    if (!fallback) fallback = g;
    const t = new Date(g.date).getTime();
    if (Number.isNaN(t) || t < cutoff) continue;
    if (!best || t > new Date(best.date).getTime()) best = g;
  }

  return best || fallback;
}

function parseEonetEvent(ev, type, hours) {
  try {
    const geom = latestGeometry(ev.geometry, hours);
    if (!geom) return null;

    const [lon, lat] = geom.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

    const time = new Date(geom.date).getTime();
    if (Number.isNaN(time)) return null;
    if (!inWindow(time, hours) && type !== "volcano") return null;

    let description = ev.title || "EONET event";
    if (geom.magnitudeValue != null && geom.magnitudeUnit) {
      description += `. ${geom.magnitudeValue} ${geom.magnitudeUnit}`;
    }
    if (ev.description) description = ev.description;

    return {
      id: `eonet-${ev.id}`,
      type,
      title: ev.title || description,
      lat,
      lon,
      time,
      description,
      source: "NASA EONET",
      url: ev.link,
    };
  } catch {
    return null;
  }
}

async function fetchEonetJson(days) {
  const urls = [`https://eonet.gsfc.nasa.gov/api/v3/events?days=${days}`];
  if (typeof window !== "undefined") {
    urls.push(`/api/eonet?days=${days}`);
  }
  let lastError;

  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`EONET HTTP ${res.status}`);
        return JSON.parse(await res.text());
      } catch (err) {
        lastError = err;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
      }
    }
  }

  throw lastError || new Error("EONET unavailable");
}

function nearDuplicateStorm(a, b) {
  return Math.abs(a.lat - b.lat) < 2 && Math.abs(a.lon - b.lon) < 2;
}

/** Prefer NHC entries; add EONET severe storms that are not colocated duplicates. */
function mergeHurricanes(nhcStorms, eonetStorms) {
  const merged = [...nhcStorms];
  for (const storm of eonetStorms) {
    if (merged.some((h) => nearDuplicateStorm(h, storm))) continue;
    merged.push(storm);
  }
  return merged;
}

function iemTimeRange(hours) {
  const end = new Date();
  const start = new Date(windowStartMs(hours));
  const fmt = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
    );
  };
  return { sts: fmt(start), ets: fmt(end) };
}

function geometryCentroid(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Point") return geometry.coordinates;

  let ring;
  if (geometry.type === "Polygon") ring = geometry.coordinates[0];
  else if (geometry.type === "MultiPolygon") ring = geometry.coordinates[0]?.[0];
  if (!ring?.length) return null;

  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

function tornadoDedupeKey(lat, lon, timeMs) {
  return `${lat.toFixed(1)},${lon.toFixed(1)},${Math.floor(timeMs / 3_600_000)}`;
}

function tsunamiDedupeKey(lat, lon, timeMs) {
  return `${lat.toFixed(2)},${lon.toFixed(2)},${Math.floor((timeMs || 0) / 1_800_000)}`;
}

export async function fetchDisasters(hours = 24) {
  const [eqResult, nhcResult, eonetResult, tornadoResult, tsunamiResult] = await Promise.allSettled([
    fetchEarthquakes(hours),
    fetchHurricanes(),
    fetchEonet(hours),
    fetchTornadoes(hours),
    fetchTsunamis(hours),
  ]);

  const events = [];
  const errors = [];

  if (eqResult.status === "fulfilled") events.push(...eqResult.value);
  else errors.push("earthquakes");

  let eonetStorms = [];
  if (eonetResult.status === "fulfilled") {
    const eonet = eonetResult.value;
    events.push(...(eonet?.general || []));
    eonetStorms = eonet?.severeStorms || [];
  } else {
    errors.push("eonet");
  }

  const nhcStorms = nhcResult.status === "fulfilled" ? nhcResult.value : [];
  if (nhcResult.status === "rejected") errors.push("nhc");
  events.push(...mergeHurricanes(nhcStorms, eonetStorms));
  if (!nhcStorms.length && !eonetStorms.length && nhcResult.status === "rejected") {
    errors.push("hurricanes");
  }

  if (tornadoResult.status === "fulfilled") events.push(...tornadoResult.value);
  else errors.push("tornadoes");

  if (tsunamiResult.status === "fulfilled") events.push(...tsunamiResult.value);
  else errors.push("tsunamis");

  const hasVolcano = events.some((e) => e.type === "volcano");
  if (!hasVolcano) events.push(...CURATED_VOLCANOES);

  events.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { events, errors };
}

async function fetchEarthquakes(hours) {
  const url =
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&starttime=${isoStart(hours)}&minmagnitude=${EARTHQUAKE_MIN_MAGNITUDE}&orderby=time`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  const data = await res.json();

  return (data.features || []).map((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    return {
      id: f.id,
      type: "earthquake",
      title: p.title || `M${p.mag} earthquake`,
      lat,
      lon,
      time: p.time,
      magnitude: p.mag,
      description: `${p.title}. Magnitude ${p.mag}${p.felt ? `, felt by ${p.felt} people` : ""}.`,
      source: "USGS",
      url: p.url,
      tsunami: p.tsunami === 1,
    };
  });
}

async function fetchTornadoes(hours) {
  const events = [];
  const seen = new Set();

  const add = (ev) => {
    if (!Number.isFinite(ev.lat) || !Number.isFinite(ev.lon)) return;
    const key = tornadoDedupeKey(ev.lat, ev.lon, ev.time || 0);
    if (seen.has(key)) return;
    seen.add(key);
    events.push(ev);
  };

  try {
    const { sts, ets } = iemTimeRange(hours);
    const url = `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts=${sts}&ets=${ets}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`IEM LSR ${res.status}`);
    const data = await res.json();

    for (const feature of data.features || []) {
      const p = feature.properties;
      if (p?.type !== "T") continue;

      const lon = p.lon ?? feature.geometry?.coordinates?.[0];
      const lat = p.lat ?? feature.geometry?.coordinates?.[1];
      const time = new Date(p.valid).getTime();
      if (Number.isNaN(time) || !inWindow(time, hours)) continue;

      const place = [p.city, p.st].filter(Boolean).join(", ") || "Unknown location";
      add({
        id: `lsr-${p.product_id || p.valid}`,
        type: "tornado",
        title: `Tornado — ${place}`,
        lat,
        lon,
        time,
        description: `Tornado reported near ${place}${p.county ? ` (${p.county} County)` : ""}.`,
        source: "NWS Storm Report",
        url: "https://www.spc.noaa.gov/climo/reports/",
      });
    }
  } catch (err) {
    console.warn("IEM tornado reports:", err);
  }

  for (const eventName of ["Tornado Warning", "Tornado Watch"]) {
    try {
      const res = await fetchWithTimeout(
        `https://api.weather.gov/alerts/active?event=${encodeURIComponent(eventName)}`
      );
      if (!res.ok) continue;
      const data = await res.json();

      for (const feature of data.features || []) {
        const p = feature.properties || {};
        const coords = geometryCentroid(feature.geometry);
        if (!coords) continue;
        const [lon, lat] = coords;
        const time = new Date(p.sent || p.effective || Date.now()).getTime();

        add({
          id: `nws-${p.id || p.sent}`,
          type: "tornado",
          title: p.headline || eventName,
          lat,
          lon,
          time,
          description: p.description || p.event || eventName,
          source: "NWS",
          url: p.id || "https://www.weather.gov/",
        });
      }
    } catch (err) {
      console.warn(`NWS ${eventName}:`, err);
    }
  }

  return events;
}

function parseNwsTsunamiFeature(feature, seen, events) {
  const p = feature.properties || {};
  const coords = geometryCentroid(feature.geometry);
  if (!coords) return;
  const [lon, lat] = coords;
  const id = `nws-tsunami-${p.id || p.sent}`;
  if (seen.has(id)) return;
  seen.add(id);

  const time = new Date(p.sent || p.effective || Date.now()).getTime();
  events.push({
    id,
    type: "tsunami",
    title: p.headline || p.event || "Tsunami alert",
    lat,
    lon,
    time,
    description: p.description || p.event || "Coastal tsunami alert",
    source: "NWS / NOAA",
    url: p.id ? `https://api.weather.gov/alerts/${p.id}` : "https://www.tsunami.gov/",
    alertLevel: p.event,
    severity: p.severity,
  });
}

async function fetchNwsTsunamiAlerts(hours, seen, events, { active }) {
  const start = new Date(windowStartMs(hours)).toISOString();
  const end = new Date().toISOString();

  for (const eventName of TSUNAMI_NWS_EVENTS) {
    try {
      const base = active
        ? `https://api.weather.gov/alerts/active?event=${encodeURIComponent(eventName)}`
        : `https://api.weather.gov/alerts?event=${encodeURIComponent(eventName)}&start=${start}&end=${end}&status=actual`;
      const res = await fetchWithTimeout(base, { headers: NWS_HEADERS });
      if (!res.ok) continue;
      const data = await res.json();
      for (const feature of data.features || []) {
        parseNwsTsunamiFeature(feature, seen, events);
      }
    } catch (err) {
      console.warn(`NWS tsunami ${active ? "active" : "recent"} ${eventName}:`, err);
    }
  }
}

async function fetchTsunamiAtomBulletins(hours, seen, events) {
  if (typeof window === "undefined") return;

  let bulletins = [];
  try {
    const res = await fetchWithTimeout("/api/tsunami");
    if (!res.ok) return;
    bulletins = await res.json();
  } catch (err) {
    console.warn("PTWC/NTWC atom proxy:", err);
    return;
  }

  for (const bulletin of bulletins) {
    if (!Number.isFinite(bulletin.lat) || !Number.isFinite(bulletin.lon)) continue;
    const time = new Date(bulletin.time).getTime();
    if (Number.isNaN(time) || !inWindow(time, hours)) continue;

    const key = tsunamiDedupeKey(bulletin.lat, bulletin.lon, time);
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({
      id: bulletin.id,
      type: "tsunami",
      title: bulletin.title,
      lat: bulletin.lat,
      lon: bulletin.lon,
      time,
      description: bulletin.description,
      source: bulletin.source,
      url: bulletin.url || "https://www.tsunami.gov/",
      alertLevel: bulletin.category,
    });
  }
}

async function fetchTsunamis(hours) {
  const events = [];
  const seen = new Set();

  await fetchNwsTsunamiAlerts(hours, seen, events, { active: true });
  await fetchNwsTsunamiAlerts(hours, seen, events, { active: false });
  await fetchTsunamiAtomBulletins(hours, seen, events);

  return events;
}

async function fetchHurricanes() {
  try {
    const res = await fetchWithTimeout("https://www.nhc.noaa.gov/CurrentStorms.json");
    if (!res.ok) throw new Error(`NHC ${res.status}`);
    const data = await res.json();

    return (data.activeStorms || []).map((s) => {
      const classification = s.classification || "Storm";
      const intensity = s.intensity ? `${s.intensity} kt` : "";
      return {
        id: `nhc-${s.id}`,
        type: "hurricane",
        title: s.name || "Unnamed storm",
        lat: s.latitudeNumeric,
        lon: s.longitudeNumeric,
        time: s.lastUpdate ? new Date(s.lastUpdate).getTime() : Date.now(),
        description: `${classification} ${s.name}. ${intensity ? `Winds ${intensity}. ` : ""}Moving ${s.movementDir}° at ${s.movementSpeed} kt.`,
        source: "NOAA NHC",
        url: s.publicAdvisory?.url || "https://www.nhc.noaa.gov/",
        movementDir: s.movementDir,
        movementSpeed: s.movementSpeed,
      };
    });
  } catch {
    return [];
  }
}

async function fetchEonet(hours) {
  const days = Math.min(3, Math.max(1, Math.ceil(hours / 24)));
  const data = await fetchEonetJson(days);

  const general = [];
  const severeStorms = [];

  for (const ev of data.events || []) {
    const catId = ev.categories?.[0]?.id;
    if (catId === "severeStorms") {
      const parsed = parseEonetEvent(ev, "hurricane", hours);
      if (parsed) {
        parsed.source = "NASA EONET (severe storm)";
        severeStorms.push(parsed);
      }
      continue;
    }

    const type = EONET_CATEGORY_MAP[catId];
    if (!type) continue;

    const parsed = parseEonetEvent(ev, type, hours);
    if (parsed) general.push(parsed);
  }

  return { general, severeStorms };
}

export function formatEventTime(timeMs) {
  if (!timeMs) return "Ongoing monitoring";
  const d = new Date(timeMs);
  const now = new Date();
  const diffH = Math.round((now - d) / 3600000);
  const timeStr = d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (diffH < 1) return `${timeStr} · just now`;
  if (diffH < 24) return `${timeStr} · ${diffH}h ago`;
  return timeStr;
}