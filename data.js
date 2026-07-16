/**
 * Disaster data — fetches and normalizes events from USGS, NOAA, NASA EONET,
 * and CIFFC/NRCan active Canadian wildfires.
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

/** National Canadian fire tracker (CIFFC) — free, all provinces, no login. */
const CANADA_FIRES_DETAIL_URL = "https://ciffc.net/";

const DETAIL_URL_FALLBACKS = {
  earthquake: "https://earthquake.usgs.gov/",
  volcano: "https://www.usgs.gov/programs/VHP",
  hurricane: "https://www.nhc.noaa.gov/",
  fire: CANADA_FIRES_DETAIL_URL,
  flood: "https://www.weather.gov/safety/flood",
  tornado: "https://www.spc.noaa.gov/climo/reports/",
  tsunami: "https://www.tsunami.gov/",
};

/** Agency codes → display labels (detail links all go to CIFFC). */
const CANADA_AGENCY_LABELS = {
  BC: "British Columbia",
  AB: "Alberta",
  SK: "Saskatchewan",
  MB: "Manitoba",
  ON: "Ontario",
  QC: "Quebec",
  NB: "New Brunswick",
  NS: "Nova Scotia",
  NL: "Newfoundland and Labrador",
  PE: "Prince Edward Island",
  YT: "Yukon",
  NT: "Northwest Territories",
  NU: "Nunavut",
  PC: "Parks Canada",
};

const CANADA_STAGE_LABELS = {
  OC: "Out of control",
  BH: "Being held",
  UC: "Under control",
  EX: "Extinguished",
};

const CANADA_RESPONSE_LABELS = {
  FUL: "Full response",
  MOD: "Modified response",
  MON: "Monitoring",
};

const CANADA_FIRES_ARCGIS_URL =
  "https://services.arcgis.com/wjcPoefzjpzCgffS/arcgis/rest/services/activefires/FeatureServer/0/query" +
  "?where=1%3D1" +
  "&outFields=Agency,Fire_Name,Latitude,Longitude,Start_Date,Hectares__Ha_,Stage_of_Control,response_type,ObjectId" +
  "&returnGeometry=true" +
  "&outSR=4326" +
  "&f=json" +
  "&resultRecordCount=2000";

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

/** Government or agency pages that require authentication in a normal browser. */
const GATED_HOSTS = new Set(["irwin.doi.gov"]);

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
  "cwfis.cfs.nrcan.gc.ca",
  "nrcan.gc.ca",
  "ciffc.net",
  "ciffc.ca",
  "alberta.ca",
  "ontario.ca",
  "sopfeu.qc.ca",
  "gov.nt.ca",
  "parks.canada.ca",
  "pc.gc.ca",
  "nrs.gov.bc.ca",
  "gov.bc.ca",
  "firms.modaps.eosdis.nasa.gov",
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

function isGatedDetailUrl(url) {
  const host = hostName(url);
  return GATED_HOSTS.has(host) || [...GATED_HOSTS].some((h) => host === h || host.endsWith(`.${h}`));
}

function isTechnicalDetailUrl(url) {
  return (
    /metoc\.navy\.mil\/jtwc/i.test(url) ||
    /eonet\.gsfc\.nasa.gov/i.test(url) ||
    /web\.txt$/i.test(url) ||
    isGatedDetailUrl(url)
  );
}

function isReadableDetailUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (isPaywalledUrl(url) || isGatedDetailUrl(url)) return false;
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

function googleNewsSearchUrl(query) {
  return `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function cycloneNewsQuery(title) {
  return title.replace(/\bSuper\s+/gi, "").replace(/\s+/g, " ").trim();
}

function simplifyTornadoPlace(place) {
  return place
    .replace(/^\d+(\.\d+)?\s*(NE|NW|SE|SW|N|S|E|W)?\s*/i, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function confirmedTornadoNewsQuery(event) {
  const titlePlace = event.title?.replace(/^Confirmed tornado — (?:EF\d+ — )?/i, "").trim();
  const rawPlace = [event.city, event.st].filter(Boolean).join(", ") || titlePlace || "";
  const place = simplifyTornadoPlace(rawPlace);
  const county = event.county ? `${event.county} County` : "";
  const ef = event.efRating != null ? `EF-${event.efRating}` : "";
  return [place, county, ef, "tornado", "confirmed"].filter(Boolean).join(" ");
}

function confirmedTornadoNewsUrl(event) {
  const query = confirmedTornadoNewsQuery(event);
  return query ? googleNewsSearchUrl(query) : null;
}

function canadaAgencyLabel(code) {
  return CANADA_AGENCY_LABELS[code] || code || "Canada";
}

function humanizeCanadaFireName(rawName, agency) {
  if (!rawName) return "";
  let name = String(rawName).trim();
  name = name.replace(/^\d{4}_[A-Z]{2}_/i, "");
  name = name.replace(/^\d{4}_/i, "");
  if (agency) name = name.replace(new RegExp(`^${agency}_`, "i"), "");
  name = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return name;
}

function wildfireNewsQuery(event) {
  if (event.canadaAgency) {
    const place = canadaAgencyLabel(event.canadaAgency);
    const shortName = humanizeCanadaFireName(event.fireName || event.title, event.canadaAgency);
    return [place, "wildfire", shortName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }
  const title = (event.title || "").trim();
  if (!title) return "";
  const stripped = title.replace(/^Wildfire\s+/i, "").replace(/,/g, " ");
  return `${stripped} wildfire`.replace(/\s+/g, " ").trim();
}

function wildfireCoverageUrl(event) {
  const query = wildfireNewsQuery(event);
  return query ? googleNewsSearchUrl(query) : null;
}

function wildfireFirmsMapUrl(event) {
  if (!Number.isFinite(event.lat) || !Number.isFinite(event.lon)) return null;
  return `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${event.lon.toFixed(4)},${event.lat.toFixed(4)},10z`;
}

/** Prefer free government pages; avoid paywalled news; FIRMS map last for non-Canada. */
function pickWildfireDetailUrl(event, ...candidates) {
  if (event.canadaAgency) return CANADA_FIRES_DETAIL_URL;

  for (const candidate of candidates) {
    const normalized = normalizeDetailUrl(candidate);
    if (normalized && isOfficialUrlForEvent(normalized, event)) return normalized;
  }

  const news = wildfireCoverageUrl(event);
  if (news) return news;

  const firms = wildfireFirmsMapUrl(event);
  if (firms) return firms;

  for (const candidate of candidates) {
    const normalized = normalizeDetailUrl(candidate);
    if (normalized && !isPaywalledUrl(normalized)) return normalized;
  }

  return DETAIL_URL_FALLBACKS.fire;
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

  if (event.type === "fire") {
    if ((event.hectares || 0) >= 1000) return true;
    if (/mega|large|massive|record/i.test(lower)) return true;
  }

  return false;
}

function mainstreamCoverageUrl(event) {
  const query = (event.title || "").trim();
  if (!query) return null;

  switch (event.type) {
    case "hurricane":
      if (event.id?.startsWith("nhc-") || event.source?.includes("NHC")) return null;
      if (/typhoon|hurricane/i.test(query)) return bbcNewsSearchUrl(cycloneNewsQuery(query));
      return reutersSearchUrl(cycloneNewsQuery(query));
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

  if (event.type === "tornado" && event.confirmed) {
    const news = confirmedTornadoNewsUrl(event);
    if (news) return news;
  }

  if (event.type === "fire") {
    return pickWildfireDetailUrl(event, ...candidates);
  }

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
  const direct = `https://eonet.gsfc.nasa.gov/api/v3/events?days=${days}`;
  const urls =
    typeof window !== "undefined"
      ? [`/api/eonet?days=${days}`, direct]
      : [direct];

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

const TORNADO_CLUSTER_MAX_DEG = 0.45;
const TORNADO_CLUSTER_MAX_MS = 4 * 3_600_000;

function parseLsrTornadoConfirmation(remark) {
  const text = (remark || "").trim();
  if (!text) return { confirmed: false, efRating: null };

  const efMatch = text.match(/\bEF\s*-?\s*([0-5])\b/i);
  const efRating = efMatch ? Number(efMatch[1]) : null;
  const nwsSurvey = /nws survey/i.test(text);
  const confirmed =
    (nwsSurvey && /confirm/i.test(text)) ||
    (efRating != null && (nwsSurvey || /rated\s+EF/i.test(text)));

  return { confirmed, efRating };
}

function tornadoClusterDistance(a, b) {
  return Math.hypot(a.lat - b.lat, a.lon - b.lon);
}

function tornadoPointsClusterable(a, b) {
  return (
    tornadoClusterDistance(a, b) <= TORNADO_CLUSTER_MAX_DEG &&
    Math.abs(a.time - b.time) <= TORNADO_CLUSTER_MAX_MS
  );
}

function clusterTornadoPoints(points) {
  const clusters = points.map((point) => [point]);

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const linked = clusters[i].some((a) => clusters[j].some((b) => tornadoPointsClusterable(a, b)));
        if (!linked) continue;
        clusters[i] = clusters[i].concat(clusters[j]);
        clusters.splice(j, 1);
        merged = true;
        break;
      }
      if (merged) break;
    }
  }

  return clusters;
}

function buildConfirmedTornadoEvent(cluster) {
  const confirmedPoints = cluster.filter((point) => point.confirmed);
  if (!confirmedPoints.length) return null;

  const track = [...cluster].sort((a, b) => a.time - b.time);
  const latest = track[track.length - 1];
  const efRating = confirmedPoints.reduce(
    (peak, point) => Math.max(peak, point.efRating ?? -1),
    -1
  );
  const efLabel = efRating >= 0 ? `EF${efRating}` : null;
  const place = [latest.city, latest.st].filter(Boolean).join(", ") || "Unknown location";
  const county = latest.county ? ` (${latest.county} County)` : "";
  const surveyRemark = confirmedPoints.find((point) => point.remark)?.remark || "";
  const title = efLabel
    ? `Confirmed tornado — ${efLabel} — ${place}`
    : `Confirmed tornado — ${place}`;

  const event = {
    id: `lsr-confirmed-${latest.productId || latest.time}`,
    type: "tornado",
    confirmed: true,
    efRating: efRating >= 0 ? efRating : null,
    title,
    city: latest.city,
    st: latest.st,
    county: latest.county,
    lat: latest.lat,
    lon: latest.lon,
    time: latest.time,
    description: surveyRemark
      ? `NWS damage survey near ${place}${county}. ${surveyRemark}`
      : `NWS-confirmed tornado near ${place}${county}.`,
    source: "NWS Damage Survey",
  };

  if (track.length >= 2) {
    event.track = track.map((point) => ({
      lat: point.lat,
      lon: point.lon,
      time: point.time,
    }));
  }

  event.url = pickEventDetailUrl(event, "https://www.spc.noaa.gov/climo/reports/");
  return event;
}

function buildTornadoReportEvent(point) {
  const place = [point.city, point.st].filter(Boolean).join(", ") || "Unknown location";
  const county = point.county ? ` (${point.county} County)` : "";
  const event = {
    id: `lsr-${point.productId || point.time}`,
    type: "tornado",
    confirmed: false,
    title: `Tornado report — ${place}`,
    lat: point.lat,
    lon: point.lon,
    time: point.time,
    description: point.remark
      ? `NWS local storm report near ${place}${county}. ${point.remark}`
      : `NWS local storm report of a tornado near ${place}${county}.`,
    source: "NWS Local Storm Report",
  };
  event.url = pickEventDetailUrl(event, "https://www.spc.noaa.gov/climo/reports/");
  return event;
}

function tsunamiDedupeKey(lat, lon, timeMs) {
  return `${lat.toFixed(2)},${lon.toFixed(2)},${Math.floor((timeMs || 0) / 1_800_000)}`;
}

function nearDuplicateFire(a, b) {
  return Math.abs(a.lat - b.lat) < 0.4 && Math.abs(a.lon - b.lon) < 0.4;
}

/** Prefer CIFFC/NRCan agency pins; keep non-overlapping EONET/IRWIN fires. */
function mergeWildfires(canadaFires, eonetFires) {
  const merged = canadaFires.map((fire) => ({ ...fire }));
  for (const fire of eonetFires) {
    if (merged.some((existing) => nearDuplicateFire(existing, fire))) continue;
    merged.push(fire);
  }
  return merged;
}

function formatHectares(ha) {
  if (!Number.isFinite(ha)) return null;
  if (ha >= 1000) return `${Math.round(ha).toLocaleString()} ha`;
  if (ha >= 10) return `${ha.toFixed(ha >= 100 ? 0 : 1)} ha`;
  if (ha >= 1) return `${ha.toFixed(1)} ha`;
  return `${ha.toFixed(2)} ha`;
}

function parseCanadaFireFeature(feature, hours) {
  const a = feature?.attributes || feature?.properties || {};
  const geom = feature?.geometry;

  const lat = Number(a.Latitude ?? a.latitude ?? geom?.y);
  const lon = Number(a.Longitude ?? a.longitude ?? geom?.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const agency = String(a.Agency || a.agency || "").toUpperCase();
  const fireName = a.Fire_Name || a.fire_name || a.FireName || "";
  const hectares = Number(a.Hectares__Ha_ ?? a.hectares ?? a.Hectares);
  const stage = String(a.Stage_of_Control || a.stage_of_control || "").toUpperCase();
  const response = String(a.response_type || a.Response_Type || "").toUpperCase();
  const startMs = Number(a.Start_Date ?? a.start_date);
  if (!Number.isFinite(startMs)) return null;
  // Same 72/48/24h window as other calamities — start time only (no "still burning" override).
  if (!inWindow(startMs, hours)) return null;
  if (stage === "EX") return null;

  const ha = Number.isFinite(hectares) ? hectares : 0;

  const place = canadaAgencyLabel(agency);
  const shortName = humanizeCanadaFireName(fireName, agency);
  const stageLabel = CANADA_STAGE_LABELS[stage] || stage || "Active";
  const responseLabel = CANADA_RESPONSE_LABELS[response];
  const haLabel = formatHectares(ha);

  const title = shortName
    ? `${place} wildfire ${shortName}`
    : `${place} wildfire`;

  const descParts = [
    `${stageLabel} wildfire in ${place}.`,
    haLabel ? `Reported size ${haLabel}.` : null,
    responseLabel ? `${responseLabel}.` : null,
    "Source: Canadian provincial/territorial agencies via CIFFC / Natural Resources Canada.",
  ].filter(Boolean);

  const event = {
    id: `canada-fire-${a.ObjectId ?? a.objectid ?? fireName ?? `${lat},${lon}`}`,
    type: "fire",
    title,
    lat,
    lon,
    time: startMs,
    description: descParts.join(" "),
    source: "CIFFC / NRCan",
    canadaAgency: agency || null,
    fireName: fireName || null,
    hectares: ha,
    stage,
  };
  event.url = pickEventDetailUrl(event);
  return event;
}

async function fetchCanadaFiresJson() {
  const urls =
    typeof window !== "undefined"
      ? ["/api/canada-fires", CANADA_FIRES_ARCGIS_URL]
      : [CANADA_FIRES_ARCGIS_URL];

  let lastError;
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Canada fires HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Canada fires unavailable");
}

async function fetchCanadaWildfires(hours) {
  const data = await fetchCanadaFiresJson();
  const features = data.features || [];
  const events = [];

  for (const feature of features) {
    const parsed = parseCanadaFireFeature(feature, hours);
    if (parsed) events.push(parsed);
  }

  return events;
}

export async function fetchDisasters(hours = 24) {
  const [eqResult, nhcResult, eonetResult, tornadoResult, tsunamiResult, canadaFireResult] =
    await Promise.allSettled([
      fetchEarthquakes(hours),
      fetchHurricanes(),
      fetchEonet(hours),
      fetchTornadoes(hours),
      fetchTsunamis(hours),
      fetchCanadaWildfires(hours),
    ]);

  const events = [];
  const errors = [];

  if (eqResult.status === "fulfilled") events.push(...eqResult.value);
  else errors.push("earthquakes");

  let eonetStorms = [];
  let eonetFires = [];
  if (eonetResult.status === "fulfilled") {
    const eonet = eonetResult.value;
    const general = eonet?.general || [];
    eonetFires = general.filter((e) => e.type === "fire");
    events.push(...general.filter((e) => e.type !== "fire"));
    eonetStorms = eonet?.severeStorms || [];
  } else {
    errors.push("eonet");
  }

  const canadaFires = canadaFireResult.status === "fulfilled" ? canadaFireResult.value : [];
  if (canadaFireResult.status === "rejected") errors.push("canada-fires");
  events.push(...mergeWildfires(canadaFires, eonetFires));

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
  const reportSeen = new Set();
  const points = [];

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
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const remark = typeof p.remark === "string" ? p.remark.trim() : "";
    const { confirmed, efRating } = parseLsrTornadoConfirmation(remark);
    points.push({
      lat,
      lon,
      time,
      remark,
      confirmed,
      efRating,
      city: p.city,
      st: p.st,
      county: p.county,
      productId: p.product_id || p.valid,
    });
  }

  for (const cluster of clusterTornadoPoints(points)) {
    const confirmed = buildConfirmedTornadoEvent(cluster);
    if (confirmed) {
      events.push(confirmed);
      continue;
    }

    for (const point of cluster) {
      const key = tornadoDedupeKey(point.lat, point.lon, point.time);
      if (reportSeen.has(key)) continue;
      reportSeen.add(key);
      events.push(buildTornadoReportEvent(point));
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
  // EONET's days window is when an event *opened*, not last update — widen so multi-day
  // open wildfires and ongoing Western Pacific storms are not dropped on 24h/48h filters.
  const data = await fetchEonetJson(7);

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