/**
 * Disaster data — fetches and normalizes events from USGS, NOAA, and NASA EONET.
 */

/** USGS minimum magnitude — was 4.5; 3.0 surfaces more felt quakes without flooding the globe. */
const EARTHQUAKE_MIN_MAGNITUDE = 2.5;

export const DISASTER_TYPES = {
  earthquake: { label: "Earthquake", color: "#ff9f0a" },
  volcano: { label: "Volcano", color: "#bf5af2" },
  hurricane: { label: "Hurricane", color: "#9ca3af" },
  fire: { label: "Wildfire", color: "#ff2d55" },
  flood: { label: "Flood", color: "#30d158" },
  tornado: { label: "Tornado report", color: "#f8fafc" },
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

const DETAIL_URL_FALLBACKS = {
  earthquake: "https://earthquake.usgs.gov/",
  volcano: "https://www.usgs.gov/programs/VHP",
  hurricane: "https://www.nhc.noaa.gov/",
  fire: "https://www.nifc.gov/",
  flood: "https://www.weather.gov/safety/flood",
  tornado: "https://www.spc.noaa.gov/climo/reports/",
  tsunami: "https://www.tsunami.gov/",
};

const MACHINE_URL_RE = /\.(xml|rss|atom|geojson|tcw|kmz|kml|zip|json)(\?|$)/i;
const API_URL_RE = /\/api\/|api\.weather\.gov\/alerts\//i;

const PAYWALL_HOSTS = new Set([
  "nytimes.com",
  "wsj.com",
  "ft.com",
  "washingtonpost.com",
  "economist.com",
  "bloomberg.com",
  "thetimes.co.uk",
  "telegraph.co.uk",
  "latimes.com",
  "bostonglobe.com",
  "newyorker.com",
  "theatlantic.com",
]);

const MAINSTREAM_FREE_HOSTS = new Set([
  "bbc.com",
  "bbc.co.uk",
  "reuters.com",
  "apnews.com",
  "wikipedia.org",
  "theguardian.com",
  "aljazeera.com",
  "dw.com",
  "france24.com",
  "gdacs.org",
  "nhc.noaa.gov",
  "noaa.gov",
  "weather.gov",
  "tsunami.gov",
  "usgs.gov",
  "spc.noaa.gov",
]);

function hostName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isPaywalledUrl(url) {
  const host = hostName(url);
  return PAYWALL_HOSTS.has(host) || [...PAYWALL_HOSTS].some((h) => host.endsWith(`.${h}`));
}

function isTechnicalDetailUrl(url) {
  return (
    /metoc\.navy\.mil\/jtwc/i.test(url) ||
    /eonet\.gsfc\.nasa\.gov/i.test(url) ||
    /web\.txt$/i.test(url)
  );
}

function isReadableDetailUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (isPaywalledUrl(url)) return false;
    if (API_URL_RE.test(url)) return false;
    if (parsed.hostname === "eonet.gsfc.nasa.gov" && url.includes("/api/")) return false;
    if (MACHINE_URL_RE.test(url)) return false;
    return true;
  } catch {
    return false;
  }
}

function isMainstreamFreeUrl(url) {
  if (!isReadableDetailUrl(url) || isTechnicalDetailUrl(url)) return false;
  const host = hostName(url);
  if (MAINSTREAM_FREE_HOSTS.has(host)) return true;
  return [...MAINSTREAM_FREE_HOSTS].some((h) => host === h || host.endsWith(`.${h}`));
}

function bbcNewsSearchUrl(query) {
  return `https://www.bbc.co.uk/search?q=${encodeURIComponent(query)}&filter=news`;
}

function reutersSearchUrl(query) {
  return `https://www.reuters.com/site-search/?query=${encodeURIComponent(query)}`;
}

function wikipediaSearchUrl(query) {
  return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
}

function peakStormIntensityKts(event) {
  const trackPeak = (event.track || []).reduce((max, p) => Math.max(max, p.intensity || 0), 0);
  return Math.max(trackPeak, event.intensity || 0);
}

function isMajorEvent(event) {
  const title = event.title || "";
  const lower = title.toLowerCase();

  if (event.type === "hurricane") {
    if (/tropical depression/i.test(title)) return false;
    if (/super typhoon|major hurricane|typhoon|hurricane/i.test(title)) return true;
    if (peakStormIntensityKts(event) >= 64) return true;
  }

  if (event.type === "earthquake") {
    if ((event.magnitude || 0) >= 6) return true;
    if ((event.felt || 0) >= 250) return true;
  }

  if (event.type === "tsunami") {
    if (/warning|advisory/i.test(lower + (event.alertLevel || "").toLowerCase())) return true;
  }

  if (event.type === "volcano" && event.id?.startsWith("curated-")) return true;

  if (event.type === "fire" && /mega|large|massive|record/i.test(lower)) return true;

  return false;
}

function mainstreamCoverageUrl(event) {
  const query = (event.title || "").trim();
  if (!query) return null;

  switch (event.type) {
    case "hurricane":
      if (event.id?.startsWith("nhc-") || event.source?.includes("NHC")) return null;
      if (/typhoon|hurricane/i.test(query)) return bbcNewsSearchUrl(query);
      return reutersSearchUrl(query);
    case "earthquake":
      if ((event.magnitude || 0) >= 6.5) return bbcNewsSearchUrl(query);
      return reutersSearchUrl(query);
    case "tsunami":
      return bbcNewsSearchUrl(query);
    case "volcano":
      return wikipediaSearchUrl(query);
    case "fire":
      return bbcNewsSearchUrl(query);
    default:
      return bbcNewsSearchUrl(query);
  }
}

function normalizeDetailUrl(url) {
  if (!url) return null;
  if (isReadableDetailUrl(url) && !isTechnicalDetailUrl(url)) return url;

  if (/metoc\.navy\.mil\/jtwc\/products\/[a-z]{2}\d{4}\./i.test(url)) {
    return null;
  }

  if (/api\.weather\.gov\/alerts\//.test(url)) {
    return "https://www.weather.gov/";
  }

  return null;
}

function isOfficialUrlForEvent(url, event) {
  if (!isMainstreamFreeUrl(url)) return false;
  const host = hostName(url);
  if (host === "nhc.noaa.gov" || host.endsWith(".nhc.noaa.gov")) {
    return event.id?.startsWith("nhc-") || event.source?.includes("NHC");
  }
  return true;
}

function pickEventDetailUrl(event, ...candidates) {
  const type = event.type;

  for (const candidate of candidates) {
    const normalized = normalizeDetailUrl(candidate);
    if (normalized && isOfficialUrlForEvent(normalized, event)) return normalized;
  }

  if (isMajorEvent(event)) {
    const coverage = mainstreamCoverageUrl(event);
    if (coverage) return coverage;
  }

  for (const candidate of candidates) {
    const normalized = normalizeDetailUrl(candidate);
    if (normalized && !isPaywalledUrl(normalized)) return normalized;
  }

  return DETAIL_URL_FALLBACKS[type] || null;
}

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

function stormTrackPoints(geometries, hours) {
  if (!geometries) return [];
  const list = Array.isArray(geometries) ? geometries : [geometries];
  const cutoff = windowStartMs(hours);
  const points = [];

  for (const g of list) {
    if (g.type !== "Point" || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
    const time = new Date(g.date).getTime();
    if (Number.isNaN(time) || time < cutoff) continue;

    const [lon, lat] = g.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    points.push({
      lat,
      lon,
      time,
      intensity: g.magnitudeValue ?? null,
      intensityUnit: g.magnitudeUnit || null,
    });
  }

  return points.sort((a, b) => a.time - b.time);
}

function latestGeometry(geometries, hours, { ongoing = false } = {}) {
  if (!geometries) return null;
  const list = Array.isArray(geometries) ? geometries : [geometries];
  if (!list.length) return null;

  const points = list.filter(
    (g) => g.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length >= 2
  );
  if (!points.length) return null;

  if (ongoing) {
    return points.reduce((latest, g) =>
      !latest || new Date(g.date) > new Date(latest.date) ? g : latest
    );
  }

  const cutoff = windowStartMs(hours);
  let best = null;
  let fallback = null;

  for (const g of points) {
    if (!fallback) fallback = g;
    const t = new Date(g.date).getTime();
    if (Number.isNaN(t) || t < cutoff) continue;
    if (!best || t > new Date(best.date).getTime()) best = g;
  }

  return best || fallback;
}

function parseEonetEvent(ev, type, hours) {
  try {
    const ongoing = type === "hurricane" && !ev.closed;
    const geom = latestGeometry(ev.geometry, hours, { ongoing });
    if (!geom) return null;

    const [lon, lat] = geom.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

    const time = new Date(geom.date).getTime();
    if (Number.isNaN(time)) return null;
    if (!ongoing && !inWindow(time, hours) && type !== "volcano") return null;

    let description = ev.title || "EONET event";
    if (geom.magnitudeValue != null && geom.magnitudeUnit) {
      description += `. ${geom.magnitudeValue} ${geom.magnitudeUnit}`;
    }
    if (ev.description) description = ev.description;

    const sourceUrls = (ev.sources || []).map((s) => s.url).filter(Boolean);
    const event = {
      id: `eonet-${ev.id}`,
      type,
      title: ev.title || description,
      lat,
      lon,
      time,
      description,
      source: "NASA EONET",
    };

    if (type === "hurricane") {
      const track = stormTrackPoints(ev.geometry, hours);
      if (track.length >= 2) event.track = track;
    }

    event.url = pickEventDetailUrl(event, ...sourceUrls, ev.link);
    return event;
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
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`EONET HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("EONET unavailable");
}

function nearDuplicateStorm(a, b) {
  return Math.abs(a.lat - b.lat) < 2 && Math.abs(a.lon - b.lon) < 2;
}

/** Prefer NHC entries; add EONET severe storms that are not colocated duplicates. */
function mergeHurricanes(nhcStorms, eonetStorms) {
  const merged = nhcStorms.map((storm) => ({ ...storm }));
  for (const storm of eonetStorms) {
    const dupeIdx = merged.findIndex((h) => nearDuplicateStorm(h, storm));
    if (dupeIdx >= 0) {
      if (storm.track?.length >= 2 && !merged[dupeIdx].track) {
        merged[dupeIdx].track = storm.track;
      }
      continue;
    }
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
  if (!hasVolcano) {
    events.push(
      ...CURATED_VOLCANOES.map((volcano) => ({
        ...volcano,
        url: pickEventDetailUrl(volcano, volcano.url),
      }))
    );
  }

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
    const event = {
      id: f.id,
      type: "earthquake",
      title: p.title || `M${p.mag} earthquake`,
      lat,
      lon,
      time: p.time,
      magnitude: p.mag,
      felt: p.felt,
      description: `${p.title}. Magnitude ${p.mag}${p.felt ? `, felt by ${p.felt} people` : ""}.`,
      source: "USGS",
      tsunami: p.tsunami === 1,
    };
    event.url = pickEventDetailUrl(event, p.url);
    return event;
  });
}

async function fetchTornadoes(hours) {
  const events = [];
  const seen = new Set();

  const { sts, ets } = iemTimeRange(hours);
  const url = `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts=${sts}&ets=${ets}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`IEM LSR ${res.status}`);
  const data = await res.json();

  for (const feature of data.features || []) {
    const p = feature.properties;
    // IEM LSR type "T" = NWS local storm report of a tornado (spotter, public, law enforcement).
    // These are reports, not confirmed survey touchdowns or warning polygons.
    if (p?.type !== "T") continue;

    const lon = p.lon ?? feature.geometry?.coordinates?.[0];
    const lat = p.lat ?? feature.geometry?.coordinates?.[1];
    const time = new Date(p.valid).getTime();
    if (Number.isNaN(time) || !inWindow(time, hours)) continue;

    const key = tornadoDedupeKey(lat, lon, time);
    if (seen.has(key)) continue;
    seen.add(key);

    const place = [p.city, p.st].filter(Boolean).join(", ") || "Unknown location";
    const county = p.county ? ` (${p.county} County)` : "";
    const remark = typeof p.remark === "string" ? p.remark.trim() : "";
    const tornado = {
      id: `lsr-${p.product_id || p.valid}`,
      type: "tornado",
      title: `Tornado report — ${place}`,
      lat,
      lon,
      time,
      description: remark
        ? `NWS local storm report near ${place}${county}. ${remark}`
        : `NWS local storm report of a tornado near ${place}${county}.`,
      source: "NWS Local Storm Report",
    };
    tornado.url = pickEventDetailUrl(tornado, "https://www.spc.noaa.gov/climo/reports/");
    events.push(tornado);
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
  const tsunami = {
    id,
    type: "tsunami",
    title: p.headline || p.event || "Tsunami alert",
    lat,
    lon,
    time,
    description: p.description || p.event || "Coastal tsunami alert",
    source: "NWS / NOAA",
    alertLevel: p.event,
    severity: p.severity,
  };
  tsunami.url = pickEventDetailUrl(tsunami, p.id, "https://www.tsunami.gov/");
  events.push(tsunami);
}

async function fetchNwsTsunamiAlerts(hours, seen, events, { active }) {
  const start = new Date(windowStartMs(hours)).toISOString();
  const end = new Date().toISOString();

  await Promise.all(
    TSUNAMI_NWS_EVENTS.map(async (eventName) => {
      try {
        const base = active
          ? `https://api.weather.gov/alerts/active?event=${encodeURIComponent(eventName)}`
          : `https://api.weather.gov/alerts?event=${encodeURIComponent(eventName)}&start=${start}&end=${end}&status=actual`;
        const res = await fetchWithTimeout(base, { headers: NWS_HEADERS });
        if (!res.ok) return;
        const data = await res.json();
        for (const feature of data.features || []) {
          parseNwsTsunamiFeature(feature, seen, events);
        }
      } catch (err) {
        console.warn(`NWS tsunami ${active ? "active" : "recent"} ${eventName}:`, err);
      }
    })
  );
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

    const tsunami = {
      id: bulletin.id,
      type: "tsunami",
      title: bulletin.title,
      lat: bulletin.lat,
      lon: bulletin.lon,
      time,
      description: bulletin.description,
      source: bulletin.source,
      alertLevel: bulletin.category,
    };
    tsunami.url = pickEventDetailUrl(tsunami, bulletin.url, "https://www.tsunami.gov/");
    events.push(tsunami);
  }
}

async function fetchTsunamis(hours) {
  const events = [];
  const seen = new Set();

  await Promise.all([
    fetchNwsTsunamiAlerts(hours, seen, events, { active: true }),
    fetchNwsTsunamiAlerts(hours, seen, events, { active: false }),
    fetchTsunamiAtomBulletins(hours, seen, events),
  ]);

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
      const event = {
        id: `nhc-${s.id}`,
        type: "hurricane",
        title: s.name ? `${classification} ${s.name}` : "Unnamed storm",
        lat: s.latitudeNumeric,
        lon: s.longitudeNumeric,
        time: s.lastUpdate ? new Date(s.lastUpdate).getTime() : Date.now(),
        description: `${classification} ${s.name}. ${intensity ? `Winds ${intensity}. ` : ""}Moving ${s.movementDir}° at ${s.movementSpeed} kt.`,
        source: "NOAA NHC",
        intensity: Number(s.intensity) || null,
        movementDir: s.movementDir,
        movementSpeed: s.movementSpeed,
      };
      event.url = pickEventDetailUrl(
        event,
        s.publicAdvisory?.url,
        s.forecastGraphics?.url,
        s.forecastDiscussion?.url,
        "https://www.nhc.noaa.gov/"
      );
      return event;
    });
  } catch {
    return [];
  }
}

async function fetchEonet(hours) {
  // EONET's days window is when an event *opened*, not last update — use max days so
  // ongoing Western Pacific storms (e.g. Bavi) are not dropped on the 24h/48h filters.
  const data = await fetchEonetJson(3);

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