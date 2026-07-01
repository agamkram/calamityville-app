/**
 * Disaster data — fetches and normalizes events from USGS, NOAA, and NASA EONET.
 */

export const DISASTER_TYPES = {
  earthquake: { label: "Earthquake", color: "#ff6b4a" },
  volcano: { label: "Volcano", color: "#e056fd" },
  hurricane: { label: "Hurricane", color: "#4a9eff" },
  fire: { label: "Wildfire", color: "#ff9f43" },
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

function isoStart(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19);
}

function inWindow(timeMs, hours) {
  if (!timeMs) return true;
  return timeMs >= Date.now() - hours * 3600000;
}

function latestGeometry(geometries, hours) {
  if (!geometries?.length) return null;
  const cutoff = Date.now() - hours * 3600000;
  let best = null;
  for (const g of geometries) {
    if (g.type !== "Point" || !g.coordinates) continue;
    const t = new Date(g.date).getTime();
    if (t < cutoff) continue;
    if (!best || t > new Date(best.date).getTime()) best = g;
  }
  return best || geometries[geometries.length - 1];
}

export async function fetchDisasters(hours = 24) {
  const [eqResult, nhcResult, eonetResult] = await Promise.allSettled([
    fetchEarthquakes(hours),
    fetchHurricanes(),
    fetchEonet(hours),
  ]);

  const events = [];
  const errors = [];

  if (eqResult.status === "fulfilled") events.push(...eqResult.value);
  else errors.push("earthquakes");

  if (nhcResult.status === "fulfilled") events.push(...nhcResult.value);
  else errors.push("hurricanes");

  if (eonetResult.status === "fulfilled") events.push(...eonetResult.value);
  else errors.push("eonet");

  const hasVolcano = events.some((e) => e.type === "volcano");
  if (!hasVolcano) events.push(...CURATED_VOLCANOES);

  events.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { events, errors };
}

async function fetchEarthquakes(hours) {
  const url =
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&starttime=${isoStart(hours)}&minmagnitude=4.5&orderby=time`;

  const res = await fetch(url);
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

async function fetchHurricanes() {
  const res = await fetch("https://www.nhc.noaa.gov/CurrentStorms.json");
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
}

async function fetchEonet(hours) {
  const days = Math.max(1, Math.ceil(hours / 24));
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?days=${days}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`EONET ${res.status}`);
  const data = await res.json();

  const events = [];
  for (const ev of data.events || []) {
    const catId = ev.categories?.[0]?.id;
    let type = null;
    if (catId === "wildfires") type = "fire";
    else if (catId === "volcanoes") type = "volcano";
    else if (catId === "severeStorms") type = "hurricane";
    else continue;

    const geom = latestGeometry(ev.geometry, hours);
    if (!geom) continue;

    const [lon, lat] = geom.coordinates;
    const time = new Date(geom.date).getTime();
    if (!inWindow(time, hours) && type !== "volcano") continue;

    let description = ev.title;
    if (geom.magnitudeValue != null && geom.magnitudeUnit) {
      description += `. ${geom.magnitudeValue} ${geom.magnitudeUnit}`;
    }
    if (ev.description) description = ev.description;

    events.push({
      id: ev.id,
      type,
      title: ev.title,
      lat,
      lon,
      time,
      description,
      source: "NASA EONET",
      url: ev.link,
    });
  }
  return events;
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